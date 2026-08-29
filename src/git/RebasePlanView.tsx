import { useEffect, useState } from "react";
import type { RebaseAction, RebasePlan, RebaseStep } from "../../shared.ts";

export function RebasePlanView({ plan, onRun }: { plan: RebasePlan; onRun: (steps: RebaseStep[]) => void }) {
  const [steps, setSteps] = useState(plan.steps);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setSteps(plan.steps); setConfirming(false); }, [plan]);
  const update = (index: number, action: RebaseAction) => setSteps(current => current.map((step, i) => i === index ? { ...step, action } : step));
  const move = (index: number, delta: -1 | 1) => setSteps(current => {
    const target = index + delta;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target]!, next[index]!];
    next[0] = { ...next[0]!, action: "pick" };
    return next;
  });
  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[var(--panel)]">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
        <div><div className="text-[13px] font-bold text-[var(--text)]">Interactive rebase onto <span className="mono text-[var(--accent-soft)]">{plan.upstream}</span></div><div className="text-[11.5px] text-[var(--muted)]">Reorder commits and combine them. Every commit remains in the plan; a safety ref is created before rewriting.</div></div>
        <button disabled={steps.length === 0} onClick={() => setConfirming(true)} className="ml-auto px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--bg)] dark:text-[#1a1200] text-[11.5px] font-extrabold disabled:opacity-35">Start rebase</button>
      </div>
      {confirming && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--active)] text-[12px] text-[var(--muted)]">
          Rewrite {steps.length} local commit{steps.length === 1 ? "" : "s"}? Published commits may require force-with-lease to push.
          <button className="ml-auto font-bold" onClick={() => setConfirming(false)}>Cancel</button>
          <button className="font-bold text-[var(--accent-soft)]" onClick={() => { onRun(steps); setConfirming(false); }}>Confirm rewrite</button>
        </div>
      )}
      <div className="overflow-auto p-3">
        {steps.map((step, index) => (
          <div key={step.sha} className="grid grid-cols-[110px_54px_74px_1fr] items-center gap-2 px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--hover)]">
            <select disabled={index === 0} value={index === 0 ? "pick" : step.action} onChange={(e) => update(index, e.target.value as RebaseAction)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[11.5px] text-[var(--text)] disabled:opacity-50">
              <option value="pick">Pick</option>
              <option value="squash">Squash + message</option>
              <option value="fixup">Fixup</option>
            </select>
            <div className="flex gap-1">
              <button disabled={index === 0} aria-label={`Move ${step.sha.slice(0, 7)} up`} className="text-[var(--muted)] disabled:opacity-25" onClick={() => move(index, -1)}>↑</button>
              <button disabled={index === steps.length - 1} aria-label={`Move ${step.sha.slice(0, 7)} down`} className="text-[var(--muted)] disabled:opacity-25" onClick={() => move(index, 1)}>↓</button>
            </div>
            <span className="mono text-[11.5px] font-bold text-[var(--accent-soft)]">{step.sha.slice(0, 7)}</span>
            <span className="truncate text-[12.5px] text-[var(--text)]">{step.subject}</span>
          </div>
        ))}
        {steps.length === 0 && <div className="p-5 text-center text-sm text-[var(--faint)]">No commits to rebase.</div>}
      </div>
    </div>
  );
}
