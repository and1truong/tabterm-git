import { useEffect, useState } from "react";
import type { LogEntry, DiffPayload } from "../../shared.ts";
import { DiffView } from "./DiffView.tsx";

type CommitDiff = { sha: string; files: DiffPayload[] };

export function HistoryView({ entries, commitDiff, onOpenCommit }: {
  entries: LogEntry[];
  commitDiff: CommitDiff | null;
  onOpenCommit: (sha: string) => void;
}) {
  const [sel, setSel] = useState<string | null>(entries[0]?.fullSha ?? null);
  const selected = entries.find(e => e.fullSha === sel) ?? entries[0];

  // Fetch the selected commit's diff. Depend only on the sha (not onOpenCommit,
  // which is a fresh closure each render) so this fires once per selection.
  const selectedSha = selected?.fullSha;
  useEffect(() => { if (selectedSha) onOpenCommit(selectedSha); }, [selectedSha]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid grid-cols-[minmax(320px,38%)_1fr] flex-1 min-h-0 bg-[var(--panel)] border-t border-[var(--border)]">
      <div className="overflow-auto border-r border-[var(--border)]">
        {entries.map((e, i) => (
          <Row key={e.fullSha} e={e} prev={entries[i - 1]} active={e.fullSha === selected?.fullSha} onClick={() => setSel(e.fullSha)} />
        ))}
      </div>
      {selected && <Detail e={selected} commitDiff={commitDiff} />}
    </div>
  );
}

function Row({ e, prev, active, onClick }: { e: LogEntry; prev?: LogEntry; active: boolean; onClick: () => void }) {
  let glyph = "● ";
  if (e.parents.length >= 2) glyph = "●╱";
  else if (prev && prev.parents[0] === e.sha) glyph = "│ ●";
  const ago = relative(e.authoredAt);
  return (
    <div className={`grid grid-cols-[74px_70px_1fr_auto] items-center gap-2.5 px-4 py-1.5 text-[12.5px] cursor-pointer ${active ? "bg-[var(--active)]" : "hover:bg-[var(--hover)]"}`} onClick={onClick}>
      <span className="mono text-[var(--accent)] whitespace-pre">{glyph}</span>
      <span className="mono font-bold text-[var(--accent-soft)]">{e.sha}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {e.refs.map(r => (
          <span key={r} className={`text-[10.5px] font-bold px-1.5 py-[1px] rounded-full mr-1.5 align-[1px] border ${r.startsWith("HEAD") ? "bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]" : "bg-[var(--brand-bg)]"} text-[var(--brand-fg)] border-[color-mix(in_srgb,var(--accent)_30%,transparent)]`}>{r}</span>
        ))}
        {e.subject}
      </span>
      <span className="text-[var(--faint)] text-[11.5px]">{ago}</span>
    </div>
  );
}

function Detail({ e, commitDiff }: { e: LogEntry; commitDiff: CommitDiff | null }) {
  // Guard against a stale response: only render the diff once it matches the
  // currently-selected commit (the user may click faster than fetches return).
  const ready = commitDiff?.sha === e.fullSha;
  return (
    <div className="flex flex-col min-w-0 overflow-auto">
      <div className="sticky top-0 z-[1] bg-[var(--panel)] px-4 py-3 border-b border-[var(--border)]">
        <h4 className="m-0 mb-1 text-[14px]">{e.subject}</h4>
        <div className="text-[var(--muted)] text-[12px]"><span className="mono font-bold text-[var(--accent-soft)] mr-2">{e.sha}</span>{e.author} · {relative(e.authoredAt)}</div>
      </div>
      {!ready ? (
        <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">Loading…</div>
      ) : commitDiff.files.length === 0 ? (
        <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">No textual changes.</div>
      ) : (
        commitDiff.files.map(f => (
          <div key={f.path} className="border-b border-[var(--border)]">
            <div className="px-3 py-1.5 bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] border-b border-[var(--border)]">
              <span className="mono text-[12.5px] text-[var(--text)] break-all" title={f.path}>{f.path}</span>
            </div>
            <DiffView diff={f} />
          </div>
        ))
      )}
    </div>
  );
}

function relative(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m";
  const h = Math.floor(m / 60); if (h < 24) return h + "h";
  const d = Math.floor(h / 24); return d + "d";
}
