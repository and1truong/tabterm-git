import type { Migration } from "@tabterm/module-host/server";

export const subtreeMigrations: Migration[] = [
  {
    v: 1,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS git_subtrees (
        id TEXT PRIMARY KEY,
        primary_tab_id TEXT NOT NULL,
        prefix TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        branch TEXT NOT NULL,
        squash INTEGER NOT NULL DEFAULT 1,
        last_synced_sha TEXT,
        last_synced_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_git_subtrees_tab ON git_subtrees(primary_tab_id)`);
    },
  },
];
