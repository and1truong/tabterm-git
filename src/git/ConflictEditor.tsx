import { useEffect, useState } from "react";
import type { ConflictPayload } from "../../shared.ts";

export function ConflictEditor({ conflict, onSave, onChooseSide, onDelete }: {
  conflict: ConflictPayload;
  onSave: (content: string) => void;
  onChooseSide: (side: "ours" | "theirs") => void;
  onDelete: () => void;
}) {
  const [result, setResult] = useState(conflict.result);
  const [showBase, setShowBase] = useState(false);

  useEffect(() => setResult(conflict.result), [conflict.path, conflict.result]);

  if (conflict.isBinary) {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm text-[var(--muted)]">
        <span>This conflicted file is binary and cannot be edited here.</span>
        <div className="flex gap-2">
          <Action label="Use ours" onClick={() => onChooseSide("ours")} disabled={conflict.ours === null} />
          <Action label="Use theirs" onClick={() => onChooseSide("theirs")} disabled={conflict.theirs === null} />
          <Action label="Delete file" danger onClick={onDelete} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[var(--panel)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <span className="mono text-[12.5px] font-bold text-[var(--text)] truncate">{conflict.path}</span>
        <span className="text-[11.5px] text-[var(--orange)]">conflict</span>
        <button className="ml-auto text-[11.5px] font-bold text-[var(--muted)]" onClick={() => setShowBase(v => !v)}>
          {showBase ? "Hide base" : "Show base"}
        </button>
      </div>
      <div className={`grid ${showBase ? "grid-cols-3" : "grid-cols-2"} min-h-0 h-[38%] border-b border-[var(--border)]`}>
        {showBase && <Version title="Base" value={conflict.base} />}
        <Version title="Ours · current branch" value={conflict.ours} />
        <Version title="Theirs · incoming" value={conflict.theirs} />
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">Resolution</span>
        <Action label="Use ours" onClick={() => conflict.ours !== null && setResult(conflict.ours)} disabled={conflict.ours === null} />
        <Action label="Use theirs" onClick={() => conflict.theirs !== null && setResult(conflict.theirs)} disabled={conflict.theirs === null} />
        <Action label="Use both" onClick={() => setResult([conflict.ours, conflict.theirs].filter(v => v !== null).join(""))} />
        <Action label="Delete file" danger onClick={onDelete} />
        <button
          onClick={() => onSave(result)}
          className="ml-auto px-2.5 py-1 rounded bg-[var(--accent)] text-[var(--bg)] dark:text-[#1a1200] text-[11.5px] font-extrabold"
        >Save &amp; stage</button>
      </div>
      <textarea
        aria-label="Conflict resolution"
        value={result}
        onChange={(e) => setResult(e.target.value)}
        spellCheck={false}
        className="flex-1 min-h-0 resize-none bg-[var(--bg)] text-[var(--text)] mono text-[12.5px] leading-relaxed p-3 outline-none"
      />
    </div>
  );
}

function Version({ title, value }: { title: string; value: string | null }) {
  return (
    <div className="flex flex-col min-w-0 border-r last:border-r-0 border-[var(--border)]">
      <div className="px-3 py-1.5 text-[11px] font-bold text-[var(--faint)] border-b border-[var(--border)]">{title}</div>
      <pre className="flex-1 overflow-auto m-0 p-3 mono text-[12px] leading-relaxed text-[var(--muted)] whitespace-pre">{value ?? "File absent in this version."}</pre>
    </div>
  );
}

function Action({ label, onClick, disabled, danger }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`text-[11.5px] font-bold disabled:opacity-35 ${danger ? "text-[var(--red)]" : "text-[var(--accent-soft)]"}`}
    >{label}</button>
  );
}
