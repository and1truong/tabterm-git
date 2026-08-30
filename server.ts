import type { ServerHost, RoomContext, Peer } from "@tabterm/module-host/server";
import * as git from "./server/git.ts";
import type { GitSnapshot, GitRefs, GitJob, GitOperation, Submodule } from "./shared.ts";
import { stat as pathStat, realpath as pathRealpath, readFile as pathReadFile } from "node:fs/promises";
import { dirname as pathDirname, join as joinPath, resolve as pathResolve } from "node:path";
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
// Mutations that may replace the checked-out tree — and therefore .gitmodules
// and the submodule list — force an eager `git submodule status` on their
// refs refresh instead of reusing the cached list on a throttled tick.
const TREE_CHANGING_MUTATIONS = new Set([
  "git:checkout", "git:checkoutRemote", "git:pull", "git:merge", "git:rebase", "git:interactiveRebase",
  "git:cherry-pick", "git:revert", "git:reset", "git:operationAction", "git:bisect",
  "git:stashCreate", "git:stashApply", "git:resolveConflict", "git:resolveConflictSide",
  "git:branchCreate", // checkout: true runs `git checkout -b` and switches the tree
  "git:submoduleUpdate", "git:submoduleUpdateRemote", "git:subtreeSync",
]);

function emptyRefs(): GitRefs {
  return { branches: [], remoteBranches: [], current: null, remotes: [], stashes: [], tags: [], submodules: [], worktrees: [] };
}

// Stable identity of an operation state, for change detection between polls.
function opKey(op: GitOperation | null): string {
  return op ? `${op.type}:${op.current ?? "-"}:${op.total ?? "-"}` : "-";
}

