import { useEffect, useRef, useState } from "react";
import type { GitRefs, GitSnapshot } from "../../shared.ts";

interface Props {
  tabId: string;
  refs: GitRefs | undefined;
  snapshot: GitSnapshot;
  onClose: () => void;
  onSend: (msg: Record<string, unknown>) => void;
}

export function BranchCreateDialog({ tabId, refs, snapshot, onClose, onSend }: Props) {
  const branches = refs?.branches ?? [];
  const existing = new Set(branches.map(b => b.name));

  const [name, setName] = useState("");
  const [base, setBase] = useState(
    refs?.current ?? snapshot.branch ?? branches[0]?.name ?? ""
  );
  const [checkout, setCheckout] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const trimmed = name.trim();
  const nameError =
    !trimmed ? null
    : existing.has(trimmed) ? "A branch with this name already exists."
    : !/^[A-Za-z0-9._/-]+$/.test(trimmed) ? "Only letters, digits, ., _, -, / are allowed."
    : trimmed.startsWith(".") || trimmed.endsWith(".") ? "Branch names cannot start or end with a dot."
    : trimmed.startsWith("/") || trimmed.endsWith("/") ? "Branch names cannot start or end with a slash."
    : trimmed.includes("..") ? "Branch names cannot contain consecutive dots."
    : trimmed.includes("//") ? "Branch names cannot contain consecutive slashes."
    : trimmed.endsWith(".lock") ? "Branch names cannot end with .lock."
    : null;
  const canSubmit = trimmed.length > 0 && !nameError && base.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onSend({ type: "git:branchCreate", tabId, name: trimmed, from: base, checkout });
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_60%,transparent)]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col w-[440px] max-h-[85vh] rounded-xl bg-[var(--panel)] border border-[var(--border)] shadow-2xl"
        role="dialog"
        aria-label="Create branch"
      >
        {/* Header */}
        <header className="flex items-baseline gap-2 px-5 py-4 border-b border-[var(--border)] min-w-0">
          <h3 className="text-[14px] font-bold text-[var(--text)] shrink-0">Create branch</h3>
          <span className="mono text-[12px] text-[var(--muted)] flex-1 min-w-0 truncate">
            from <span className="font-bold text-[var(--brand-fg)] bg-[var(--brand-bg)] px-1.5 py-0.5 rounded">{base || "—"}</span>
          </span>
          <button
            className="shrink-0 ml-auto text-[var(--muted)] hover:text-[var(--text)] font-bold text-[14px] leading-none"
            onClick={onClose}
            aria-label="Close"
          >✕</button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 grid gap-3.5 min-h-0">
          {/* Base */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Base</label>
            <select
              className="w-full mono text-[13px] px-2.5 py-1.5 rounded-md bg-[var(--bg)] border border-[var(--border-2)] text-[var(--text)] outline-none focus:outline-[var(--accent)] focus:outline-2 focus:-outline-offset-1"
              value={base}
              onChange={e => setBase(e.target.value)}
              onKeyDown={onKey}
            >
              {branches.map(b => (
                <option key={b.name} value={b.name}>{b.name}{b.current ? "  (current)" : ""}</option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Name</label>
            <input
              ref={inputRef}
              type="text"
              className="w-full mono text-[13px] px-2.5 py-1.5 rounded-md bg-[var(--bg)] border border-[var(--border-2)] text-[var(--text)] outline-none focus:outline-[var(--accent)] focus:outline-2 focus:-outline-offset-1"
              placeholder="feature/login"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={onKey}
            />
            {nameError && <span className="text-[11.5px] text-[var(--red)]">{nameError}</span>}
          </div>

          {/* Checkout */}
          <label className="flex items-center gap-2 text-[12.5px] text-[var(--muted)] min-w-0">
            <input
              type="checkbox"
              className="w-[14px] h-[14px] shrink-0"
              style={{ accentColor: "var(--accent)" }}
              checked={checkout}
              onChange={e => setCheckout(e.target.checked)}
            />
            Check out after creating
            <span className="mono text-[11px] text-[var(--faint)] ml-auto truncate">git checkout -b {trimmed || "<name>"} {base || "<base>"}</span>
          </label>
        </div>

        {/* Footer */}
        <footer className="flex items-center gap-2.5 px-5 py-3.5 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_30%,var(--panel))]">
          <span className="mono text-[11px] text-[var(--faint)]">
            <kbd className="mono bg-[var(--hover)] border border-[var(--border)] rounded px-1 text-[var(--muted)]">⌘↵</kbd> create ·{" "}
            <kbd className="mono bg-[var(--hover)] border border-[var(--border)] rounded px-1 text-[var(--muted)]">esc</kbd> cancel
          </span>
          <div className="ml-auto flex gap-2">
            <button
              className="px-3.5 py-1.5 rounded-md text-[12.5px] font-semibold text-[var(--text)] border border-[var(--border-2)] bg-[var(--panel)] hover:bg-[var(--hover)]"
              onClick={onClose}
            >Cancel</button>
            <button
              className="px-3.5 py-1.5 rounded-md text-[12.5px] font-semibold text-[var(--panel)] bg-[var(--accent)] border border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:border-[var(--accent-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!canSubmit}
              onClick={submit}
            >Create branch</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
