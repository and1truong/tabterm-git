import { useEffect, useState } from "react";
import type { CommitContext } from "../../shared.ts";

interface Props {
  initialDraft?: CommitDraft;
  context?: CommitContext;
  stagedCount: number;
  branchLabel: string;
  headSha: string | null;
  onDraftChange: (draft: CommitDraft) => void;
  onCommit: (message: string, amend: boolean, signoff: boolean, sign: boolean) => void;
}
export interface CommitDraft { summary: string; body: string }
export function CommitComposer(p: Props) {
  const [summary, setSummary] = useState(p.initialDraft?.summary ?? "");
  const [body, setBody] = useState(p.initialDraft?.body ?? "");
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [sign, setSign] = useState(p.context?.signingEnabled ?? false);
  // HEAD sha captured at submit; `undefined` means no commit is pending. We
  // clear the message only once HEAD advances past it (commit landed). A failed
  // commit leaves HEAD untouched, so the typed message is preserved.
  const [pendingSha, setPendingSha] = useState<string | null | undefined>(undefined);
  const disabled = !summary.trim() || (!amend && p.stagedCount === 0);

  useEffect(() => { p.onDraftChange({ summary, body }); }, [summary, body]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (p.context?.signingEnabled) setSign(true); }, [p.context?.signingEnabled]);

  useEffect(() => {
    if (pendingSha !== undefined && p.headSha !== pendingSha) {
      setSummary(""); setBody(""); setAmend(false); setSignoff(false); setSign(p.context?.signingEnabled ?? false); setPendingSha(undefined);
    }
  }, [p.headSha, pendingSha]);

  const submit = () => {
    if (disabled) return;
    setPendingSha(p.headSha ?? null);
    p.onCommit([summary.trim(), body.trim()].filter(Boolean).join("\n\n"), amend, signoff, sign);
  };
  return (
    <div className="border-t border-[var(--border)] px-3 py-2.5 bg-[var(--panel)] flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Commit summary"
          className="flex-1 border border-[var(--border-2)] bg-[var(--bg)] text-[var(--text)] rounded-md px-2.5 py-1.5 mono text-[13px] focus:outline-2 focus:outline-[var(--accent)] -outline-offset-1"
        />
        <button
          disabled={disabled}
          onClick={submit}
          className="border-0 bg-[var(--accent)] text-[var(--bg)] dark:text-[#1a1200] text-[12.5px] font-extrabold py-2 px-4 rounded-md disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >Commit · {p.stagedCount}</button>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className="w-full resize-y border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] rounded-md px-2.5 py-1.5 mono text-[12px] leading-relaxed focus:outline-2 focus:outline-[var(--accent)] -outline-offset-1"
      />
      <div className="flex items-center gap-3 text-[var(--faint)] text-[11.5px]">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend last
        </label>
        {amend && p.context?.headMessage && (
          <button className="font-bold text-[var(--accent-soft)]" onClick={() => applyMessage(p.context!.headMessage, setSummary, setBody)}>Load HEAD message</button>
        )}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} /> Sign off
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} /> Sign
        </label>
        {p.context?.template && (
          <button className="font-bold text-[var(--accent-soft)]" onClick={() => applyMessage(p.context!.template!, setSummary, setBody)}>Template</button>
        )}
        <span className={summary.length > 72 ? "text-[var(--orange)]" : ""}>{summary.length}/72</span>
        <span>to <b className="text-[var(--text)] mono">{p.branchLabel}</b></span>
        {p.context?.authorName && <span className="ml-auto truncate">{p.context.authorName} &lt;{p.context.authorEmail}&gt;</span>}
      </div>
    </div>
  );
}

function applyMessage(message: string, setSummary: (value: string) => void, setBody: (value: string) => void) {
  const [summary = "", ...body] = message.trim().split("\n");
  setSummary(summary);
  setBody(body.join("\n").trim());
}
