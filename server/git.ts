import { spawn } from "bun";
import { realpath, readFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import type { FileChange, GitSnapshot, FileCode, DiffPayload, DiffHunk, Branch, Stash, LogEntry, Remote, Submodule } from "../shared.ts";

// Minimum git: status + resolveRoot + the shared spawn helper. The rest of
// the module is built up over Tasks 4–8 — each adds one logical area.

export interface GitResult { stdout: string; stderr: string; exitCode: number }

export async function runGit(root: string, args: string[]): Promise<GitResult> {
  const proc = spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
}

export async function resolveRoot(cwd: string): Promise<string | null> {
  // Resolve symlinks so the returned path matches what the caller passed in
  // (important on macOS where /tmp → /private/tmp).
  let resolved: string;
  try { resolved = await realpath(cwd); } catch { return null; }
  const r = await runGit(resolved, ["rev-parse", "--show-toplevel"]);
  if (r.exitCode !== 0) return null;
  const top = r.stdout.trim();
  if (!top) return null;
  // If the caller's cwd resolves to the same real path as toplevel, return
  // the original (pre-realpath) form so callers get back what they passed in.
  return top === resolved ? cwd : top;
}

// Parse `git status --porcelain=v2 --branch -uall`. v2 gives stable fields
// for renames + submodules and a machine-readable branch header. Submodules
// appear as `1`/`2` lines with a `XY` worktree-status pair where the X char
// is one of "?" "M" "C" "U" "N"; we collapse them to a single 'S' code so
// the UI can show "submodule pointer changed" distinctly from a file edit.
export async function status(root: string): Promise<GitSnapshot> {
  const r = await runGit(root, ["status", "--porcelain=v2", "--branch", "-uall"]);
  if (r.exitCode !== 0) {
    return emptySnapshot();
  }
  const files: FileChange[] = [];
  const staged: FileChange[] = [];
  let branch: string | null = null;
  let detached = false;
  let headSha: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ");
      const val = rest.join(" ");
      if (key === "branch.head") {
        if (val === "(detached)") { detached = true; branch = null; }
        else branch = val;
      } else if (key === "branch.oid")    headSha = val === "(initial)" ? null : val.slice(0, 7);
      else if (key === "branch.upstream") upstream = val;
      else if (key === "branch.ab") {
        // "+1 -2"
        const m = val.match(/^\+(\d+)\s+-(\d+)$/);
        if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      }
      continue;
    }
    if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), code: "?", staged: false, submodule: false });
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // "1 XY sub mH mI mW hH hI path"  (2 adds rename: " origPath" suffix)
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const sub = parts[2] ?? "N...";
      const x = xy[0], y = xy[1];
      const path = line.startsWith("1 ")
        ? parts.slice(8).join(" ")
        : parts.slice(9).join(" ").split("\t")[0] ?? "";
      const renamedFrom = line.startsWith("2 ")
        ? (parts.slice(9).join(" ").split("\t")[1] ?? undefined)
        : undefined;
      const submodule = sub.startsWith("S");
      const make = (code: string, st: boolean): FileChange => ({
        path,
        code: submodule ? "S" : (code as FileCode),
        staged: st,
        submodule,
        ...(renamedFrom ? { renamedFrom } : {}),
      });
      if (x !== "." && x !== "?") staged.push(make(x, true));
      if (y !== "." && y !== "?") files.push(make(y, false));
      continue;
    }
    // line starts with "u " → unmerged. Surface as "U" code in unstaged.
    if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ");
      files.push({ path, code: "?", staged: false, submodule: false });
    }
  }
  return { branch, detached, headSha, upstream, ahead, behind, files, staged, fetchedAt: Date.now() };
}

export async function diff(root: string, path: string, staged: boolean): Promise<DiffPayload> {
  const r = await runGit(root, [
    "diff", staged ? "--cached" : "HEAD", "--no-color", "--unified=3", "--", path,
  ]);
  // Untracked files produce no diff; fall back to `--no-index /dev/null path`.
  let stdout = r.stdout;
  if (!stdout && !staged) {
    const r2 = await runGit(root, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]);
    stdout = r2.stdout;
  }
  return parseDiff(stdout, path, staged);
}

