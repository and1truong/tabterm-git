import type { FileChange } from "../../shared.ts";
import { CodeChip } from "./icons.tsx";

interface Props {
  unstaged: FileChange[];
  staged: FileChange[];
  selectedPath: string | null;
  onSelect: (path: string, staged: boolean) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
}

export function ChangesPane(p: Props) {
  return (
    <div className="flex flex-col min-w-0 border-r border-[var(--border)] bg-[var(--panel)] w-80">
      <Section title="Unstaged" actionLabel="stage all" onAction={() => p.onStage(p.unstaged.map(f => f.path))}>
        {p.unstaged.map(f => (
          <Row key={`u-${f.path}`} f={f} active={p.selectedPath === f.path}
               onSelect={() => p.onSelect(f.path, false)}
               onPrimary={() => p.onStage([f.path])}
               primaryLabel="＋" primaryTitle="Stage" />
        ))}
      </Section>
      <Section title="Staged" actionLabel="unstage all" onAction={() => p.onUnstage(p.staged.map(f => f.path))}>
        {p.staged.map(f => (
          <Row key={`s-${f.path}`} f={f} active={p.selectedPath === f.path}
               onSelect={() => p.onSelect(f.path, true)}
               onPrimary={() => p.onUnstage([f.path])}
               primaryLabel="－" primaryTitle="Unstage" />
        ))}
      </Section>
    </div>
  );
}

function Section({ title, actionLabel, onAction, children }: {
  title: string;
  actionLabel: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[var(--faint)] border-b border-[var(--border)]">
        {title}
        <button className="ml-auto text-[10.5px] text-[var(--accent-soft)] normal-case tracking-normal font-bold" onClick={onAction}>
          {actionLabel}
        </button>
      </div>
      <div className="overflow-auto">{children}</div>
    </>
  );
}

function Row({ f, active, onSelect, onPrimary, primaryLabel, primaryTitle }: {
  f: FileChange;
  active: boolean;
  onSelect: () => void;
  onPrimary: () => void;
  primaryLabel: string;
  primaryTitle: string;
}) {
  const lastSlash = f.path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? f.path.slice(0, lastSlash + 1) : "";
  const name = lastSlash >= 0 ? f.path.slice(lastSlash + 1) : f.path;
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer ${active ? "bg-[var(--active)]" : "hover:bg-[var(--hover)]"}`}
    >
      <CodeChip code={f.code} />
      <span className="mono text-[12.5px] min-w-0 truncate">
        <span className="text-[var(--faint)]">{dir}</span>
        <span className="text-[var(--text)]">{name}</span>
      </span>
      {f.submodule && <span className="mono text-[11px] text-[var(--faint)] whitespace-nowrap mr-2">submodule</span>}
      <button
        title={primaryTitle}
        className="ml-auto opacity-0 group-hover:opacity-100 text-[var(--accent-soft)] text-[15px] leading-none px-0.5"
        onClick={(e) => { e.stopPropagation(); onPrimary(); }}
      >{primaryLabel}</button>
    </div>
  );
}
