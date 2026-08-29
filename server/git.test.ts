import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { resolveRoot, initRepository, status, runGit, diff, conflictFile, saveConflictResolution, chooseConflictSide, commitDiff, compareRefs, fileInsight, stage, stageHunk, unstage, discard, ignore, commit, commitContext, branches, remoteBranches, checkout, branchCreate, branchDelete, merge, rebase, rebasePlan, interactiveRebase, cherryPick, revert, bisect, reflog, resetTo, recoverBranch, worktrees, worktreeAdd, worktreeRemove, worktreeLock, stashes, stashCreate, stashDiff, stashDrop, log, tags, tagCreate, remotes, remoteAdd, remoteUpdate, remoteRemove, submodules, subtreeSync, fetchRemote, pull, push, operationAction } from "./git.ts";
import { serializeSelectedLines } from "../src/git/patch.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tabterm-git-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "README.md"), "hi\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("git.ts: resolveRoot + status", () => {
  let root: string;
  beforeAll(async () => { root = await makeRepo(); });

  test("resolveRoot in a repo returns the toplevel", async () => {
    expect(await resolveRoot(root)).toBe(root);
  });

  test("resolveRoot outside a repo returns null", async () => {
    const d = await mkdtemp(join(tmpdir(), "tabterm-norepo-"));
    expect(await resolveRoot(d)).toBeNull();
    await rm(d, { recursive: true, force: true });
  });

  test("initRepository creates an empty main-branch repository", async () => {
    const d = await mkdtemp(join(tmpdir(), "tabterm-init-"));
    expect(await initRepository(d)).toBe(d);
    const snap = await status(d);
    expect(snap.branch).toBe("main");
    expect(snap.headSha).toBeNull();
    expect(await initRepository(d)).toBe(d);
    await rm(d, { recursive: true, force: true });
  });

  test("status: clean repo on a branch", async () => {
    const snap = await status(root);
    expect(snap.branch).toBe("main");
    expect(snap.detached).toBe(false);
    expect(snap.files).toEqual([]);
    expect(snap.staged).toEqual([]);
  });

  test("status: untracked + modified + staged", async () => {
    await writeFile(join(root, "README.md"), "hi\nchanged\n");
    await writeFile(join(root, "new.txt"), "n\n");
    await git(root, "add", "new.txt");
    const snap = await status(root);
    const codes = (xs: typeof snap.files) => xs.map(f => `${f.code} ${f.path}${f.staged ? " S" : ""}`).sort();
    expect(codes(snap.files)).toEqual(["M README.md"]);
    expect(codes(snap.staged)).toEqual(["A new.txt S"]);
  });

  test("runGit captures stdout and exit code", async () => {
    const r = await runGit(root, ["status", "--porcelain"]);
    expect(r.exitCode).toBe(0);
    expect(typeof r.stdout).toBe("string");
  });
});

