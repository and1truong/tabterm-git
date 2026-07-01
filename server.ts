import type { ServerHost, RoomContext, Peer } from "@tabterm/module-host/server";
import * as git from "./server/git.ts";
import type { GitSnapshot, GitRefs } from "./shared.ts";
import { subtreeMigrations } from "./server/subtreeMigrations.ts";
import { makeSubtreeDb } from "./server/subtreeDb.ts";
import { makeSubtreeService } from "./server/subtreeService.ts";

const POLL_MS = 1500;
const REFS_EVERY = 3; // ~5s at 1.5s poll

function emptyRefs(): GitRefs {
  return { branches: [], current: null, remotes: [], stashes: [], tags: [], submodules: [] };
}

export default function activate(host: ServerHost) {
  host.migrate(subtreeMigrations);
  const sdb = makeSubtreeDb(host.db);
  const subtreeSvc = makeSubtreeService(sdb, host.sync);
  const offSubtree = host.onMessage(["gitSubtree"], (msg) => subtreeSvc.handle(msg));
  host.registerRoute("GET", "/subtrees", () => Response.json({ subtrees: sdb.list() }));

  const latestStatus = new Map<string, GitSnapshot>();
  const refsTick = new Map<string, number>();

  const rootFor = (key: string) => {
    const cwd = host.workspaces.get(key)?.cwd;
    return cwd ? git.resolveRoot(cwd) : Promise.resolve(null);
  };

  async function refsMsg(key: string) {
    const root = await rootFor(key);
    if (!root) return { type: "git:refs", tabId: key, refs: emptyRefs() };
    try {
      const [branches, remotes, stashes, tags, submodules] = await Promise.all([
        git.branches(root), git.remotes(root), git.stashes(root), git.tags(root), git.submodules(root),
      ]);
      const current = branches.find((b) => b.current)?.name ?? null;
      const refs: GitRefs = { branches, current, remotes, stashes, tags, submodules };
      return { type: "git:refs", tabId: key, refs };
    } catch {
      return { type: "git:refs", tabId: key, refs: emptyRefs() };
    }
  }

  const off = host.room("git", {
    prefixes: ["git"],
    keyOf: (m) => m.tabId ?? null,
    subscribeType: "git:subscribe",
    unsubscribeType: "git:unsubscribe",
    pollMs: POLL_MS,
    poll: async (ctx: RoomContext) => {
      const root = await rootFor(ctx.key);
      if (!root) return undefined;
      let snap: GitSnapshot;
      try { snap = await git.status(root); } catch { return undefined; }
      latestStatus.set(ctx.key, snap);
      const t = (refsTick.get(ctx.key) ?? 0) + 1;
      refsTick.set(ctx.key, t);
      if (t % REFS_EVERY === 0) ctx.push(await refsMsg(ctx.key));
      return { type: "git:status", tabId: ctx.key, snapshot: snap };
    },
    onJoin: async (ctx: RoomContext, peer: Peer) => {
      // Three states the panel needs to tell apart on join:
      //   - cached status   → send it, panel renders the repo
      //   - no git root      → send git:noRepo, panel shows "Not a git repository"
      //   - root, poll pending → send nothing; panel stays in its "Reading
      //                          repository…" gate until the first poll lands.
      // Sending a placeholder empty snapshot here would be indistinguishable
      // from a real repo mid-load and flash the not-a-repo view.
      const last = latestStatus.get(ctx.key);
      if (last) {
        peer.send({ type: "git:status", tabId: ctx.key, snapshot: last });
      } else if (!(await rootFor(ctx.key))) {
        peer.send({ type: "git:noRepo", tabId: ctx.key });
      }
      peer.send(await refsMsg(ctx.key));
    },
    onIdle: (key: string) => { latestStatus.delete(key); refsTick.delete(key); },
    onRequest: async (ctx: RoomContext, msg: any, peer: Peer) => {
      const root = await rootFor(ctx.key);
      if (!root) { peer.send({ type: "git:error", tabId: ctx.key, message: "Not a git repository" }); return; }
      const err = (m: string) => peer.send({ type: "git:error", tabId: ctx.key, message: m });
      try {
        let refsChanged = false;
        switch (msg.type) {
          case "git:openDiff":
            peer.send({ type: "git:diff", tabId: ctx.key, diff: await git.diff(root, msg.path, msg.staged) });
            return;
          case "git:openHistory":
            peer.send({ type: "git:log", tabId: ctx.key, entries: await git.log(root, { limit: 200 }) });
            return;
          case "git:openCommitDiff":
            peer.send({ type: "git:commitDiff", tabId: ctx.key, sha: msg.sha, files: await git.commitDiff(root, msg.sha) });
            return;
          case "git:stage":   await git.stage(root, msg.paths); break;
          case "git:unstage": await git.unstage(root, msg.paths); break;
          case "git:stageHunk": await git.stageHunk(root, msg.patch, msg.staged); break;
          case "git:discard": await git.discard(root, msg.paths); break;
          case "git:commit":  await git.commit(root, msg.message, msg.amend); refsChanged = true; break;
          case "git:checkout":     await git.checkout(root, msg.branch); refsChanged = true; break;
          case "git:branchCreate": await git.branchCreate(root, msg.name, msg.from, msg.checkout); refsChanged = true; break;
          case "git:branchDelete": await git.branchDelete(root, msg.name, msg.force); refsChanged = true; break;
          case "git:push":         await git.push(root, msg.branch, msg.remote, msg.setUpstream); refsChanged = true; break;
          case "git:stashCreate":  await git.stashCreate(root, msg.message); refsChanged = true; break;
          case "git:stashApply":   await git.stashApply(root, msg.index, msg.pop); refsChanged = true; break;
          case "git:stashDrop":    await git.stashDrop(root, msg.index); refsChanged = true; break;
          case "git:tagCreate":    await git.tagCreate(root, msg.name, msg.message, msg.push); refsChanged = true; break;
          case "git:tagDelete":    await git.tagDelete(root, msg.name, msg.remote); refsChanged = true; break;
          case "git:remoteAdd":    await git.remoteAdd(root, msg.name, msg.url); refsChanged = true; break;
          case "git:remoteUpdate": await git.remoteUpdate(root, msg.name, msg.newName, msg.fetchUrl, msg.pushUrl); refsChanged = true; break;
          case "git:remoteRemove": await git.remoteRemove(root, msg.name); refsChanged = true; break;
          case "git:submoduleUpdate":
            await git.runGit(root, ["submodule", "update", "--", msg.path]); refsChanged = true; break;
          default: return;
        }
        // After a mutation, push fresh status (+refs) to all subscribers.
        let snap: GitSnapshot;
        try { snap = await git.status(root); latestStatus.set(ctx.key, snap); ctx.push({ type: "git:status", tabId: ctx.key, snapshot: snap }); } catch { /* keep last */ }
        if (refsChanged) ctx.push(await refsMsg(ctx.key));
      } catch (e) {
        err((e as Error).message);
      }
    },
  });

  return () => { off(); offSubtree(); };
}