function parseDiff(out: string, path: string, staged: boolean): DiffPayload {
  if (out.includes("Binary files")) return { path, staged, isBinary: true, hunks: [] };
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) cur.lines.push({ kind: "+", src: line.slice(1) });
    else if (line.startsWith("-") && !line.startsWith("---")) cur.lines.push({ kind: "-", src: line.slice(1) });
    else if (line.startsWith(" ")) cur.lines.push({ kind: " ", src: line.slice(1) });
    else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — applies to the line just emitted. Flag
      // it so the hunk can be re-serialized faithfully when staging.
      const last = cur.lines[cur.lines.length - 1];
      if (last) last.noNewline = true;
    }
  }
  return { path, staged, isBinary: false, hunks };
}

// All files touched by a single commit, parsed from `git show`. Merge commits
// produce no diff under git's default (no -c/--cc), so this returns [] for them.
export async function commitDiff(root: string, sha: string): Promise<DiffPayload[]> {
  const r = await runGit(root, ["show", sha, "--no-color", "--format=", "--unified=3"]);
  return parseCommitDiff(r.stdout);
}

// `git show` concatenates per-file diffs; split on each `diff --git` header and
// reuse the single-file hunk parser. `staged` is meaningless here, so it's false.
export function parseCommitDiff(out: string): DiffPayload[] {
  const files: DiffPayload[] = [];
  let cur: string[] | null = null;
  const flush = () => { if (cur) files.push(parseDiff(cur.join("\n"), pathFromSection(cur), false)); };
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); cur = [line]; }
    else if (cur) cur.push(line);
  }
  flush();
  return files;
}

