// Git domain types — the wire protocol and domain shapes the git module owns.
// Copied from the host at extraction so the module has no deep import into
// tabterm's src/. The host keeps no copy (git types were removed from
// src/shared/types.ts when this module was extracted).

// Working-tree snapshot, polled while the git view is focused. NOT persisted.
export type FileCode = "M" | "A" | "D" | "R" | "?" | "S" | "U";
export type ConflictCode = "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU";
export interface FileChange {
  path: string;
  code: FileCode;
  staged: boolean;
  submodule: boolean;
  renamedFrom?: string;
  conflict?: ConflictCode;
}
export type GitOperationType = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
export interface GitOperation {
  type: GitOperationType;
  current: number | null;
  total: number | null;
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
  operation: GitOperation | null;
  fetchedAt: number;
}

// Refs payload, sent on subscribe and after a ref-mutating action.
export interface Branch  { name: string; current: boolean; upstream: string | null; ahead: number; behind: number }
export interface RemoteBranch { name: string; remote: string; branch: string; sha: string }
export interface Remote  { name: string; fetchUrl: string; pushUrl: string | null }
export interface Stash   { index: number; message: string; createdAt: number }
export interface StashDiffPayload { index: number; message: string; files: DiffPayload[] }
export interface Submodule {
  path: string;
  url: string;
  branch: string | null;
  pinnedSha: string | null;
  dirty: boolean;
}
export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
}
export interface GitRefs {
  branches: Branch[];
  remoteBranches: RemoteBranch[];
  current: string | null;
  remotes: Remote[];
  stashes: Stash[];
  tags: string[];
  submodules: Submodule[];
  worktrees: Worktree[];
}

export type GitJobKind = "fetch" | "pull" | "push" | "checkout" | "commit" | "stage" | "stash" | "refs" | "merge" | "rebase" | "cherry-pick" | "revert" | "reset";
export interface GitJob {
  kind: GitJobKind;
  label: string;
  startedAt: number;
}

// Log entry for the History tab.
export interface LogEntry {
  sha: string;            // short
  fullSha: string;
  parents: string[];      // short shas
  author: string;
  authorEmail: string;
  authoredAt: number;
  committer: string;
  committedAt: number;
  subject: string;
  body: string;
  refs: string[];         // e.g. ["HEAD -> main", "origin/main"]
  signature: "G" | "B" | "U" | "X" | "Y" | "R" | "E" | "N";
}
export interface GitLogPayload { entries: LogEntry[]; hasMore: boolean; limit: number }
export interface ComparePayload {
  base: string;
  head: string;
  ahead: number;
  behind: number;
  commits: LogEntry[];
  files: DiffPayload[];
}
export interface ReflogEntry {
  selector: string;
  sha: string;
  fullSha: string;
  action: string;
  message: string;
  at: number;
}
export interface BlameLine {
  line: number;
  sha: string;
  author: string;
  authorEmail: string;
  authoredAt: number;
  summary: string;
  content: string;
}
export interface FileInsightPayload { path: string; blame: BlameLine[]; history: LogEntry[] }
export type RebaseAction = "pick" | "squash" | "fixup";
export interface RebaseStep { sha: string; subject: string; action: RebaseAction }
export interface RebasePlan { upstream: string; steps: RebaseStep[] }

// Diff payload, unicast in reply to git:openDiff.
export interface DiffHunk { header: string; lines: { kind: " " | "+" | "-"; src: string; noNewline?: boolean }[] }
export interface DiffPayload { path: string; staged: boolean; isBinary: boolean; hunks: DiffHunk[] }
export interface ConflictPayload {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  result: string;
  isBinary: boolean;
}
export interface CommitContext {
  authorName: string;
  authorEmail: string;
  headMessage: string;
  template: string | null;
  signingEnabled: boolean;
}

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
