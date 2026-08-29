import { useEffect, useRef, useState } from "react";
import type { ClientHost } from "@tabterm/module-host/client";
import type { GitSnapshot, GitRefs, GitJob, GitOperationType, ConflictPayload, CommitContext, GitLogPayload, ComparePayload, ReflogEntry, FileInsightPayload, RebasePlan, StashDiffPayload } from "../shared.ts";
import { HostCtx } from "./useHost.ts";
import { ChangesPane } from "./git/ChangesPane.tsx";
import { DiffView } from "./git/DiffView.tsx";
import { CommitComposer } from "./git/CommitComposer.tsx";
import { HistoryView } from "./git/HistoryView.tsx";
import { RefsColumn } from "./git/RefsColumn.tsx";
import { ManageDialog } from "./git/ManageDialog.tsx";
import { TagCreateDialog } from "./git/TagCreateDialog.tsx";
import { BranchCreateDialog } from "./git/BranchCreateDialog.tsx";
import { ShortcutsHint } from "./git/ShortcutsHint.tsx";
import { ConflictEditor } from "./git/ConflictEditor.tsx";
import { CompareView } from "./git/CompareView.tsx";
import { RecoveryView } from "./git/RecoveryView.tsx";
import { FileInsightView } from "./git/FileInsightView.tsx";
import { RebasePlanView } from "./git/RebasePlanView.tsx";
import { StashView } from "./git/StashView.tsx";
import Notice from "./Notice.tsx";

type ManageTab = "remotes" | "submodules" | "subtrees" | "worktrees";
type GitTab = "changes" | "history" | "compare" | "recovery" | "file" | "rebase" | "stash";

