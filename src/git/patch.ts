import type { DiffHunk } from "../../shared.ts";

export function serializeHunk(hunk: DiffHunk, path: string): string {
  return serialize(hunk.header, hunk.lines, path);
}

export function serializeSelectedLines(hunk: DiffHunk, path: string, selected: ReadonlySet<number>): string | null {
  if (![...selected].some(i => hunk.lines[i]?.kind !== " ")) return null;
  const lines = hunk.lines.flatMap((line, index) => {
    if (line.kind === " " || selected.has(index)) return [line];
    // An unselected deletion remains in both sides, so it becomes context. An
    // unselected addition does not exist in the index and is omitted.
    return line.kind === "-" ? [{ ...line, kind: " " as const }] : [];
  });
  const parsed = parseHeader(hunk.header);
  if (!parsed) return null;
  const oldCount = lines.filter(line => line.kind !== "+").length;
  const newCount = lines.filter(line => line.kind !== "-").length;
  const header = `@@ -${range(parsed.oldStart, oldCount)} +${range(parsed.newStart, newCount)} @@${parsed.suffix}`;
  return serialize(header, lines, path);
}

function serialize(header: string, lines: DiffHunk["lines"], path: string): string {
  const body: string[] = [];
  for (const line of lines) {
    body.push(line.kind + line.src);
    if (line.noNewline) body.push("\\ No newline at end of file");
  }
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    header,
    ...body,
    "",
  ].join("\n");
}

function parseHeader(header: string): { oldStart: number; newStart: number; suffix: string } | null {
  const match = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  return match ? { oldStart: Number(match[1]), newStart: Number(match[2]), suffix: match[3] ?? "" } : null;
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