// Filesystem identity of a repository marker (.git), used to detect a
// repository replaced in place (e.g. `rm -rf .git && git init`) where path
// existence, root, and realpath target all stay the same. dev:ino alone can be
// reused when a directory is deleted and recreated on many filesystems, so a
// generation component is included:
//   - directory marker: birthtime (creation time) is monotonic and immutable
//     across normal git activity inside an existing .git (ctime of the
//     directory changes on every entry write, so it is not used);
//   - regular-file gitfile (linked worktrees / submodules): content hash
//     catches in-place pointer rewrites; the resolved gitdir target's own
//     identity catches replacing/retargeting the target behind an unchanged
//     pointer; a worktree admin's commondir text plus the resolved common
//     dir identity catches in-place administrative rewrites that retarget
//     the shared repository.
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function pathIdentity(p: string): Promise<string | null> {
  try {
    const st = await pathStat(p);
    if (st.isDirectory()) {
      return `d:${st.dev}:${st.ino}:${st.birthtimeMs || st.ctimeMs}`;
    }
    // Regular file: a .git gitfile (linked worktrees / submodules) pointing at
    // the real gitdir. In-place rewrites of the pointer are caught by the
    // content hash, and replacing/retargeting the gitdir BEHIND an unchanged
    // pointer (e.g. swapping the worktree admin dir for a symlink to another
    // repo's) is caught by resolving the target and folding its filesystem
    // identity in (realpath follows the swap, so the identities diverge).
    const content = await pathReadFile(p, "utf8");
    const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (m) {
      // gitfile paths are relative to the directory containing the .git file.
      const target = pathResolve(pathDirname(p), m[1]!);
      const resolved = await pathRealpath(target).catch(() => null);
      if (resolved) {
        try {
          const tst = await pathStat(resolved);
          let common = "";
          if (tst.isDirectory()) {
            // A worktree admin dir selects its shared repository via the
            // commondir file. Rewriting it in place (or the HEAD/index it
            // pairs with) is invisible to the directory's own dev/ino/
            // birthtime, so fold both the commondir text and the resolved
            // common dir's identity in.
            const cd = await pathReadFile(joinPath(resolved, "commondir"), "utf8").catch(() => null);
            if (cd !== null) {
              const text = cd.trim();
              common = `:${hashString(text)}`;
              const commonDir = await pathRealpath(pathResolve(resolved, text)).catch(() => null);
              if (commonDir) {
                const cst = await pathStat(commonDir).catch(() => null);
                if (cst) common += `:${cst.dev}:${cst.ino}:${cst.birthtimeMs || cst.ctimeMs}`;
              }
            }
          }
          return `f:${st.dev}:${st.ino}:${st.birthtimeMs || st.ctimeMs}:${hashString(content)}:${tst.dev}:${tst.ino}:${tst.birthtimeMs || tst.ctimeMs}${common}`;
        } catch { /* fall through to pointer-only identity */ }
      }
    }
    return `f:${st.dev}:${st.ino}:${st.birthtimeMs || st.ctimeMs}:${hashString(content)}`;
  } catch {
    return null;
  }
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
async function rootCacheValid(entry: { cwd: string; root: string | null; gitIdent: string | null }, real: string): Promise<boolean> {
  let p = real;
  // resolveRoot returns the caller's original cwd form when the cwd itself is
  // the toplevel (server/git.ts) — a symlinked cwd stays in symlink form. Its
  // realpath IS the repository root, so compare both in the same space.
  const stop = entry.root !== null && entry.root === entry.cwd ? real : entry.root;
  for (;;) {
    const id = await pathIdentity(joinPath(p, ".git"));
    if (id !== null) {
      // First marker found must be the cached root ITSELF, with the same
      // filesystem identity — a marker closer to the cwd (nested init), the
      // root's marker replaced in place, or the root reached without its
      // marker all invalidate the entry.
      if (stop === null) return false;
      return p === stop && id === entry.gitIdent;
    }
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
  const rootCache = new Map<string, { cwd: string; root: string | null; real: string; gitIdent: string | null }>();
  // Last successful submodule list per workspace, keyed with the root, its
  // realpath target, and the .git filesystem identity it was resolved against
  // and reused on throttled ticks so a `git:refs` push never resets the
  // sidebar to an empty submodule list — and never leaks a previous
  // repository's list across a root switch, symlink retarget, or in-place
  // repository replacement.
  const cachedSubmodules = new Map<string, { root: string; real: string; gitIdent: string | null; eagerGen: number; submodules: Submodule[] }>();
  // Per-workspace refresh generations. `refsGen` bumps on every refsMsg start;
  // `eagerGen` bumps only on EAGER refreshes (joins plus tree-changing
  // mutations). An in-flight refresh whose generation is no longer current
  // discards its result, but eager refreshes have priority over background
  // ticks: an eager result is superseded only by a NEWER eager refresh, while
  // a background result is superseded by any newer refresh and also refuses to
  // reuse a submodule cache that predates an in-flight eager refresh (the
  // cache entries carry the eager generation they were written with). Without
  // this, a tick-3/6 refresh overlapping a mutation's eager refresh could
  // broadcast stale submodules and get the fresh eager result discarded.
  const refsGen = new Map<string, number>();
  const eagerGen = new Map<string, number>();

  const gitIdentOf = async (root: string | null, cwd: string, real: string): Promise<string | null> =>
    root === null ? null : await pathIdentity(joinPath(root === cwd ? real : root, ".git"));

  const rootForInfo = async (key: string): Promise<{ root: string | null; real: string; gitIdent: string | null }> => {
    const cwd = host.workspaces.get(key)?.cwd;
    if (!cwd) { rootCache.delete(key); return { root: null, real: "", gitIdent: null }; }
    let real: string;
    try { real = await pathRealpath(cwd); } catch { rootCache.delete(key); return { root: null, real: "", gitIdent: null }; }
    const entry = rootCache.get(key);
    if (entry && entry.cwd === cwd && entry.real === real && await rootCacheValid(entry, real)) return { root: entry.root, real, gitIdent: entry.gitIdent };
    const root = await git.resolveRoot(cwd);
    const gitIdent = await gitIdentOf(root, cwd, real);
    rootCache.set(key, { cwd, root, real, gitIdent });
    return { root, real, gitIdent };
  };

  const rootFor = async (key: string): Promise<string | null> => (await rootForInfo(key)).root;

  // Pushes the refs message itself (or the error/empty messages) once the
  // result is known to be current, so the guarded check and the push happen in
  // the same synchronous block — an awaiting caller could otherwise resume
  // after a mutation reservation landed and push superseded data. `passive` is
  // for peer-scoped join refreshes: they capture but do not advance the shared
  // generations (a join must not supersede a pending room broadcast, and
  // overlapping joins must not invalidate each other), yet they still discard
  // their result when an authoritative refresh changed the generations or the
  // repository identity after they started — otherwise a join finishing after
  // a mutation would deliver pre-mutation refs and tag the stale submodule
  // list with the new eager generation.
  async function refsMsg(key: string, includeSubmodules: boolean, push: (msg: unknown) => void, passive = false): Promise<void> {
    const gen = (refsGen.get(key) ?? 0) + 1;
    const isEager = includeSubmodules;
    const genAtStart = refsGen.get(key) ?? 0;
    const eagerAtStart = eagerGen.get(key) ?? 0;
    if (!passive) {
      refsGen.set(key, gen);
      if (isEager) eagerGen.set(key, gen);
    }
    // True when a newer refresh (or, for eager results, a newer eager or
    // reservation; for background ticks, any newer refresh or reservation)
    // started after this one — or, for passive joins, when the eager
    // generation advanced after they started.
    const superseded = (): boolean => {
      if (isEager) {
        // An eager result is superseded by a newer eager (or reservation); a
        // passive join additionally yields to ANY newer refresh (refsGen
        // advance) so an older join cannot deliver (or error) after an
        // authoritative room refresh.
        if (passive) return (refsGen.get(key) ?? 0) !== genAtStart || (eagerGen.get(key) ?? 0) !== eagerAtStart;
        return eagerGen.get(key) !== gen;
      }
      return (refsGen.get(key) !== (passive ? genAtStart : gen)) || (eagerGen.get(key) ?? 0) !== eagerAtStart;
    };
    const start = await rootForInfo(key);
    const root = start.root;
    if (!root) { push({ type: "git:refs", tabId: key, refs: emptyRefs() }); return; }
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
        // same root, realpath target, AND .git identity (a diverging identity
        // means the repository was replaced: an empty list is factually
        // correct for a fresh repo, never a leak of the previous one), and
        // only when no eager refresh has started since the cache was written
        // (its eager generation still matches): reusing a cache an eager
        // refresh is about to update would broadcast mixed refs + stale
        // submodules, so that push is skipped entirely.
        const cached = cachedSubmodules.get(key);
        const cacheSafe = !!cached && cached.root === root && cached.real === start.real && cached.gitIdent === start.gitIdent;
        if (cacheSafe && cached!.eagerGen === (eagerGen.get(key) ?? 0)) {
          submodules = cached!.submodules;
        } else if (cacheSafe) {
          return;
        } else {
          submodules = [];
        }
      }
      // Revalidate AFTER every awaited subprocess — a repository boundary may
      // have changed (e.g. a terminal `git init`) or the cwd symlink been
      // retargeted while any of them was running, including the slow
      // `git submodule status`. Discard the result instead of
      // caching/broadcasting the superseded root's refs; the next refs tick
      // recomputes against the new root.
      const latest = await rootForInfo(key);
      if (latest.root !== start.root || latest.real !== start.real || latest.gitIdent !== start.gitIdent) return;
      if (superseded()) return;
      const current = all.branches.find((b) => b.current)?.name ?? null;
      const refs: GitRefs = { branches: all.branches, remoteBranches: all.remoteBranches, current, remotes, stashes, tags: all.tags, submodules, worktrees };
      if (due) cachedSubmodules.set(key, { root, real: start.real, gitIdent: start.gitIdent, submodules, eagerGen: eagerGen.get(key) ?? 0 });
      // Check and push are synchronous here — the result cannot be superseded
      // between validation and delivery.
      push({ type: "git:refs", tabId: key, refs });
    } catch (e) {
      // Superseded or old-root errors must not be delivered either: the client
      // stores git:error persistently and a later successful git:refs message
      // does not clear it, so an obsolete error would linger after the
      // authoritative refresh succeeded. All guards run AFTER the awaited
      // identity revalidation — the generation check passes as the final
      // synchronous step before delivery.
      const latest = await rootForInfo(key);
      if (latest.root !== start.root || latest.real !== start.real || latest.gitIdent !== start.gitIdent) return;
      if (superseded()) return;
      push({ type: "git:error", tabId: key, message: `Unable to refresh refs: ${(e as Error).message}` });
    }
  }

  const off = host.room("git", {
    prefixes: ["git"],
    keyOf: (m) => m.tabId ?? null,
    subscribeType: "git:subscribe",
    unsubscribeType: "git:unsubscribe",
    pollMs: POLL_MS,
    poll: async (ctx: RoomContext) => {
      const start = await rootForInfo(ctx.key);
      const root = start.root;
      if (!root) return undefined;
      const t = (refsTick.get(ctx.key) ?? 0) + 1;
      refsTick.set(ctx.key, t);
      let out: { snapshot: GitSnapshot; raw: string };
      try { out = await git.statusWithRaw(root); } catch { rootCache.delete(ctx.key); return undefined; }
      // A repository boundary may have changed (e.g. a terminal `git init`)
      // while git status was running — discard the snapshot of the superseded
      // root instead of caching/pushing it; the next poll recomputes.
      const latest = await rootForInfo(ctx.key);
      if (latest.root !== start.root || latest.real !== start.real || latest.gitIdent !== start.gitIdent) return undefined;
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
      if (t % REFS_EVERY === 0) await refsMsg(ctx.key, false, (m) => ctx.push(m));
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
      await refsMsg(ctx.key, true, (m) => peer.send(m), true);
    },
    onIdle: (key: string) => { latestStatus.delete(key); lastStatusOut.delete(key); refsTick.delete(key); activeJobs.delete(key); rootCache.delete(key); cachedSubmodules.delete(key); refsGen.delete(key); eagerGen.delete(key); },
    onRequest: async (ctx: RoomContext, msg: any, peer: Peer) => {
      const err = (m: string) => peer.send({ type: "git:error", tabId: ctx.key, message: m });
      if (msg.type === "git:init") {
        const cwd = host.workspaces.get(ctx.key)?.cwd;
        if (!cwd) { err("Workspace directory not found."); return; }
        try {
          rootCache.delete(ctx.key); // may have cached "no repo" for this cwd
          const root = await git.initRepository(cwd);
          const real = await pathRealpath(cwd);
          const gitIdent = await gitIdentOf(root, cwd, real);
          rootCache.set(ctx.key, { cwd, root, real, gitIdent });
          const out = await git.statusWithRaw(root);
          lastStatusOut.set(ctx.key, out.raw + "\u0000" + opKey(out.snapshot.operation));
          latestStatus.set(ctx.key, out.snapshot);
          refsTick.set(ctx.key, 0);
          ctx.push({ type: "git:status", tabId: ctx.key, snapshot: out.snapshot });
          await refsMsg(ctx.key, false, (m) => ctx.push(m));
        } catch (e) {
          err((e as Error).message);
        }
        return;
      }
      const start = await rootForInfo(ctx.key);
      const root = start.root;
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
            refresh = true; refsChanged = true; // a resolved .gitmodules may change the submodule list
            if (msg.delete) await git.deleteConflictResolution(root, msg.path);
            else await git.saveConflictResolution(root, msg.path, msg.content);
            break;
          case "git:resolveConflictSide":
            refresh = true; refsChanged = true;
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
        // Reserve the eager refresh generation as soon as a tree-changing
        // mutation completes, BEFORE the awaited status and refs refresh below:
        // a throttled tick overlapping this window would otherwise still match
        // the pre-mutation cache generation and broadcast stale submodules
        // ahead of the eager refresh.
        if (TREE_CHANGING_MUTATIONS.has(msg.type)) {
          eagerGen.set(ctx.key, (eagerGen.get(ctx.key) ?? 0) + 1);
        }
        let out: { snapshot: GitSnapshot; raw: string };
        try {
          out = await git.statusWithRaw(root);
          // Discard the refresh snapshot when the workspace root changed while
          // the request was in flight (same race as the poll path); the next
          // poll recomputes against the current root.
          const latest = await rootForInfo(ctx.key);
          if (latest.root === start.root && latest.real === start.real && latest.gitIdent === start.gitIdent) {
            lastStatusOut.set(ctx.key, out.raw + "\u0000" + opKey(out.snapshot.operation));
            latestStatus.set(ctx.key, out.snapshot);
            ctx.push({ type: "git:status", tabId: ctx.key, snapshot: out.snapshot });
          }
        } catch { /* keep last */ }
        if (refsChanged) await refsMsg(ctx.key, TREE_CHANGING_MUTATIONS.has(msg.type), (m) => ctx.push(m));
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