export function GitPanel({ tabId, host }: { tabId: string; host: ClientHost }) {
  const snapshot = host.store.use((s) => s.gitStatus?.[tabId] as GitSnapshot | undefined);
  const noRepo   = host.store.use((s) => (s.gitNoRepo?.[tabId] as boolean | undefined) ?? false);
  const refs     = host.store.use((s) => s.gitRefs?.[tabId] as GitRefs | undefined);
  const error    = host.store.use((s) => (s.gitError?.[tabId] as string | null | undefined) ?? null);
  const diff     = host.store.use((s) => s.gitDiff?.[tabId] ?? null);
  const conflict = host.store.use((s) => (s.gitConflict?.[tabId] as ConflictPayload | undefined) ?? null);
  const log      = host.store.use((s) => s.gitLog?.[tabId] as GitLogPayload | undefined);
  const commitDiff = host.store.use((s) => s.gitCommitDiff?.[tabId] ?? null);
  const compare    = host.store.use((s) => s.gitCompare?.[tabId] as ComparePayload | undefined);
  const reflog     = host.store.use((s) => s.gitReflog?.[tabId] as ReflogEntry[] | undefined);
  const fileInsight = host.store.use((s) => s.gitFileInsight?.[tabId] as FileInsightPayload | undefined);
  const rebasePlan = host.store.use((s) => s.gitRebasePlan?.[tabId] as RebasePlan | undefined);
  const stashDiff = host.store.use((s) => s.gitStashDiff?.[tabId] as StashDiffPayload | undefined);
  const commitContext = host.store.use((s) => (s.gitCommitContext?.[tabId] as CommitContext | undefined));
  const job       = host.store.use((s) => (s.gitJob?.[tabId] as GitJob | null | undefined) ?? null);

  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [discardConfirming, setDiscardConfirming] = useState(false);
  const [activeTab, setActiveTab] = useState<GitTab>("changes");
  const [manageOpen, setManageOpen] = useState<null | ManageTab>(null);
  const [tagCreateOpen, setTagCreateOpen] = useState(false);
  const [branchCreateOpen, setBranchCreateOpen] = useState(false);
  const [historySelection, setHistorySelection] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const ready = !!snapshot;

  const send = (msg: Record<string, unknown>) => host.send(msg);
  const clearError = () => host.store.setState((s) => ({
    ...s,
    gitError: { ...(s.gitError ?? {}), [tabId]: null },
  }));

  useEffect(() => {
    host.send({ type: "git:subscribe", tabId });
    return () => { host.send({ type: "git:unsubscribe", tabId }); };
  }, [tabId]);
  useEffect(() => {
    if (snapshot) host.send({ type: "git:openCommitContext", tabId });
  }, [tabId, snapshot?.headSha]);
  useEffect(() => {
    if (snapshot || error) setInitializing(false);
  }, [snapshot, error]);

  // Focus the panel once it first renders. The keyboard shortcuts below are
  // scoped to focus living inside the panel, and nothing in it is otherwise
  // focusable — without this they'd never fire until a stray click on a button.
  useEffect(() => { if (ready) panelRef.current?.focus(); }, [tabId, ready]);
  useEffect(() => {
    if (activeTab === "history" && !log) send({ type: "git:openHistory", tabId });
  }, [activeTab, log, tabId]);
  useEffect(() => { if (compare) setActiveTab("compare"); }, [compare]);
  useEffect(() => { if (activeTab === "recovery" && !reflog) send({ type: "git:openReflog", tabId }); }, [activeTab, reflog, tabId]);
  useEffect(() => { if (fileInsight) setActiveTab("file"); }, [fileInsight]);
  useEffect(() => { if (rebasePlan) setActiveTab("rebase"); }, [rebasePlan]);
  useEffect(() => { if (stashDiff) setActiveTab("stash"); }, [stashDiff]);
  useEffect(() => {
    // Reads live state via refs so this listener binds once per tab instead of
    // re-binding on every poll (snapshot changes ~1.5s).
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      const sel = selectedRef.current;
      if (e.key === " ") {
        e.preventDefault();
        if (sel) {
          const target = sel.staged ? "git:unstage" : "git:stage";
          send({ type: target, tabId, paths: [sel.path] });
        }
        return;
      }
      if (e.key === "a") {
        const snap = snapshotRef.current;
        if (snap) send({ type: "git:stage", tabId, paths: snap.files.map(f => f.path) });
        return;
      }
      if (e.key === "c") {
        const i = document.querySelector<HTMLInputElement>("input[placeholder='Commit summary']");
        i?.focus();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId]);
  // Keep the selected file in sync with staging. When a file's stage state flips
  // (space-toggle, stage-all) or it disappears (discard/commit), follow it to the
  // other side and refetch its diff, or clear the selection — otherwise the diff
  // pane shows a stale side/header.
  useEffect(() => {
    if (!selected || !snapshot) return;
    const inUnstaged = snapshot.files.some(f => f.path === selected.path);
    const inStaged   = snapshot.staged.some(f => f.path === selected.path);
    if (!inUnstaged && !inStaged) { setSelected(null); return; }
    const stillThere = selected.staged ? inStaged : inUnstaged;
    if (!stillThere) {
      const nowStaged = inStaged;
      setSelected({ path: selected.path, staged: nowStaged });
      send({ type: "git:openDiff", tabId, path: selected.path, staged: nowStaged });
    }
  }, [snapshot, selected, tabId]);

  if (!snapshot) {
    // A real status always wins; until one arrives, the server tells us whether
    // this tab is a repo (stay in the loading gate) or not (offer initialization).
    if (noRepo) {
      const cwd = host.workspaces.get(tabId)?.cwd;
      const initialize = () => {
        clearError();
        setInitializing(true);
        send({ type: "git:init", tabId });
      };
      return (
        <div className="flex-1 float-card flex items-center justify-center p-6">
          <div className="max-w-lg text-center">
            <div className="text-[14px] font-semibold text-[var(--text)]">Not a Git repository</div>
            <div className="mt-1.5 text-[12.5px] text-[var(--muted)]">Initialize this workspace with a <span className="mono">main</span> branch.</div>
            {cwd && <div className="mt-2 mono text-[11.5px] text-[var(--faint)] break-all">{cwd}</div>}
            {error && <div className="mt-3 text-[12px] text-[var(--red)]">{error}</div>}
            <button
              type="button"
              disabled={initializing || !cwd}
              onClick={initialize}
              className="mt-4 px-3.5 py-1.5 rounded-md text-[12.5px] font-semibold text-[var(--panel)] bg-[var(--accent)] border border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:border-[var(--accent-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
            >{initializing ? "Initializing…" : "Initialize repository"}</button>
          </div>
        </div>
      );
    }
    return <div className="flex-1 float-card flex items-center justify-center text-[var(--faint)] text-sm">Reading repository…</div>;
  }

  const stage   = (paths: string[]) => send({ type: "git:stage",   tabId, paths });
  const unstage = (paths: string[]) => send({ type: "git:unstage", tabId, paths });
  const onSelect = (path: string, staged: boolean) => {
    setSelected({ path, staged });
    setDiscardConfirming(false);
    panelRef.current?.focus();
    const isConflict = !staged && snapshot.files.some(f => f.path === path && f.code === "U");
    send({ type: isConflict ? "git:openConflict" : "git:openDiff", tabId, path, staged });
  };

  return (
    <HostCtx.Provider value={host}>
      <div ref={panelRef} tabIndex={-1} className="flex-1 flex flex-col min-h-0 float-card overflow-hidden outline-none">
        <Header snapshot={snapshot} refs={refs} job={job} activeTab={activeTab} setActiveTab={setActiveTab}
          tabs={["changes", "history", "recovery", ...(compare ? ["compare" as const] : []), ...(fileInsight ? ["file" as const] : []), ...(rebasePlan ? ["rebase" as const] : []), ...(stashDiff ? ["stash" as const] : [])]}
          onSend={send} tabId={tabId} />
        {error && (
          <Notice
            variant="error"
            layout="bar"
            title="Git error"
            mono
            className="text-[12px]"
            onDismiss={clearError}
          >
            {error}
          </Notice>
        )}
        {snapshot.operation && (
          <Notice
            variant="warning"
            layout="bar"
            title={`${operationLabel(snapshot.operation.type)} in progress`}
            className="text-[12px]"
            actions={
              snapshot.operation.type === "bisect" ? <>
                <button onClick={() => send({ type: "git:bisect", tabId, action: "good" })} className="text-[11.5px] font-bold text-[var(--green)]">Mark good</button>
                <button onClick={() => send({ type: "git:bisect", tabId, action: "bad" })} className="text-[11.5px] font-bold text-[var(--red)]">Mark bad</button>
                <button onClick={() => send({ type: "git:bisect", tabId, action: "skip" })} className="text-[11.5px] font-bold text-[var(--muted)]">Skip</button>
                <button onClick={() => send({ type: "git:bisect", tabId, action: "reset" })} className="text-[11.5px] font-bold text-[var(--accent-soft)]">End bisect</button>
              </> : <>
                <button
                  onClick={() => send({ type: "git:operationAction", tabId, action: "continue" })}
                  className="text-[11.5px] font-bold text-[var(--accent-soft)]"
                >Continue</button>
                {snapshot.operation.type !== "merge" && (
                  <button
                    onClick={() => send({ type: "git:operationAction", tabId, action: "skip" })}
                    className="text-[11.5px] font-bold text-[var(--muted)]"
                  >Skip</button>
                )}
                <button
                  onClick={() => send({ type: "git:operationAction", tabId, action: "abort" })}
                  className="text-[11.5px] font-bold text-[var(--red)]"
                >Abort</button>
              </>
            }
          >
            {snapshot.operation.type === "bisect" ? "Test the checked-out commit, then mark it good or bad to narrow down the first broken revision."
              : snapshot.operation.current !== null && snapshot.operation.total !== null
              ? `Step ${snapshot.operation.current} of ${snapshot.operation.total}. Resolve conflicted files before continuing.`
              : "Resolve conflicted files before continuing or aborting the operation."}
          </Notice>
        )}
        {activeTab === "changes" ? (
          <>
            <div className="flex-1 flex min-h-0">
              <RefsColumn refs={refs} tabId={tabId} onManage={(tab) => setManageOpen(tab)} onNewTag={() => setTagCreateOpen(true)} onNewBranch={() => setBranchCreateOpen(true)} />
              <ChangesPane
                unstaged={snapshot.files}
                staged={snapshot.staged}
                selectedPath={selected?.path ?? null}
                onSelect={onSelect}
                onStage={stage}
                onUnstage={unstage}
                onIgnore={(paths) => send({ type: "git:ignore", tabId, paths })}
              />
              <div className="flex-1 flex flex-col min-w-0">
                {selected && snapshot.files.some(f => f.path === selected.path && f.code === "U") ? (
                  conflict?.path === selected.path ? (
                    <ConflictEditor
                      conflict={conflict}
                      onSave={(content) => send({ type: "git:resolveConflict", tabId, path: selected.path, content, delete: false })}
                      onChooseSide={(side) => send({ type: "git:resolveConflictSide", tabId, path: selected.path, side })}
                      onDelete={() => send({ type: "git:resolveConflict", tabId, path: selected.path, content: "", delete: true })}
                    />
                  ) : (
                    <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">Loading conflict…</div>
                  )
                ) : selected && diff?.path === selected.path && diff.staged === selected.staged ? (
                  <>
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--panel)]">
                      <span className="mono text-[12.5px] min-w-0 truncate" title={selected.path}>{selected.path}</span>
                      {discardConfirming ? (
                        <div className="shrink-0 ml-auto flex items-center gap-2 text-[12px] text-[var(--muted)]">
                          <span>Discard changes to this file?</span>
                          <button className="text-[11.5px] font-bold text-[var(--muted)] hover:text-[var(--text)]"
                            onClick={() => setDiscardConfirming(false)}>Cancel</button>
                          <button className="text-[11.5px] font-bold text-[var(--red)] hover:opacity-80"
                            onClick={() => { send({ type: "git:discard", tabId, paths: [selected.path] }); setDiscardConfirming(false); }}>Discard</button>
                        </div>
                      ) : (
                        <>
                          <span className="shrink-0 ml-auto text-[12px] text-[var(--muted)]">{selected.staged ? "staged" : "unstaged"}</span>
                          <button className="shrink-0 text-[11.5px] font-bold text-[var(--red)]"
                            onClick={() => setDiscardConfirming(true)}>discard file</button>
                          <button className="shrink-0 text-[11.5px] font-bold text-[var(--accent-soft)]"
                            onClick={() => send({ type: "git:openFileInsight", tabId, path: selected.path })}>blame &amp; history</button>
                        </>
                      )}
                    </div>
                    <DiffView
                      diff={diff as any}
                      onStageHunk={(patch, path, staged) => send({ type: "git:stageHunk", tabId, path, staged, patch })}
                    />
                  </>
                ) : (
                  <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">
                    {selected ? "Loading…" : "Select a file to see its diff."}
                  </div>
                )}
              </div>
            </div>
            <CommitComposer
              initialDraft={(host.kv.get(`commitDraft:${tabId}`) as any) ?? undefined}
              context={commitContext}
              stagedCount={snapshot.staged.length}
              branchLabel={snapshot.branch ?? snapshot.headSha ?? "—"}
              headSha={snapshot.headSha}
              onDraftChange={(draft) => host.kv.set(`commitDraft:${tabId}`, draft)}
              onCommit={(message, amend, signoff, sign) => send({ type: "git:commit", tabId, message, amend, signoff, sign })}
            />
          </>
        ) : activeTab === "history" ? (
          log ? <HistoryView
            entries={log.entries}
            requestedSha={historySelection}
            hasMore={log.hasMore}
            commitDiff={commitDiff as any}
            onOpenCommit={(sha) => send({ type: "git:openCommitDiff", tabId, sha })}
            onLoadMore={() => send({ type: "git:openHistory", tabId, limit: log.limit + 200, all: true })}
            onAction={(action, sha) => action === "bisect-start"
              ? send({ type: "git:bisect", tabId, action: "start", good: sha, bad: "HEAD" })
              : send({ type: `git:${action}`, tabId, sha })}
          /> : (
            <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">Loading…</div>
          )
        ) : activeTab === "compare" && compare ? (
          <CompareView compare={compare} />
        ) : activeTab === "recovery" && reflog ? (
          <RecoveryView
            entries={reflog}
            onRefresh={() => send({ type: "git:openReflog", tabId })}
            onRecover={(ref) => send({ type: "git:recoverBranch", tabId, ref })}
            onReset={(ref, mode) => send({ type: "git:reset", tabId, ref, mode })}
          />
        ) : activeTab === "file" && fileInsight ? (
          <FileInsightView insight={fileInsight} onOpenCommit={(sha) => { setHistorySelection(sha); setActiveTab("history"); }} />
        ) : activeTab === "rebase" && rebasePlan ? (
          <RebasePlanView plan={rebasePlan} onRun={(steps) => send({ type: "git:interactiveRebase", tabId, upstream: rebasePlan.upstream, steps })} />
        ) : activeTab === "stash" && stashDiff ? (
          <StashView stash={stashDiff} />
        ) : (
          <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">
            {activeTab === "compare" ? "Choose Compare with current from a branch menu."
              : activeTab === "file" ? "Choose blame & history from a changed file."
              : activeTab === "rebase" ? "Choose Interactive rebase from a branch menu."
              : activeTab === "stash" ? "Choose View from a stash."
              : "Loading recovery history…"}
          </div>
        )}
        <Footer snapshot={snapshot}><ShortcutsHint /></Footer>
        {manageOpen && (
          <ManageDialog
            tabId={tabId}
            initialTab={manageOpen}
            onClose={() => setManageOpen(null)}
          />
        )}
        {tagCreateOpen && (
          <TagCreateDialog
            tabId={tabId}
            refs={refs}
            snapshot={snapshot}
            onClose={() => setTagCreateOpen(false)}
            onSend={send}
          />
        )}
        {branchCreateOpen && (
          <BranchCreateDialog
            tabId={tabId}
            refs={refs}
            snapshot={snapshot}
            onClose={() => setBranchCreateOpen(false)}
            onSend={send}
          />
        )}
      </div>
    </HostCtx.Provider>
  );
}

