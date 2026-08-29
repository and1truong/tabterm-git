import type { ComparePayload } from "../../shared.ts";
import { DiffView } from "./DiffView.tsx";

export function CompareView({ compare }: { compare: ComparePayload }) {
  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[var(--panel)]">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
        <span className="mono text-[12.5px] font-bold text-[var(--text)]">{compare.base}</span>
        <span className="text-[var(--faint)]">…</span>
        <span className="mono text-[12.5px] font-bold text-[var(--accent-soft)]">{compare.head}</span>
        <span className="text-[11.5px] text-[var(--muted)]">↑{compare.ahead} unique here · ↓{compare.behind} unique there</span>
      </div>
      <div className="grid grid-cols-[minmax(260px,30%)_1fr] flex-1 min-h-0">
        <div className="overflow-auto border-r border-[var(--border)]">
          <div className="sticky top-0 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)] bg-[var(--panel)] border-b border-[var(--border)]">Commits · {compare.commits.length}</div>
          {compare.commits.map(commit => (
            <div key={commit.fullSha} className="px-3 py-2 border-b border-[var(--border)]">
              <div className="text-[12px] text-[var(--text)] truncate">{commit.subject}</div>
              <div className="mt-0.5 mono text-[10.5px] text-[var(--faint)]">{commit.sha} · {commit.author}</div>
            </div>
          ))}
          {compare.commits.length === 0 && <div className="p-4 text-sm text-[var(--faint)]">No commits unique to {compare.head}.</div>}
        </div>
        <div className="overflow-auto min-w-0">
          {compare.files.map(file => (
            <div key={file.path} className="border-b border-[var(--border)]">
              <div className="sticky top-0 z-[1] px-3 py-1.5 bg-[var(--panel)] border-b border-[var(--border)] mono text-[12px] text-[var(--text)]">{file.path}</div>
              <DiffView diff={file} />
            </div>
          ))}
          {compare.files.length === 0 && <div className="grid place-items-center h-full text-sm text-[var(--faint)]">No file differences.</div>}
        </div>
      </div>
    </div>
  );
}
