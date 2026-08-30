import type { ServerHost, RoomContext, Peer } from "@tabterm/module-host/server";
import * as git from "./server/git.ts";
import type { GitSnapshot, GitRefs, GitJob, GitOperation, Submodule } from "./shared.ts";
import { stat as pathStat, realpath as pathRealpath } from "node:fs/promises";
import { dirname as pathDirname, join as joinPath } from "node:path";
import { subtreeMigrations } from "./server/subtreeMigrations.ts";
import { makeSubtreeDb } from "./server/subtreeDb.ts";
import { makeSubtreeService } from "./server/subtreeService.ts";

const POLL_MS = 1500;
const REFS_EVERY = 3; // ~4.5s at 1.5s poll
// `git submodule status` stats every submodule worktree and is by far the
// most expensive refs command; run it on a slower cadence (~13.5s) instead of
// piggybacking on every refs refresh. Changed/conflicted submodules still
// surface immediately through the porcelain status poll.
const SUBMODULES_EVERY = 9;
const SUBMODULE_MUTATIONS = new Set(["git:submoduleUpdate", "git:submoduleUpdateRemote", "git:subtreeSync"]);

function emptyRefs(): GitRefs {
  return { branches: [], remoteBranches: [], current: null, remotes: [], stashes: [], tags: [], submodules: [], worktrees: [] };
}

// Stable identity of an operation state, for change detection between polls.
function opKey(op: GitOperation | null): string {
  return op ? `${op.type}:${op.current ?? "-"}:${op.total ?? "-"}` : "-";
}

async function dirExists(p: string): Promise<boolean> {
  try { await pathStat(p); return true; } catch { return false; }
}

// A cached root is valid only while no repository boundary changed between the
// workspace cwd and that root (or, for a cached "no repo", anywhere up the
// tree). Walking up from the cwd:
//   - the first `.git` marker found must be the cached root itself — a marker
//     closer to the cwd (nested `git init`) or farther up (ancestor init, e.g.
//     `git init ..`) invalidates the entry;
//   - reaching the cached root without its own marker (repo deleted)
//     invalidates it too.
// Paths are compared in realpath space: resolveRoot returns a realpath'd root,
// and symlinked cwds (e.g. /tmp → /private/tmp on macOS) otherwise never meet
// it as a string prefix.
async function rootCacheValid(entry: { cwd: string; root: string | null }, real: string): Promise<boolean> {
  let p = real;
  // resolveRoot returns the caller's original cwd form when the cwd itself is
  // the toplevel (server/git.ts) — a symlinked cwd stays in symlink form. Its
  // realpath IS the repository root, so compare both in the same space.
  const stop = entry.root !== null && entry.root === entry.cwd ? real : entry.root;
  for (;;) {
    if (await dirExists(joinPath(p, ".git"))) return stop !== null && p === stop;
    if (stop !== null && p === stop) return false;   // root reached without its marker
    if (p === pathDirname(p)) return stop === null;  // filesystem root: stale only if a repo was cached
    p = pathDirname(p);
  }
}