describe("git.ts: diff", () => {
  test("unstaged diff returns hunks with +/-/space lines", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "README.md"), "hi\nadded\n");
    const d = await diff(root, "README.md", false);
    expect(d.path).toBe("README.md");
    expect(d.staged).toBe(false);
    expect(d.isBinary).toBe(false);
    expect(d.hunks.length).toBeGreaterThan(0);
    const kinds = d.hunks[0]!.lines.map(l => l.kind).join("");
    expect(kinds).toMatch(/\+/);
  });

  test("diff flags a no-newline-at-eof line", async () => {
    const root = await makeRepo();
    // Committed README.md ends in "\n"; rewrite it without a trailing newline.
    await writeFile(join(root, "README.md"), "hi\nno-eol");
    const d = await diff(root, "README.md", false);
    const lines = d.hunks.flatMap(h => h.lines);
    expect(lines.some(l => l.noNewline)).toBe(true);
  });

  test("unstaged diff excludes changes already staged in the same file", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\n");
    await git(root, "add", "lines.txt");
    await git(root, "commit", "-q", "-m", "add lines");

    await writeFile(join(root, "lines.txt"), "ONE\ntwo\nthree\n");
    await git(root, "add", "lines.txt");
    await writeFile(join(root, "lines.txt"), "ONE\nTWO\nthree\n");

    const staged = await diff(root, "lines.txt", true);
    const unstaged = await diff(root, "lines.txt", false);
    const text = (d: typeof staged) => d.hunks.flatMap(h => h.lines.map(l => `${l.kind}${l.src}`)).join("\n");
    expect(text(staged)).toContain("+ONE");
    expect(text(staged)).not.toContain("+TWO");
    expect(text(unstaged)).toContain("+TWO");
    expect(text(unstaged)).not.toContain("+ONE");
  });

  test("stages one selected line without staging another change in the hunk", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour\nfive\n");
    await git(root, "add", "lines.txt");
    await git(root, "commit", "-q", "-m", "add lines");
    await writeFile(join(root, "lines.txt"), "ONE\ntwo\nthree\nFOUR\nfive\n");
    const change = await diff(root, "lines.txt", false);
    const hunk = change.hunks[0]!;
    const line = hunk.lines.findIndex(item => item.kind === "+" && item.src === "ONE");
    const patch = serializeSelectedLines(hunk, "lines.txt", new Set([line]));
    expect(patch).not.toBeNull();

    await stageHunk(root, patch!, false, "lines.txt");

    const stagedText = (await diff(root, "lines.txt", true)).hunks.flatMap(h => h.lines.map(l => `${l.kind}${l.src}`)).join("\n");
    const unstagedText = (await diff(root, "lines.txt", false)).hunks.flatMap(h => h.lines.map(l => `${l.kind}${l.src}`)).join("\n");
    expect(stagedText).toContain("+ONE");
    expect(stagedText).not.toContain("+FOUR");
    expect(unstagedText).toContain("+FOUR");
    expect(unstagedText).not.toContain("+ONE");
  });
});

describe("git.ts: operation state", () => {
  test("status reports conflicted files and an in-progress merge", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "topic");
    await writeFile(join(root, "README.md"), "topic\n");
    await git(root, "commit", "-q", "-am", "topic change");
    await git(root, "checkout", "-q", "main");
    await writeFile(join(root, "README.md"), "main\n");
    await git(root, "commit", "-q", "-am", "main change");

    const merge = await runGit(root, ["merge", "topic"]);
    expect(merge.exitCode).not.toBe(0);

    const snap = await status(root);
    expect(snap.operation).toEqual({ type: "merge", current: null, total: null });
    expect(snap.files).toContainEqual(expect.objectContaining({
      path: "README.md",
      code: "U",
      conflict: "UU",
    }));
  });

  test("continues a merge after its resolution is staged", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "topic");
    await writeFile(join(root, "README.md"), "topic\n");
    await git(root, "commit", "-q", "-am", "topic change");
    await git(root, "checkout", "-q", "main");
    await writeFile(join(root, "README.md"), "main\n");
    await git(root, "commit", "-q", "-am", "main change");
    expect((await runGit(root, ["merge", "topic"])).exitCode).not.toBe(0);
    await writeFile(join(root, "README.md"), "main and topic\n");
    await stage(root, ["README.md"]);

    await operationAction(root, "continue");

    expect((await status(root)).operation).toBeNull();
    expect((await runGit(root, ["log", "-1", "--pretty=%P"])).stdout.trim().split(" ")).toHaveLength(2);
  });

  test("reads three conflict stages and saves the resolution", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "topic");
    await writeFile(join(root, "README.md"), "topic\n");
    await git(root, "commit", "-q", "-am", "topic change");
    await git(root, "checkout", "-q", "main");
    await writeFile(join(root, "README.md"), "main\n");
    await git(root, "commit", "-q", "-am", "main change");
    expect((await runGit(root, ["merge", "topic"])).exitCode).not.toBe(0);

    const conflict = await conflictFile(root, "README.md");
    expect(conflict.base).toBe("hi\n");
    expect(conflict.ours).toBe("main\n");
    expect(conflict.theirs).toBe("topic\n");
    expect(conflict.result).toContain("<<<<<<< HEAD");

    await saveConflictResolution(root, "README.md", "resolved\n");
    const snap = await status(root);
    expect(snap.files.find(f => f.code === "U")).toBeUndefined();
    expect(snap.staged).toContainEqual(expect.objectContaining({ path: "README.md" }));
  });

  test("chooses a binary conflict side without decoding or changing bytes", async () => {
    const root = await makeRepo();
    const base = new Uint8Array([0, 1, 2, 3]);
    const ours = new Uint8Array([0, 255, 4, 5]);
    const theirs = new Uint8Array([0, 128, 6, 7]);
    await writeFile(join(root, "asset.bin"), base);
    await git(root, "add", "asset.bin");
    await git(root, "commit", "-q", "-m", "add binary");
    await git(root, "checkout", "-q", "-b", "topic");
    await writeFile(join(root, "asset.bin"), theirs);
    await git(root, "commit", "-q", "-am", "topic binary");
    await git(root, "checkout", "-q", "main");
    await writeFile(join(root, "asset.bin"), ours);
    await git(root, "commit", "-q", "-am", "main binary");
    expect((await runGit(root, ["merge", "topic"])).exitCode).not.toBe(0);

    const conflict = await conflictFile(root, "asset.bin");
    expect(conflict.isBinary).toBe(true);
    expect(conflict.ours).toBe("");
    expect(conflict.theirs).toBe("");

    await chooseConflictSide(root, "asset.bin", "theirs");
    expect([...await readFile(join(root, "asset.bin"))]).toEqual([...theirs]);
    const snap = await status(root);
    expect(snap.files.find(file => file.code === "U")).toBeUndefined();
    expect(snap.staged).toContainEqual(expect.objectContaining({ path: "asset.bin" }));
  });
});

