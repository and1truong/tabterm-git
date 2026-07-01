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

  // host.events.on delivers { moduleId, payload }, where payload is the raw
  // module message the server peer sent (e.g. { type:"git:status", tabId,
  // snapshot }). Verified: store.ts emits registries.emit(msg.event,
  // { moduleId, payload: msg.payload }). So read e.payload, not e.
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

  const offs = [
    host.events.on("git:status",     (e: any) => set("gitStatus",     e.payload.tabId, e.payload.snapshot)),
    host.events.on("git:noRepo",     (e: any) => set("gitNoRepo",     e.payload.tabId, true)),
    host.events.on("git:refs",       (e: any) => set("gitRefs",       e.payload.tabId, e.payload.refs)),
    host.events.on("git:diff",       (e: any) => set("gitDiff",       e.payload.tabId, e.payload.diff)),
    host.events.on("git:log",        (e: any) => set("gitLog",        e.payload.tabId, e.payload.entries)),
    host.events.on("git:commitDiff", (e: any) => set("gitCommitDiff", e.payload.tabId, { sha: e.payload.sha, files: e.payload.files })),
    host.events.on("git:error",      (e: any) => set("gitError",      e.payload.tabId, e.payload.message)),
  ];

  return () => { offRail(); offs.forEach((f) => f()); };
}
