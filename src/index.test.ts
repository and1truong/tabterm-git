import { expect, test } from "bun:test";
import type { ClientHost } from "@tabterm/module-host/client";
import activate from "./index.tsx";

test("stores raw host.events payloads by workspace id", () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  let state: Record<string, Record<string, any>> = { gitNoRepo: { "workspace-1": true } };
  const off = () => {};
  const host = {
    ui: {
      registerUI: () => off,
      registerPaletteAction: () => off,
      registerShortcut: () => off,
    },
    events: {
      on: (event: string, callback: (payload: unknown) => void) => {
        listeners.set(event, callback);
        return () => { listeners.delete(event); };
      },
    },
    store: {
      getState: () => state,
      setState: (update: (current: typeof state) => typeof state) => { state = update(state); },
      patch: () => {},
    },
    context: { active: () => ({ workspaceId: "workspace-1" }) },
    actions: { setActiveView: () => {}, toast: () => {} },
    send: () => {},
  } as unknown as ClientHost;

  const cleanup = activate(host);
  const snapshot = { branch: "main", files: [] };
  listeners.get("git:status")?.({ type: "git:status", tabId: "workspace-1", snapshot });

  expect(state.gitStatus?.["workspace-1"]).toBe(snapshot);
  expect(state.gitNoRepo?.["workspace-1"]).toBe(false);
  cleanup();
  expect(listeners.size).toBe(0);
});