function Header({ snapshot, refs, job, activeTab, setActiveTab, tabs, onSend, tabId }: {
  snapshot: GitSnapshot;
  refs: GitRefs | undefined;
  job: GitJob | null;
  activeTab: GitTab;
  setActiveTab: (t: GitTab) => void;
  tabs: GitTab[];
  onSend: (msg: Record<string, unknown>) => void;
  tabId: string;
}) {
  const [pullStrategy, setPullStrategy] = useState<"ff-only" | "rebase" | "merge">("ff-only");
  const hasRemote = !!refs?.remotes.length;
  const canPull = hasRemote && !!snapshot.upstream && !job;
  const canPush = hasRemote && !!snapshot.branch && !job;
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-[var(--panel)] border-b border-[var(--border)]">
      <span className="mono inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[12.5px] font-bold bg-[var(--brand-bg)] text-[var(--brand-fg)] border border-[color-mix(in_srgb,var(--accent)_35%,transparent)]">
        {snapshot.detached ? `${snapshot.headSha} (detached)` : snapshot.branch ?? "—"}
      </span>
      {job ? (
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]">
          <span className="inline-block w-[10px] h-[10px] rounded-full border-[1.5px] border-[var(--faint)] border-t-transparent animate-spin" />
          {job.label}…
          {["fetch", "pull", "push"].includes(job.kind) && <button className="ml-1 font-bold text-[var(--red)]" onClick={() => onSend({ type: "git:cancelJob", tabId })}>Cancel</button>}
        </span>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            disabled={!hasRemote}
            onClick={() => onSend({ type: "git:fetch", tabId, remote: null, prune: true })}
            className="px-2 py-1 rounded text-[11.5px] font-bold text-[var(--accent-soft)] hover:bg-[var(--hover)] disabled:opacity-35 disabled:cursor-not-allowed"
          >Fetch</button>
          <select
            aria-label="Pull strategy"
            value={pullStrategy}
            onChange={(e) => setPullStrategy(e.target.value as typeof pullStrategy)}
            disabled={!canPull}
            className="bg-[var(--bg)] border border-[var(--border)] rounded px-1.5 py-1 text-[11.5px] text-[var(--muted)] disabled:opacity-35"
          >
            <option value="ff-only">FF only</option>
            <option value="rebase">Rebase</option>
            <option value="merge">Merge</option>
          </select>
          <button
            disabled={!canPull}
            onClick={() => onSend({ type: "git:pull", tabId, strategy: pullStrategy })}
            className="px-2 py-1 rounded text-[11.5px] font-bold text-[var(--accent-soft)] hover:bg-[var(--hover)] disabled:opacity-35 disabled:cursor-not-allowed"
          >Pull</button>
          <button
            disabled={!canPush}
            onClick={() => onSend({
              type: "git:push",
              tabId,
              branch: snapshot.branch,
              remote: snapshot.upstream?.split("/")[0] ?? refs?.remotes[0]?.name ?? "origin",
              setUpstream: snapshot.upstream === null,
            })}
            className="px-2 py-1 rounded text-[11.5px] font-bold text-[var(--accent-soft)] hover:bg-[var(--hover)] disabled:opacity-35 disabled:cursor-not-allowed"
          >Push{snapshot.ahead ? ` · ${snapshot.ahead}` : ""}</button>
        </div>
      )}
      <div className="ml-auto flex gap-1">
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-3 py-1 rounded-t-md text-[12.5px] font-bold ${activeTab === t ? "bg-[var(--panel)] text-[var(--text)] border border-[var(--border)] border-b-[var(--panel)]" : "text-[var(--muted)]"}`}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

function operationLabel(type: GitOperationType): string {
  return type === "cherry-pick" ? "Cherry-pick" : type[0]!.toUpperCase() + type.slice(1);
}

function Footer({ snapshot, children }: { snapshot: GitSnapshot; children?: React.ReactNode }) {
  // Tick once a second so "updated Ns ago" advances between polls (and keeps
  // counting if a poll stalls), instead of freezing until the next snapshot.
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);
  const ahead  = snapshot.ahead  ?? "—";
  const behind = snapshot.behind ?? "—";
  const changed = snapshot.files.length;
  const staged  = snapshot.staged.length;
  const ago = Math.max(0, Math.round((Date.now() - snapshot.fetchedAt) / 1000));
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-[11.5px] text-[var(--muted)] bg-[var(--bg)] border-t border-[var(--border)]">
      <span className="mono">↑<b className="text-[var(--text)] font-bold">{ahead}</b> ↓<b className="text-[var(--text)] font-bold">{behind}</b></span>
      <span className="text-[var(--border-2)]">·</span>
      <span><b className="text-[var(--text)]">{changed}</b> changed · <b className="text-[var(--text)]">{staged}</b> staged</span>
      <span className="text-[var(--border-2)]">·</span>
      <span>updated {ago}s ago</span>
      <span className="ml-auto">{children}</span>
    </div>
  );
}
