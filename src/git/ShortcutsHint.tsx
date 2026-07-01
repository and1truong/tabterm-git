export function ShortcutsHint() {
  return (
    <span
      className="shortcuts-hint relative inline-flex items-center gap-1.5 cursor-default text-[11.5px] font-semibold text-[var(--faint)] underline decoration-dotted decoration-[var(--border-2)] underline-offset-1 hover:text-[var(--text)] focus-visible:outline-none"
      tabIndex={0}
    >
      Shortcuts
      <div className="shortcuts-tooltip absolute bottom-[calc(100%+8px)] right-0 z-30 min-w-56 rounded-[11px] bg-[var(--panel)] border border-[var(--border-2)] shadow-[0_16px_44px_-18px_rgba(0,0,0,0.55)] hidden flex-col gap-px">
        <div className="flex flex-col gap-px">
          <div className="px-1.5 py-1 text-[10px] font-extrabold tracking-widest uppercase text-[var(--faint)]">
            Keys
          </div>
          <div className="flex items-center gap-2.5 px-1.5 py-1 rounded-[7px] text-[12px] text-[var(--text)] whitespace-nowrap hover:bg-[var(--hover)]">
            <kbd className="font-mono text-[10.5px] min-w-9 text-center px-1.5 py-0.5 rounded-[5px] bg-[var(--bg)] border border-[var(--border-2)] text-[var(--accent-soft)] font-bold flex-none">space</kbd>
            <span>Stage / unstage</span>
          </div>
          <div className="flex items-center gap-2.5 px-1.5 py-1 rounded-[7px] text-[12px] text-[var(--text)] whitespace-nowrap hover:bg-[var(--hover)]">
            <kbd className="font-mono text-[10.5px] min-w-9 text-center px-1.5 py-0.5 rounded-[5px] bg-[var(--bg)] border border-[var(--border-2)] text-[var(--accent-soft)] font-bold flex-none">a</kbd>
            <span>Stage all</span>
          </div>
          <div className="flex items-center gap-2.5 px-1.5 py-1 rounded-[7px] text-[12px] text-[var(--text)] whitespace-nowrap hover:bg-[var(--hover)]">
            <kbd className="font-mono text-[10.5px] min-w-9 text-center px-1.5 py-0.5 rounded-[5px] bg-[var(--bg)] border border-[var(--border-2)] text-[var(--accent-soft)] font-bold flex-none">c</kbd>
            <span>Commit</span>
          </div>
        </div>
      </div>
    </span>
  );
}
