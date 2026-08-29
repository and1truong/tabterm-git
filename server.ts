import type { ServerHost, RoomContext, Peer } from "@tabterm/module-host/server";
import * as git from "./server/git.ts";
import type { GitSnapshot, GitRefs, GitJob } from "./shared.ts";
import { subtreeMigrations } from "./server/subtreeMigrations.ts";
import { makeSubtreeDb } from "./server/subtreeDb.ts";
import { makeSubtreeService } from "./server/subtreeService.ts";

const POLL_MS = 1500;
const REFS_EVERY = 3; // ~5s at 1.5s poll

function emptyRefs(): GitRefs {
  return { branches: [], remoteBranches: [], current: null, remotes: [], stashes: [], tags: [], submodules: [], worktrees: [] };
}

export default function activate(host: ServerHost) {
  host.migrate(subtreeMigrations);
  const sdb = makeSubtreeDb(host.db);
  const subtreeSvc = makeSubtreeService(sdb, host.sync);
  const offSubtree = host.onMessage(["gitSubtree"], (msg) => subtreeSvc.handle(msg));
  host.registerRoute("GET", "/subtrees", () => Response.json({ subtrees: sdb.list() }));

  const latestStatus = new Map<string, GitSnapshot>();
  const refsTick = new Map<string, number>();
  const activeJobs = new Map<string, GitJob>();

  const rootFor = (key: string) => {
    const cwd = host.workspaces.get(key)?.cwd;
    return cwd ? git.resolveRoot(cwd) : Promise.resolve(null);
  };

  async function refsMsg(key: string) {
    const root = await rootFor(key);
    if (!root) return { type: "git:refs", tabId: key, refs: emptyRefs() };
    try {
      const [branches, remoteBranches, remotes, stashes, tags, submodules, worktrees] = await Promise.all([
        git.branches(root), git.remoteBranches(root), git.remotes(root), git.stashes(root), git.tags(root), git.submodules(root), git.worktrees(root),
      ]);
      const current = branches.find((b) => b.current)?.name ?? null;
      const refs: GitRefs = { branches, remoteBranches, current, remotes, stashes, tags, submodules, worktrees };
      return { type: "git:refs", tabId: key, refs };
    } catch (e) {
      return { type: "git:error", tabId: key, message: `Unable to refresh refs: ${(e as Error).message}` };
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
    onIdle: (key: string) => { latestStatus.delete(key); refsTick.delete(key); activeJobs.delete(key); },
    onRequest: async (ctx: RoomContext, msg: any, peer: Peer) => {
      const err = (m: string) => peer.send({ type: "git:error", tabId: ctx.key, message: m });
      if (msg.type === "git:init") {
        const cwd = host.workspaces.get(ctx.key)?.cwd;
        if (!cwd) { err("Workspace directory not found."); return; }
        try {
          const root = await git.initRepository(cwd);
          const snapshot = await git.status(root);
          latestStatus.set(ctx.key, snapshot);
          refsTick.set(ctx.key, 0);
          ctx.push({ type: "git:status", tabId: ctx.key, snapshot });
          ctx.push(await refsMsg(ctx.key));
        } catch (e) {
          err((e as Error).message);
        }
        return;
      }
      const root = await rootFor(ctx.key);
      if (!root) { err("Not a git repository"); return; }
      const descriptor = jobFor(msg);
      if (descriptor && activeJobs.has(ctx.key)) {
        err(`${activeJobs.get(ctx.key)!.label} is already in progress.`);
        return;
      }
      if (descriptor) {
        const job = { ...descriptor, startedAt: host.now() };
        activeJobs.set(ctx.key, job);
        ctx.push({ type: "git:job", tabId: ctx.key, job });
      }
      let refresh = false;
      let refsChanged = false;
      let failed = false;
      try {
        switch (msg.type) {
          case "git:openDiff":
            peer.send({ type: "git:diff", tabId: ctx.key, diff: await git.diff(root, msg.path, msg.staged) });
            return;
          case "git:openConflict":
            peer.send({ type: "git:conflict", tabId: ctx.key, conflict: await git.conflictFile(root, msg.path) });
            return;
          case "git:openHistory":
            {
              const limit = Math.min(Math.max(Number(msg.limit) || 200, 50), 5000);
              const entries = await git.log(root, { limit: limit + 1, all: msg.all !== false });
              peer.send({ type: "git:log", tabId: ctx.key, log: { entries: entries.slice(0, limit), hasMore: entries.length > limit, limit } });
            }
            return;
          case "git:openCommitDiff":
            peer.send({ type: "git:commitDiff", tabId: ctx.key, sha: msg.sha, files: await git.commitDiff(root, msg.sha) });
            return;
          case "git:compare":
            peer.send({ type: "git:compare", tabId: ctx.key, compare: await git.compareRefs(root, msg.base, msg.head ?? "HEAD") });
            return;
          case "git:openReflog":
            peer.send({ type: "git:reflog", tabId: ctx.key, entries: await git.reflog(root, msg.limit ?? 200) });
            return;
          case "git:openFileInsight":
            peer.send({ type: "git:fileInsight", tabId: ctx.key, insight: await git.fileInsight(root, msg.path) });
            return;
          case "git:openRebasePlan":
            peer.send({ type: "git:rebasePlan", tabId: ctx.key, plan: await git.rebasePlan(root, msg.upstream) });
            return;
          case "git:openStash": {
            const stash = (await git.stashes(root)).find(item => item.index === msg.index);
            peer.send({ type: "git:stashDiff", tabId: ctx.key, stash: { index: msg.index, message: stash?.message ?? `stash@{${msg.index}}`, files: await git.stashDiff(root, msg.index) } });
            return;
          }
          case "git:openCommitContext":
            peer.send({ type: "git:commitContext", tabId: ctx.key, context: await git.commitContext(root) });
            return;
          case "git:stage":   refresh = true; await git.stage(root, msg.paths); break;
          case "git:unstage": refresh = true; await git.unstage(root, msg.paths); break;
          case "git:stageHunk": refresh = true; await git.stageHunk(root, msg.patch, msg.staged, msg.path); break;
          case "git:discard": refresh = true; await git.discard(root, msg.paths); break;
          case "git:ignore": refresh = true; await git.ignore(root, msg.paths); break;
          case "git:resolveConflict":
            refresh = true;
            if (msg.delete) await git.deleteConflictResolution(root, msg.path);
            else await git.saveConflictResolution(root, msg.path, msg.content);
            break;
          case "git:commit":  refresh = true; refsChanged = true; await git.commit(root, msg.message, msg.amend, msg.signoff, msg.sign); break;
          case "git:checkout":     refresh = true; refsChanged = true; await git.checkout(root, msg.branch); break;
          case "git:checkoutRemote": refresh = true; refsChanged = true; await git.checkoutRemote(root, msg.branch, msg.localName); break;
          case "git:branchCreate": refresh = true; refsChanged = true; await git.branchCreate(root, msg.name, msg.from, msg.checkout); break;
          case "git:branchDelete": refresh = true; refsChanged = true; await git.branchDelete(root, msg.name, msg.force); break;
          case "git:fetch":        refresh = true; refsChanged = true; await git.fetchRemote(root, msg.remote ?? null, msg.prune ?? true); break;
          case "git:pull":         refresh = true; refsChanged = true; await git.pull(root, msg.strategy); break;
          case "git:operationAction": refresh = true; refsChanged = true; await git.operationAction(root, msg.action); break;
          case "git:cherry-pick": refresh = true; refsChanged = true; await git.cherryPick(root, [msg.sha]); break;
          case "git:revert":      refresh = true; refsChanged = true; await git.revert(root, msg.sha); break;
          case "git:merge":       refresh = true; refsChanged = true; await git.merge(root, msg.ref, msg.noFf); break;
          case "git:rebase":      refresh = true; refsChanged = true; await git.rebase(root, msg.ref); break;
          case "git:interactiveRebase": refresh = true; refsChanged = true; await git.interactiveRebase(root, msg.upstream, msg.steps); break;
          case "git:bisect": refresh = true; refsChanged = true; await git.bisect(root, msg.action, msg.good, msg.bad); break;
          case "git:reset":
            if (msg.mode !== "soft" && msg.mode !== "mixed") throw new Error("Only soft and mixed reset are supported.");
            refresh = true; refsChanged = true; await git.resetTo(root, msg.ref, msg.mode); break;
          case "git:recoverBranch": refresh = true; refsChanged = true; await git.recoverBranch(root, msg.ref); break;
          case "git:worktreeAdd": refresh = true; refsChanged = true; await git.worktreeAdd(root, msg.path, msg.ref, msg.newBranch ?? null); break;
          case "git:worktreeRemove": refresh = true; refsChanged = true; await git.worktreeRemove(root, msg.path); break;
          case "git:worktreeLock": refresh = true; refsChanged = true; await git.worktreeLock(root, msg.path, msg.lock, msg.reason); break;
          case "git:worktreePrune": refresh = true; refsChanged = true; await git.worktreePrune(root); break;
          case "git:cancelJob":
            if (!git.cancelNetwork(root)) throw new Error("No cancellable network operation is running.");
            break;
          case "git:push":         refresh = true; refsChanged = true; await git.push(root, msg.branch, msg.remote, msg.setUpstream); break;
          case "git:stashCreate":  refresh = true; refsChanged = true; await git.stashCreate(root, msg.message, msg.options); break;
          case "git:stashApply":   refresh = true; refsChanged = true; await git.stashApply(root, msg.index, msg.pop); break;
          case "git:stashDrop":    refresh = true; refsChanged = true; await git.stashDrop(root, msg.index); break;
          case "git:tagCreate":    refresh = true; refsChanged = true; await git.tagCreate(root, msg.name, msg.message, msg.push); break;
          case "git:tagDelete":    refresh = true; refsChanged = true; await git.tagDelete(root, msg.name, msg.remote); break;
          case "git:remoteAdd":    refresh = true; refsChanged = true; await git.remoteAdd(root, msg.name, msg.url); break;
          case "git:remoteUpdate": refresh = true; refsChanged = true; await git.remoteUpdate(root, msg.name, msg.newName, msg.fetchUrl, msg.pushUrl); break;
          case "git:remoteRemove": refresh = true; refsChanged = true; await git.remoteRemove(root, msg.name); break;
          case "git:submoduleUpdate":
            refresh = true; refsChanged = true; await git.runGit(root, ["submodule", "update", "--", msg.path]); break;
          case "git:submoduleUpdateRemote":
            refresh = true; refsChanged = true; await git.submoduleUpdateRemote(root, msg.path); break;
          case "git:subtreeSync": {
            const subtree = sdb.get(msg.subtreeId);
            if (!subtree || subtree.primaryTabId !== ctx.key) throw new Error("Subtree mapping not found for this workspace.");
            refresh = true; refsChanged = true;
            const sha = await git.subtreeSync(root, subtree, msg.direction);
            const updated = sdb.update(subtree.id, { lastSyncedSha: sha, lastSyncedAt: host.now() });
            if (updated) ctx.push({ type: "git:subtreeSynced", tabId: ctx.key, subtree: updated });
            break;
          }
          default: return;
        }
      } catch (e) {
        failed = true;
        err((e as Error).message);
      } finally {
        // Refresh even after a failed mutation: merge/rebase/pull can leave a
        // valid conflicted operation state that the UI must surface.
        if (refresh) {
        let snap: GitSnapshot;
        try { snap = await git.status(root); latestStatus.set(ctx.key, snap); ctx.push({ type: "git:status", tabId: ctx.key, snapshot: snap }); } catch { /* keep last */ }
        if (refsChanged) ctx.push(await refsMsg(ctx.key));
        }
        if (descriptor) {
          activeJobs.delete(ctx.key);
          ctx.push({ type: "git:jobDone", tabId: ctx.key, job: descriptor, ok: !failed });
          ctx.push({ type: "git:job", tabId: ctx.key, job: null });
        }
      }
    },
  });

  return () => { off(); offSubtree(); };
}

