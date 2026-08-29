import type { FileInsightPayload } from "../../shared.ts";

export function FileInsightView({ insight, onOpenCommit }: { insight: FileInsightPayload; onOpenCommit: (sha: string) => void }) {
  return (
    <div className="grid grid-cols-[minmax(280px,32%)_1fr] flex-1 min-h-0 bg-[var(--panel)]">
      <div className="overflow-auto border-r border-[var(--border)]">
        <div className="sticky top-0 z-[1] px-3 py-2 bg-[var(--panel)] border-b border-[var(--border)]">
          <div className="mono text-[12px] font-bold text-[var(--text)] truncate" title={insight.path}>{insight.path}</div>
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-[var(--faint)] mt-1">File history · {insight.history.length}</div>
        </div>
        {insight.history.map(commit => (
          <button key={commit.fullSha} onClick={() => onOpenCommit(commit.fullSha)} className="w-full px-3 py-2 text-left border-b border-[var(--border)] hover:bg-[var(--hover)]">
            <div className="text-[12px] text-[var(--text)] truncate">{commit.subject}</div>
            <div className="mt-0.5 text-[10.5px] text-[var(--faint)]"><span className="mono text-[var(--accent-soft)]">{commit.sha}</span> · {commit.author} · {relative(commit.authoredAt)}</div>
          </button>
        ))}
      </div>
      <div className="flex flex-col min-w-0 overflow-auto mono text-[12px]">
        <div className="sticky top-0 z-[1] grid grid-cols-[48px_72px_140px_1fr] gap-2 px-3 py-2 bg-[var(--panel)] border-b border-[var(--border)] text-[10.5px] uppercase tracking-wider font-bold text-[var(--faint)]">
          <span>Line</span><span>Commit</span><span>Author</span><span>Content</span>
        </div>
        {insight.blame.map(line => (
          <button key={line.line} onClick={() => onOpenCommit(line.sha)} title={`${line.summary} · ${new Date(line.authoredAt).toLocaleString()}`} className="grid grid-cols-[48px_72px_140px_1fr] gap-2 px-3 py-0.5 text-left hover:bg-[var(--hover)]">
            <span className="text-[var(--faint)] text-right pr-2">{line.line}</span>
            <span className="text-[var(--accent-soft)]">{line.sha.slice(0, 7)}</span>
            <span className="text-[var(--muted)] truncate">{line.author}</span>
            <span className="text-[var(--text)] whitespace-pre overflow-visible">{line.content}</span>
          </button>
        ))}
        {insight.blame.length === 0 && <div className="p-5 text-center text-sm text-[var(--faint)]">Blame is unavailable for this file.</div>}
      </div>
    </div>
  );
}

function relative(ms: number): string {
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  return days < 1 ? "today" : `${days}d`;
}
