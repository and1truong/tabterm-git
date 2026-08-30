import { useEffect, useRef, useState } from "react";
import type { GitRefs, GitSnapshot } from "../../shared.ts";
import { modalBackdropClass, modalShellClass } from "./modalClasses.ts";

interface Props {
  tabId: string;
  refs: GitRefs | undefined;
  snapshot: GitSnapshot;
  onClose: () => void;
  onSend: (msg: Record<string, unknown>) => void;
}

export function TagCreateDialog({ tabId, refs, snapshot, onClose, onSend }: Props) {
  const existing = new Set(refs?.tags ?? []);
  const remote   = refs?.remotes.find(r => r.name === "origin")?.name
    ?? refs?.remotes[0]?.name ?? null;

  const [name, setName]       = useState("");
  const [annotated, setAnnotated] = useState(true);
  const [message, setMessage] = useState("");
  const [push, setPush]       = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const trimmed = name.trim();
  const nameError =
    !trimmed ? null
    : existing.has(trimmed) ? "A tag with this name already exists."
    : !/^[A-Za-z0-9._/-]+$/.test(trimmed) ? "Only letters, digits, ., _, -, / are allowed."
    : trimmed.startsWith(".") || trimmed.endsWith(".") ? "Tag names cannot start or end with a dot."
    : trimmed.startsWith("/") || trimmed.endsWith("/") ? "Tag names cannot start or end with a slash."
    : trimmed.includes("..") ? "Tag names cannot contain consecutive dots."
    : trimmed.includes("//") ? "Tag names cannot contain consecutive slashes."
    : trimmed.endsWith(".lock") ? "Tag names cannot end with .lock."
    : null;
  const messageMissing = annotated && !message.trim();
  const canSubmit = trimmed.length > 0 && !nameError && !messageMissing;

  const submit = () => {
    if (!canSubmit) return;
    onSend({
      type: "git:tagCreate",
      tabId,
      name: trimmed,
      message: annotated ? message.trim() : "",
      push: push && !!remote,
    });
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  };

  const headLabel = snapshot.detached
    ? `${snapshot.headSha ?? "—"} (detached)`
    : snapshot.branch ?? "—";

  return (
    <div
      className={modalBackdropClass}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={modalShellClass}
        role="dialog"
        aria-label="Create tag"
      >
        {/* Header */}
        <header className="flex items-baseline gap-2 px-5 py-4 border-b border-[var(--border)] min-w-0">
          <h3 className="text-[14px] font-bold text-[var(--text)] shrink-0">Create tag</h3>
          <span className="mono text-[12px] text-[var(--muted)] flex-1 min-w-0 truncate">
            at <span className="font-bold text-[var(--brand-fg)] bg-[var(--brand-bg)] px-1.5 py-0.5 rounded">{headLabel}</span>
          </span>
          <button
            className="shrink-0 ml-auto text-[var(--muted)] hover:text-[var(--text)] font-bold text-[14px] leading-none"
            onClick={onClose}
            aria-label="Close"
          >✕</button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 grid gap-3.5 min-h-0">
          {/* Name */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Name</label>
            <input
              ref={inputRef}
              type="text"
              className="w-full mono text-[13px] px-2.5 py-1.5 rounded-md bg-[var(--bg)] border border-[var(--border-2)] text-[var(--text)] outline-none focus:outline-[var(--accent)] focus:outline-2 focus:-outline-offset-1"
              placeholder="v1.4.0"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={onKey}
            />
            {nameError && <span className="text-[11.5px] text-[var(--red)]">{nameError}</span>}
          </div>

          {/* Type */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Type</label>
            <div className="flex w-max border border-[var(--border-2)] rounded-md overflow-hidden bg-[var(--bg)]">
              {([["annotated", "Annotated"], ["lightweight", "Lightweight"]] as const).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setAnnotated(val === "annotated")}
                  className={`px-3 py-1.5 mono text-[11.5px] ${annotated === (val === "annotated")
                    ? "bg-[var(--accent)] text-[var(--panel)] font-bold"
                    : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}
                >{label}</button>
              ))}
            </div>
          </div>

          {/* Message */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              Message
              <span className="ml-1.5 font-normal normal-case tracking-normal text-[var(--border-2)]">
                {annotated ? "required for annotated" : "disabled for lightweight"}
              </span>
            </label>
            <textarea
              rows={7}
              disabled={!annotated}
              placeholder={annotated ? "Release notes, motivation, breaking changes…" : ""}
              className={`w-full mono text-[13px] px-2.5 py-1.5 rounded-md bg-[var(--bg)] border border-[var(--border-2)] text-[var(--text)] outline-none focus:outline-[var(--accent)] focus:outline-2 focus:-outline-offset-1 resize-y min-h-[140px] ${annotated ? "" : "opacity-40 cursor-not-allowed"}`}
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={onKey}
            />
          </div>

          {/* Push */}
          {remote && (
            <label className="flex items-center gap-2 text-[12.5px] text-[var(--muted)] min-w-0">
              <input
                type="checkbox"
                className="w-[14px] h-[14px] shrink-0"
                style={{ accentColor: "var(--accent)" }}
                checked={push}
                onChange={e => setPush(e.target.checked)}
              />
              Also push to <span className="mono font-semibold text-[var(--text)]">{remote}</span>
              <span className="mono text-[11px] text-[var(--faint)] ml-auto truncate">git push {remote} {trimmed || "<tag>"}</span>
            </label>
          )}
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
            >Create tag</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
