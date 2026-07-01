// Git domain types — the wire protocol and domain shapes the git module owns.
// Copied from the host at extraction so the module has no deep import into
// tabterm's src/. The host keeps no copy (git types were removed from
// src/shared/types.ts when this module was extracted).

// Working-tree snapshot, polled while the git view is focused. NOT persisted.
export type FileCode = "M" | "A" | "D" | "R" | "?" | "S";
export interface FileChange {
  path: string;
  code: FileCode;
  staged: boolean;
  submodule: boolean;
  renamedFrom?: string;
}
export interface GitSnapshot {
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  upstream: string | null;
  ahead: number | null;   // null = no upstream / never fetched
  behind: number | null;
  files: FileChange[];    // unstaged + untracked
  staged: FileChange[];
  fetchedAt: number;
}

// Refs payload, sent on subscribe and after a ref-mutating action.
export interface Branch  { name: string; current: boolean; upstream: string | null; ahead: number; behind: number }
export interface Remote  { name: string; fetchUrl: string; pushUrl: string | null }
export interface Stash   { index: number; message: string; createdAt: number }
export interface Submodule {
  path: string;
  url: string;
  branch: string | null;
  pinnedSha: string | null;
  dirty: boolean;
}
export interface GitRefs {
  branches: Branch[];
  current: string | null;
  remotes: Remote[];
  stashes: Stash[];
  tags: string[];
  submodules: Submodule[];
}

// Log entry for the History tab.
export interface LogEntry {
  sha: string;            // short
  fullSha: string;
  parents: string[];      // short shas
  author: string;
  authorEmail: string;
  authoredAt: number;
  subject: string;
  refs: string[];         // e.g. ["HEAD -> main", "origin/main"]
}

// Diff payload, unicast in reply to git:openDiff.
export interface DiffHunk { header: string; lines: { kind: " " | "+" | "-"; src: string; noNewline?: boolean }[] }
export interface DiffPayload { path: string; staged: boolean; isBinary: boolean; hunks: DiffHunk[] }

// A workspace-scoped subtree mapping. Git stores no metadata about subtrees,
// so tabterm persists the prefix → remote/branch mapping itself. last_synced_*
// are populated by future network ops; null in this slice.
export interface GitSubtree {
  id: string;
  primaryTabId: string;
  prefix: string;        // path inside the repo, e.g. "third_party/highlight"
  remoteUrl: string;
  branch: string;
  squash: boolean;
  lastSyncedSha: string | null;
  lastSyncedAt: number | null;
  createdAt: number;
}

// Client messages for the gitSubtree service (moved from src/shared/types.ts).
export type GitSubtreeClientMessage =
  | { type: "gitSubtree:create"; id: string; primaryTabId: string; prefix: string; remoteUrl: string; branch: string; squash: boolean }
  | { type: "gitSubtree:update"; subtreeId: string; prefix?: string; remoteUrl?: string; branch?: string; squash?: boolean }
  | { type: "gitSubtree:delete"; subtreeId: string };
