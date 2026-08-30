import { memo, useEffect, useState } from "react";
import type { FileChange } from "../../shared.ts";
import { CodeChip } from "./icons.tsx";

interface Props {
  unstaged: FileChange[];
  staged: FileChange[];
  selectedPath: string | null;
  onSelect: (path: string, staged: boolean) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onIgnore: (paths: string[]) => void;
}

export const ChangesPane = memo(function ChangesPane(p: Props) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const conflicts = p.unstaged.filter(f => f.code === "U");
  const unstaged = p.unstaged.filter(f => f.code !== "U");
  const live = new Set([
    ...p.unstaged.map(f => keyFor(f.path, false)),
    ...p.staged.map(f => keyFor(f.path, true)),
  ]);
  useEffect(() => {
    setChecked(current => {
      const next = new Set([...current].filter(key => live.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [p.unstaged, p.staged]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedUnstaged = p.unstaged.filter(f => checked.has(keyFor(f.path, false))).map(f => f.path);
  const selectedStaged = p.staged.filter(f => checked.has(keyFor(f.path, true))).map(f => f.path);
  const toggle = (path: string, staged: boolean) => setChecked(current => {
    const next = new Set(current);
    const key = keyFor(path, staged);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div className="flex flex-col min-w-0 border-r border-[var(--border)] bg-[var(--panel)] w-80">
      {checked.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--active)] text-[11.5px]">
          <span className="text-[var(--muted)]">{checked.size} selected</span>
          {selectedUnstaged.length > 0 && <button className="font-bold text-[var(--accent-soft)]" onClick={() => p.onStage(selectedUnstaged)}>Stage</button>}
          {selectedStaged.length > 0 && <button className="font-bold text-[var(--accent-soft)]" onClick={() => p.onUnstage(selectedStaged)}>Unstage</button>}
          <button className="ml-auto font-bold text-[var(--muted)]" onClick={() => setChecked(new Set())}>Clear</button>
        </div>
      )}
      {conflicts.length > 0 && (
        <Section title="Conflicts" actionLabel="stage resolved" onAction={() => p.onStage(conflicts.map(f => f.path))}>
          {conflicts.map(f => (
            <Row key={`c-${f.path}`} f={f} active={p.selectedPath === f.path}
                 checked={checked.has(keyFor(f.path, false))} onCheck={() => toggle(f.path, false)}
                 onSelect={() => p.onSelect(f.path, false)}
                 onPrimary={() => p.onStage([f.path])}
                 primaryLabel="✓" primaryTitle="Stage resolution" />
          ))}
        </Section>
      )}
      <Section title="Unstaged" actionLabel="stage all" onAction={() => p.onStage(unstaged.map(f => f.path))}>
        {unstaged.map(f => (
          <Row key={`u-${f.path}`} f={f} active={p.selectedPath === f.path}
               checked={checked.has(keyFor(f.path, false))} onCheck={() => toggle(f.path, false)}
               onSelect={() => p.onSelect(f.path, false)}
               onPrimary={() => p.onStage([f.path])}
               onIgnore={f.code === "?" ? () => p.onIgnore([f.path]) : undefined}
               primaryLabel="＋" primaryTitle="Stage" />
        ))}
      </Section>
      <Section title="Staged" actionLabel="unstage all" onAction={() => p.onUnstage(p.staged.map(f => f.path))}>
        {p.staged.map(f => (
          <Row key={`s-${f.path}`} f={f} active={p.selectedPath === f.path}
               checked={checked.has(keyFor(f.path, true))} onCheck={() => toggle(f.path, true)}
               onSelect={() => p.onSelect(f.path, true)}
               onPrimary={() => p.onUnstage([f.path])}
               primaryLabel="－" primaryTitle="Unstage" />
        ))}
      </Section>
    </div>
  );
});

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

function Row({ f, active, checked, onSelect, onCheck, onPrimary, onIgnore, primaryLabel, primaryTitle }: {
  f: FileChange;
  active: boolean;
  checked: boolean;
  onSelect: () => void;
  onCheck: () => void;
  onPrimary: () => void;
  primaryLabel: string;
  primaryTitle: string;
  onIgnore?: () => void;
}) {
  const lastSlash = f.path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? f.path.slice(0, lastSlash + 1) : "";
  const name = lastSlash >= 0 ? f.path.slice(lastSlash + 1) : f.path;
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer ${active ? "bg-[var(--active)]" : "hover:bg-[var(--hover)]"}`}
    >
      <input
        type="checkbox"
        aria-label={`Select ${f.path}`}
        checked={checked}
        onChange={onCheck}
        onClick={(e) => e.stopPropagation()}
        className="shrink-0"
      />
      <CodeChip code={f.code} />
      <span className="mono text-[12.5px] min-w-0 truncate">
        <span className="text-[var(--faint)]">{dir}</span>
        <span className="text-[var(--text)]">{name}</span>
      </span>
      {f.submodule && <span className="mono text-[11px] text-[var(--faint)] whitespace-nowrap mr-2">submodule</span>}
      {onIgnore && (
        <button
          title="Add to .gitignore"
          className="ml-auto opacity-0 group-hover:opacity-100 text-[10.5px] font-bold text-[var(--muted)]"
          onClick={(e) => { e.stopPropagation(); onIgnore(); }}
        >ignore</button>
      )}
      <button
        title={primaryTitle}
        className={`${onIgnore ? "" : "ml-auto"} opacity-0 group-hover:opacity-100 text-[var(--accent-soft)] text-[15px] leading-none px-0.5`}
        onClick={(e) => { e.stopPropagation(); onPrimary(); }}
      >{primaryLabel}</button>
    </div>
  );
}

function keyFor(path: string, staged: boolean): string {
  return `${staged ? "s" : "u"}:${path}`;
}
