import type { FileCode } from "../../shared.ts";

const STYLES: Record<FileCode, string> = {
  M: "text-[var(--amber)] bg-[color-mix(in_srgb,var(--amber)_16%,transparent)]",
  A: "text-[var(--green)] bg-[color-mix(in_srgb,var(--green)_16%,transparent)]",
  D: "text-[var(--red)]   bg-[color-mix(in_srgb,var(--red)_16%,transparent)]",
  R: "text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]",
  "?": "text-[var(--faint)] bg-[color-mix(in_srgb,var(--faint)_16%,transparent)]",
  S: "text-[var(--accent-soft)] border border-[color-mix(in_srgb,var(--accent)_50%,transparent)]",
  U: "text-[var(--red)] bg-[color-mix(in_srgb,var(--red)_18%,transparent)]",
};

export function CodeChip({ code }: { code: FileCode }) {
  return (
    <span className={`inline-grid place-items-center w-[18px] h-[18px] rounded-[5px] mono text-[11px] font-bold ${STYLES[code]}`}>
      {code}
    </span>
  );
}