describe("git.ts: commitDiff", () => {
  test("returns one DiffPayload per changed file with +/- lines", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "a.txt"), "alpha\n");
    await writeFile(join(root, "b.txt"), "beta\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "add a and b");
    const sha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();

    const files = await commitDiff(root, sha);
    expect(files.map(f => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    for (const f of files) {
      expect(f.isBinary).toBe(false);
      const kinds = f.hunks.flatMap(h => h.lines).map(l => l.kind).join("");
      expect(kinds).toContain("+");
    }
  });

  test("a merge commit yields no textual diff (git's default)", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "feat");
    await writeFile(join(root, "f.txt"), "f\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "feat work");
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    const sha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();

    expect(await commitDiff(root, sha)).toEqual([]);
  });
});

describe("git.ts: mutations", () => {
  test("stage then unstage round-trips", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "x.txt"), "x\n");
    await stage(root, ["x.txt"]);
    expect((await status(root)).staged.map(f => f.path)).toEqual(["x.txt"]);
    await unstage(root, ["x.txt"]);
    expect((await status(root)).staged).toEqual([]);
  });
  test("commit creates a new HEAD", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "x.txt"), "x\n");
    await stage(root, ["x.txt"]);
    const r = await commit(root, "add x", false);
    expect(r.sha).toMatch(/^[0-9a-f]{7}/);
    expect((await status(root)).files).toEqual([]);
  });
  test("commit can add a Signed-off-by trailer", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "x.txt"), "x\n");
    await stage(root, ["x.txt"]);
    await commit(root, "add x", false, true);
    const message = (await runGit(root, ["log", "-1", "--pretty=%B"])).stdout;
    expect(message).toContain("Signed-off-by: t <t@t>");
  });
  test("commit context returns identity, HEAD message, template, and signing preference", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".commit-template"), "Template summary\n\nTemplate body\n");
    await git(root, "config", "commit.template", ".commit-template");
    await git(root, "config", "commit.gpgSign", "true");
    const context = await commitContext(root);
    expect(context).toEqual({
      authorName: "t",
      authorEmail: "t@t",
      headMessage: "init",
      template: "Template summary\n\nTemplate body\n",
      signingEnabled: true,
    });
  });
  test("discard reverts a working-tree change", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "README.md"), "hi\nbad\n");
    await discard(root, ["README.md"]);
    const snap = await status(root);
    expect(snap.files).toEqual([]);
  });
  test("ignore adds exact root-relative patterns without duplicates", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "debug[1].log"), "noise\n");
    await ignore(root, ["debug[1].log"]);
    await ignore(root, ["debug[1].log"]);
    const contents = await Bun.file(join(root, ".gitignore")).text();
    expect(contents).toBe("/debug\\[1\\].log\n");
    expect((await status(root)).files.map(f => f.path)).toEqual([".gitignore"]);
  });
});

