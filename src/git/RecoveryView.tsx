import { useState } from "react";
import type { ReflogEntry } from "../../shared.ts";

export function RecoveryView({ entries, onRefresh, onRecover, onReset }: {
  entries: ReflogEntry[];
  onRefresh: () => void;
  onRecover: (ref: string) => void;
  onReset: (ref: string, mode: "soft" | "mixed") => void;
}) {
  const [selected, setSelected] = useState(entries[0]?.selector ?? "HEAD@{0}");
  const [confirming, setConfirming] = useState<"soft" | "mixed" | null>(null);
  const entry = entries.find(item => item.selector === selected) ?? entries[0];
  return (
    <div className="grid grid-cols-[minmax(360px,42%)_1fr] flex-1 min-h-0 bg-[var(--panel)]">
      <div className="flex flex-col min-h-0 border-r border-[var(--border)]">
        <div className="flex items-center px-3 py-2 border-b border-[var(--border)]">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">HEAD reflog · {entries.length}</span>
          <button className="ml-auto text-[11.5px] font-bold text-[var(--accent-soft)]" onClick={onRefresh}>Refresh</button>
        </div>
        <div className="overflow-auto">
          {entries.map(item => (
            <button key={item.selector} onClick={() => { setSelected(item.selector); setConfirming(null); }} className={`w-full grid grid-cols-[78px_62px_1fr_auto] gap-2 items-center px-3 py-2 text-left border-b border-[var(--border)] ${item.selector === entry?.selector ? "bg-[var(--active)]" : "hover:bg-[var(--hover)]"}`}>
              <span className="mono text-[11.5px] text-[var(--accent-soft)]">{item.selector}</span>
              <span className="mono text-[11px] text-[var(--faint)]">{item.sha}</span>
              <span className="truncate text-[12px] text-[var(--text)]"><span className="text-[var(--muted)]">{item.action}: </span>{item.message}</span>
              <span className="text-[10.5px] text-[var(--faint)]">{relative(item.at)}</span>
            </button>
          ))}
        </div>
      </div>
      {entry ? (
        <div className="p-5 overflow-auto">
          <h3 className="m-0 text-[15px] text-[var(--text)]">Recover {entry.sha}</h3>
          <p className="text-[12.5px] text-[var(--muted)] leading-relaxed">{entry.action}: {entry.message}</p>
          <div className="mono text-[11.5px] text-[var(--faint)] break-all">{entry.fullSha}</div>
          <div className="flex flex-wrap gap-2 mt-5">
            <button className="px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--bg)] dark:text-[#1a1200] text-[11.5px] font-extrabold" onClick={() => onRecover(entry.fullSha)}>Create recovery branch</button>
            <button className="px-3 py-1.5 rounded border border-[var(--border)] text-[11.5px] font-bold text-[var(--accent-soft)]" onClick={() => setConfirming("soft")}>Soft reset…</button>
            <button className="px-3 py-1.5 rounded border border-[var(--border)] text-[11.5px] font-bold text-[var(--accent-soft)]" onClick={() => setConfirming("mixed")}>Mixed reset…</button>
          </div>
          <p className="mt-3 text-[11.5px] text-[var(--faint)]">Soft reset keeps changes staged. Mixed reset keeps files but unstages changes. TabTerm creates a safety ref before either reset.</p>
          {confirming && (
            <div className="mt-4 p-3 rounded-lg border border-[var(--border-2)] bg-[var(--bg)] text-[12px] text-[var(--muted)]">
              Move the current branch to <b className="mono text-[var(--text)]">{entry.selector}</b>? Working-tree files will be preserved.
              <div className="flex gap-3 mt-2">
                <button className="font-bold" onClick={() => setConfirming(null)}>Cancel</button>
                <button className="font-bold text-[var(--accent-soft)]" onClick={() => { onReset(entry.fullSha, confirming); setConfirming(null); }}>Confirm {confirming} reset</button>
              </div>
            </div>
          )}
        </div>
      ) : <div className="grid place-items-center text-sm text-[var(--faint)]">No reflog entries.</div>}
    </div>
  );
}

function relative(ms: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
