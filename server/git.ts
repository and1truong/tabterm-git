import { spawn } from "bun";
import { realpath, readFile, writeFile, stat, lstat, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import type { FileChange, GitSnapshot, FileCode, ConflictCode, GitOperation, GitOperationType, DiffPayload, DiffHunk, ConflictPayload, CommitContext, ComparePayload, ReflogEntry, BlameLine, FileInsightPayload, RebasePlan, RebaseStep, Branch, RemoteBranch, Stash, LogEntry, Remote, Submodule, Worktree } from "../shared.ts";

// Minimum git: status + resolveRoot + the shared spawn helper. The rest of
// the module is built up over Tasks 4–8 — each adds one logical area.

export interface GitResult { stdout: string; stderr: string; exitCode: number }
const networkProcesses = new Map<string, ReturnType<typeof spawn>>();

export async function runGit(root: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
  // --no-optional-locks: read commands (status/diff/log/…) must not take the
  // optional index lock — the module fires git constantly, and grabbing the
  // lock would race with git commands the user runs in their own terminal
  // ("index.lock exists"). Required locks (commit/add/…) are unaffected.
  const proc = spawn(["git", "-C", root, "--no-optional-locks", ...args], { stdout: "pipe", stderr: "pipe", ...(env ? { env: { ...process.env, ...env } } : {}) });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
}

async function runNetworkGit(root: string, args: string[]): Promise<GitResult> {
  if (networkProcesses.has(root)) throw new Error("Another network operation is already running for this repository.");
  const proc = spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  networkProcesses.set(root, proc);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
  } finally {
    if (networkProcesses.get(root) === proc) networkProcesses.delete(root);
  }
}