describe("git.ts: branches", () => {
  test("create, list, checkout, delete", async () => {
    const root = await makeRepo();
    await branchCreate(root, "feat/x", null, false);
    let bs = await branches(root);
    expect(bs.map(b => b.name).sort()).toEqual(["feat/x", "main"]);
    expect(bs.find(b => b.current)!.name).toBe("main");
    await checkout(root, "feat/x");
    bs = await branches(root);
    expect(bs.find(b => b.current)!.name).toBe("feat/x");
    await checkout(root, "main");
    await branchDelete(root, "feat/x", false);
    expect(await branches(root)).toHaveLength(1);
  });

  test("create from a base ref without switching", async () => {
    const root = await makeRepo();
    await branchCreate(root, "feat/y", "main", false);
    const bs = await branches(root);
    expect(bs.map(b => b.name).sort()).toEqual(["feat/y", "main"]);
    expect(bs.find(b => b.current)!.name).toBe("main");
  });

  test("create from a base ref and check out", async () => {
    const root = await makeRepo();
    await branchCreate(root, "feat/z", "main", true);
    const bs = await branches(root);
    expect(bs.find(b => b.current)!.name).toBe("feat/z");
  });

  test("merges another branch into the current branch", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "topic");
    await writeFile(join(root, "topic.txt"), "topic\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "topic");
    await git(root, "checkout", "-q", "main");
    await merge(root, "topic");
    expect((await runGit(root, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("topic");
  });

  test("rebases current commits onto another branch", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "base");
    await writeFile(join(root, "base.txt"), "base\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "base");
    await git(root, "checkout", "-q", "main");
    await writeFile(join(root, "main.txt"), "main\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "main work");
    await rebase(root, "base");
    expect((await runGit(root, ["merge-base", "--is-ancestor", "base", "main"])).exitCode).toBe(0);
  });

  test("cherry-picks and reverts a commit", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "topic");
    await writeFile(join(root, "picked.txt"), "picked\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "pick me");
    const sha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, "checkout", "-q", "main");
    await cherryPick(root, [sha]);
    expect((await status(root)).files).toEqual([]);
    const picked = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await revert(root, picked);
    expect((await runGit(root, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe('Revert "pick me"');
  });

  test("compares divergent refs with counts, commits, and files", async () => {
    const root = await makeRepo();
    await git(root, "checkout", "-q", "-b", "topic");
    await writeFile(join(root, "topic.txt"), "topic\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "topic work");
    await git(root, "checkout", "-q", "main");
    await writeFile(join(root, "main.txt"), "main\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "main work");

    const comparison = await compareRefs(root, "topic", "main");

    expect(comparison.ahead).toBe(1);
    expect(comparison.behind).toBe(1);
    expect(comparison.commits.map(entry => entry.subject)).toEqual(["main work"]);
    expect(comparison.files.map(file => file.path)).toEqual(["main.txt"]);
  });
});

describe("git.ts: stashes/tags/log", () => {
  test("log returns commits oldest-last", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "a.txt"), "a\n");
    await stage(root, ["a.txt"]);
    await commit(root, "add a", false);
    const entries = await log(root);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]!.subject).toBe("add a");
    expect(entries[0]!.parents.length).toBe(1);
  });

  test("stash create/list/drop round-trips", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "README.md"), "hi\nmore\n");
    await stashCreate(root, "wip");
    const s = await stashes(root);
    expect(s).toHaveLength(1);
    expect(s[0]!.index).toBe(0);
    await stashDrop(root, 0);
    expect(await stashes(root)).toEqual([]);
  });

  test("stash can include untracked files and exposes a diff", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "README.md"), "changed\n");
    await writeFile(join(root, "untracked.txt"), "new\n");
    await stashCreate(root, "with untracked", { includeUntracked: true });
    expect((await status(root)).files).toEqual([]);
    expect((await stashDiff(root, 0)).map(file => file.path).sort()).toEqual(["README.md", "untracked.txt"]);
  });

  test("tags is empty in a fresh repo", async () => {
    const root = await makeRepo();
    expect(await tags(root)).toEqual([]);
  });

  test("tagCreate makes lightweight and annotated tags", async () => {
    const root = await makeRepo();
    await tagCreate(root, "v1.0.0", "", false);
    await tagCreate(root, "v1.1.0", "release one one", false);
    const ts = await tags(root);
    expect(ts).toContain("v1.0.0");
    expect(ts).toContain("v1.1.0");
    // annotated tag carries its own message; lightweight does not
    const lw = await runGit(root, ["for-each-ref", "--format=%(objecttype)", "refs/tags/v1.0.0"]);
    const an = await runGit(root, ["for-each-ref", "--format=%(objecttype)", "refs/tags/v1.1.0"]);
    expect(lw.stdout.trim()).toBe("commit");
    expect(an.stdout.trim()).toBe("tag");
  });
});

