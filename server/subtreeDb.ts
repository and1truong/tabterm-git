import type { Database } from "bun:sqlite";
import type { GitSubtree } from "../shared.ts";

interface GitSubtreeRow {
  id: string;
  primary_tab_id: string;
  prefix: string;
  remote_url: string;
  branch: string;
  squash: number;
  last_synced_sha: string | null;
  last_synced_at: number | null;
  created_at: number;
}

function toGitSubtree(r: GitSubtreeRow): GitSubtree {
  return {
    id: r.id,
    primaryTabId: r.primary_tab_id,
    prefix: r.prefix,
    remoteUrl: r.remote_url,
    branch: r.branch,
    squash: r.squash === 1,
    lastSyncedSha: r.last_synced_sha,
    lastSyncedAt: r.last_synced_at,
    createdAt: r.created_at,
  };
}

export function makeSubtreeDb(db: Database) {
  function list(primaryTabId?: string): GitSubtree[] {
    const rows = primaryTabId
      ? db.query<GitSubtreeRow, [string]>("SELECT * FROM git_subtrees WHERE primary_tab_id = ? ORDER BY prefix").all(primaryTabId)
      : db.query<GitSubtreeRow, []>("SELECT * FROM git_subtrees ORDER BY primary_tab_id, prefix").all();
    return rows.map(toGitSubtree);
  }

  function get(id: string): GitSubtree | null {
    const r = db.query<GitSubtreeRow, [string]>("SELECT * FROM git_subtrees WHERE id = ?").get(id);
    return r ? toGitSubtree(r) : null;
  }

  function create(
    id: string,
    primaryTabId: string,
    prefix: string,
    remoteUrl: string,
    branch: string,
    squash: boolean,
  ): GitSubtree {
    db.query(
      "INSERT INTO git_subtrees (id, primary_tab_id, prefix, remote_url, branch, squash) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, primaryTabId, prefix, remoteUrl, branch, squash ? 1 : 0);
    return get(id)!;
  }

  function update(
    id: string,
    patch: { prefix?: string; remoteUrl?: string; branch?: string; squash?: boolean; lastSyncedSha?: string | null; lastSyncedAt?: number | null },
  ): GitSubtree | null {
    const cur = get(id);
    if (!cur) return null;
    db.query(
      "UPDATE git_subtrees SET prefix = ?, remote_url = ?, branch = ?, squash = ?, last_synced_sha = ?, last_synced_at = ? WHERE id = ?",
    ).run(
      patch.prefix ?? cur.prefix,
      patch.remoteUrl ?? cur.remoteUrl,
      patch.branch ?? cur.branch,
      (patch.squash ?? cur.squash) ? 1 : 0,
      patch.lastSyncedSha === undefined ? cur.lastSyncedSha : patch.lastSyncedSha,
      patch.lastSyncedAt === undefined ? cur.lastSyncedAt : patch.lastSyncedAt,
      id,
    );
    return get(id);
  }

  function del(id: string): boolean {
    const res = db.query("DELETE FROM git_subtrees WHERE id = ?").run(id);
    return res.changes > 0;
  }

  return { list, get, create, update, delete: del };
}
