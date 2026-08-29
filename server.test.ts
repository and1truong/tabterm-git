import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
