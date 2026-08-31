import { memo, useEffect, useRef, useState, useLayoutEffect } from "react";
import { useHost } from "../useHost.ts";
import type { GitRefs, Branch, RemoteBranch, Stash, Submodule } from "../../shared.ts";

type ManageTab = "remotes" | "submodules" | "subtrees" | "worktrees";

interface Props {
  refs: GitRefs | undefined;
  tabId: string;
  onManage: (tab: ManageTab) => void;
  onNewTag: () => void;
  onNewBranch: () => void;
}

export const RefsColumn = memo(function RefsColumn({ refs, tabId, onManage, onNewTag, onNewBranch }: Props) {
  const host = useHost();
  const [newBranch, setNewBranch] = useState("");
  const [addingBranch, setAddingBranch] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const [newStash, setNewStash] = useState("");
  const [addingStash, setAddingStash] = useState(false);
  const [stashUntracked, setStashUntracked] = useState(false);
  const [stashKeepIndex, setStashKeepIndex] = useState(false);
  const [menu, setMenu] = useState<{ branch: Branch; x: number; y: number } | null>(null);
  const [pushingBranch, setPushingBranch] = useState<string | null>(null);
  const pushErrRef = useRef<string | null>(null);
  const gitError = host.store.use((s) => (s.gitError?.[tabId] as string | null | undefined) ?? null);

  // Close the "+ new" branch menu on outside click or Escape.
  useEffect(() => {
    if (!branchMenuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) setBranchMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setBranchMenuOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [branchMenuOpen]);

  // Clear the in-flight push indicator once refs refresh shows the branch is no
  // longer ahead (success), or an error surfaces (failure). Mirrors how the
  // commit composer clears on HEAD advance.
  useEffect(() => {
    if (!pushingBranch) return;
    const b = (refs?.branches ?? []).find((x) => x.name === pushingBranch);
    if (!b || b.ahead === 0 || (gitError !== null && gitError !== pushErrRef.current)) setPushingBranch(null);
  }, [refs, gitError, pushingBranch]);

  const branches  = refs?.branches   ?? [];
  const remoteBranches = refs?.remoteBranches ?? [];
  const remotes   = refs?.remotes    ?? [];
  const stashes   = refs?.stashes    ?? [];
  const tags      = refs?.tags       ?? [];
  const submodules = refs?.submodules ?? [];
  const worktrees = refs?.worktrees ?? [];

  // gitSubtrees is module-owned: seeded on ManageDialog mount via GET /subtrees
  // and kept live by the module's gitSubtree service (host.sync → module:patch).
  const subtreeCount = host.store.use((s) =>
    Object.values((s.gitSubtrees ?? {}) as Record<string, { primaryTabId: string }>)
      .filter((t) => t.primaryTabId === tabId).length
  );

  const send = (msg: Record<string, unknown>) => host.send(msg);

  const checkout = (name: string) => send({ type: "git:checkout", tabId, branch: name });
  const deleteBranch = (name: string, force: boolean) => send({ type: "git:branchDelete", tabId, name, force });
  const pushBranch = (b: Branch) => {
    const remote = b.upstream ? b.upstream.split("/")[0]! : "origin";
    send({ type: "git:push", tabId, branch: b.name, remote, setUpstream: b.upstream === null });
    pushErrRef.current = gitError;
    setPushingBranch(b.name);
    setMenu(null);
  };
  const deleteTag = (name: string, remote: boolean) => send({ type: "git:tagDelete", tabId, name, remote });
  const createBranch = () => {
    const name = newBranch.trim();
    if (name) { send({ type: "git:branchCreate", tabId, name, from: null, checkout: false }); }
    setNewBranch(""); setAddingBranch(false);
  };
  const createStash = () => {
    const message = newStash.trim();
    send({ type: "git:stashCreate", tabId, message, options: { includeUntracked: stashUntracked, keepIndex: stashKeepIndex } });
    setNewStash(""); setAddingStash(false); setStashUntracked(false); setStashKeepIndex(false);
  };

  return (
    <div className="w-[208px] shrink-0 flex flex-col min-h-0 border-r border-[var(--border)] bg-[var(--panel)] overflow-y-auto">

      {/* Local Branches */}
      <SectTitle label="Local" count={branches.length} raised={branchMenuOpen}>
        <div ref={branchMenuRef} className="relative ml-auto">
          <button
            className="text-[10.5px] text-[var(--accent-soft)] font-bold"
            onClick={() => setBranchMenuOpen(v => !v)}
            title="New branch"
          >+ new ▾</button>
          {branchMenuOpen && (
            <div className="absolute right-0 top-6 z-40 w-[180px] p-1 rounded-lg bg-[var(--panel)] border border-[var(--border-2)] shadow-xl">
              <button
                className="w-full flex flex-col items-start px-2.5 py-1.5 rounded-md text-left text-[12px] text-[var(--text)] hover:bg-[var(--hover)] normal-case tracking-normal"
                onClick={() => { setBranchMenuOpen(false); setAddingBranch(true); }}
              >
                from HEAD
                <span className="text-[10px] font-normal text-[var(--faint)]">branch off current commit</span>
              </button>
              <button
                className="w-full flex flex-col items-start px-2.5 py-1.5 rounded-md text-left text-[12px] text-[var(--text)] hover:bg-[var(--hover)] normal-case tracking-normal"
                onClick={() => { setBranchMenuOpen(false); onNewBranch(); }}
              >
                from certain branch…
                <span className="text-[10px] font-normal text-[var(--faint)]">choose a base branch</span>
              </button>
            </div>
          )}
        </div>
      </SectTitle>
      {addingBranch && (
        <div className="px-2 py-1.5">
          <input
            autoFocus
            className="w-full mono text-[12px] px-2 py-1 rounded-md bg-[var(--bg)] border border-[var(--border-2)] text-[var(--text)] outline-none focus:outline-[var(--accent)] focus:outline-2 focus:-outline-offset-1"
            placeholder="branch-name"
            value={newBranch}
            onChange={e => setNewBranch(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") createBranch(); if (e.key === "Escape") { setAddingBranch(false); setNewBranch(""); } }}
          />
        </div>
      )}
      {branches.map(b => (
        <BranchRow
          key={b.name}
          branch={b}
          pushing={pushingBranch === b.name}
          menuOpen={menu?.branch.name === b.name}
          onContext={(branch, x, y) => setMenu({ branch, x, y })}
          onCheckout={() => !b.current && checkout(b.name)}
        />
      ))}

      {/* Remote branches */}
      <SectTitle label="Remotes" count={remoteBranches.length}>
        <button className="ml-auto text-[10.5px] text-[var(--accent-soft)] font-bold" onClick={() => onManage("remotes")}>manage</button>
      </SectTitle>
      {remoteBranches.map(branch => (
        <RemoteBranchRow key={branch.name} branch={branch} onCheckout={() => send({ type: "git:checkoutRemote", tabId, branch: branch.name, localName: branch.branch })} />
      ))}

      {/* Stashes */}
      <SectTitle label="Stashes" count={stashes.length}>
        <button
          className="ml-auto text-[10.5px] text-[var(--accent-soft)] font-bold"
          onClick={() => setAddingStash(v => !v)}
          title="New stash"
        >+ new</button>
      </SectTitle>
      {addingStash && (
        <div className="px-2 py-1.5">
          <input
            autoFocus
            className="w-full mono text-[12px] px-2 py-1 rounded-md bg-[var(--bg)] border border-[var(--border-2)] text-[var(--text)] outline-none focus:outline-[var(--accent)] focus:outline-2 focus:-outline-offset-1"
            placeholder="stash message"
            value={newStash}
            onChange={e => setNewStash(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") createStash(); if (e.key === "Escape") { setAddingStash(false); setNewStash(""); } }}
          />
          <div className="flex gap-3 mt-1.5 text-[10.5px] text-[var(--muted)]">
            <label className="flex items-center gap-1"><input type="checkbox" checked={stashUntracked} onChange={(e) => setStashUntracked(e.target.checked)} /> untracked</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={stashKeepIndex} onChange={(e) => setStashKeepIndex(e.target.checked)} /> keep staged</label>
          </div>
        </div>
      )}
      {stashes.map(s => <StashRow key={s.index} stash={s} tabId={tabId} onSend={send} />)}

      {/* Tags */}
      <SectTitle label="Tags" count={tags.length}>
        <button
          className="ml-auto text-[10.5px] text-[var(--accent-soft)] font-bold"
          onClick={onNewTag}
          title="New tag"
        >+ new</button>
      </SectTitle>
      {tags.map(t => (
        <TagRow key={t} name={t} hasRemote={remotes.length > 0} onDelete={deleteTag} />
      ))}

      {/* Submodules */}
      <SectTitle label="Submodules" count={submodules.length}>
        <button className="ml-auto text-[10.5px] text-[var(--accent-soft)] font-bold" onClick={() => onManage("submodules")}>manage</button>
      </SectTitle>
      {submodules.map(s => <SubmoduleRow key={s.path} sub={s} tabId={tabId} onSend={send} />)}

      {/* Worktrees */}
      <SectTitle label="Worktrees" count={worktrees.length}>
        <button className="ml-auto text-[10.5px] text-[var(--accent-soft)] font-bold" onClick={() => onManage("worktrees")}>manage</button>
      </SectTitle>
      {worktrees.map(worktree => (
        <RefRow key={worktree.path}>
          <span className="mono text-[12px] text-[var(--muted)] truncate" title={worktree.path}>{worktree.branch ?? worktree.head?.slice(0, 7) ?? "bare"}</span>
        </RefRow>
      ))}

      {/* Subtrees */}
      <SectTitle label="Subtrees" count={subtreeCount}>
        <button className="ml-auto text-[10.5px] text-[var(--accent-soft)] font-bold" onClick={() => onManage("subtrees")}>manage</button>
      </SectTitle>
      {menu && (
        <BranchContextMenu
          branch={menu.branch}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onCheckout={() => { checkout(menu.branch.name); setMenu(null); }}
          onPush={() => pushBranch(menu.branch)}
          onMerge={() => { send({ type: "git:merge", tabId, ref: menu.branch.name, noFf: false }); setMenu(null); }}
          onRebase={() => { send({ type: "git:rebase", tabId, ref: menu.branch.name }); setMenu(null); }}
          onInteractiveRebase={() => { send({ type: "git:openRebasePlan", tabId, upstream: menu.branch.name }); setMenu(null); }}
          onCompare={() => { send({ type: "git:compare", tabId, base: menu.branch.name, head: "HEAD" }); setMenu(null); }}
          onFetch={() => { send({ type: "git:fetch", tabId, remote: null, prune: true }); setMenu(null); }}
          onPull={() => { send({ type: "git:pull", tabId, strategy: "ff-only" }); setMenu(null); }}
          onCopy={() => { navigator.clipboard?.writeText(menu.branch.name); setMenu(null); }}
          onDelete={() => { deleteBranch(menu.branch.name, false); setMenu(null); }}
        />
      )}
    </div>
  );
});

function RemoteBranchRow({ branch, onCheckout }: { branch: RemoteBranch; onCheckout: () => void }) {
  return (
    <RefRow onClick={onCheckout}>
      <span className="w-2 h-2 rounded-full shrink-0 border border-[var(--faint)]" />
      <span className="mono text-[12px] text-[var(--muted)] truncate" title={`Checkout ${branch.name}`}>
        <span className="text-[var(--faint)]">{branch.remote}/</span>{branch.branch}
      </span>
    </RefRow>
  );
}

function SectTitle({ label, count, children, raised }: { label: string; count: number; children?: React.ReactNode; raised?: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)] border-b border-[var(--border)] sticky top-0 bg-[var(--panel)] ${raised ? "z-30" : "z-10"}`}>
      <span>{label}</span>
      <span className="text-[var(--border-2)] font-normal normal-case tracking-normal">{count}</span>
      {children}
    </div>
  );
}

function RefRow({ children, onClick, active }: { children: React.ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] ${onClick ? "cursor-pointer" : ""} ${active ? "bg-[var(--active)]" : onClick ? "hover:bg-[var(--hover)]" : ""}`}
    >
      {children}
    </div>
  );
}

function BranchRow({ branch, pushing, onContext, menuOpen, onCheckout }: {
  branch: Branch;
  pushing: boolean;
  menuOpen: boolean;
  onContext: (branch: Branch, x: number, y: number) => void;
  onCheckout: () => void;
}) {
  const isCurrent = branch.current;
  const ahead  = branch.ahead;
  const behind = branch.behind;
  const tracking = (ahead || behind) ? `${ahead > 0 ? `↑${ahead}` : ""}${behind > 0 ? `↓${behind}` : ""}`.trim() : "·";

  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); onContext(branch, e.clientX, e.clientY); }}
      onDoubleClick={onCheckout}
      title={branch.current ? "Current branch" : `Double-click to checkout ${branch.name}`}
      className={`group flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] cursor-default ${
        menuOpen ? "bg-[var(--hover)] outline outline-1 -outline-offset-1 outline-[var(--border-2)]"
        : isCurrent ? "bg-[var(--active)]" : "hover:bg-[var(--hover)]"
      }`}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${isCurrent ? "bg-[var(--accent)]" : "opacity-0"}`} />
      <span className={`mono truncate flex-1 min-w-0 ${isCurrent ? "text-[var(--text)] font-bold" : "text-[var(--muted)]"}`}>
        {branch.name}
      </span>
      {pushing ? (
        <span className="mono text-[11px] text-[var(--faint)] shrink-0 flex items-center gap-1">
          <span className="inline-block w-[9px] h-[9px] rounded-full border-[1.5px] border-[var(--faint)] border-t-transparent animate-spin" />
          pushing…
        </span>
      ) : (
        <span className="mono text-[11px] text-[var(--faint)] shrink-0">{tracking}</span>
      )}
      <button
        aria-label={`Open actions for ${branch.name}`}
        title={`Actions for ${branch.name}`}
        className={`w-5 shrink-0 rounded text-[14px] leading-none text-[var(--muted)] hover:bg-[var(--active)] hover:text-[var(--text)] ${menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onContext(branch, rect.left, rect.bottom + 4);
        }}
      >⋯</button>
    </div>
  );
}

