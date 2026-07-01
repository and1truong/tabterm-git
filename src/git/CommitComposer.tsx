import { useEffect, useState } from "react";

interface Props {
  stagedCount: number;
  branchLabel: string;
  headSha: string | null;
  onCommit: (message: string, amend: boolean) => void;
}
export function CommitComposer(p: Props) {
  const [msg, setMsg] = useState("");
  const [amend, setAmend] = useState(false);
  // HEAD sha captured at submit; `undefined` means no commit is pending. We
  // clear the message only once HEAD advances past it (commit landed). A failed
  // commit leaves HEAD untouched, so the typed message is preserved.
  const [pendingSha, setPendingSha] = useState<string | null | undefined>(undefined);
  const disabled = !msg.trim() || (!amend && p.stagedCount === 0);

  useEffect(() => {
    if (pendingSha !== undefined && p.headSha !== pendingSha) {
      setMsg(""); setAmend(false); setPendingSha(undefined);
    }
  }, [p.headSha, pendingSha]);

  const submit = () => {
    if (disabled) return;
    setPendingSha(p.headSha ?? null);
    p.onCommit(msg.trim(), amend);
  };
  return (
    <div className="border-t border-[var(--border)] px-3 py-2.5 bg-[var(--panel)] flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="Commit summary"
          className="flex-1 border border-[var(--border-2)] bg-[var(--bg)] text-[var(--text)] rounded-md px-2.5 py-1.5 mono text-[13px] focus:outline-2 focus:outline-[var(--accent)] -outline-offset-1"
        />
        <button
          disabled={disabled}
          onClick={submit}
          className="border-0 bg-[var(--accent)] text-[var(--bg)] dark:text-[#1a1200] text-[12.5px] font-extrabold py-2 px-4 rounded-md disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >Commit · {p.stagedCount}</button>
      </div>
      <div className="flex items-center gap-3 text-[var(--faint)] text-[11.5px]">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend last
        </label>
        <span>{msg.length}/72 · to <b className="text-[var(--text)] mono">{p.branchLabel}</b></span>
      </div>
    </div>
  );
}