// Prefer the new-side path (+++ b/…); fall back to the old side for deletions,
// then to the `diff --git` header for binary/mode-only changes with no +++/---.
function pathFromSection(lines: string[]): string {
  for (const l of lines) if (l.startsWith("+++ ") && l !== "+++ /dev/null") return l.slice(4).replace(/^b\//, "");
  for (const l of lines) if (l.startsWith("--- ") && l !== "--- /dev/null") return l.slice(4).replace(/^a\//, "");
  const m = (lines[0] ?? "").match(/^diff --git a\/(.+) b\/(.+)$/);
  return m ? m[2]! : "";
}

async function mustRun(root: string, args: string[]): Promise<string> {
  const r = await runGit(root, args);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout;
}

export async function stage(root: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await mustRun(root, ["add", "--", ...paths]);
}

export async function unstage(root: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await mustRun(root, ["restore", "--staged", "--", ...paths]);
}

export async function discard(root: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await mustRun(root, ["checkout", "HEAD", "--", ...paths]).catch(async () => {
    const { rm } = await import("node:fs/promises");
    const safeRoot = resolvePath(root);
    const safe = paths
      .map((p) => resolvePath(safeRoot, p))
      .filter((abs) => abs === safeRoot || abs.startsWith(safeRoot + sep));
    await Promise.all(safe.map((abs) => rm(abs, { force: true })));
  });
}

export async function stageHunk(root: string, patch: string, reverse: boolean): Promise<void> {
  const proc = spawn(["git", "-C", root, "apply", "--cached", "--unidiff-zero", ...(reverse ? ["--reverse"] : []), "-"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(patch);
  await proc.stdin.end();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(err.trim() || "git apply failed");
}

export async function commit(root: string, message: string, amend: boolean): Promise<{ sha: string }> {
  await mustRun(root, ["commit", ...(amend ? ["--amend"] : []), "-m", message]);
  const sha = (await mustRun(root, ["rev-parse", "--short", "HEAD"])).trim();
  return { sha };
}

export async function branches(root: string): Promise<Branch[]> {
  // `git for-each-ref --format` is the stable parser-friendly form.
  const fmt = "%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)";
  const r = await mustRun(root, ["for-each-ref", "--format=" + fmt, "refs/heads"]);
  const out: Branch[] = [];
  for (const line of r.split("\n")) {
    if (!line) continue;
    const [name, head, up, track] = line.split("\t");
    let ahead = 0, behind = 0;
    const am = track?.match(/ahead (\d+)/);
    const bm = track?.match(/behind (\d+)/);
    if (am) ahead = Number(am[1]);
    if (bm) behind = Number(bm[1]);
    out.push({ name: name ?? "", current: head === "*", upstream: up || null, ahead, behind });
  }
  return out;
}

export async function checkout(root: string, name: string): Promise<void> {
  await mustRun(root, ["checkout", name]);
}

export async function branchCreate(root: string, name: string, from: string | null, checkout: boolean): Promise<void> {
  const base = from ? [from] : [];
  if (checkout) await mustRun(root, ["checkout", "-b", name, ...base]);
  else          await mustRun(root, ["branch", name, ...base]);
}

export async function branchDelete(root: string, name: string, force: boolean): Promise<void> {
  await mustRun(root, ["branch", force ? "-D" : "-d", name]);
}

export async function push(root: string, branch: string, remote: string, setUpstream: boolean): Promise<void> {
  const args = setUpstream ? ["push", "-u", remote, branch] : ["push", remote, branch];
  const r = await runGit(root, args);
  if (r.exitCode !== 0) {
    const err = r.stderr.trim();
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(err)) {
      throw new Error("Updates were rejected — the remote has commits you don't. Pull first, then push.");
    }
    throw new Error(err || "git push failed");
  }
}

export async function stashes(root: string): Promise<Stash[]> {
  const r = await runGit(root, ["stash", "list", "--format=%gd%x09%s%x09%ct"]);
  if (r.exitCode !== 0) return [];
  const out: Stash[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [ref, message, ts] = line.split("\t");
    const m = ref?.match(/^stash@\{(\d+)\}$/);
    if (!m) continue;
    out.push({ index: Number(m[1]), message: message ?? "", createdAt: Number(ts) * 1000 });
  }
  return out;
}

export async function stashCreate(root: string, message: string): Promise<void> {
  await mustRun(root, message ? ["stash", "push", "-m", message] : ["stash", "push"]);
}

export async function stashApply(root: string, index: number, pop: boolean): Promise<void> {
  await mustRun(root, ["stash", pop ? "pop" : "apply", `stash@{${index}}`]);
}

export async function stashDrop(root: string, index: number): Promise<void> {
  await mustRun(root, ["stash", "drop", `stash@{${index}}`]);
}

export async function tags(root: string): Promise<string[]> {
  const r = await runGit(root, ["tag", "--list", "--sort=-creatordate"]);
  return r.stdout.split("\n").filter(Boolean);
}

export async function tagCreate(root: string, name: string, message: string, push: boolean): Promise<void> {
  await mustRun(root, message ? ["tag", "-a", name, "-m", message] : ["tag", name]);
  if (push) await mustRun(root, ["push", "origin", name]);
}

export async function tagDelete(root: string, name: string, remote: boolean): Promise<void> {
  await mustRun(root, ["tag", "-d", name]);
  if (remote) await mustRun(root, ["push", "origin", "--delete", name]);
}

export async function log(root: string, opts: { limit?: number } = {}): Promise<LogEntry[]> {
  const limit = opts.limit ?? 200;
  // Custom record sep \x1e + field sep \x1f keep subject + refs intact.
  const fmt = ["%h", "%H", "%P", "%an", "%ae", "%at", "%s", "%D"].join("%x1f");
  const r = await runGit(root, ["log", `-n${limit}`, "--no-color", `--pretty=format:${fmt}%x1e`]);
  if (r.exitCode !== 0) return [];
  const out: LogEntry[] = [];
  for (const rec of r.stdout.split("\x1e")) {
    const t = rec.trim();
    if (!t) continue;
    const [sha, fullSha, parents, author, email, ts, subject, refs] = t.split("\x1f");
    out.push({
      sha: sha ?? "",
      fullSha: fullSha ?? "",
      parents: (parents ?? "").split(" ").filter(Boolean).map(p => p.slice(0, 7)),
      author: author ?? "",
      authorEmail: email ?? "",
      authoredAt: Number(ts) * 1000,
      subject: subject ?? "",
      refs: (refs ?? "").split(",").map(s => s.trim()).filter(Boolean),
    });
  }
  return out;
}

export async function remotes(root: string): Promise<Remote[]> {
  const r = await runGit(root, ["remote", "-v"]);
  if (r.exitCode !== 0) return [];
  const byName = new Map<string, Remote>();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const [, name, url, kind] = m;
    const cur = byName.get(name!) ?? { name: name!, fetchUrl: "", pushUrl: null };
    if (kind === "fetch") cur.fetchUrl = url!;
    else cur.pushUrl = url!;
    byName.set(name!, cur);
  }
  // If push URL was never set explicitly, surface null (we render that
  // distinctly: "no push URL — pushing disabled").
  // remotes whose push URL equals fetch URL are pushable as-is (no separate
  // push URL was configured); `pushUrl === null` is what signals "no push".
  return [...byName.values()];
}

export async function remoteAdd(root: string, name: string, url: string): Promise<void> {
  await mustRun(root, ["remote", "add", name, url]);
}

export async function remoteUpdate(root: string, name: string, newName: string, fetchUrl: string, pushUrl: string | null): Promise<void> {
  if (newName && newName !== name) await mustRun(root, ["remote", "rename", name, newName]);
  const effective = newName && newName !== name ? newName : name;
  await mustRun(root, ["remote", "set-url", effective, fetchUrl]);
  if (pushUrl !== null) await mustRun(root, ["remote", "set-url", "--push", effective, pushUrl]);
  else await runGit(root, ["remote", "set-url", "--delete", "--push", effective, ".*"]); // best-effort
}

export async function remoteRemove(root: string, name: string): Promise<void> {
  await mustRun(root, ["remote", "remove", name]);
}

// Parse .gitmodules (URL + path + branch) + `git submodule status` (sha + dirty).
// `.gitmodules` may not exist; absence = no submodules.
export async function submodules(root: string): Promise<Submodule[]> {
  let modulesText = "";
  try { modulesText = await readFile(join(root, ".gitmodules"), "utf8"); }
  catch { return []; }
  const entries = new Map<string, { url: string; path: string; branch: string | null }>();
  let current: string | null = null;
  for (const line of modulesText.split("\n")) {
    const m = line.match(/^\[submodule "(.+)"\]/);
    if (m) { current = m[1]!; entries.set(current, { url: "", path: "", branch: null }); continue; }
    if (!current) continue;
    const kv = line.match(/^\s*(url|path|branch)\s*=\s*(.+)\s*$/);
    if (!kv) continue;
    const e = entries.get(current)!;
    if (kv[1] === "url") e.url = kv[2]!;
    else if (kv[1] === "path") e.path = kv[2]!;
    else if (kv[1] === "branch") e.branch = kv[2]!;
  }
  // status: lines like " a1b2c3 path (tag/sha)" — leading "+" = pinned drifted,
  // "-" = not initialised. We surface `dirty = !line.startsWith(" ")`.
  const r = await runGit(root, ["submodule", "status"]);
  const dirtyByPath = new Map<string, { sha: string | null; dirty: boolean }>();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^([ +\-U])([0-9a-f]+)\s+(\S+)/);
    if (!m) continue;
    dirtyByPath.set(m[3]!, { sha: m[2] ?? null, dirty: m[1] !== " " });
  }
  const out: Submodule[] = [];
  for (const e of entries.values()) {
    const status = dirtyByPath.get(e.path);
    out.push({ path: e.path, url: e.url, branch: e.branch, pinnedSha: status?.sha ?? null, dirty: status?.dirty ?? false });
  }
  return out;
}

function emptySnapshot(): GitSnapshot {
  return {
    branch: null, detached: false, headSha: null, upstream: null,
    ahead: null, behind: null, files: [], staged: [], fetchedAt: Date.now(),
  };
}
