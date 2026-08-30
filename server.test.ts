import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as pathResolve, join } from "node:path";
import { spawn } from "bun";
import type { ServerHost, RoomSpec, RoomContext, Peer } from "@tabterm/module-host/server";
import activate from "./server.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tabterm-git-srv-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "README.md"), "hi\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

// Minimal ServerHost that records the room spec activate() registers and maps a
// tabId -> cwd so rootFor() can resolve. Everything else is a no-op stub.
function fakeHost(cwds: Record<string, string>): { host: ServerHost; spec: () => RoomSpec } {
  let captured: RoomSpec | undefined;
  const host = {
    id: "test",
    dataDir: "/tmp",
    registerRoute: () => {},
    registerRpc: () => {},
    broadcast: () => {},
    kv: { get: () => undefined, set: () => {} },
    db: { run: () => {}, query: () => ({ all: () => [], get: () => undefined }) } as any,
    migrate: () => {},
    onMessage: () => () => {},
    sync: { set: () => ({}) as any, del: () => ({}) as any, toSender: () => ({}) as any },
    log: () => {},
    schedule: () => () => {},
    interval: () => () => {},
    now: () => 0,
    workspaces: { get: (id: string) => (cwds[id] ? { id, cwd: cwds[id] } : null) },
    room: (_id: string, spec: RoomSpec) => { captured = spec; return () => {}; },
  } as unknown as ServerHost;
  return { host, spec: () => captured! };
}

function captureSends(): { peer: Peer; sent: any[] } {
  const sent: any[] = [];
  return { peer: { send: (m: unknown) => sent.push(m) }, sent };
}

function ctxFor(key: string, pushed: any[] = []): RoomContext {
  return { key, push: (message) => pushed.push(message) };
}

describe("git module onJoin: loading vs not-a-repo", () => {
  let repo: string;
  let nonRepo: string;
  beforeAll(async () => {
    repo = await makeRepo();
    nonRepo = await mkdtemp(join(tmpdir(), "tabterm-norepo-"));
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(nonRepo, { recursive: true, force: true });
  });

  test("a real repo with no cached status does NOT get an empty snapshot on join", async () => {
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer, sent } = captureSends();
    await spec().onJoin!(ctxFor("tab1"), peer);

    // The client shows "Reading repository…" only while no snapshot exists.
    // Sending an empty snapshot for a real repo flashes "Not a git repository".
    const statusMsgs = sent.filter((m) => m.type === "git:status");
    expect(statusMsgs).toEqual([]);
    const noRepoMsgs = sent.filter((m) => m.type === "git:noRepo");
    expect(noRepoMsgs).toEqual([]);
  });

  test("a non-repo dir gets an explicit git:noRepo on join", async () => {
    const { host, spec } = fakeHost({ tab1: nonRepo });
    activate(host);
    const { peer, sent } = captureSends();
    await spec().onJoin!(ctxFor("tab1"), peer);

    const noRepoMsgs = sent.filter((m) => m.type === "git:noRepo");
    expect(noRepoMsgs).toEqual([{ type: "git:noRepo", tabId: "tab1" }]);
    expect(sent.filter((m) => m.type === "git:status")).toEqual([]);
  });
});

describe("git module initialization", () => {
  test("git:init initializes the workspace cwd and broadcasts its first snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tabterm-init-srv-"));
    const { host, spec } = fakeHost({ tab1: dir });
    activate(host);
    const { peer, sent } = captureSends();
    const pushed: any[] = [];

    await spec().onRequest!(ctxFor("tab1", pushed), { type: "git:init", tabId: "tab1" }, peer);

    expect(sent).toEqual([]);
    expect(pushed[0]).toEqual(expect.objectContaining({
      type: "git:status",
      tabId: "tab1",
      snapshot: expect.objectContaining({ branch: "main", headSha: null }),
    }));
    expect(pushed[1]).toEqual(expect.objectContaining({ type: "git:refs", tabId: "tab1" }));
    expect((await run(dir, ["rev-parse", "--show-toplevel"])).trim()).toBe(await realpath(dir));
    await rm(dir, { recursive: true, force: true });
  });
});

