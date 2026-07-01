import { useEffect, useRef, useState } from "react";
import type { ClientHost } from "@tabterm/module-host/client";
import type { GitSnapshot, GitRefs } from "../shared.ts";
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
import Notice from "./Notice.tsx";

type ManageTab = "remotes" | "submodules" | "subtrees";

export function GitPanel({ tabId, host }: { tabId: string; host: ClientHost }) {
  const snapshot = host.store.use((s) => s.gitStatus?.[tabId] as GitSnapshot | undefined);
  const noRepo   = host.store.use((s) => (s.gitNoRepo?.[tabId] as boolean | undefined) ?? false);
  const refs     = host.store.use((s) => s.gitRefs?.[tabId] as GitRefs | undefined);
  const error    = host.store.use((s) => (s.gitError?.[tabId] as string | null | undefined) ?? null);
  const diff     = host.store.use((s) => s.gitDiff?.[tabId] ?? null);
  const log      = host.store.use((s) => s.gitLog?.[tabId] as any[] | undefined);
  const commitDiff = host.store.use((s) => s.gitCommitDiff?.[tabId] ?? null);

  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [discardConfirming, setDiscardConfirming] = useState(false);
  const [activeTab, setActiveTab] = useState<"changes" | "history">("changes");
  const [manageOpen, setManageOpen] = useState<null | ManageTab>(null);
  const [tagCreateOpen, setTagCreateOpen] = useState(false);
  const [branchCreateOpen, setBranchCreateOpen] = useState(false);
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

  // Focus the panel once it first renders. The keyboard shortcuts below are
  // scoped to focus living inside the panel, and nothing in it is otherwise
  // focusable — without this they'd never fire until a stray click on a button.
  useEffect(() => { if (ready) panelRef.current?.focus(); }, [tabId, ready]);
  useEffect(() => {
    if (activeTab === "history" && !log) send({ type: "git:openHistory", tabId });
  }, [activeTab, log, tabId]);
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
    // this tab is a repo (stay in the loading gate) or not (show not-a-repo).
    return noRepo
      ? <div className="flex-1 float-card flex items-center justify-center text-[var(--muted)] text-sm">Not a git repository.</div>
      : <div className="flex-1 float-card flex items-center justify-center text-[var(--faint)] text-sm">Reading repository…</div>;
  }

  const stage   = (paths: string[]) => send({ type: "git:stage",   tabId, paths });
  const unstage = (paths: string[]) => send({ type: "git:unstage", tabId, paths });
  const onSelect = (path: string, staged: boolean) => {
    setSelected({ path, staged });
    setDiscardConfirming(false);
    panelRef.current?.focus();
    send({ type: "git:openDiff", tabId, path, staged });
  };

  return (
    <HostCtx.Provider value={host}>
      <div ref={panelRef} tabIndex={-1} className="flex-1 flex flex-col min-h-0 float-card overflow-hidden outline-none">
        <Header snapshot={snapshot} refs={refs} activeTab={activeTab} setActiveTab={setActiveTab} />
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
              />
              <div className="flex-1 flex flex-col min-w-0">
                {selected && diff ? (
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
              stagedCount={snapshot.staged.length}
              branchLabel={snapshot.branch ?? snapshot.headSha ?? "—"}
              headSha={snapshot.headSha}
              onCommit={(message, amend) => send({ type: "git:commit", tabId, message, amend })}
            />
          </>
        ) : (
          log ? <HistoryView entries={log as any} commitDiff={commitDiff as any} onOpenCommit={(sha) => send({ type: "git:openCommitDiff", tabId, sha })} /> : (
            <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">Loading…</div>
          )
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

function Header({ snapshot, refs: _refs, activeTab, setActiveTab }: {
  snapshot: GitSnapshot;
  refs: GitRefs | undefined;
  activeTab: "changes" | "history";
  setActiveTab: (t: "changes" | "history") => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-[var(--panel)] border-b border-[var(--border)]">
      <span className="mono inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[12.5px] font-bold bg-[var(--brand-bg)] text-[var(--brand-fg)] border border-[color-mix(in_srgb,var(--accent)_35%,transparent)]">
        {snapshot.detached ? `${snapshot.headSha} (detached)` : snapshot.branch ?? "—"}
      </span>
      <div className="ml-auto flex gap-1">
        {(["changes", "history"] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-3 py-1 rounded-t-md text-[12.5px] font-bold ${activeTab === t ? "bg-[var(--panel)] text-[var(--text)] border border-[var(--border)] border-b-[var(--panel)]" : "text-[var(--muted)]"}`}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
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