function jobFor(msg: any): Omit<GitJob, "startedAt"> | null {
  switch (msg.type) {
    case "git:fetch": return { kind: "fetch", label: msg.remote ? `Fetching ${msg.remote}` : "Fetching all remotes" };
    case "git:pull": return { kind: "pull", label: `Pulling with ${msg.strategy}` };
    case "git:push": return { kind: "push", label: `Pushing ${msg.branch}` };
    case "git:checkout": return { kind: "checkout", label: `Checking out ${msg.branch}` };
    case "git:checkoutRemote": return { kind: "checkout", label: `Checking out ${msg.branch}` };
    case "git:cherry-pick": return { kind: "cherry-pick", label: `Cherry-picking ${String(msg.sha).slice(0, 7)}` };
    case "git:revert": return { kind: "revert", label: `Reverting ${String(msg.sha).slice(0, 7)}` };
    case "git:merge": return { kind: "merge", label: `Merging ${msg.ref}` };
    case "git:rebase": return { kind: "rebase", label: `Rebasing onto ${msg.ref}` };
    case "git:interactiveRebase": return { kind: "rebase", label: `Rewriting commits onto ${msg.upstream}` };
    case "git:reset": return { kind: "reset", label: `${msg.mode === "soft" ? "Soft" : "Mixed"} reset to ${String(msg.ref).slice(0, 12)}` };
    default: return null;
  }
}
