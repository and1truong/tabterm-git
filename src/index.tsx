import type { ClientHost } from "@tabterm/module-host/client";
import { GitBranch } from "lucide-react";
import { GitPanel } from "./GitPanel.tsx";

export default function activate(host: ClientHost) {
  const offRail = host.ui.registerUI({
    railPage: {
      id: "git",
      icon: <GitBranch size={16} />,
      label: "Git",
      component: ({ tabId }: { tabId: string }) => <GitPanel tabId={tabId} host={host} />,
    },
  });

  // host.events.on delivers the raw module message the server broadcast
  // (e.g. { type:"git:status", tabId, snapshot }).
  //
  // host.store.setState is used instead of host.store.patch because git data
  // objects (GitSnapshot, GitRefs, DiffPayload, etc.) don't carry an `id`
  // field — applyPatch keys by p.data.id which would be undefined. setState
  // lets us write entity[tabId] = value directly.
  const set = (entity: string, id: string, data: unknown) =>
    host.store.setState((s) => ({
      ...s,
      [entity]: { ...(s[entity] ?? {}), [id]: data },
    }));

  const activeTabId = () => host.context.active().workspaceId;
  const withRepo = (run: (tabId: string, snapshot: any, refs: any) => void) => {
    const tabId = activeTabId();
    const state = host.store.getState();
    const snapshot = tabId ? state.gitStatus?.[tabId] : null;
    if (!tabId || !snapshot) { host.actions.toast("No active Git repository"); return; }
    run(tabId, snapshot, state.gitRefs?.[tabId]);
  };

  const paletteOffs = [
    host.ui.registerPaletteAction({ id: "git.open", title: "Git: Open repository view", run: () => {
      const tabId = activeTabId(); if (tabId) host.actions.setActiveView(tabId, "git");
    } }),
    host.ui.registerPaletteAction({ id: "git.fetch", title: "Git: Fetch all remotes", run: () => withRepo((tabId) => host.send({ type: "git:fetch", tabId, remote: null, prune: true })) }),
    host.ui.registerPaletteAction({ id: "git.pull", title: "Git: Pull (fast-forward only)", run: () => withRepo((tabId) => host.send({ type: "git:pull", tabId, strategy: "ff-only" })) }),
    host.ui.registerPaletteAction({ id: "git.push", title: "Git: Push current branch", run: () => withRepo((tabId, snapshot, refs) => {
      if (!snapshot.branch) { host.actions.toast("Detached HEAD cannot be pushed as a branch"); return; }
      host.send({ type: "git:push", tabId, branch: snapshot.branch, remote: snapshot.upstream?.split("/")[0] ?? refs?.remotes?.[0]?.name ?? "origin", setUpstream: snapshot.upstream === null });
    }) }),
    host.ui.registerShortcut({ id: "git.open", key: "g", shift: true, run: () => {
      const tabId = activeTabId(); if (tabId) host.actions.setActiveView(tabId, "git");
    } }),
  ];

  const offs = [
    host.events.on("git:status",     (message: any) => {
      set("gitStatus", message.tabId, message.snapshot);
      set("gitNoRepo", message.tabId, false);
    }),
    host.events.on("git:noRepo",     (message: any) => set("gitNoRepo",     message.tabId, true)),
    host.events.on("git:refs",       (message: any) => set("gitRefs",       message.tabId, message.refs)),
    host.events.on("git:diff",       (message: any) => set("gitDiff",       message.tabId, message.diff)),
    host.events.on("git:conflict",   (message: any) => set("gitConflict",   message.tabId, message.conflict)),
    host.events.on("git:commitContext", (message: any) => set("gitCommitContext", message.tabId, message.context)),
    host.events.on("git:log",        (message: any) => set("gitLog",        message.tabId, message.log)),
    host.events.on("git:commitDiff", (message: any) => set("gitCommitDiff", message.tabId, { sha: message.sha, files: message.files })),
    host.events.on("git:compare",    (message: any) => set("gitCompare",    message.tabId, message.compare)),
    host.events.on("git:reflog",     (message: any) => set("gitReflog",     message.tabId, message.entries)),
    host.events.on("git:fileInsight", (message: any) => set("gitFileInsight", message.tabId, message.insight)),
    host.events.on("git:rebasePlan",  (message: any) => set("gitRebasePlan",  message.tabId, message.plan)),
    host.events.on("git:stashDiff",   (message: any) => set("gitStashDiff",   message.tabId, message.stash)),
    host.events.on("git:subtreeSynced", (message: any) => host.store.patch({ entity: "gitSubtrees", op: "set", data: message.subtree })),
    host.events.on("git:job",        (message: any) => {
      set("gitJob", message.tabId, message.job);
      if (message.job) set("gitError", message.tabId, null);
    }),
    host.events.on("git:jobDone",    (message: any) => {
      if (message.ok) host.actions.toast(`${message.job.label} complete`);
    }),
    host.events.on("git:error",      (message: any) => set("gitError",      message.tabId, message.message)),
  ];

  return () => { offRail(); offs.forEach((f) => f()); paletteOffs.forEach((f) => f()); };
}