describe("git module jobs", () => {
  test("a checkout broadcasts running and successful completion states", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "topic");
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer, sent } = captureSends();
    const pushed: any[] = [];

    await spec().onRequest!(ctxFor("tab1", pushed), { type: "git:checkout", tabId: "tab1", branch: "topic" }, peer);

    expect(sent).toEqual([]);
    expect(pushed[0]).toEqual(expect.objectContaining({
      type: "git:job",
      tabId: "tab1",
      job: expect.objectContaining({ kind: "checkout", label: "Checking out topic" }),
    }));
    expect(pushed).toContainEqual(expect.objectContaining({
      type: "git:jobDone",
      ok: true,
      job: expect.objectContaining({ kind: "checkout" }),
    }));
    expect(pushed.at(-1)).toEqual({ type: "git:job", tabId: "tab1", job: null });
    expect((await run(repo, ["branch", "--show-current"])).trim()).toBe("topic");
    await rm(repo, { recursive: true, force: true });
  });
});

async function run(cwd: string, args: string[]): Promise<string> {
  const p = spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(p.stdout).text();
  await p.exited;
  return stdout;
}

describe("git module: throttled submodule refresh preserves the list", () => {
  test("refs pushes never drop submodules between cadence ticks", async () => {
    const repo = await makeRepo();
    const lib = await makeRepo();
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(repo, "commit", "-q", "-m", "add submodule");
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer } = captureSends();
    // Join loads submodules eagerly (includeSubmodules = true).
    await spec().onJoin!(ctxFor("tab1"), peer);

    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    // Ticks 1..5: status pushes + one refs push at tick 3, where the expensive
    // `git submodule status` is throttled off. The cached list must be reused
    // instead of broadcasting an empty submodule array.
    for (let i = 0; i < 5; i++) await spec().poll!(ctx);
    const refsMsgs = pushed.filter((m) => m.type === "git:refs");
    expect(refsMsgs.length).toBeGreaterThanOrEqual(1);
    for (const m of refsMsgs) expect(m.refs.submodules).toHaveLength(1);
    await rm(repo, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });
});