export default function activate(host: ServerHost) {
  host.migrate(subtreeMigrations);
  const sdb = makeSubtreeDb(host.db);
  const subtreeSvc = makeSubtreeService(sdb, host.sync);
  const offSubtree = host.onMessage(["gitSubtree"], (msg) => subtreeSvc.handle(msg));
  host.registerRoute("GET", "/subtrees", () => Response.json({ subtrees: sdb.list() }));

  const latestStatus = new Map<string, GitSnapshot>();
  // Fingerprint (status stdout + operation) of the last pushed snapshot — a
  // repo that hasn't changed must not re-render the client or re-serialize a
  // potentially huge payload every poll.
  const lastStatusOut = new Map<string, string>();
  const refsTick = new Map<string, number>();
  const activeJobs = new Map<string, GitJob>();
  // Resolved roots are stable for a workspace cwd. Resolving spawns
  // `git rev-parse --show-toplevel` (~30ms), so cache and re-resolve only when
  // the cwd moves, the realpath target changes (symlink retarget), the cached
  // root disappears, or a `.git` marker appears closer to the cwd (e.g.
  // `git init` from a terminal). `real` pins the resolved target so a
  // symlinked cwd retargeted mid-session cannot pass an old cache entry.
  const rootCache = new Map<string, { cwd: string; root: string | null; real: string }>();
  // Last successful submodule list per workspace, keyed with the root AND its
  // realpath target it was resolved against and reused on throttled ticks so a
  // `git:refs` push never resets the sidebar to an empty submodule list — and
  // never leaks a previous repository's list across a root switch or symlink
  // retarget.
  const cachedSubmodules = new Map<string, { root: string; real: string; submodules: Submodule[] }>();

  const rootForInfo = async (key: string): Promise<{ root: string | null; real: string }> => {
    const cwd = host.workspaces.get(key)?.cwd;
    if (!cwd) { rootCache.delete(key); return { root: null, real: "" }; }
    let real: string;
    try { real = await pathRealpath(cwd); } catch { rootCache.delete(key); return { root: null, real: "" }; }
    const entry = rootCache.get(key);
    if (entry && entry.cwd === cwd && entry.real === real && await rootCacheValid(entry, real)) return { root: entry.root, real };
    const root = await git.resolveRoot(cwd);
    rootCache.set(key, { cwd, root, real });
    return { root, real };
  };

  const rootFor = async (key: string): Promise<string | null> => (await rootForInfo(key)).root;

  async function refsMsg(key: string, includeSubmodules = false) {
    const start = await rootForInfo(key);
    const root = start.root;
    if (!root) return { type: "git:refs", tabId: key, refs: emptyRefs() };
    try {
      const [all, remotes, stashes, worktrees] = await Promise.all([
        git.refsOf(root), git.remotes(root), git.stashes(root), git.worktrees(root),
      ]);
      const due = includeSubmodules || (refsTick.get(key) ?? 0) % SUBMODULES_EVERY === 0;
      let submodules: Submodule[];
      if (due) {
        submodules = await git.submodules(root);
      } else {
        // Throttled ticks reuse the last successful list — but only for the
        // same root AND realpath target, so a repository-boundary change
        // (e.g. a nested `git init`) or symlink retarget never broadcasts the
        // previous repository's submodules.
        const cached = cachedSubmodules.get(key);
        submodules = cached && cached.root === root && cached.real === start.real ? cached.submodules : [];
      }
      // Revalidate AFTER every awaited subprocess — a repository boundary may
      // have changed (e.g. a terminal `git init`) or the cwd symlink been
      // retargeted while any of them was running, including the slow
      // `git submodule status`. Discard the result instead of
      // caching/broadcasting the superseded root's refs; the next refs tick
      // recomputes against the new root.
      const latest = await rootForInfo(key);
      if (latest.root !== start.root || latest.real !== start.real) return null;
      const current = all.branches.find((b) => b.current)?.name ?? null;
      const refs: GitRefs = { branches: all.branches, remoteBranches: all.remoteBranches, current, remotes, stashes, tags: all.tags, submodules, worktrees };
      if (due) cachedSubmodules.set(key, { root, real: start.real, submodules });
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
      const t = (refsTick.get(ctx.key) ?? 0) + 1;
      refsTick.set(ctx.key, t);
      let out: { snapshot: GitSnapshot; raw: string };
      try { out = await git.statusWithRaw(root); } catch { rootCache.delete(ctx.key); return undefined; }
      // Skip the push entirely when nothing changed (raw stdout AND operation
      // state — a merge/cherry-pick/revert can start without touching files).
      // The host keeps polling regardless of the returned value.
      const fingerprint = out.raw + "\u0000" + opKey(out.snapshot.operation);
      if (lastStatusOut.get(ctx.key) !== fingerprint) {
        lastStatusOut.set(ctx.key, fingerprint);
        latestStatus.set(ctx.key, out.snapshot);
        ctx.push({ type: "git:status", tabId: ctx.key, snapshot: out.snapshot });
      }
      // Refs are independent of the working tree; push after status so a slow
      // refs refresh (submodule status) never delays the status message.
      if (t % REFS_EVERY === 0) { const refs = await refsMsg(ctx.key); if (refs) ctx.push(refs); }
      return undefined;
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
      // A fresh join sees submodules immediately; the cadence only throttles
      // the background refreshes.
      const refs = await refsMsg(ctx.key, true);
      if (refs) peer.send(refs);
    },
    onIdle: (key: string) => { latestStatus.delete(key); lastStatusOut.delete(key); refsTick.delete(key); activeJobs.delete(key); rootCache.delete(key); cachedSubmodules.delete(key); },
    onRequest: async (ctx: RoomContext, msg: any, peer: Peer) => {
      const err = (m: string) => peer.send({ type: "git:error", tabId: ctx.key, message: m });
      if (msg.type === "git:init") {
        const cwd = host.workspaces.get(ctx.key)?.cwd;
        if (!cwd) { err("Workspace directory not found."); return; }
        try {
          rootCache.delete(ctx.key); // may have cached "no repo" for this cwd
          const root = await git.initRepository(cwd);
          rootCache.set(ctx.key, { cwd, root, real: await pathRealpath(cwd) });
          const out = await git.statusWithRaw(root);
          lastStatusOut.set(ctx.key, out.raw + "\u0000" + opKey(out.snapshot.operation));
          latestStatus.set(ctx.key, out.snapshot);
          refsTick.set(ctx.key, 0);
          ctx.push({ type: "git:status", tabId: ctx.key, snapshot: out.snapshot });
          const refs = await refsMsg(ctx.key);
          if (refs) ctx.push(refs);
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
          case "git:resolveConflictSide":
            refresh = true;
            if (msg.side !== "ours" && msg.side !== "theirs") throw new Error("Invalid conflict side.");
            await git.chooseConflictSide(root, msg.path, msg.side);
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
        let out: { snapshot: GitSnapshot; raw: string };
        try {
          out = await git.statusWithRaw(root);
          lastStatusOut.set(ctx.key, out.raw + "\u0000" + opKey(out.snapshot.operation));
          latestStatus.set(ctx.key, out.snapshot);
          ctx.push({ type: "git:status", tabId: ctx.key, snapshot: out.snapshot });
        } catch { /* keep last */ }
        if (refsChanged) { const refs = await refsMsg(ctx.key, SUBMODULE_MUTATIONS.has(msg.type)); if (refs) ctx.push(refs); }
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