describe("git.ts: recovery", () => {
  test("mixed reset preserves files, creates a safety ref, and remains recoverable", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "recover.txt"), "recover me\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "recoverable work");
    const originalHead = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();

    const safetyRef = await resetTo(root, "HEAD^", "mixed");

    expect(await Bun.file(join(root, "recover.txt")).text()).toBe("recover me\n");
    expect((await runGit(root, ["rev-parse", safetyRef])).stdout.trim()).toBe(originalHead);
    const branch = await recoverBranch(root, originalHead);
    expect((await runGit(root, ["rev-parse", branch])).stdout.trim()).toBe(originalHead);
    expect((await reflog(root)).some(entry => entry.action.includes("reset"))).toBe(true);
  });

  test("rejects destructive reset modes at runtime", async () => {
    const root = await makeRepo();
    await expect(resetTo(root, "HEAD", "hard" as any)).rejects.toThrow(/Only soft and mixed/);
  });
});

describe("git.ts: interactive rebase", () => {
  test("fixups a commit while preserving every planned commit and a safety ref", async () => {
    const root = await makeRepo();
    for (const name of ["one", "two", "three"]) {
      await writeFile(join(root, `${name}.txt`), `${name}\n`);
      await git(root, "add", ".");
      await git(root, "commit", "-q", "-m", name);
    }
    const upstream = (await runGit(root, ["rev-parse", "HEAD~3"])).stdout.trim();
    const oldHead = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    const plan = await rebasePlan(root, upstream);
    plan.steps[1] = { ...plan.steps[1]!, action: "fixup" };

    const safetyRef = await interactiveRebase(root, upstream, plan.steps);

    expect((await runGit(root, ["rev-list", "--count", `${upstream}..HEAD`])).stdout.trim()).toBe("2");
    expect((await runGit(root, ["log", "--format=%s", `${upstream}..HEAD`])).stdout.trim().split("\n")).toEqual(["three", "one"]);
    expect((await runGit(root, ["rev-parse", safetyRef])).stdout.trim()).toBe(oldHead);
  });

  test("rejects a plan that omits a commit", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "one.txt"), "one\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "one");
    const plan = await rebasePlan(root, "HEAD^");
    await expect(interactiveRebase(root, "HEAD^", [])).rejects.toThrow(/every commit exactly once/);
    expect(plan.steps).toHaveLength(1);
  });
});

describe("git.ts: bisect", () => {
  test("starts and resets a bisect session reflected in operation state", async () => {
    const root = await makeRepo();
    for (const name of ["middle", "bad"]) {
      await writeFile(join(root, `${name}.txt`), `${name}\n`);
      await git(root, "add", ".");
      await git(root, "commit", "-q", "-m", name);
    }
    await bisect(root, "start", "HEAD~2", "HEAD");
    expect((await status(root)).operation?.type).toBe("bisect");
    await bisect(root, "reset");
    expect((await status(root)).operation).toBeNull();
    expect((await runGit(root, ["branch", "--show-current"])).stdout.trim()).toBe("main");
  });
});

