import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { resolveRoot, status, runGit, diff, commitDiff, stage, unstage, discard, commit, branches, checkout, branchCreate, branchDelete, stashes, stashCreate, stashDrop, log, tags, tagCreate, remotes, remoteAdd, remoteUpdate, remoteRemove, submodules, push } from "./git.ts";

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
  test("discard reverts a working-tree change", async () => {
    const root = await makeRepo();
    await writeFile(join(root, "README.md"), "hi\nbad\n");
    await discard(root, ["README.md"]);
    const snap = await status(root);
    expect(snap.files).toEqual([]);
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