async function mustRunNetwork(root: string, args: string[]): Promise<string> {
  const result = await runNetworkGit(root, args);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

export function cancelNetwork(root: string): boolean {
  const process = networkProcesses.get(root);
  if (!process) return false;
  process.kill();
  return true;
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

export async function initRepository(cwd: string): Promise<string> {
  // The workspace cwd comes from the trusted host, never from the client. Keep
  // this idempotent in case two subscribed clients initialize at the same time.
  const existing = await resolveRoot(cwd);
  if (existing) return existing;
  let resolved: string;
  try { resolved = await realpath(cwd); } catch { throw new Error("Workspace directory does not exist."); }
  const result = await runGit(resolved, ["init", "-q", "-b", "main"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to initialize repository.");
  const root = await resolveRoot(cwd);
  if (!root) throw new Error("Repository was initialized but could not be opened.");
  return root;
}

// Parse `git status --porcelain=v2 --branch -uall`. v2 gives stable fields
// for renames + submodules and a machine-readable branch header. Submodules
// appear as `1`/`2` lines with a `XY` worktree-status pair where the X char
// is one of "?" "M" "C" "U" "N"; we collapse them to a single 'S' code so
// the UI can show "submodule pointer changed" distinctly from a file edit.
export async function status(root: string): Promise<GitSnapshot> {
  return (await statusWithRaw(root)).snapshot;
}

export async function statusWithRaw(root: string): Promise<{ snapshot: GitSnapshot; raw: string }> {
  const [r, operation] = await Promise.all([
    runGit(root, ["status", "--porcelain=v2", "--branch", "-uall"]),
    operationState(root),
  ]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "git status failed");
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
    // line starts with "u " → unmerged. Keep the porcelain XY pair so the
    // conflict UI can distinguish both-modified from add/delete conflicts.
    if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ");
      files.push({
        path,
        code: "U",
        staged: false,
        submodule: (parts[2] ?? "N...").startsWith("S"),
        conflict: parts[1] as ConflictCode,
      });
    }
  }
  return { snapshot: { branch, detached, headSha, upstream, ahead, behind, files, staged, operation, fetchedAt: Date.now() }, raw: r.stdout };
}

// The git dir for a checkout, worktree, or submodule, via fs only: `.git` is a
// directory, a symlink to one, or a file containing "gitdir: <path>" (linked
// worktrees/submodules). The hot poll path calls this every cycle — the former
// `rev-parse --git-path` spawns here were half the per-poll process count.
async function gitDir(root: string): Promise<string | null> {
  const dotGit = join(root, ".git");
  let st;
  try { st = await lstat(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  if (st.isSymbolicLink()) {
    try { return await realpath(dotGit); } catch { return null; }
  }
  try {
    const m = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+?)\s*$/m);
    return m ? resolvePath(root, m[1]!) : null;
  } catch {
    return null;
  }
}

async function operationState(root: string): Promise<GitOperation | null> {
  const dir = await gitDir(root);
  if (!dir) return null;
  const rebaseMerge = join(dir, "rebase-merge");
  if (await exists(rebaseMerge)) {
    return {
      type: "rebase",
      current: await readInt(join(rebaseMerge, "msgnum")),
      total: await readInt(join(rebaseMerge, "end")),
    };
  }
  const rebaseApply = join(dir, "rebase-apply");
  if (await exists(rebaseApply)) {
    return {
      type: "rebase",
      current: await readInt(join(rebaseApply, "next")),
      total: await readInt(join(rebaseApply, "last")),
    };
  }
  for (const [type, marker] of [
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
  ] as const) {
    if (await exists(join(dir, marker))) return { type, current: null, total: null };
  }
  // An active bisect leaves BISECT_START/BISECT_LOG plus loose refs/bisect/*
  // refs in the git dir. Check all markers so a freshly started-but-unmarked
  // session surfaces too (BISECT_START alone).
  if (await exists(join(dir, "BISECT_START"))
      || await exists(join(dir, "BISECT_LOG"))
      || await exists(join(dir, "refs/bisect/bad"))) {
    return { type: "bisect", current: null, total: null };
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

async function readInt(path: string): Promise<number | null> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function diff(root: string, path: string, staged: boolean): Promise<DiffPayload> {
  const r = await runGit(root, [
    "diff", ...(staged ? ["--cached"] : []), "--no-color", "--unified=3", "--", path,
  ]);
  // Untracked files produce no diff; fall back to `--no-index /dev/null path`.
  let stdout = r.stdout;
  if (!stdout && !staged) {
    const r2 = await runGit(root, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]);
    stdout = r2.stdout;
  }
  return parseDiff(stdout, path, staged);
}

export async function conflictFile(root: string, path: string): Promise<ConflictPayload> {
  const target = await safeWorktreePath(root, path);
  const [baseBytes, oursBytes, theirsBytes, resultBytes] = await Promise.all([
    conflictStageBytes(root, 1, path),
    conflictStageBytes(root, 2, path),
    conflictStageBytes(root, 3, path),
    readFile(target).catch(() => new Uint8Array()),
  ]);
  const values = [baseBytes, oursBytes, theirsBytes, resultBytes].filter((value): value is Uint8Array => value !== null);
  const isBinary = values.some(isBinaryData);
  const decodeStage = (value: Uint8Array | null) => value === null ? null : isBinary ? "" : new TextDecoder().decode(value);
  return {
    path,
    base: decodeStage(baseBytes),
    ours: decodeStage(oursBytes),
    theirs: decodeStage(theirsBytes),
    result: isBinary ? "" : new TextDecoder().decode(resultBytes),
    isBinary,
  };
}

export async function saveConflictResolution(root: string, path: string, content: string): Promise<void> {
  const target = await safeWorktreePath(root, path);
  await writeFile(target, content);
  await stage(root, [path]);
}

export async function chooseConflictSide(root: string, path: string, side: "ours" | "theirs"): Promise<void> {
  await safeWorktreePath(root, path);
  await mustRun(root, ["checkout", `--${side}`, "--", path]);
  await stage(root, [path]);
}

export async function deleteConflictResolution(root: string, path: string): Promise<void> {
  await safeWorktreePath(root, path);
  await mustRun(root, ["rm", "--", path]);
}

async function conflictStageBytes(root: string, stage: 1 | 2 | 3, path: string): Promise<Uint8Array | null> {
  const proc = spawn(["git", "-C", root, "show", `:${stage}:${path}`], { stdout: "pipe", stderr: "ignore" });
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  return proc.exitCode === 0 ? bytes : null;
}

function isBinaryData(value: Uint8Array): boolean {
  if (value.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return false;
  } catch {
    return true;
  }
}

async function safeWorktreePath(root: string, path: string): Promise<string> {
  const rootPath = await realpath(root);
  const target = resolvePath(rootPath, path);
  if (target === rootPath || !target.startsWith(rootPath + sep)) throw new Error("Invalid repository path.");
  const parent = await realpath(dirname(target));
  if (parent !== rootPath && !parent.startsWith(rootPath + sep)) throw new Error("Repository path escapes through a symlink.");
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Conflict resolution for symlinks is not supported in the editor.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return target;
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

export async function compareRefs(root: string, base: string, head: string): Promise<ComparePayload> {
  await mustRun(root, ["rev-parse", "--verify", base]);
  await mustRun(root, ["rev-parse", "--verify", head]);
  const [counts, commits, changes] = await Promise.all([
    mustRun(root, ["rev-list", "--left-right", "--count", `${base}...${head}`]),
    log(root, { limit: 500, range: `${base}..${head}` }),
    mustRun(root, ["diff", "--no-color", "--unified=3", `${base}...${head}`]),
  ]);
  const [behind = 0, ahead = 0] = counts.trim().split(/\s+/).map(Number);
  return { base, head, ahead, behind, commits, files: parseCommitDiff(changes) };
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

export async function ignore(root: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const ignorePath = join(root, ".gitignore");
  const current = await readFile(ignorePath, "utf8").catch(() => "");
  const existing = new Set(current.split("\n"));
  const additions = paths.map(exactIgnorePattern).filter(pattern => !existing.has(pattern));
  if (!additions.length) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(ignorePath, current + prefix + additions.join("\n") + "\n");
}

function exactIgnorePattern(path: string): string {
  if (path.includes("\n") || path.includes("\r")) throw new Error("Paths containing newlines cannot be added to .gitignore.");
  return "/" + path.replace(/([\\*?\[\]])/g, "\\$1");
}

export async function stageHunk(root: string, patch: string, reverse: boolean, path?: string): Promise<void> {
  if (!reverse && path) {
    const tracked = await runGit(root, ["ls-files", "--error-unmatch", "--", path]);
    if (tracked.exitCode !== 0) await mustRun(root, ["add", "--intent-to-add", "--", path]);
  }
  const proc = spawn(["git", "-C", root, "apply", "--cached", "--unidiff-zero", ...(reverse ? ["--reverse"] : []), "-"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(patch);
  await proc.stdin.end();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(err.trim() || "git apply failed");
}

export async function commit(root: string, message: string, amend: boolean, signoff = false, sign = false): Promise<{ sha: string }> {
  await mustRun(root, ["commit", ...(amend ? ["--amend"] : []), ...(signoff ? ["--signoff"] : []), ...(sign ? ["--gpg-sign"] : []), "-m", message]);
  const sha = (await mustRun(root, ["rev-parse", "--short", "HEAD"])).trim();
  return { sha };
}

export async function commitContext(root: string): Promise<CommitContext> {
  const [ident, head, templatePath, signing] = await Promise.all([
    runGit(root, ["var", "GIT_AUTHOR_IDENT"]),
    runGit(root, ["log", "-1", "--format=%B"]),
    runGit(root, ["config", "--path", "--get", "commit.template"]),
    runGit(root, ["config", "--bool", "--get", "commit.gpgSign"]),
  ]);
  const match = ident.stdout.trim().match(/^(.*) <([^>]*)> \d+ [+-]\d+$/);
  const configuredPath = templatePath.stdout.trim();
  const template = configuredPath
    ? await readFile(resolvePath(root, configuredPath), "utf8").catch(() => null)
    : null;
  return {
    authorName: match?.[1] ?? "",
    authorEmail: match?.[2] ?? "",
    headMessage: head.exitCode === 0 ? head.stdout.trim() : "",
    template,
    signingEnabled: signing.stdout.trim() === "true",
  };
}

// One `for-each-ref` covers local branches, remote-tracking branches, and tags
// (the refs refresh used to spawn three processes for these). The superset
// format carries every field the three lists need; callers slice by refname
// prefix. Tag order keeps `git tag --list --sort=-creatordate` semantics via
// the explicit creatordate field.
export async function refsOf(root: string): Promise<{ branches: Branch[]; remoteBranches: RemoteBranch[]; tags: string[] }> {
  const fmt = ["%(refname)", "%(HEAD)", "%(upstream:short)", "%(upstream:track)", "%(objectname:short)", "%(symref)", "%(creatordate:unix)"].join("\t");
  const r = await mustRun(root, ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes", "refs/tags"]);
  const branches: Branch[] = [];
  const remoteBranches: RemoteBranch[] = [];
  const tagDates: { name: string; date: number }[] = [];
  for (const line of r.split("\n")) {
    if (!line) continue;
    const [ref = "", head = "", up = "", track = "", sha = "", symref = "", date = ""] = line.split("\t");
    if (ref.startsWith("refs/heads/")) {
      let ahead = 0, behind = 0;
      const am = track.match(/ahead (\d+)/);
      const bm = track.match(/behind (\d+)/);
      if (am) ahead = Number(am[1]);
      if (bm) behind = Number(bm[1]);
      branches.push({ name: ref.slice("refs/heads/".length), current: head === "*", upstream: up || null, ahead, behind });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      // Skip refs/remotes/<remote>/HEAD and other symrefs.
      if (!name || symref) continue;
      const slash = name.indexOf("/");
      if (slash < 1) continue;
      remoteBranches.push({ name, remote: name.slice(0, slash), branch: name.slice(slash + 1), sha });
    } else if (ref.startsWith("refs/tags/")) {
      tagDates.push({ name: ref.slice("refs/tags/".length), date: Number(date) || 0 });
    }
  }
  tagDates.sort((a, b) => b.date - a.date);
  return { branches, remoteBranches, tags: tagDates.map((t) => t.name) };
}

export async function branches(root: string): Promise<Branch[]> {
  return (await refsOf(root)).branches;
}

export async function remoteBranches(root: string): Promise<RemoteBranch[]> {
  return (await refsOf(root)).remoteBranches;
}

export async function fetchRemote(root: string, remote: string | null, prune: boolean): Promise<void> {
  await mustRunNetwork(root, ["fetch", ...(prune ? ["--prune"] : []), ...(remote ? [remote] : ["--all"])]);
}

export async function pull(root: string, strategy: "ff-only" | "merge" | "rebase"): Promise<void> {
  const flag = strategy === "ff-only" ? "--ff-only" : strategy === "rebase" ? "--rebase" : "--no-rebase";
  await mustRunNetwork(root, ["pull", flag]);
}

export async function operationAction(root: string, action: "continue" | "skip" | "abort"): Promise<void> {
  const operation = (await status(root)).operation;
  if (!operation) throw new Error("No merge, rebase, cherry-pick, or revert is in progress.");
  const command = operationCommand(operation.type, action);
  await mustRun(root, ["-c", "core.editor=true", command, `--${action}`]);
}

export async function bisect(root: string, action: "start" | "good" | "bad" | "skip" | "reset", good?: string, bad = "HEAD"): Promise<void> {
  if (action === "start") {
    if (!good) throw new Error("Choose a known-good commit to start bisect.");
    await mustRun(root, ["bisect", "start", bad, good]);
  } else {
    await mustRun(root, ["bisect", action]);
  }
}

export async function cherryPick(root: string, shas: string[]): Promise<void> {
  if (!shas.length) return;
  await mustRun(root, ["cherry-pick", ...shas]);
}

export async function revert(root: string, sha: string): Promise<void> {
  await mustRun(root, ["revert", "--no-edit", sha]);
}

export async function merge(root: string, ref: string, noFf = false): Promise<void> {
  await mustRun(root, ["merge", "--no-edit", ...(noFf ? ["--no-ff"] : []), ref]);
}

export async function rebase(root: string, ref: string): Promise<void> {
  await mustRun(root, ["rebase", ref]);
}

const MAX_INTERACTIVE_REBASE_COMMITS = 500;

async function interactiveRebaseShas(root: string, upstream: string): Promise<string[]> {
  await mustRun(root, ["rev-parse", "--verify", upstream]);
  // Plain `git rebase -i` flattens topology and does not put merge commits in
  // its todo. Mirror that set so we never serialize a merge as an invalid pick.
  const output = await mustRun(root, ["rev-list", "--reverse", "--no-merges", `${upstream}..HEAD`]);
  const shas = output.trim().split("\n").filter(Boolean);
  if (shas.length > MAX_INTERACTIVE_REBASE_COMMITS) {
    throw new Error(`Interactive rebase supports at most ${MAX_INTERACTIVE_REBASE_COMMITS} commits; ${shas.length} found. Choose a closer upstream.`);
  }
  return shas;
}

export async function rebasePlan(root: string, upstream: string): Promise<RebasePlan> {
  const shas = await interactiveRebaseShas(root, upstream);
  if (shas.length === 0) return { upstream, steps: [] };
  const entries = await log(root, { limit: shas.length, range: `${upstream}..HEAD`, noMerges: true });
  const bySha = new Map(entries.map(entry => [entry.fullSha, entry]));
  return {
    upstream,
    steps: shas.map(sha => {
      const entry = bySha.get(sha);
      if (!entry) throw new Error(`Unable to load rebase commit ${sha.slice(0, 7)}.`);
      return { sha, subject: entry.subject, action: "pick" };
    }),
  };
}

export async function interactiveRebase(root: string, upstream: string, steps: RebaseStep[]): Promise<string> {
  const expected = await interactiveRebaseShas(root, upstream);
  const supplied = steps.map(step => step.sha);
  if (expected.length === 0) throw new Error(`No commits to rebase onto ${upstream}.`);
  if (supplied.length !== expected.length || new Set(supplied).size !== expected.length || expected.some(sha => !supplied.includes(sha))) {
    throw new Error("Rebase plan must contain every commit exactly once.");
  }
  if (steps[0]?.action !== "pick" || steps.some(step => !["pick", "squash", "fixup"].includes(step.action))) {
    throw new Error("The first commit must be picked; supported actions are pick, squash, and fixup.");
  }
  const head = (await mustRun(root, ["rev-parse", "HEAD"])).trim();
  const safetyRef = `refs/tabterm/safety/${Date.now()}-${head.slice(0, 7)}`;
  await mustRun(root, ["update-ref", safetyRef, head]);
  const temp = await mkdtemp(join(tmpdir(), "tabterm-rebase-"));
  try {
    const todo = join(temp, "todo");
    const editor = join(temp, "sequence-editor.sh");
    await writeFile(todo, steps.map(step => `${step.action} ${step.sha} ${step.subject.replace(/[\r\n]/g, " ")}`).join("\n") + "\n");
    await writeFile(editor, "#!/bin/sh\ncp \"$TABTERM_REBASE_TODO\" \"$1\"\n");
    await chmod(editor, 0o700);
    const result = await runGit(root, ["rebase", "-i", upstream], {
      GIT_SEQUENCE_EDITOR: editor,
      GIT_EDITOR: "true",
      TABTERM_REBASE_TODO: todo,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Interactive rebase stopped.");
    return safetyRef;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function reflog(root: string, limit = 200): Promise<ReflogEntry[]> {
  const fmt = ["%gd", "%h", "%H", "%gs", "%ct"].join("%x1f");
  const r = await runGit(root, ["reflog", "show", `-n${limit}`, `--format=${fmt}%x1e`]);
  if (r.exitCode !== 0) return [];
  return r.stdout.split("\x1e").flatMap(record => {
    const value = record.trim();
    if (!value) return [];
    const [selector = "", sha = "", fullSha = "", subject = "", timestamp = ""] = value.split("\x1f");
    const colon = subject.indexOf(":");
    return [{
      selector,
      sha,
      fullSha,
      action: colon >= 0 ? subject.slice(0, colon) : subject,
      message: colon >= 0 ? subject.slice(colon + 1).trim() : "",
      at: Number(timestamp) * 1000,
    }];
  });
}

export async function resetTo(root: string, ref: string, mode: "soft" | "mixed"): Promise<string> {
  if (mode !== "soft" && mode !== "mixed") throw new Error("Only soft and mixed reset are supported; both preserve working-tree files.");
  await mustRun(root, ["rev-parse", "--verify", ref]);
  const head = (await mustRun(root, ["rev-parse", "HEAD"])).trim();
  const safetyRef = `refs/tabterm/safety/${Date.now()}-${head.slice(0, 7)}`;
  await mustRun(root, ["update-ref", safetyRef, head]);
  await mustRun(root, ["reset", `--${mode}`, ref]);
  return safetyRef;
}

export async function recoverBranch(root: string, ref: string): Promise<string> {
  const sha = (await mustRun(root, ["rev-parse", "--verify", ref])).trim();
  const base = `recovery/${sha.slice(0, 7)}`;
  let name = base;
  let suffix = 2;
  while ((await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).exitCode === 0) name = `${base}-${suffix++}`;
  await mustRun(root, ["branch", name, sha]);
  return name;
}

export async function worktrees(root: string): Promise<Worktree[]> {
  const r = await mustRun(root, ["worktree", "list", "--porcelain", "-z"]);
  return r.split("\0\0").flatMap(record => {
    const fields = record.split("\0").filter(Boolean);
    const path = valueFor(fields, "worktree ");
    if (!path) return [];
    const branchRef = valueFor(fields, "branch ");
    return [{
      path,
      head: valueFor(fields, "HEAD "),
      branch: branchRef?.replace(/^refs\/heads\//, "") ?? null,
      bare: fields.includes("bare"),
      detached: fields.includes("detached"),
      locked: valueFor(fields, "locked ") ?? (fields.includes("locked") ? "" : null),
      prunable: valueFor(fields, "prunable ") ?? (fields.includes("prunable") ? "" : null),
    }];
  });
}

function valueFor(fields: string[], prefix: string): string | null {
  const field = fields.find(value => value.startsWith(prefix));
  return field ? field.slice(prefix.length) : null;
}

export async function worktreeAdd(root: string, path: string, ref: string, newBranch: string | null): Promise<void> {
  await mustRun(root, ["worktree", "add", ...(newBranch ? ["-b", newBranch] : []), path, ref]);
}

export async function worktreeRemove(root: string, path: string): Promise<void> {
  await mustRun(root, ["worktree", "remove", path]);
}

export async function worktreeLock(root: string, path: string, lock: boolean, reason?: string): Promise<void> {
  await mustRun(root, ["worktree", lock ? "lock" : "unlock", ...(lock && reason ? ["--reason", reason] : []), path]);
}

export async function worktreePrune(root: string): Promise<void> {
  await mustRun(root, ["worktree", "prune"]);
}

export async function fileInsight(root: string, path: string): Promise<FileInsightPayload> {
  const [blameResult, history] = await Promise.all([
    runGit(root, ["blame", "--line-porcelain", "--", path]),
    log(root, { limit: 500, path }),
  ]);
  return { path, blame: blameResult.exitCode === 0 ? parseBlame(blameResult.stdout) : [], history };
}

export function parseBlame(output: string): BlameLine[] {
  const lines = output.split("\n");
  const result: BlameLine[] = [];
  for (let index = 0; index < lines.length;) {
    const header = lines[index]?.match(/^([0-9a-f^]{40}) \d+ (\d+)(?: \d+)?$/);
    if (!header) { index++; continue; }
    const sha = header[1]!.replace(/^\^/, "");
    const line = Number(header[2]);
    let author = "", authorEmail = "", authoredAt = 0, summary = "", content = "";
    index++;
    while (index < lines.length && !lines[index]!.startsWith("\t")) {
      const value = lines[index++]!;
      if (value.startsWith("author ")) author = value.slice(7);
      else if (value.startsWith("author-mail ")) authorEmail = value.slice(12).replace(/^<|>$/g, "");
      else if (value.startsWith("author-time ")) authoredAt = Number(value.slice(12)) * 1000;
      else if (value.startsWith("summary ")) summary = value.slice(8);
    }
    if (lines[index]?.startsWith("\t")) content = lines[index++]!.slice(1);
    result.push({ line, sha, author, authorEmail, authoredAt, summary, content });
  }
  return result;
}

function operationCommand(type: GitOperationType, action: "continue" | "skip" | "abort"): string {
  if (type === "bisect") throw new Error("Use the bisect controls to mark the current commit or end the bisect.");
  if (action === "skip" && type === "merge") throw new Error("A merge cannot skip a commit. Resolve it or abort the merge.");
  return type;
}

export async function checkout(root: string, name: string): Promise<void> {
  await mustRun(root, ["checkout", name]);
}

export async function checkoutRemote(root: string, name: string, localName: string): Promise<void> {
  const local = await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${localName}`]);
  if (local.exitCode === 0) await mustRun(root, ["checkout", localName]);
  else await mustRun(root, ["checkout", "--track", "-b", localName, name]);
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
  const r = await runNetworkGit(root, args);
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

export async function stashCreate(root: string, message: string, opts: { includeUntracked?: boolean; keepIndex?: boolean; stagedOnly?: boolean } = {}): Promise<void> {
  await mustRun(root, ["stash", "push", ...(message ? ["-m", message] : []), ...(opts.includeUntracked ? ["--include-untracked"] : []), ...(opts.keepIndex ? ["--keep-index"] : []), ...(opts.stagedOnly ? ["--staged"] : [])]);
}

export async function stashApply(root: string, index: number, pop: boolean): Promise<void> {
  await mustRun(root, ["stash", pop ? "pop" : "apply", `stash@{${index}}`]);
}

export async function stashDrop(root: string, index: number): Promise<void> {
  await mustRun(root, ["stash", "drop", `stash@{${index}}`]);
}

export async function stashDiff(root: string, index: number): Promise<DiffPayload[]> {
  const output = await mustRun(root, ["stash", "show", "--patch", "--include-untracked", `stash@{${index}}`]);
  return parseCommitDiff(output);
}

export async function tags(root: string): Promise<string[]> {
  return (await refsOf(root)).tags;
}

export async function tagCreate(root: string, name: string, message: string, push: boolean): Promise<void> {
  await mustRun(root, message ? ["tag", "-a", name, "-m", message] : ["tag", name]);
  if (push) await mustRun(root, ["push", "origin", name]);
}

export async function tagDelete(root: string, name: string, remote: boolean): Promise<void> {
  await mustRun(root, ["tag", "-d", name]);
  if (remote) await mustRun(root, ["push", "origin", "--delete", name]);
}

export async function log(root: string, opts: { limit?: number; all?: boolean; range?: string; path?: string; noMerges?: boolean } = {}): Promise<LogEntry[]> {
  const limit = opts.limit ?? 200;
  // Custom record sep \x1e + field sep \x1f keep subject + refs intact.
  const fmt = ["%h", "%H", "%P", "%an", "%ae", "%at", "%cn", "%ct", "%s", "%b", "%D", "%G?"].join("%x1f");
  const r = await runGit(root, ["log", ...(opts.all ? ["--all"] : []), ...(opts.noMerges ? ["--no-merges"] : []), `-n${limit}`, "--date-order", "--no-color", `--pretty=format:${fmt}%x1e`, ...(opts.range ? [opts.range] : []), ...(opts.path ? ["--follow", "--", opts.path] : [])]);
  if (r.exitCode !== 0) return [];
  const out: LogEntry[] = [];
  for (const rec of r.stdout.split("\x1e")) {
    const t = rec.trim();
    if (!t) continue;
    const [sha, fullSha, parents, author, email, authoredTs, committer, committedTs, subject, body, refs, signature] = t.split("\x1f");
    out.push({
      sha: sha ?? "",
      fullSha: fullSha ?? "",
      parents: (parents ?? "").split(" ").filter(Boolean).map(p => p.slice(0, 7)),
      author: author ?? "",
      authorEmail: email ?? "",
      authoredAt: Number(authoredTs) * 1000,
      committer: committer ?? "",
      committedAt: Number(committedTs) * 1000,
      subject: subject ?? "",
      body: body?.trim() ?? "",
      refs: (refs ?? "").split(",").map(s => s.trim()).filter(Boolean),
      signature: (signature || "N") as LogEntry["signature"],
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

export async function submoduleUpdateRemote(root: string, path: string): Promise<void> {
  await mustRunNetwork(root, ["submodule", "update", "--init", "--remote", "--", path]);
}

export async function subtreeSync(root: string, subtree: { prefix: string; remoteUrl: string; branch: string; squash: boolean }, direction: "pull" | "push"): Promise<string> {
  for (const value of [subtree.prefix, subtree.remoteUrl, subtree.branch]) {
    if (!value || value.startsWith("-")) throw new Error("Invalid subtree configuration.");
  }
  const squash = subtree.squash ? ["--squash"] : [];
  if (direction === "push") {
    await mustRunNetwork(root, ["subtree", "push", `--prefix=${subtree.prefix}`, subtree.remoteUrl, subtree.branch]);
  } else if (await exists(join(root, subtree.prefix))) {
    await mustRunNetwork(root, ["subtree", "pull", `--prefix=${subtree.prefix}`, subtree.remoteUrl, subtree.branch, ...squash]);
  } else {
    await mustRunNetwork(root, ["subtree", "add", `--prefix=${subtree.prefix}`, subtree.remoteUrl, subtree.branch, ...squash]);
  }
  return (await mustRun(root, ["rev-parse", "HEAD"])).trim();
}
