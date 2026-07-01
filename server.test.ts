import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function ctxFor(key: string): RoomContext {
  return { key, push: () => {} };
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