function BranchContextMenu({ branch, x, y, onClose, onCheckout, onPush, onMerge, onRebase, onInteractiveRebase, onCompare, onFetch, onPull, onCopy, onDelete }: {
  branch: Branch;
  x: number;
  y: number;
  onClose: () => void;
  onCheckout: () => void;
  onPush: () => void;
  onMerge: () => void;
  onRebase: () => void;
  onInteractiveRebase: () => void;
  onCompare: () => void;
  onFetch: () => void;
  onPull: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState<"merge" | "rebase" | null>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const left = Math.min(Math.max(margin, x), Math.max(margin, viewWidth - rect.width - margin));
    const top = Math.min(Math.max(margin, y), Math.max(margin, viewHeight - rect.height - margin));
    if (left !== position.x || top !== position.y) setPosition({ x: left, y: top });
  }, [x, y, confirming, position.x, position.y]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  useEffect(() => {
    if (!ref.current) return;
    const onResize = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      const viewWidth = window.innerWidth;
      const viewHeight = window.innerHeight;
      const left = Math.min(Math.max(margin, position.x), Math.max(margin, viewWidth - rect.width - margin));
      const top = Math.min(Math.max(margin, position.y), Math.max(margin, viewHeight - rect.height - margin));
      if (left !== position.x || top !== position.y) setPosition({ x: left, y: top });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [position.x, position.y]);

  const publish = branch.upstream === null;

  return (
    <div
      ref={ref}
      className="fixed z-40 min-w-[188px] max-w-[260px] p-1 rounded-lg bg-[var(--panel)] border border-[var(--border-2)] shadow-xl"
      style={{ left: position.x, top: position.y, maxHeight: "min(70vh, 360px)", overflowY: "auto" }}
    >
      {!branch.current && (
        <>
          <MenuItem label="Checkout" onClick={onCheckout} />
          <MenuItem label="Merge into current" onClick={() => setConfirming("merge")} />
          <MenuItem label="Rebase current onto this" onClick={() => setConfirming("rebase")} />
          <MenuItem label="Interactive rebase…" onClick={onInteractiveRebase} />
        </>
      )}
      {confirming && (
        <div className="m-1 p-2 rounded bg-[var(--bg)] text-[11px] text-[var(--muted)]">
          <div>{confirming === "merge" ? `Merge ${branch.name} into the current branch?` : `Rewrite current commits onto ${branch.name}?`}</div>
          <div className="flex gap-2 mt-2">
            <button className="font-bold" onClick={() => setConfirming(null)}>Cancel</button>
            <button className="font-bold text-[var(--accent-soft)]" onClick={confirming === "merge" ? onMerge : onRebase}>Confirm</button>
          </div>
        </div>
      )}
      <MenuItem
        label={publish ? "Publish to origin" : "Push to origin"}
        hint={publish ? "set upstream" : branch.ahead > 0 ? `↑${branch.ahead}` : undefined}
        tone={publish ? "publish" : "push"}
        onClick={onPush}
      />
      {!branch.current && <MenuItem label="Compare with current" onClick={onCompare} />}
      <MenuItem label="Copy name" onClick={onCopy} />
      <div className="h-px bg-[var(--border)] mx-1.5 my-1" />
      <MenuItem label="Fetch all remotes" onClick={onFetch} />
      <MenuItem label="Pull (fast-forward only)" disabled={!branch.current || !branch.upstream} onClick={onPull} />
      {!branch.current && (
        <>
          <div className="h-px bg-[var(--border)] mx-1.5 my-1" />
          <MenuItem label="Delete branch" tone="danger" onClick={onDelete} />
        </>
      )}
    </div>
  );
}

function MenuItem({ label, hint, tone, disabled, onClick }: {
  label: string;
  hint?: string;
  tone?: "push" | "publish" | "danger";
  disabled?: boolean;
  onClick?: () => void;
}) {
  const color =
    disabled ? "text-[var(--faint)] opacity-55 cursor-default"
    : tone === "push" ? "text-[var(--accent-soft)]"
    : tone === "publish" ? "text-[var(--green)]"
    : tone === "danger" ? "text-[var(--red)]"
    : "text-[var(--text)]";
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[12.5px] ${color} ${disabled ? "" : "hover:bg-[var(--hover)]"}`}
    >
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[10px] text-[var(--faint)]">{hint}</span>}
    </button>
  );
}

function TagRow({ name, hasRemote, onDelete }: {
  name: string;
  hasRemote: boolean;
  onDelete: (name: string, remote: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <RefRow>
        <div className="flex flex-col gap-1 w-full min-w-0">
          <span className="text-[10.5px] text-[var(--muted)]">
            Delete tag <b className="mono text-[var(--text)]">{name}</b>?
          </span>
          <div className="flex items-center gap-2">
            <button
              className="text-[10.5px] font-bold text-[var(--muted)] hover:text-[var(--text)]"
              onClick={e => { e.stopPropagation(); setConfirming(false); }}
            >Cancel</button>
            <button
              className="text-[10.5px] font-bold text-[var(--red)] hover:opacity-80"
              onClick={e => { e.stopPropagation(); onDelete(name, false); setConfirming(false); }}
            >Delete</button>
            {hasRemote && (
              <button
                className="text-[10.5px] font-bold text-[var(--red)] bg-[color-mix(in_srgb,var(--red)_18%,transparent)] px-1.5 py-0.5 rounded hover:opacity-80"
                onClick={e => { e.stopPropagation(); onDelete(name, true); setConfirming(false); }}
                title="Delete locally and on origin"
              >Delete + remote</button>
            )}
          </div>
        </div>
      </RefRow>
    );
  }

  return (
    <RefRow>
      <span className="mono text-[12px] text-[var(--text)] truncate flex-1 min-w-0">{name}</span>
      <button
        className="opacity-0 group-hover:opacity-100 text-[10.5px] text-[var(--red)] font-bold shrink-0 px-0.5"
        onClick={e => { e.stopPropagation(); setConfirming(true); }}
        title="Delete tag"
      >✕</button>
    </RefRow>
  );
}

function StashRow({ stash, tabId, onSend }: { stash: Stash; tabId: string; onSend: (m: Record<string, unknown>) => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="group px-3 py-1.5 hover:bg-[var(--hover)]">
      <div className="mono text-[12px] text-[var(--muted)] truncate">{stash.message}</div>
      <div className="flex gap-2 mt-1 opacity-0 group-hover:opacity-100">
        {confirming ? (
          <>
            <span className="text-[10.5px] text-[var(--muted)]">Drop stash?</span>
            <button
              className="text-[10.5px] font-bold text-[var(--muted)] hover:text-[var(--text)]"
              onClick={() => setConfirming(false)}
            >Cancel</button>
            <button
              className="text-[10.5px] font-bold text-[var(--red)] hover:opacity-80"
              onClick={() => { onSend({ type: "git:stashDrop", tabId, index: stash.index }); setConfirming(false); }}
            >Drop</button>
          </>
        ) : (
          <>
            <button
              className="text-[10.5px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)]"
              onClick={() => onSend({ type: "git:openStash", tabId, index: stash.index })}
            >View</button>
            <button
              className="text-[10.5px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)]"
              onClick={() => onSend({ type: "git:stashApply", tabId, index: stash.index, pop: false })}
            >Apply</button>
            <button
              className="text-[10.5px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)]"
              onClick={() => onSend({ type: "git:stashApply", tabId, index: stash.index, pop: true })}
            >Pop</button>
            <button
              className="text-[10.5px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)]"
              onClick={() => setConfirming(true)}
            >Drop</button>
          </>
        )}
      </div>
    </div>
  );
}

function SubmoduleRow({ sub, tabId, onSend }: { sub: Submodule; tabId: string; onSend: (m: Record<string, unknown>) => void }) {
  return (
    <div className="group flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] hover:bg-[var(--hover)]">
      <span className={`mono text-[12px] truncate flex-1 min-w-0 ${sub.dirty ? "text-[var(--orange)]" : "text-[var(--muted)]"}`}>
        {sub.path}
      </span>
      <button
        className="opacity-0 group-hover:opacity-100 text-[10.5px] font-bold text-[var(--accent-soft)] shrink-0"
        onClick={() => onSend({ type: "git:submoduleUpdate", tabId, path: sub.path })}
        title="Update submodule"
      >Update</button>
    </div>
  );
}