describe("git.ts: file insight", () => {
  test("returns line blame metadata and file history", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "README.md"), "hi\nsecond\n");
    await git(root, "commit", "-q", "-am", "add second line");
    const insight = await fileInsight(root, "README.md");
    expect(insight.path).toBe("README.md");
    expect(insight.blame).toHaveLength(2);
    expect(insight.blame[1]).toEqual(expect.objectContaining({ line: 2, author: "t", summary: "add second line", content: "second" }));
    expect(insight.history.map(entry => entry.subject)).toEqual(["add second line", "init"]);
  });
});

describe("git.ts: worktrees", () => {
  test("adds, lists, locks, unlocks, and removes a clean worktree", async () => {
    const root = await makeRepo();
    const parent = await mkdtemp(join(tmpdir(), "tabterm-worktree-parent-"));
    const path = join(parent, "topic");
    await worktreeAdd(root, path, "HEAD", "topic");
    const resolvedPath = await realpath(path);
    expect(await worktrees(root)).toContainEqual(expect.objectContaining({ path: resolvedPath, branch: "topic", locked: null }));
    await worktreeLock(root, resolvedPath, true, "test lock");
    expect((await worktrees(root)).find(item => item.path === resolvedPath)?.locked).toBe("test lock");
    await worktreeLock(root, resolvedPath, false);
    await worktreeRemove(root, resolvedPath);
    expect((await worktrees(root)).map(item => item.path)).toEqual([await realpath(root)]);
  });
});

describe("git.ts: subtrees", () => {
  test("adds a missing subtree then pulls later remote changes", async () => {
    const remote = await makeRepo();
    await writeFile(join(remote, "library.txt"), "v1\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-q", "-m", "library v1");
    const root = await makeRepo();
    const mapping = { prefix: "vendor/library", remoteUrl: remote, branch: "main", squash: true };

    await subtreeSync(root, mapping, "pull");
    expect(await Bun.file(join(root, "vendor/library/library.txt")).text()).toBe("v1\n");

    await writeFile(join(remote, "library.txt"), "v2\n");
    await git(remote, "commit", "-q", "-am", "library v2");
    await subtreeSync(root, mapping, "pull");
    expect(await Bun.file(join(root, "vendor/library/library.txt")).text()).toBe("v2\n");
  });
});

describe("git.ts: remotes/submodules", () => {
  test("remoteAdd then list", async () => {
    const root = await makeRepo();
    await remoteAdd(root, "origin", "https://example.com/repo.git");
    const r = await remotes(root);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe("origin");
    expect(r[0]!.fetchUrl).toContain("example.com");
  });
  test("remoteUpdate sets push URL separately", async () => {
    const root = await makeRepo();
    await remoteAdd(root, "origin", "https://example.com/a.git");
    await remoteUpdate(root, "origin", "origin", "https://example.com/a.git", "https://example.com/b.git");
    const r = await remotes(root);
    expect(r[0]!.pushUrl).toContain("b.git");
  });
  test("remoteUpdate renames a remote", async () => {
    const root = await makeRepo();
    await remoteAdd(root, "origin", "https://example.com/a.git");
    await remoteUpdate(root, "origin", "upstream", "https://example.com/a.git", null);
    const r = await remotes(root);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe("upstream");
    expect(r[0]!.fetchUrl).toContain("a.git");
  });
  test("remoteRemove removes", async () => {
    const root = await makeRepo();
    await remoteAdd(root, "origin", "x");
    await remoteRemove(root, "origin");
    expect(await remotes(root)).toEqual([]);
  });
  test("submodules empty in fresh repo", async () => {
    const root = await makeRepo();
    expect(await submodules(root)).toEqual([]);
  });
});

