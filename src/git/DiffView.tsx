import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import type { DiffPayload, DiffHunk } from "../../shared.ts";
import { serializeHunk, serializeSelectedLines } from "./patch.ts";

interface Props {
  diff: DiffPayload;
  // Omitted for historical (read-only) diffs — the "stage hunk" button is hidden.
  onStageHunk?: (patch: string, path: string, staged: boolean) => void;
}

export function DiffView({ diff, onStageHunk }: Props) {
  const langHint = useMemo(() => guessLang(diff.path), [diff.path]);
  // Partial-patch normalization is forward-only. A staged replacement needs a
  // different reverse patch, so staged diffs intentionally unstage by hunk.
  const canStageLines = !!onStageHunk && !diff.staged;

  if (diff.isBinary) {
    return <div className="px-4 py-3 text-[var(--muted)] text-sm">Binary file. No textual diff.</div>;
  }
  if (diff.hunks.length === 0) {
    return <div className="px-4 py-3 text-[var(--faint)] text-sm">No textual changes.</div>;
  }
  return (
    // Inner wrapper is `w-max min-w-full`: sized to its widest row (so a long
    // line drives the scroll width) but never narrower than the viewport (so
    // short rows still fill the pane and per-line bg highlights extend across).
    // The outer container owns the horizontal scroll.
    <div className="flex flex-col min-w-0 flex-1 overflow-auto">
      <div className="min-w-full w-max">
        {diff.hunks.map((h, idx) => (
          <Hunk key={idx} h={h} langHint={langHint}
            action={diff.staged ? "unstage" : "stage"}
            onStage={onStageHunk ? () => onStageHunk(serializeHunk(h, diff.path), diff.path, diff.staged) : undefined}
            onStageLine={canStageLines ? (line) => {
              const patch = serializeSelectedLines(h, diff.path, new Set([line]));
              if (patch) onStageHunk!(patch, diff.path, false);
            } : undefined} />
        ))}
      </div>
    </div>
  );
}

function Hunk({ h, langHint, action, onStage, onStageLine }: {
  h: DiffHunk;
  langHint: string;
  action: "stage" | "unstage";
  onStage?: () => void;
  onStageLine?: (line: number) => void;
}) {
  // Highlight each side of the hunk as one contiguous block (so multi-line
  // constructs like block comments / template literals stay correct) instead of
  // highlighting each line in isolation, then map the result back per line.
  const html = useMemo(() => highlightHunk(h, langHint), [h, langHint]);
  return (
    <>
      <div className="flex items-center gap-3 px-3 py-0.5 text-[var(--accent-soft)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] border-t border-b border-[var(--border)]">
        <span className="mono text-[12px]">{h.header}</span>
        {onStage && <button className="ml-auto text-[11px] font-bold text-[var(--accent-soft)]" onClick={onStage}>{action} hunk</button>}
      </div>
      <div className="mono text-[12.5px] leading-snug">
        {h.lines.map((l, i) => {
          const bg = l.kind === "+"
            ? "bg-[color-mix(in_srgb,var(--green)_13%,transparent)]"
            : l.kind === "-"
              ? "bg-[color-mix(in_srgb,var(--red)_12%,transparent)]"
              : "";
          const gut = l.kind === "+"
            ? "text-[var(--green)]"
            : l.kind === "-"
              ? "text-[var(--red)]"
              : "text-[var(--faint)]";
          return (
            <div key={i} className={`flex whitespace-pre ${bg}`}>
              {onStageLine && l.kind !== " " ? (
                <button
                  title={`${action} this line`}
                  aria-label={`${action} line ${i + 1}`}
                  className={`w-[30px] text-center select-none hover:font-bold hover:bg-[var(--hover)] ${gut}`}
                  onClick={() => onStageLine(i)}
                >{l.kind}</button>
              ) : (
                <span className={`w-[30px] text-center select-none ${gut}`}>{l.kind === " " ? "" : l.kind}</span>
              )}
              <span className="pl-1.5 flex-1" dangerouslySetInnerHTML={{ __html: html[i] ?? "" }} />
            </div>
          );
        })}
      </div>
    </>
  );
}

// Highlight the hunk's new side (context + additions) and old side (context +
// deletions) as two whole blocks, then return one HTML string per diff line.
function highlightHunk(h: DiffHunk, lang: string): string[] {
  const newSrc: string[] = [];
  const oldSrc: string[] = [];
  const map = h.lines.map(l => {
    if (l.kind === "+") { newSrc.push(l.src); return { side: "new" as const, idx: newSrc.length - 1 }; }
    if (l.kind === "-") { oldSrc.push(l.src); return { side: "old" as const, idx: oldSrc.length - 1 }; }
    newSrc.push(l.src); oldSrc.push(l.src); return { side: "new" as const, idx: newSrc.length - 1 };
  });
  const newHi = highlightLines(newSrc, lang);
  const oldHi = highlightLines(oldSrc, lang);
  return map.map(m => (m.side === "new" ? newHi[m.idx] : oldHi[m.idx]) ?? "");
}

function highlightLines(srcLines: string[], lang: string): string[] {
  if (!lang || srcLines.length === 0) return srcLines.map(escape);
  let out: string;
  try { out = hljs.highlight(srcLines.join("\n"), { language: lang, ignoreIllegals: true }).value; }
  catch { return srcLines.map(escape); }
  return splitHighlightedLines(out, srcLines.length);
}

// hljs emits one HTML blob where a <span> may straddle newlines. Split it into
// per-line HTML, closing open spans at each line end and re-opening them on the
// next so every line is independently well-formed. hljs escapes `<`/`>` in text
// to entities, so a literal `<` only ever begins a tag.
function splitHighlightedLines(html: string, count: number): string[] {
  const lines: string[] = [];
  const open: string[] = []; // stack of opening <span ...> tags still in effect
  let cur = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) { cur += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) open.pop();
      else if (!tag.endsWith("/>")) open.push(tag);
      cur += tag;
      i = end + 1;
    } else if (ch === "\n") {
      cur += "</span>".repeat(open.length);
      lines.push(cur);
      cur = open.join("");
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  lines.push(cur);
  while (lines.length < count) lines.push("");
  return lines.slice(0, count);
}

function escape(s: string) {
  return s.replace(/[&<>]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;");
}

function guessLang(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "javascript",
           md: "markdown", json: "json", py: "python", rs: "rust", go: "go",
           sh: "bash", yml: "yaml", yaml: "yaml", css: "css", html: "xml" } as Record<string,string>)[ext] ?? "";
}
