import { useEffect, useMemo, useState } from "react";
import type { LogEntry, DiffPayload } from "../../shared.ts";
import { DiffView } from "./DiffView.tsx";

type CommitDiff = { sha: string; files: DiffPayload[] };
type HistoryAction = "cherry-pick" | "revert" | "bisect-start";

export function HistoryView({ entries, requestedSha, hasMore, commitDiff, onOpenCommit, onLoadMore, onAction }: {
  entries: LogEntry[];
  requestedSha?: string | null;
  hasMore: boolean;
  commitDiff: CommitDiff | null;
  onOpenCommit: (sha: string) => void;
  onLoadMore: () => void;
  onAction: (action: HistoryAction, sha: string) => void;
}) {
  const [sel, setSel] = useState<string | null>(entries[0]?.fullSha ?? null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "merges" | "linear">("all");
  const selected = entries.find(e => e.fullSha === sel) ?? entries[0];
  const graph = useMemo(() => new Map(graphRows(entries).map(row => [row.entry.fullSha, row])), [entries]);
  const needle = query.trim().toLowerCase();
  const visible = entries.filter(entry => {
    if (filter === "merges" && entry.parents.length < 2) return false;
    if (filter === "linear" && entry.parents.length >= 2) return false;
    return !needle || [entry.sha, entry.subject, entry.body, entry.author, entry.authorEmail, ...entry.refs]
      .some(value => value.toLowerCase().includes(needle));
  });

  const selectedSha = selected?.fullSha;
  useEffect(() => { if (requestedSha && entries.some(entry => entry.fullSha === requestedSha || entry.sha === requestedSha)) setSel(entries.find(entry => entry.fullSha === requestedSha || entry.sha === requestedSha)!.fullSha); }, [requestedSha, entries]);
  useEffect(() => { if (selectedSha) onOpenCommit(selectedSha); }, [selectedSha]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid grid-cols-[minmax(380px,42%)_1fr] flex-1 min-h-0 bg-[var(--panel)] border-t border-[var(--border)]">
      <div className="flex flex-col min-h-0 border-r border-[var(--border)]">
        <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SHA, message, author, ref…"
            className="flex-1 min-w-0 bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[12px] text-[var(--text)] outline-none focus:outline-2 focus:outline-[var(--accent)]" />
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-1.5 py-1.5 text-[11.5px] text-[var(--muted)]">
            <option value="all">All commits</option>
            <option value="merges">Merges</option>
            <option value="linear">Non-merges</option>
          </select>
        </div>
        <div className="overflow-auto flex-1 min-h-0">
          {visible.map(entry => <Row key={entry.fullSha} row={graph.get(entry.fullSha)!} active={entry.fullSha === selected?.fullSha} onClick={() => setSel(entry.fullSha)} />)}
          {visible.length === 0 && <div className="p-4 text-center text-sm text-[var(--faint)]">No matching commits.</div>}
          {hasMore && !needle && filter === "all" && <button className="w-full py-2.5 text-[12px] font-bold text-[var(--accent-soft)] hover:bg-[var(--hover)]" onClick={onLoadMore}>Load more commits</button>}
        </div>
      </div>
      {selected && <Detail entry={selected} commitDiff={commitDiff} onAction={onAction} />}
    </div>
  );
}

function Row({ row, active, onClick }: { row: GraphRow; active: boolean; onClick: () => void }) {
  const entry = row.entry;
  return (
    <div className={`grid grid-cols-[96px_70px_1fr_auto] items-center gap-2 px-3 py-1.5 text-[12.5px] cursor-pointer ${active ? "bg-[var(--active)]" : "hover:bg-[var(--hover)]"}`} onClick={onClick}>
      <Graph row={row} />
      <span className="mono font-bold text-[var(--accent-soft)]">{entry.sha}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {entry.refs.map(ref => <RefBadge key={ref} value={ref} />)}
        {entry.subject}
      </span>
      <span className="text-[var(--faint)] text-[11.5px]">{relative(entry.authoredAt)}</span>
    </div>
  );
}

function RefBadge({ value }: { value: string }) {
  return <span className={`text-[10.5px] font-bold px-1.5 py-[1px] rounded-full mr-1.5 align-[1px] border ${value.startsWith("HEAD") ? "bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]" : "bg-[var(--brand-bg)]"} text-[var(--brand-fg)] border-[color-mix(in_srgb,var(--accent)_30%,transparent)]`}>{value}</span>;
}

function Detail({ entry, commitDiff, onAction }: { entry: LogEntry; commitDiff: CommitDiff | null; onAction: (action: HistoryAction, sha: string) => void }) {
  const [confirming, setConfirming] = useState<HistoryAction | null>(null);
  const ready = commitDiff?.sha === entry.fullSha;
  return (
    <div className="flex flex-col min-w-0 overflow-auto">
      <div className="sticky top-0 z-[1] bg-[var(--panel)] px-4 py-3 border-b border-[var(--border)]">
        <h4 className="m-0 mb-1 text-[14px]">{entry.subject}</h4>
        {entry.body && <p className="m-0 my-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--muted)]">{entry.body}</p>}
        <div className="text-[var(--muted)] text-[12px]"><span className="mono font-bold text-[var(--accent-soft)] mr-2">{entry.sha}</span>{entry.author} &lt;{entry.authorEmail}&gt; · {relative(entry.authoredAt)}{entry.signature !== "N" && <span className="ml-2 text-[var(--green)]">signed · {entry.signature}</span>}</div>
        <div className="flex items-center gap-3 mt-2 text-[11.5px]">
          {confirming ? <>
              <span className="text-[var(--muted)]">{confirming === "revert" ? "Create a commit reverting this change?" : confirming === "bisect-start" ? "Treat this as known-good and current HEAD as bad?" : "Apply this commit onto the current branch?"}</span>
            <button className="font-bold text-[var(--muted)]" onClick={() => setConfirming(null)}>Cancel</button>
            <button className="font-bold text-[var(--accent-soft)]" onClick={() => { onAction(confirming, entry.fullSha); setConfirming(null); }}>Confirm</button>
          </> : <>
            <button className="font-bold text-[var(--accent-soft)]" onClick={() => setConfirming("cherry-pick")}>Cherry-pick</button>
            <button className="font-bold text-[var(--accent-soft)]" onClick={() => setConfirming("revert")}>Revert</button>
            <button className="font-bold text-[var(--accent-soft)]" onClick={() => setConfirming("bisect-start")}>Start bisect</button>
            <button className="font-bold text-[var(--muted)]" onClick={() => navigator.clipboard?.writeText(entry.fullSha)}>Copy SHA</button>
          </>}
        </div>
      </div>
      {!ready ? <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">Loading…</div>
        : commitDiff.files.length === 0 ? <div className="grid place-items-center flex-1 text-[var(--faint)] text-sm">No textual changes.</div>
        : commitDiff.files.map(file => <div key={file.path} className="border-b border-[var(--border)]">
          <div className="px-3 py-1.5 bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] border-b border-[var(--border)]"><span className="mono text-[12.5px] text-[var(--text)] break-all" title={file.path}>{file.path}</span></div>
          <DiffView diff={file} />
        </div>)}
    </div>
  );
}

type GraphRow = { entry: LogEntry; top: string[]; bottom: string[]; lane: number };

function graphRows(entries: LogEntry[]): GraphRow[] {
  let lanes: string[] = [];
  return entries.map(entry => {
    let lane = lanes.indexOf(entry.sha);
    if (lane < 0) { lanes = [entry.sha, ...lanes]; lane = 0; }
    const top = [...lanes];
    const next = [...lanes];
    next.splice(lane, 1, ...entry.parents);
    const seen = new Set<string>();
    const bottom = next.filter(sha => sha && !seen.has(sha) && !!seen.add(sha));
    lanes = bottom;
    return { entry, top, bottom, lane };
  });
}

function Graph({ row }: { row: GraphRow }) {
  const gap = 13;
  const x = (lane: number) => 5 + lane * gap;
  const width = Math.max(row.top.length, row.bottom.length, 1) * gap + 4;
  const paths: React.ReactNode[] = [];
  row.top.forEach((sha, topLane) => {
    if (topLane === row.lane) return;
    const bottomLane = row.bottom.indexOf(sha);
    if (bottomLane >= 0) paths.push(<line key={`c-${sha}-${topLane}`} x1={x(topLane)} y1="0" x2={x(bottomLane)} y2="28" />);
  });
  paths.push(<line key="incoming" x1={x(row.lane)} y1="0" x2={x(row.lane)} y2="14" />);
  row.entry.parents.forEach((parent, index) => {
    const parentLane = row.bottom.indexOf(parent);
    if (parentLane >= 0) paths.push(<line key={`p-${parent}-${index}`} x1={x(row.lane)} y1="14" x2={x(parentLane)} y2="28" />);
  });
  return <svg width={width} height="28" viewBox={`0 0 ${width} 28`} className="overflow-visible" aria-hidden="true">
    <g fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.8">{paths}</g>
    <circle cx={x(row.lane)} cy="14" r="3.5" fill="var(--panel)" stroke="var(--accent)" strokeWidth="2" />
  </svg>;
}

function relative(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60); if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}