describe("git.ts: push", () => {
  // A bare repo acts as the "remote"; clone it so origin is wired up.
  async function makeRepoWithRemote(): Promise<{ work: string; bare: string }> {
    const bare = await mkdtemp(join(tmpdir(), "tabterm-bare-"));
    await git(bare, "init", "-q", "--bare", "-b", "main");
    const work = await mkdtemp(join(tmpdir(), "tabterm-work-"));
    await git(work, "clone", "-q", bare, ".");
    await git(work, "config", "user.email", "t@t");
    await git(work, "config", "user.name", "t");
    await writeFile(join(work, "README.md"), "hi\n");
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", "init");
    return { work, bare };
  }

  async function remoteHas(bare: string, ref: string): Promise<boolean> {
    const r = await runGit(bare, ["rev-parse", "--verify", "-q", ref]);
    return r.exitCode === 0;
  }

  test("push with setUpstream publishes a new branch to the remote", async () => {
    const { work, bare } = await makeRepoWithRemote();
    await git(work, "checkout", "-q", "-b", "feature");
    await writeFile(join(work, "f.txt"), "x\n");
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", "feat");

    await push(work, "feature", "origin", true);

    expect(await remoteHas(bare, "refs/heads/feature")).toBe(true);
    // upstream is now set: branches() reports it.
    const b = (await branches(work)).find(x => x.name === "feature");
    expect(b?.upstream).toBe("origin/feature");
  });

  test("push without setUpstream pushes commits to an existing upstream", async () => {
    const { work, bare } = await makeRepoWithRemote();
    await git(work, "push", "-q", "-u", "origin", "main");
    await writeFile(join(work, "README.md"), "hi\nmore\n");
    await git(work, "commit", "-q", "-am", "more");

    await push(work, "main", "origin", false);

    const r = await runGit(bare, ["log", "-1", "--pretty=%s", "main"]);
    expect(r.stdout.trim()).toBe("more");
  });

  test("non-fast-forward push throws a pull-first message", async () => {
    const { work, bare } = await makeRepoWithRemote();
    await git(work, "push", "-q", "-u", "origin", "main");
    // Second clone advances the remote behind this work tree's back.
    const other = await mkdtemp(join(tmpdir(), "tabterm-other-"));
    await git(other, "clone", "-q", bare, ".");
    await git(other, "config", "user.email", "t@t");
    await git(other, "config", "user.name", "t");
    await writeFile(join(other, "README.md"), "hi\nremote\n");
    await git(other, "commit", "-q", "-am", "remote");
    await git(other, "push", "-q", "origin", "main");
    // Local diverges.
    await writeFile(join(work, "README.md"), "hi\nlocal\n");
    await git(work, "commit", "-q", "-am", "local");

    await expect(push(work, "main", "origin", false)).rejects.toThrow(/Pull first/);
  });
});

