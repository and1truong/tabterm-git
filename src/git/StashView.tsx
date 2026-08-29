import type { StashDiffPayload } from "../../shared.ts";
import { DiffView } from "./DiffView.tsx";

export function StashView({ stash }: { stash: StashDiffPayload }) {
  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[var(--panel)] overflow-auto">
      <div className="sticky top-0 z-[1] px-4 py-3 bg-[var(--panel)] border-b border-[var(--border)]">
        <div className="text-[13px] font-bold text-[var(--text)]">stash@&#123;{stash.index}&#125;</div>
        <div className="mt-0.5 text-[12px] text-[var(--muted)]">{stash.message} · {stash.files.length} files</div>
      </div>
      {stash.files.map(file => <div key={file.path} className="border-b border-[var(--border)]">
        <div className="px-3 py-1.5 bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] border-b border-[var(--border)] mono text-[12px] text-[var(--text)]">{file.path}</div>
        <DiffView diff={file} />
      </div>)}
      {stash.files.length === 0 && <div className="grid place-items-center flex-1 text-sm text-[var(--faint)]">No textual changes in this stash.</div>}
    </div>
  );
}