describe("git module: root cache detects repository-boundary changes", () => {
  test("git init inside a cached parent-root workspace switches roots", async () => {
    const parent = await makeRepo();
    const work = join(parent, "inner");
    await mkdir(work);
    const { host, spec } = fakeHost({ tab1: work });
    activate(host);
    const { peer } = captureSends();

    // First poll resolves and caches the PARENT repo as the workspace root.
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    await spec().poll!(ctx);
    const first = pushed.find((m) => m.type === "git:status");
    expect(first).toBeDefined();
    expect(first.snapshot.headSha).not.toBeNull(); // parent repo has commits

    // A nested repository appears at the workspace cwd; the next poll must
    // notice the boundary and re-resolve to the fresh repo (no commits yet).
    await git(work, "init", "-q", "-b", "main");
    pushed.length = 0;
    await spec().poll!(ctx);
    const second = pushed.find((m) => m.type === "git:status");
    expect(second).toBeDefined();
    expect(second.snapshot.headSha).toBeNull();
    expect(second.snapshot.branch).toBe("main");
    await rm(parent, { recursive: true, force: true });
  });

  test("git init in an ancestor of a cached no-repo workspace switches roots", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tabterm-ancestor-init-"));
    const work = join(parent, "work");
    await mkdir(work);
    const { host, spec } = fakeHost({ tab1: work });
    activate(host);
    const { peer, sent } = captureSends();
    // Join resolves + caches root: null ("not a repository").
    await spec().onJoin!(ctxFor("tab1"), peer);
    expect(sent.some((m) => m.type === "git:noRepo")).toBe(true);

    // An ancestor gains a repository; the next poll must notice it even though
    // no .git marker exists at the workspace cwd itself.
    await git(parent, "init", "-q", "-b", "main");
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    await spec().poll!(ctx);
    const status = pushed.find((m) => m.type === "git:status");
    expect(status).toBeDefined();
    expect(status.snapshot.branch).toBe("main");
    await rm(parent, { recursive: true, force: true });
  });

  test("submodule cache does not leak across a root switch", async () => {
    const parent = await makeRepo();
    const lib = await makeRepo();
    await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(parent, "commit", "-q", "-m", "add submodule");
    const work = join(parent, "inner");
    await mkdir(work);
    const { host, spec } = fakeHost({ tab1: work });
    activate(host);
    const { peer } = captureSends();
    // Eager join caches the PARENT repo's submodule list for this workspace.
    await spec().onJoin!(ctxFor("tab1"), peer);

    // A nested repo appears at the cwd; the tick-3 refs push must not
    // broadcast the parent's stale submodule list for the new repository.
    await git(work, "init", "-q", "-b", "main");
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    for (let i = 0; i < 3; i++) await spec().poll!(ctx);
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(parent, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("an in-flight refs refresh is discarded when the root switches", async () => {
    const parent = await makeRepo();
    await git(parent, "branch", "keep"); // parent has 2 branches
    const work = join(parent, "inner");
    await mkdir(work);
    const { host, spec } = fakeHost({ tab1: work });
    activate(host);
    await spec().poll!(ctxFor("tab1")); // pre-cache the parent root

    const { peer, sent } = captureSends();
    // Start the eager join (refsMsg incl. submodules) and switch the
    // repository boundary while its subprocesses are still in flight — the
    // completed refresh must be discarded, not broadcast for the old root.
    const joinP = spec().onJoin!(ctxFor("tab1"), peer);
    await git(work, "init", "-q", "-b", "main");
    await joinP;
    expect(sent.filter((m) => m.type === "git:refs")).toEqual([]);

    // The next refs tick recomputes against the new repository.
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    await spec().poll!(ctx); // tick 2
    await spec().poll!(ctx); // tick 3 → refs push
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    // The fresh repo has no commits yet, so for-each-ref lists no branches —
    // the parent's ["keep", "main"] would distinguish it if leaked.
    expect(refsMsg.refs.branches.map((b: any) => b.name).sort()).toEqual([]);
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(parent, { recursive: true, force: true });
  });

  test("symlink retarget re-resolves the root and does not leak submodules", async () => {
    const d1 = await makeRepo();
    const lib = await makeRepo();
    await git(d1, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(d1, "commit", "-q", "-m", "add submodule");
    const d2 = await mkdtemp(join(tmpdir(), "tabterm-retarget-"));
    await git(d2, "init", "-q", "-b", "main"); // fresh repo, no commits
    const linkDir = await mkdtemp(join(tmpdir(), "tabterm-linkdir-"));
    const link = join(linkDir, "repo");
    await symlink(d1, link);
    const { host, spec } = fakeHost({ tab1: link });
    activate(host);
    const { peer } = captureSends();
    // Eager join caches d1's submodule list against real = d1.
    await spec().onJoin!(ctxFor("tab1"), peer);

    // Retarget the cwd symlink to a different repository while the room is
    // active; the next polls must switch roots and never reuse d1's list.
    await rm(link);
    await symlink(d2, link);
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    for (let i = 0; i < 3; i++) await spec().poll!(ctx);
    const status = pushed.find((m) => m.type === "git:status");
    expect(status).toBeDefined();
    expect(status.snapshot.headSha).toBeNull(); // new target has no commits
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(d1, { recursive: true, force: true });
    await rm(d2, { recursive: true, force: true });
    await rm(linkDir, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("in-place repository replacement invalidates the submodule cache", async () => {
    const repo = await makeRepo();
    const lib = await makeRepo();
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(repo, "commit", "-q", "-m", "add submodule");
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer } = captureSends();
    // Eager join caches the submodule list keyed to the .git identity.
    await spec().onJoin!(ctxFor("tab1"), peer);

    // Replace the repository in place: same path, same realpath, brand-new
    // .git. The throttled refs push must not reuse the old repository's
    // submodules (root/real comparisons alone cannot detect this).
    await rm(join(repo, ".git"), { recursive: true, force: true });
    await git(repo, "init", "-q", "-b", "main");
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    for (let i = 0; i < 3; i++) await spec().poll!(ctx);
    const status = pushed.find((m) => m.type === "git:status");
    expect(status).toBeDefined();
    expect(status.snapshot.headSha).toBeNull(); // fresh repo, no commits
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(repo, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("in-place gitfile rewrite invalidates the root cache", async () => {
    // r1 carries a submodule and gets a linked worktree; r2 is a plain repo
    // with its own linked worktree, so both worktrees have real .git gitfiles.
    const r1 = await makeRepo();
    const lib = await makeRepo();
    await git(r1, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(r1, "commit", "-q", "-m", "add submodule");
    const r2 = await makeRepo();
    const wd = await mkdtemp(join(tmpdir(), "tabterm-gitfile-wt-"));
    const w1 = join(wd, "w1");
    const w2 = join(wd, "w2");
    await git(r1, "worktree", "add", "-q", "-b", "linked1", w1);
    await git(r2, "worktree", "add", "-q", "-b", "linked2", w2);
    const { host, spec } = fakeHost({ tab1: w1 });
    activate(host);
    const { peer } = captureSends();
    // Eager join caches r1's submodule list for the w1 worktree.
    await spec().onJoin!(ctxFor("tab1"), peer);

    // Rewrite w1/.git in place to point at r2's worktree gitdir: same path,
    // same inode, same birthtime — only the gitfile contents change.
    const w2Gitfile = await readFile(join(w2, ".git"), "utf8");
    await writeFile(join(w1, ".git"), w2Gitfile);
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    for (let i = 0; i < 3; i++) await spec().poll!(ctx);
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    // The refs now come from r2's worktree, and r1's submodule list is not reused.
    const branchNames = refsMsg.refs.branches.map((b: any) => b.name);
    expect(branchNames).toContain("linked2");
    expect(branchNames).not.toContain("linked1");
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(wd, { recursive: true, force: true });
    await rm(r1, { recursive: true, force: true });
    await rm(r2, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("replacing the gitfile target behind an unchanged pointer invalidates the cache", async () => {
    const r1 = await makeRepo();
    const lib = await makeRepo();
    await git(r1, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(r1, "commit", "-q", "-m", "add submodule");
    const r2 = await makeRepo();
    const wd = await mkdtemp(join(tmpdir(), "tabterm-gitfile-wt2-"));
    const w1 = join(wd, "w1");
    const w2 = join(wd, "w2");
    await git(r1, "worktree", "add", "-q", "-b", "linked1", w1);
    await git(r2, "worktree", "add", "-q", "-b", "linked2", w2);
    const { host, spec } = fakeHost({ tab1: w1 });
    activate(host);
    const { peer } = captureSends();
    await spec().onJoin!(ctxFor("tab1"), peer);

    // The gitfile pointer text stays the same, but the admin dir it names is
    // replaced by a symlink to r2's worktree admin dir — git in w1 now
    // operates on r2. Only the resolved-target identity catches this.
    const adminOf = async (w: string): Promise<string> =>
      pathResolve(w, (await readFile(join(w, ".git"), "utf8")).match(/^gitdir:\s*(.+?)\s*$/m)![1]!);
    const admin1 = await adminOf(w1);
    const admin2 = await adminOf(w2);
    await rm(admin1, { recursive: true, force: true });
    await symlink(admin2, admin1);

    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    for (let i = 0; i < 3; i++) await spec().poll!(ctx);
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    const branchNames = refsMsg.refs.branches.map((b: any) => b.name);
    expect(branchNames).toContain("linked2");
    expect(branchNames).not.toContain("linked1");
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(wd, { recursive: true, force: true });
    await rm(r1, { recursive: true, force: true });
    await rm(r2, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("in-place admin rewrite retargeting the common repo invalidates the cache", async () => {
    const r1 = await makeRepo();
    const lib = await makeRepo();
    await git(r1, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(r1, "commit", "-q", "-m", "add submodule");
    const r2 = await makeRepo();
    const wd = await mkdtemp(join(tmpdir(), "tabterm-gitfile-wt3-"));
    const w1 = join(wd, "w1");
    const w2 = join(wd, "w2");
    await git(r1, "worktree", "add", "-q", "-b", "linked1", w1);
    await git(r2, "worktree", "add", "-q", "-b", "linked2", w2);
    const { host, spec } = fakeHost({ tab1: w1 });
    activate(host);
    const { peer } = captureSends();
    await spec().onJoin!(ctxFor("tab1"), peer);

    // Rewrite w1's admin dir IN PLACE: commondir now names r2's common dir
    // (absolute), HEAD and index copied from w2's admin. The admin dir itself
    // keeps its device, inode, and birthtime, and w1's .git gitfile text is
    // untouched — only the commondir component of the identity can catch this.
    const adminOf = async (w: string): Promise<string> =>
      pathResolve(w, (await readFile(join(w, ".git"), "utf8")).match(/^gitdir:\s*(.+?)\s*$/m)![1]!);
    const admin1 = await adminOf(w1);
    const admin2 = await adminOf(w2);
    await writeFile(join(admin1, "commondir"), (await realpath(join(r2, ".git"))) + "\n");
    await writeFile(join(admin1, "HEAD"), await readFile(join(admin2, "HEAD")));
    await writeFile(join(admin1, "index"), await readFile(join(admin2, "index")));

    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    for (let i = 0; i < 3; i++) await spec().poll!(ctx);
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    const branchNames = refsMsg.refs.branches.map((b: any) => b.name);
    expect(branchNames).toContain("linked2");
    expect(branchNames).not.toContain("linked1");
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(wd, { recursive: true, force: true });
    await rm(r1, { recursive: true, force: true });
    await rm(r2, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("tree-changing mutations eagerly refresh the submodule list", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-q", "-b", "nosub"); // branch WITHOUT the submodule
    await git(repo, "checkout", "-q", "main");
    const lib = await makeRepo();
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(repo, "commit", "-q", "-m", "add submodule");
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer } = captureSends();
    // Eager join caches the submodule list of the submodule-carrying branch.
    await spec().onJoin!(ctxFor("tab1"), peer);

    // Checkout to the pre-submodule branch replaces the tree (and .gitmodules);
    // the refs push after the mutation must carry an eagerly refreshed — now
    // empty — list rather than the cached one.
    const pushed: any[] = [];
    await spec().onRequest!(ctxFor("tab1", pushed), { type: "git:checkout", tabId: "tab1", branch: "nosub" }, peer);
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(repo, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("branch creation that checks out a base eagerly refreshes the submodule list", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-q", "-b", "nosub"); // branch WITHOUT the submodule
    await git(repo, "checkout", "-q", "main");
    const lib = await makeRepo();
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(repo, "commit", "-q", "-m", "add submodule");
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer } = captureSends();
    await spec().onJoin!(ctxFor("tab1"), peer);

    // branchCreate with checkout: true switches the tree to the base branch's
    // state (git checkout -b ...), so the refs push must refresh submodules
    // eagerly instead of reusing the cached list.
    const pushed: any[] = [];
    await spec().onRequest!(ctxFor("tab1", pushed), { type: "git:branchCreate", tabId: "tab1", name: "feature", from: "nosub", checkout: true }, peer);
    const refsMsg = pushed.find((m) => m.type === "git:refs");
    expect(refsMsg).toBeDefined();
    expect(refsMsg.refs.submodules).toEqual([]);
    await rm(repo, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("an in-flight throttled refresh is discarded when a mutation's eager refresh supersedes it", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-q", "-b", "nosub");
    await git(repo, "checkout", "-q", "main");
    const lib = await makeRepo();
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(repo, "commit", "-q", "-m", "add submodule");
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer } = captureSends();
    await spec().onJoin!(ctxFor("tab1"), peer);

    // Pump ticks 1..8 (refs pushes at ticks 3 and 6 land in the throwaway ctx).
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));

    // Tick 9 starts a throttled refresh (submodule cadence due, ~130ms of
    // subprocesses). A checkout mutation lands mid-flight and starts its own
    // EAGER refresh (generation supersedes the tick's); the tick's completed
    // result must be discarded so it cannot broadcast pre-mutation refs or
    // overwrite the submodule cache after the eager refresh.
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    const pollP = spec().poll!(ctx);
    await spec().onRequest!(ctx, { type: "git:checkout", tabId: "tab1", branch: "nosub" }, peer);
    await pollP;
    const refsMsgs = pushed.filter((m) => m.type === "git:refs");
    expect(refsMsgs).toHaveLength(1); // only the eager (post-mutation) refresh
    expect(refsMsgs[0]!.refs.submodules).toEqual([]);
    await rm(repo, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("a mutation's eager refresh wins over a throttled tick that starts after it", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-q", "-b", "nosub");
    await git(repo, "checkout", "-q", "main");
    const lib = await makeRepo();
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", lib, "vendor/lib");
    await git(repo, "commit", "-q", "-m", "add submodule");
    const { host, spec } = fakeHost({ tab1: repo });
    activate(host);
    const { peer } = captureSends();
    await spec().onJoin!(ctxFor("tab1"), peer);
    // Ticks 1 and 2 (no refs pushes).
    await spec().poll!(ctxFor("tab1"));
    await spec().poll!(ctxFor("tab1"));

    // Start the checkout mutation (its eager refresh — git submodule status —
    // runs last, ~90ms). The tick-3 throttled refresh starts while the eager
    // one is in flight: it must NOT re-use the pre-mutation submodule cache or
    // supersede the eager refresh.
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    const mutP = spec().onRequest!(ctx, { type: "git:checkout", tabId: "tab1", branch: "nosub" }, peer);
    await Bun.sleep(70);
    await spec().poll!(ctx); // tick 3
    await mutP;
    const refsMsgs = pushed.filter((m) => m.type === "git:refs");
    expect(refsMsgs.length).toBeGreaterThanOrEqual(1);
    // The final refs push is the eager, post-mutation one: empty submodules.
    expect(refsMsgs.at(-1)!.refs.submodules).toEqual([]);
    // No stale pre-mutation list (length 1) may reach the clients.
    expect(refsMsgs.some((m) => m.refs.submodules.length === 1)).toBe(false);
    await rm(repo, { recursive: true, force: true });
    await rm(lib, { recursive: true, force: true });
  });

  test("a poll discards a status snapshot for a superseded root", async () => {
    const parent = await makeRepo();
    const work = join(parent, "inner");
    await mkdir(work);
    const { host, spec } = fakeHost({ tab1: work });
    activate(host);
    await spec().poll!(ctxFor("tab1")); // pre-cache the parent root

    // Start a poll and switch the repository boundary while git status is
    // running; the completed snapshot must be discarded, not pushed.
    const pushed: any[] = [];
    const ctx = ctxFor("tab1", pushed);
    const pollP = spec().poll!(ctx);
    await git(work, "init", "-q", "-b", "main");
    await pollP;
    expect(pushed.filter((m) => m.type === "git:status")).toEqual([]);

    // The next poll computes against the new repository and pushes.
    await spec().poll!(ctx);
    const status = pushed.find((m) => m.type === "git:status");
    expect(status).toBeDefined();
    expect(status.snapshot.headSha).toBeNull();
    await rm(parent, { recursive: true, force: true });
  });
});