describe("git.ts: fetch/pull", () => {
  async function setup(): Promise<{ work: string; other: string }> {
    const bare = await mkdtemp(join(tmpdir(), "tabterm-sync-bare-"));
    await git(bare, "init", "-q", "--bare", "-b", "main");
    const work = await mkdtemp(join(tmpdir(), "tabterm-sync-work-"));
    await git(work, "clone", "-q", bare, ".");
    await git(work, "config", "user.email", "t@t");
    await git(work, "config", "user.name", "t");
    await writeFile(join(work, "README.md"), "one\n");
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", "init");
    await git(work, "push", "-q", "-u", "origin", "main");
    const other = await mkdtemp(join(tmpdir(), "tabterm-sync-other-"));
    await git(other, "clone", "-q", bare, ".");
    await git(other, "config", "user.email", "t@t");
    await git(other, "config", "user.name", "t");
    return { work, other };
  }

  test("fetch updates remote branches and behind count without changing HEAD", async () => {
    const { work, other } = await setup();
    await writeFile(join(other, "remote.txt"), "remote\n");
    await git(other, "add", ".");
    await git(other, "commit", "-q", "-m", "remote work");
    await git(other, "push", "-q", "origin", "main");
    const before = (await status(work)).headSha;

    await fetchRemote(work, "origin", true);

    expect((await status(work)).headSha).toBe(before);
    expect((await status(work)).behind).toBe(1);
    expect(await remoteBranches(work)).toContainEqual(expect.objectContaining({
      name: "origin/main",
      remote: "origin",
      branch: "main",
    }));
  });

  test("fast-forward pull updates the working tree", async () => {
    const { work, other } = await setup();
    await writeFile(join(other, "remote.txt"), "remote\n");
    await git(other, "add", ".");
    await git(other, "commit", "-q", "-m", "remote work");
    await git(other, "push", "-q", "origin", "main");

    await pull(work, "ff-only");

    expect((await status(work)).behind).toBe(0);
    expect((await runGit(work, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("remote work");
  });
});

describe("git.ts: professional workflow", () => {
  test("completes sync, partial staging, rewrite, conflict resolution, publish, and recovery", async () => {
    const bare = await mkdtemp(join(tmpdir(), "tabterm-flow-bare-"));
    await git(bare, "init", "-q", "--bare", "-b", "main");
    const maintainer = await mkdtemp(join(tmpdir(), "tabterm-flow-maintainer-"));
    await git(maintainer, "clone", "-q", bare, ".");
    await git(maintainer, "config", "user.email", "maintainer@test");
    await git(maintainer, "config", "user.name", "maintainer");
    await writeFile(join(maintainer, "README.md"), "alpha\nbeta\ngamma\n");
    await git(maintainer, "add", ".");
    await git(maintainer, "commit", "-q", "-m", "initial content");
    await git(maintainer, "push", "-q", "-u", "origin", "main");

    const work = await mkdtemp(join(tmpdir(), "tabterm-flow-work-"));
    await git(work, "clone", "-q", bare, ".");
    await git(work, "config", "user.email", "author@test");
    await git(work, "config", "user.name", "author");

    await fetchRemote(work, "origin", true);
    await branchCreate(work, "feature/professional-flow", null, true);
    await writeFile(join(work, "README.md"), "ALPHA\nBETA\ngamma\n");
    const change = await diff(work, "README.md", false);
    const alphaDeletion = change.hunks[0]!.lines.findIndex(line => line.kind === "-" && line.src === "alpha");
    const alphaAddition = change.hunks[0]!.lines.findIndex(line => line.kind === "+" && line.src === "ALPHA");
    const patch = serializeSelectedLines(change.hunks[0]!, "README.md", new Set([alphaDeletion, alphaAddition]));
    expect(patch).not.toBeNull();
    await stageHunk(work, patch!, false, "README.md");
    await commit(work, "change only alpha", false);
    expect((await diff(work, "README.md", false)).hunks.flatMap(hunk => hunk.lines).some(line => line.src === "BETA")).toBe(true);
    await discard(work, ["README.md"]);

    await writeFile(join(maintainer, "remote.txt"), "upstream work\n");
    await git(maintainer, "add", ".");
    await git(maintainer, "commit", "-q", "-m", "advance main");
    await git(maintainer, "push", "-q", "origin", "main");
    await fetchRemote(work, "origin", true);
    await rebase(work, "origin/main");

    await branchCreate(work, "integration", "origin/main", true);
    await writeFile(join(work, "README.md"), "INTEGRATION\nbeta\ngamma\n");
    await stage(work, ["README.md"]);
    await commit(work, "integration change", false);
    await checkout(work, "feature/professional-flow");
    await expect(merge(work, "integration")).rejects.toThrow();
    expect((await status(work)).operation?.type).toBe("merge");
    expect((await conflictFile(work, "README.md")).theirs).toContain("INTEGRATION");
    await saveConflictResolution(work, "README.md", "ALPHA + INTEGRATION\nbeta\ngamma\n");
    await operationAction(work, "continue");

    await push(work, "feature/professional-flow", "origin", true);
    expect((await branches(work)).find(branch => branch.current)?.upstream).toBe("origin/feature/professional-flow");
    const publishedHead = (await runGit(work, ["rev-parse", "HEAD"])).stdout.trim();
    const safetyRef = await resetTo(work, "HEAD^", "mixed");
    expect((await runGit(work, ["rev-parse", safetyRef])).stdout.trim()).toBe(publishedHead);
    const recovered = await recoverBranch(work, publishedHead);
    expect((await runGit(work, ["rev-parse", recovered])).stdout.trim()).toBe(publishedHead);
  });
});
