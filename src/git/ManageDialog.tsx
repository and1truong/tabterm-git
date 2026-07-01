import { useState, useEffect } from "react";
import { useHost } from "../useHost.ts";
import type { Remote, Submodule, GitSubtree } from "../../shared.ts";

const NETWORK_DISABLED_TITLE = "Network operations are not available in this version.";

type Tab = "remotes" | "submodules" | "subtrees";

interface Props {
  tabId: string;
  initialTab: Tab;
  onClose: () => void;
}

export function ManageDialog({ tabId, initialTab, onClose }: Props) {
  const host = useHost();
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const refs = host.store.use((s) => s.gitRefs?.[tabId] as any);
  const gitSubtrees = host.store.use((s) => (s.gitSubtrees ?? {}) as Record<string, GitSubtree>);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/modules/git/r/subtrees");
        if (!res.ok || cancelled) return;
        const { subtrees } = await res.json();
        for (const t of subtrees ?? []) host.store.patch({ entity: "gitSubtrees", op: "set", data: t });
      } catch { /* offline / transient — live edits still arrive via module:patch */ }
    })();
    return () => { cancelled = true; };
  }, [host]);

  const remotes: Remote[] = refs?.remotes ?? [];
  const submodules: Submodule[] = refs?.submodules ?? [];
  const subtrees = Object.values(gitSubtrees).filter((t) => t.primaryTabId === tabId);

  const send = (msg: Record<string, unknown>) => host.send(msg);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_60%,transparent)]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col w-[640px] max-h-[80vh] rounded-xl bg-[var(--panel)] border border-[var(--border)] shadow-2xl"
        role="dialog"
        aria-label="Manage repository"
      >
        {/* Header */}
        <header className="flex items-baseline gap-2 px-5 py-4 border-b border-[var(--border)]">
          <h3 className="text-[14px] font-bold text-[var(--text)]">Manage</h3>
          <span className="text-[12px] text-[var(--muted)]">remotes, submodules &amp; subtrees for this repo</span>
          <button
            className="ml-auto text-[var(--muted)] hover:text-[var(--text)] font-bold text-[14px] leading-none"
            onClick={onClose}
            aria-label="Close"
          >✕</button>
        </header>

        {/* Tab strip */}
        <div className="flex gap-1 px-5 pt-3 border-b border-[var(--border)]">
          {(["remotes", "submodules", "subtrees"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-1.5 text-[12.5px] font-semibold rounded-t-md -mb-px border border-b-0 capitalize
                ${activeTab === t
                  ? "bg-[var(--bg)] border-[var(--border)] text-[var(--text)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"}`}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">
          {activeTab === "remotes" && (
            <RemotesPane tabId={tabId} remotes={remotes} onSend={send} />
          )}
          {activeTab === "submodules" && (
            <SubmodulesPane tabId={tabId} submodules={submodules} onSend={send} />
          )}
          {activeTab === "subtrees" && (
            <SubtreesPane primaryTabId={tabId} subtrees={subtrees} onSend={send} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── REMOTES ─────────────────────────────────────────────────── */

function RemotesPane({ tabId, remotes, onSend }: { tabId: string; remotes: Remote[]; onSend: (m: Record<string, unknown>) => void }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      {remotes.map((r) => (
        <RemoteRow key={r.name} tabId={tabId} remote={r} onSend={onSend} />
      ))}

      {adding ? (
        <AddRemoteForm tabId={tabId} onDone={() => setAdding(false)} onSend={onSend} />
      ) : (
        <button
          className="self-start text-[12px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)] mt-1"
          onClick={() => setAdding(true)}
        >＋ Add remote</button>
      )}
    </div>
  );
}

function RemoteRow({ tabId, remote, onSend }: { tabId: string; remote: Remote; onSend: (m: Record<string, unknown>) => void }) {
  const [editing, setEditing]       = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName]             = useState(remote.name);
  const [fetchUrl, setFetchUrl]     = useState(remote.fetchUrl);
  const [pushUrl, setPushUrl]       = useState(remote.pushUrl ?? "");
  const [sameAsFetch, setSameAsFetch] = useState(!remote.pushUrl || remote.pushUrl === remote.fetchUrl);

  const save = () => {
    onSend({
      type: "git:remoteUpdate",
      tabId,
      name: remote.name,
      newName: name.trim() || remote.name,
      fetchUrl,
      pushUrl: sameAsFetch ? null : (pushUrl || null),
    });
    setEditing(false);
  };

  const remove = () => {
    onSend({ type: "git:remoteRemove", tabId, name: remote.name });
    setConfirming(false);
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-bold text-[13px] text-[var(--text)]">{remote.name}</span>
        <div className="ml-auto flex gap-2">
          <button
            disabled
            title={NETWORK_DISABLED_TITLE}
            className="text-[11.5px] font-bold text-[var(--muted)] opacity-40 cursor-not-allowed"
          >Fetch</button>
          {!editing && !confirming && (
            <>
              <button
                className="text-[11.5px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)]"
                onClick={() => setEditing(true)}
              >Edit</button>
              <button
                className="text-[11.5px] font-bold text-[var(--red)] hover:opacity-80"
                onClick={() => setConfirming(true)}
              >Remove</button>
            </>
          )}
        </div>
      </div>

      {!editing && (
        <div className="flex flex-col gap-1">
          <UrlRow label="fetch" value={remote.fetchUrl} />
          {remote.pushUrl
            ? <UrlRow label="push" value={remote.pushUrl} />
            : <UrlRow label="push" value="no push URL — pushing disabled" muted />}
        </div>
      )}

      {editing && (
        <div className="flex flex-col gap-2 mt-2">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Fetch URL">
            <input value={fetchUrl} onChange={(e) => setFetchUrl(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Push URL">
            <input
              value={sameAsFetch ? fetchUrl : pushUrl}
              disabled={sameAsFetch}
              onChange={(e) => setPushUrl(e.target.value)}
              placeholder="leave empty to disable pushing"
              className={inputCls + (sameAsFetch ? " opacity-40" : "")}
            />
          </Field>
          <label className="flex items-center gap-2 text-[12px] text-[var(--muted)] select-none cursor-pointer">
            <input type="checkbox" checked={sameAsFetch} onChange={(e) => setSameAsFetch(e.target.checked)} />
            Use the fetch URL for pushing
          </label>
          <div className="flex gap-2 mt-1">
            <button className={btnQuiet} onClick={() => {
              setEditing(false);
              setName(remote.name);
              setFetchUrl(remote.fetchUrl);
              setPushUrl(remote.pushUrl ?? "");
              setSameAsFetch(remote.pushUrl == null || remote.pushUrl === remote.fetchUrl);
            }}>Cancel</button>
            <button className={btnPrimary} onClick={save}>Save remote</button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="flex items-center gap-3 mt-2 text-[12px] text-[var(--muted)]">
          <span>Remove <b className="text-[var(--text)]">{remote.name}</b>?</span>
          <button className={btnQuiet} onClick={() => setConfirming(false)}>Cancel</button>
          <button className="text-[11.5px] font-bold text-[var(--red)] hover:opacity-80" onClick={remove}>Remove</button>
        </div>
      )}
    </div>
  );
}

function AddRemoteForm({ tabId, onDone, onSend }: { tabId: string; onDone: () => void; onSend: (m: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl]   = useState("");

  const add = () => {
    const n = name.trim(); const u = url.trim();
    if (!n || !u) return;
    onSend({ type: "git:remoteAdd", tabId, name: n, url: u });
    onDone();
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 flex flex-col gap-2">
      <Field label="Name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. fork" className={inputCls} />
      </Field>
      <Field label="URL">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:you/repo.git" className={inputCls} />
      </Field>
      <div className="flex gap-2 mt-1">
        <button className={btnQuiet} onClick={onDone}>Cancel</button>
        <button className={btnPrimary} onClick={add}>Add remote</button>
      </div>
    </div>
  );
}

/* ─── SUBMODULES ──────────────────────────────────────────────── */

function SubmodulesPane({ tabId, submodules, onSend }: { tabId: string; submodules: Submodule[]; onSend: (m: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--muted)]">
        A submodule pins another repo at one commit. tabterm reads these from <b className="text-[var(--text)]">.gitmodules</b> and
        flags when a pin has drifted from its remote.
      </p>
      {submodules.length === 0 && (
        <p className="text-[12px] text-[var(--faint)]">No submodules in this repository.</p>
      )}
      {submodules.map((s) => (
        <SubmoduleRow key={s.path} tabId={tabId} sub={s} onSend={onSend} />
      ))}
    </div>
  );
}

function SubmoduleRow({ tabId, sub, onSend }: { tabId: string; sub: Submodule; onSend: (m: Record<string, unknown>) => void }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className={`font-bold text-[13px] ${sub.dirty ? "text-[var(--orange)]" : "text-[var(--text)]"}`}>
          {sub.path}
        </span>
        {sub.dirty && <span className="text-[11px] text-[var(--orange)] font-semibold">drifted</span>}
        <div className="ml-auto flex gap-2">
          <button
            className="text-[11.5px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)]"
            onClick={() => onSend({ type: "git:submoduleUpdate", tabId, path: sub.path })}
          >Update</button>
          <button
            disabled
            title={NETWORK_DISABLED_TITLE}
            className="text-[11.5px] font-bold text-[var(--muted)] opacity-40 cursor-not-allowed"
          >Pull latest</button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <UrlRow label="url" value={sub.url} />
        {sub.branch && <UrlRow label="branch" value={sub.branch} />}
        {sub.pinnedSha && <UrlRow label="pinned" value={sub.pinnedSha} />}
      </div>
    </div>
  );
}

/* ─── SUBTREES ────────────────────────────────────────────────── */

function SubtreesPane({ primaryTabId, subtrees, onSend }: { primaryTabId: string; subtrees: GitSubtree[]; onSend: (m: Record<string, unknown>) => void }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--muted)]">
        Git keeps <b className="text-[var(--text)]">no record</b> of a subtree. tabterm persists the prefix → remote/branch
        mapping for this workspace so it can be edited and operated on.
      </p>
      {subtrees.map((t) => (
        <SubtreeRow key={t.id} subtree={t} onSend={onSend} />
      ))}

      {adding ? (
        <AddSubtreeForm primaryTabId={primaryTabId} onDone={() => setAdding(false)} onSend={onSend} />
      ) : (
        <button
          className="self-start text-[12px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)] mt-1"
          onClick={() => setAdding(true)}
        >＋ Add subtree</button>
      )}
    </div>
  );
}

function SubtreeRow({ subtree, onSend }: { subtree: GitSubtree; onSend: (m: Record<string, unknown>) => void }) {
  const [editing, setEditing]       = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [prefix, setPrefix]         = useState(subtree.prefix);
  const [remoteUrl, setRemoteUrl]   = useState(subtree.remoteUrl);
  const [branch, setBranch]         = useState(subtree.branch);
  const [squash, setSquash]         = useState(subtree.squash);

  const save = () => {
    onSend({ type: "gitSubtree:update", subtreeId: subtree.id, prefix, remoteUrl, branch, squash });
    setEditing(false);
  };

  const forget = () => {
    onSend({ type: "gitSubtree:delete", subtreeId: subtree.id });
    setConfirming(false);
  };

  const lastSync = subtree.lastSyncedAt
    ? `last synced ${subtree.lastSyncedSha ? subtree.lastSyncedSha.slice(0, 7) + " · " : ""}${new Date(subtree.lastSyncedAt).toLocaleDateString()}`
    : null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-bold text-[13px] text-[var(--text)]">{subtree.prefix}</span>
        {lastSync && <span className="text-[11.5px] text-[var(--muted)]">{lastSync}</span>}
        <div className="ml-auto flex gap-2">
          <button
            disabled
            title={NETWORK_DISABLED_TITLE}
            className="text-[11.5px] font-bold text-[var(--muted)] opacity-40 cursor-not-allowed"
          >Pull</button>
          <button
            disabled
            title={NETWORK_DISABLED_TITLE}
            className="text-[11.5px] font-bold text-[var(--muted)] opacity-40 cursor-not-allowed"
          >Push</button>
          {!editing && !confirming && (
            <>
              <button
                className="text-[11.5px] font-bold text-[var(--accent-soft)] hover:text-[var(--text)]"
                onClick={() => setEditing(true)}
              >Edit</button>
              <button
                className="text-[11.5px] font-bold text-[var(--red)] hover:opacity-80"
                onClick={() => setConfirming(true)}
              >Forget</button>
            </>
          )}
        </div>
      </div>

      {!editing && (
        <div className="flex flex-col gap-1">
          <UrlRow label="repo" value={subtree.remoteUrl} />
          <UrlRow label="branch" value={subtree.branch + (subtree.squash ? " · squash merges" : "")} />
        </div>
      )}

      {editing && (
        <div className="flex flex-col gap-2 mt-2">
          <Field label="Prefix (path)">
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Repo URL">
            <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Branch">
            <input value={branch} onChange={(e) => setBranch(e.target.value)} className={inputCls} />
          </Field>
          <label className="flex items-center gap-2 text-[12px] text-[var(--muted)] select-none cursor-pointer">
            <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} />
            Squash history on pull
          </label>
          <div className="flex gap-2 mt-1">
            <button className={btnQuiet} onClick={() => {
              setEditing(false);
              setPrefix(subtree.prefix);
              setRemoteUrl(subtree.remoteUrl);
              setBranch(subtree.branch);
              setSquash(subtree.squash);
            }}>Cancel</button>
            <button className={btnPrimary} onClick={save}>Save subtree</button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="flex items-center gap-3 mt-2 text-[12px] text-[var(--muted)]">
          <span>Forget <b className="text-[var(--text)]">{subtree.prefix}</b>? (files stay, mapping is removed)</span>
          <button className={btnQuiet} onClick={() => setConfirming(false)}>Cancel</button>
          <button className="text-[11.5px] font-bold text-[var(--red)] hover:opacity-80" onClick={forget}>Forget</button>
        </div>
      )}
    </div>
  );
}

function AddSubtreeForm({ primaryTabId, onDone, onSend }: { primaryTabId: string; onDone: () => void; onSend: (m: Record<string, unknown>) => void }) {
  const [prefix, setPrefix]       = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch]       = useState("main");
  const [squash, setSquash]       = useState(true);

  const add = () => {
    const p = prefix.trim(); const u = remoteUrl.trim(); const b = branch.trim();
    if (!p || !u || !b) return;
    onSend({
      type: "gitSubtree:create",
      id: crypto.randomUUID(),
      primaryTabId,
      prefix: p,
      remoteUrl: u,
      branch: b,
      squash,
    });
    onDone();
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 flex flex-col gap-2">
      <Field label="Prefix (path)">
        <input autoFocus value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="third_party/lib" className={inputCls} />
      </Field>
      <Field label="Repo URL">
        <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/acme/lib.git" className={inputCls} />
      </Field>
      <Field label="Branch">
        <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className={inputCls} />
      </Field>
      <label className="flex items-center gap-2 text-[12px] text-[var(--muted)] select-none cursor-pointer">
        <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} />
        Squash history on pull
      </label>
      <div className="flex gap-2 mt-1">
        <button className={btnQuiet} onClick={onDone}>Cancel</button>
        <button className={btnPrimary} onClick={add}>Add subtree</button>
      </div>
    </div>
  );
}

/* ─── SHARED HELPERS ──────────────────────────────────────────── */

function UrlRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex gap-2 text-[12px]">
      <span className="w-12 shrink-0 text-[var(--faint)] font-semibold">{label}</span>
      <span className={`mono truncate ${muted ? "text-[var(--faint)] italic" : "text-[var(--muted)]"}`}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-[12px] text-[var(--muted)] w-24 shrink-0 text-right">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "flex-1 mono text-[12px] px-2 py-1 rounded-md bg-[var(--bg)] border border-[var(--border-2)] text-[var(--text)] outline-none focus:outline-[var(--accent)] focus:outline-2 focus:-outline-offset-1 min-w-0";
const btnQuiet   = "text-[11.5px] font-bold text-[var(--muted)] hover:text-[var(--text)] px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)]";
const btnPrimary = "text-[11.5px] font-bold px-3 py-1 rounded bg-[var(--accent)] text-[var(--brand-fg)] hover:opacity-90";
