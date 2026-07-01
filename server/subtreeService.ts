import type { Effect } from "@tabterm/module-host/server";
import type { makeSubtreeDb } from "./subtreeDb.ts";

type Sync = {
  set(entity: string, data: unknown): Effect;
  del(entity: string, id: string): Effect;
};

export function makeSubtreeService(
  sdb: ReturnType<typeof makeSubtreeDb>,
  sync: Sync,
) {
  return {
    handle(msg: any): Effect[] {
      switch (msg.type) {
        // Entity is "gitSubtrees" (plural) to match the client read key
        // s.gitSubtrees — the module store keys state by the literal entity
        // string, so a singular/plural mismatch silently never meets.
        case "gitSubtree:create": {
          const s = sdb.create(msg.id, msg.primaryTabId, msg.prefix, msg.remoteUrl, msg.branch, msg.squash);
          return [sync.set("gitSubtrees", s)];
        }
        case "gitSubtree:update": {
          const s = sdb.update(msg.subtreeId, { prefix: msg.prefix, remoteUrl: msg.remoteUrl, branch: msg.branch, squash: msg.squash });
          return s ? [sync.set("gitSubtrees", s)] : [];
        }
        case "gitSubtree:delete": {
          const ok = sdb.delete(msg.subtreeId);
          return ok ? [sync.del("gitSubtrees", msg.subtreeId)] : [];
        }
        default:
          return [];
      }
    },
  };
}
