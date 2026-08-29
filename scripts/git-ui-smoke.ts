// Standalone interaction smoke check for Git UI behavior. This is a script,
// not a *.test.ts, so happy-dom is installed before react-dom is imported.

import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Event", "MouseEvent", "CustomEvent", "getComputedStyle"] as const) {
  (globalThis as any)[key] = (win as any)[key];
}
(globalThis as any).window = win as any;

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { ConflictEditor } = await import("../src/git/ConflictEditor.tsx");
  const { DiffView } = await import("../src/git/DiffView.tsx");
  const { CommitComposer } = await import("../src/git/CommitComposer.tsx");
  const { RebasePlanView } = await import("../src/git/RebasePlanView.tsx");
  const { RecoveryView } = await import("../src/git/RecoveryView.tsx");
  const { RefsColumn } = await import("../src/git/RefsColumn.tsx");
  const { GitPanel } = await import("../src/GitPanel.tsx");
  const { HostCtx } = await import("../src/useHost.ts");

  const saved: string[] = [];
  let deleted = 0;
  const conflict = {
    path: "README.md",
    base: "base\n",
    ours: "ours\n",
    theirs: "theirs\n",
    result: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n",
    isBinary: false,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const chosenSides: string[] = [];
  flushSync(() => root.render(React.createElement(ConflictEditor, {
    conflict,
    onSave: (content: string) => saved.push(content),
    onChooseSide: (side: string) => chosenSides.push(side),
    onDelete: () => deleted++,
  })));
  if (!container.textContent?.includes("Ours · current branch") || !container.textContent.includes("Theirs · incoming")) {
    fail("three-way sides were not rendered");
  }
  if (container.textContent.includes("base\n")) fail("base content should be hidden initially");

  const buttons = () => [...container.querySelectorAll("button")];
  const click = (label: string) => {
    const button = buttons().find((b) => b.textContent?.trim() === label);
    if (!button) fail(`button not found: ${label}`);
    button.click();
  };

  flushSync(() => click("Show base"));
  if (!container.textContent?.includes("base\n")) fail("base content did not become visible");

  flushSync(() => click("Use theirs"));
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
  if (textarea?.value !== "theirs\n") fail(`Use theirs did not update result: ${textarea?.value}`);
  flushSync(() => click("Save & stage"));
  if (saved[0] !== "theirs\n") fail("Save & stage did not submit the edited result");

  flushSync(() => click("Delete file"));
  if (deleted !== 1) fail("Delete file did not invoke its action");

  flushSync(() => root.render(React.createElement(ConflictEditor, {
    conflict: { ...conflict, base: "", ours: "", theirs: "", result: "", isBinary: true },
    onSave: (content: string) => saved.push(content),
    onChooseSide: (side: string) => chosenSides.push(side),
    onDelete: () => deleted++,
  })));
  flushSync(() => click("Use theirs"));
  if (chosenSides[0] !== "theirs") fail("binary conflict choice was not delegated to the server");

  const diffContainer = document.createElement("div");
  document.body.appendChild(diffContainer);
  const diffRoot = createRoot(diffContainer);
  const replacementDiff = {
    path: "file.txt", staged: true, isBinary: false,
    hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "-" as const, src: "old" }, { kind: "+" as const, src: "new" }] }],
  };
  flushSync(() => diffRoot.render(React.createElement(DiffView, { diff: replacementDiff, onStageHunk: () => {} })));
  if (diffContainer.querySelector('[aria-label^="unstage line"]')) fail("staged replacement exposed unsafe per-line unstaging");
  if (![...diffContainer.querySelectorAll("button")].some(button => button.textContent?.trim() === "unstage hunk")) fail("staged diff lost hunk unstaging");

  const commitContainer = document.createElement("div");
  document.body.appendChild(commitContainer);
  const commitRoot = createRoot(commitContainer);
  const commits: any[] = [];
  flushSync(() => commitRoot.render(React.createElement(CommitComposer, {
    initialDraft: { summary: "Concise summary", body: "Useful context" },
    stagedCount: 2,
    branchLabel: "main",
    headSha: "abc1234",
    onDraftChange: () => {},
    onCommit: (message: string, amend: boolean, signoff: boolean) => commits.push({ message, amend, signoff }),
  })));
  const commitChecks = [...commitContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  flushSync(() => commitChecks[1]?.click());
  const commitButton = [...commitContainer.querySelectorAll("button")].find(button => button.textContent?.includes("Commit · 2"));
  if (!commitButton) fail("commit action was not rendered");
  flushSync(() => commitButton.click());
  if (commits[0]?.message !== "Concise summary\n\nUseful context" || commits[0]?.signoff !== true) {
    fail(`commit composer submitted the wrong payload: ${JSON.stringify(commits[0])}`);
  }

  const rebaseContainer = document.createElement("div");
  document.body.appendChild(rebaseContainer);
  const rebaseRoot = createRoot(rebaseContainer);
  const rebaseRuns: any[] = [];
  const plan = { upstream: "main", steps: [
    { sha: "1111111111111111111111111111111111111111", subject: "one", action: "pick" as const },
    { sha: "2222222222222222222222222222222222222222", subject: "two", action: "pick" as const },
    { sha: "3333333333333333333333333333333333333333", subject: "three", action: "pick" as const },
  ] };
  flushSync(() => rebaseRoot.render(React.createElement(RebasePlanView, { plan, onRun: (steps: any[]) => rebaseRuns.push(steps) })));
  const actionSelect = rebaseContainer.querySelectorAll("select")[1] as HTMLSelectElement;
  actionSelect.value = "fixup";
  actionSelect.dispatchEvent(new win.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const moveThreeUp = rebaseContainer.querySelector('button[aria-label="Move 3333333 up"]') as HTMLButtonElement | null;
  if (!moveThreeUp) fail("rebase reorder control was not rendered");
  flushSync(() => moveThreeUp.click());
  const rebaseButton = (label: string) => [...rebaseContainer.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
  flushSync(() => rebaseButton("Start rebase")?.click());
  flushSync(() => rebaseButton("Confirm rewrite")?.click());
  if (rebaseRuns[0]?.map((step: any) => `${step.subject}:${step.action}`).join(",") !== "one:pick,three:pick,two:fixup") {
    fail(`interactive rebase submitted the wrong plan: ${JSON.stringify(rebaseRuns[0])}`);
  }

  const recoveryContainer = document.createElement("div");
  document.body.appendChild(recoveryContainer);
  const recoveryRoot = createRoot(recoveryContainer);
  const resets: any[] = [];
  flushSync(() => recoveryRoot.render(React.createElement(RecoveryView, {
    entries: [{ selector: "HEAD@{1}", sha: "abc1234", fullSha: "abc1234000000000000000000000000000000000", action: "commit", message: "before", at: Date.now() }],
    onRefresh: () => {}, onRecover: () => {}, onReset: (ref: string, mode: string) => resets.push({ ref, mode }),
  })));
  const recoveryButton = (label: string) => [...recoveryContainer.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
  flushSync(() => recoveryButton("Mixed reset…")?.click());
  flushSync(() => recoveryButton("Confirm mixed reset")?.click());
  if (resets[0]?.mode !== "mixed" || resets[0]?.ref !== "abc1234000000000000000000000000000000000") fail("recovery confirmation submitted the wrong reset");

  const refsContainer = document.createElement("div");
  document.body.appendChild(refsContainer);
  const refsRoot = createRoot(refsContainer);
  const branchMessages: any[] = [];
  const hostState = { gitError: {}, gitSubtrees: {} };
  const fakeHost = {
    send: (message: any) => branchMessages.push(message),
    store: { use: (selector: (state: any) => unknown) => selector(hostState) },
  };
  const refs = {
    branches: [
      { name: "main", current: true, upstream: "origin/main", ahead: 0, behind: 0 },
      { name: "feature", current: false, upstream: null, ahead: 0, behind: 0 },
    ],
    remoteBranches: [], current: "main", remotes: [], stashes: [], tags: [], submodules: [], worktrees: [],
  };
  flushSync(() => refsRoot.render(React.createElement(HostCtx.Provider, { value: fakeHost },
    React.createElement(RefsColumn, { refs, tabId: "tab-1", onManage: () => {}, onNewTag: () => {}, onNewBranch: () => {} }))));
  const actionsButton = refsContainer.querySelector('button[aria-label="Open actions for feature"]') as HTMLButtonElement | null;
  if (!actionsButton) fail("discoverable branch actions button was not rendered");
  flushSync(() => actionsButton.click());
  const checkoutButton = [...refsContainer.querySelectorAll("button")].find(button => button.textContent?.trim() === "Checkout");
  if (!checkoutButton) fail("branch action menu did not open");
  flushSync(() => checkoutButton.click());
  if (branchMessages[0]?.type !== "git:checkout" || branchMessages[0]?.branch !== "feature") fail("branch checkout action sent the wrong payload");

  const initContainer = document.createElement("div");
  document.body.appendChild(initContainer);
  const initRoot = createRoot(initContainer);
  const initMessages: any[] = [];
  let initHostState: any = { gitNoRepo: { "tab-1": true } };
  const initHost = {
    send: (message: any) => initMessages.push(message),
    store: {
      use: (selector: (state: any) => unknown) => selector(initHostState),
      setState: (update: (state: any) => any) => { initHostState = update(initHostState); },
    },
    workspaces: { get: () => ({ id: "tab-1", label: "Empty", cwd: "/tmp/empty-workspace" }) },
  };
  flushSync(() => initRoot.render(React.createElement(GitPanel, { tabId: "tab-1", host: initHost })));
  const initButton = [...initContainer.querySelectorAll("button")].find(button => button.textContent?.trim() === "Initialize repository");
  if (!initButton) fail("not-a-repository state did not offer initialization");
  flushSync(() => initButton.click());
  if (!initMessages.some(message => message.type === "git:init" && message.tabId === "tab-1")) fail("initialize action sent the wrong payload");

  const contextContainer = document.createElement("div");
  document.body.appendChild(contextContainer);
  const contextRoot = createRoot(contextContainer);
  const contextMessages: any[] = [];
  const snapshot = (headSha: string) => ({
    branch: "main", detached: false, headSha, upstream: null, ahead: null, behind: null,
    files: [], staged: [], operation: null, fetchedAt: Date.now(),
  });
  let contextHostState: any = { gitStatus: { "tab-1": snapshot("aaaaaaa") }, gitNoRepo: {}, gitError: {}, gitSubtrees: {} };
  const contextHost = {
    send: (message: any) => contextMessages.push(message),
    store: {
      use: (selector: (state: any) => unknown) => selector(contextHostState),
      setState: (update: (state: any) => any) => { contextHostState = update(contextHostState); },
    },
    workspaces: { get: () => ({ id: "tab-1", label: "Repo", cwd: "/tmp/repo" }) },
    kv: { get: () => undefined, set: () => {} },
  };
  flushSync(() => contextRoot.render(React.createElement(GitPanel, { tabId: "tab-1", host: contextHost })));
  contextHostState = { ...contextHostState, gitStatus: { "tab-1": snapshot("bbbbbbb") } };
  flushSync(() => contextRoot.render(React.createElement(GitPanel, { tabId: "tab-1", host: contextHost })));
  if (contextMessages.filter(message => message.type === "git:openCommitContext").length !== 2) fail("commit context did not refresh after HEAD changed");

  console.log("PASS: conflict, diff, commit, interactive rebase, recovery, branch menu, repository initialization, and HEAD refresh interactions work");
  process.exit(0);
}

main().catch((error) => fail(error?.message ?? String(error)));
