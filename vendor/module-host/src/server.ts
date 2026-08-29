// Server-side host contract. No React — server halves never touch the DOM.
import type { Database } from "bun:sqlite";

export type RouteHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface Migration { v: number; up: (db: Database) => void }

export type ServerCapabilityHandlerResult<T> =
  | { handled: true; value: T }
  | { handled: false; reason: string };

export type ServerCapabilityInvocation<T> =
  | { handled: true; providerId: string; value: T }
  | { handled: false; reason: "unavailable" | "declined"; attempts: Array<{ providerId: string; reason: string }> };

export const AI_COMPLETION_CAPABILITY = "ai.completion.v1";

export interface AiCompletionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface AiCompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AiCompletionConnection {
  id: string;
  label: string;
  provider: string;
  defaultModel: string;
}

export type AiCompletionCapabilityRequest =
  | { operation: "connections" }
  | { operation: "models"; connectionId: string }
  | {
    operation: "complete";
    conversationId: string;
    messages: AiCompletionMessage[];
    systemPrompt?: string;
    connectionId?: string | null;
    model?: string | null;
    signal: AbortSignal;
    onDelta(delta: string): void;
  };

export type AiCompletionCapabilityValue =
  | { operation: "connections"; connections: AiCompletionConnection[] }
  | { operation: "models"; connectionId: string; models: string[]; source: "api" | "fallback"; error?: string }
  | {
    operation: "complete";
    content: string;
    usage: AiCompletionUsage | null;
    connectionId: string;
    model: string;
  };

// The subset of JSON Schema the host's built-in validator understands. Modules
// declare their config shape with this via host.settings.define(). Supported
// keywords: type, properties, required, enum, items, default, and the numeric
// (minimum/maximum) + string (minLength/maxLength) + array (minItems/maxItems)
// bounds. On validation, a field that fails is replaced by its schema `default`
// (or the current value); unknown keywords are ignored. Not full JSON Schema.
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

// An Effect is produced by host.sync.* and returned from an onMessage handler.
// Its internals are core-private; modules treat it as an opaque token.
export type Effect = unknown;

export interface ModuleCallContext { moduleId: string }
export type ModuleMessageHandler = (msg: any, ctx: ModuleCallContext) => Effect[];

// A connected client socket, opaque to the module. Stable identity for the
// life of the connection; the module never touches the raw socket.
export interface Peer {
  id: string;                 // stable per-connection key
  send(msg: unknown): void;   // emits a module:event to THIS socket only
}

// Passed into a room's poll/onJoin/onRequest, scoped to one key.
export interface RoomContext {
  key: string;
  push(msg: unknown): void;   // fan out a module:event to this key's subscribers
}

export interface RoomSpec {
  prefixes: string[];                 // message types this room owns, e.g. ["git"]
  keyOf(msg: any): string | null;     // extract the room key from a message
  subscribeType: string;              // e.g. "git:subscribe"
  unsubscribeType: string;            // e.g. "git:unsubscribe"
  // Host-owned poll loop. Runs while the key has >=1 subscriber; starts on
  // first join, stops on last leave. A non-undefined return is pushed verbatim
  // to the key's subscribers (the module shapes its own message, e.g. one with
  // a `type` field). Returning undefined means "nothing to push this tick".
  poll?: (ctx: RoomContext) => unknown | Promise<unknown>;
  pollMs?: number;                    // required iff poll is set
  onJoin?: (ctx: RoomContext, peer: Peer) => void | Promise<void>;
  onRequest?: (ctx: RoomContext, msg: any, peer: Peer) => void | Promise<void>;
  onIdle?: (key: string) => void;     // fires when a key's last subscriber leaves
}

// Identity of the tabterm session an MCP tool call originates from, resolved
// from the request's X-Tabterm-Session-Id header. Both fields are null when the
// header is missing or names a session that no longer exists — identity-needing
// tools should error in-band; identity-free tools ignore it.
export interface McpToolContext {
  sessionId: string | null;
  workspaceId: string | null;
}

// A tool a module exposes to MCP clients (Claude Code panes) via
// host.registerMcpTool. The exposed name is `<moduleId>_<name>` unless `name`
// already carries that prefix, so authors pick short verbs ("open", "list").
export interface McpToolDef {
  name: string;
  description: string;
  // Flat JSON Schema for the arguments object. The host validates required keys
  // and primitive types before calling handler; nested shapes aren't checked.
  inputSchema: JsonSchema;
  // Returns a text result. A thrown Error becomes an isError result carrying its
  // message; the host also wraps the call in a timeout.
  handler(args: Record<string, unknown>, ctx: McpToolContext): string | Promise<string>;
}

export type EntityRefType = "session" | "note" | "task_list";
export type EntityRef<T extends EntityRefType = EntityRefType> = {
  workspaceId: string;
  type: T;
  id: string;
};

export interface ResolvedEntityBase {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
}

// Open agent-adapter id. Built-in ids are claude/codex/pi; server modules may
// register more, so consumers must not exhaustively switch on this string.
export type WorkerPromptProvider = string;

export type AgentPhase = "starting" | "idle" | "running" | "approval" | "error";
export interface AgentMetric {
  key: string;
  label?: string;
  value: string;
  placement?: "main" | "detail";
  tone?: "default" | "warning" | "error";
  title?: string;
}
export interface AgentSnapshot {
  integrationId: string;
  model: string;
  provider: string | null;
  phase: AgentPhase;
  conversationId: string | null;
  startedAt: number | null;
  updatedAt: number;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  metrics: AgentMetric[];
  title?: string;
}
export interface AgentSessionInfo {
  id: string;
  kind: string;
  integrationId: string;
  model: string | null;
  closed: boolean;
}
export interface AgentLaunchInput {
  sessionId: string;
  kind: string;
  command: string;
  workerPrompt?: string;
}
export interface AgentLaunchPlan {
  args?: string[];
  env?: Record<string, string>;
}
export interface AgentIntegrationDefinition {
  id: string;
  supportsWorkerPrompt?: boolean;
  start?(): void | (() => void);
  prepareLaunch(input: AgentLaunchInput): AgentLaunchPlan;
  handleEvent?(event: string, req: Request, session: AgentSessionInfo): Response | Promise<Response>;
}

export type ResolvedEntity =
  | (ResolvedEntityBase & { type: "session"; workerPromptProvider: WorkerPromptProvider | null })
  | (ResolvedEntityBase & { type: "task_list" })
  | (ResolvedEntityBase & {
    type: "note";
    content: string;
    noteType: "markdown" | "excalidraw";
    version: number;
  });

export type EntityMetadataPatch = { title?: string; description?: string };
export type NoteMetadataPatch = EntityMetadataPatch & { baseVersion: number };
export type EntityConflict = ResolvedEntity & { conflict: true };

export interface TaskList {
  id: string;
  primaryTabId: string;
  sessionId: string | null;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskItem {
  id: string;
  listId: string;
  parentTaskId: string | null;
  title: string;
  detailsMarkdown: string;
  position: number;
  state: "pending" | "in_progress" | "completed";
  completedAt: number | null;
  completedByType: "user" | "agent" | null;
  completedById: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDependency { taskId: string; blockerTaskId: string; createdAt: number }
export interface TaskClaim {
  taskId: string;
  agentId: string;
  agentLabel: string;
  claimedAt: number;
  leaseExpiresAt: number;
  lastSeenCommentId: string | null;
}
export interface TaskComment {
  id: string;
  taskId: string;
  authorType: "user" | "agent";
  authorId: string;
  authorLabel: string;
  bodyMarkdown: string;
  kind: "comment" | "completion_summary";
  createdAt: number;
  updatedAt: number | null;
}
export interface TaskBundle {
  list: TaskList | null;
  items: TaskItem[];
  dependencies: TaskDependency[];
  claims: TaskClaim[];
  comments: TaskComment[];
}
export interface TaskChangeSet {
  bundle: TaskBundle;
  deleted: Array<{ entity: "taskList" | "taskItem" | "taskDependency" | "taskClaim" | "taskComment"; id: string }>;
}
export type TaskErrorCode =
  | "not_found" | "claimed" | "not_available" | "lease_expired"
  | "lease_mismatch" | "unseen_comments" | "hierarchy_cycle"
  | "dependency_cycle" | "cross_list" | "invalid_input";
export type TaskMutationResult<T = TaskChangeSet> =
  | { ok: true; value: T }
  | { ok: false; code: TaskErrorCode; message: string; value?: TaskBundle };
export type CreateTaskListInput = { id: string; title: string; description?: string };
export type UpdateTaskListInput = { title?: string; description?: string };
export type TaskClaimInput = { taskId?: string; agentId: string; agentLabel: string };
export type TaskCommentInput = { agentId: string; agentLabel: string; bodyMarkdown: string };
export type TaskCompletionInput = { leaseToken: string; agentId: string; summaryMarkdown: string };

export interface ServerHost {
  id: string;
  notes?: { apiVersion: 1 };
  // Static configuration from the module manifest's serverConfig field. Core
  // never sends this object to browsers. Use it for trust-boundary settings
  // that client-writable host.settings must not be able to lower or redirect.
  readonly config: Readonly<Record<string, unknown>>;
  // Absolute path to the host's data/config directory. Modules store files
  // under it (e.g. join(dataDir, "uploads")). Same dir core uses.
  dataDir: string;
  registerRoute(method: string, path: string, handler: RouteHandler): void;
  // An RPC that MUTATES shared state must broadcast the new state before
  // returning — don't rely on the return value to update the UI. The client's
  // host.rpc.call return is for one-off reads; live UI reflects state from
  // host.events.on(event), which only fires from broadcast(). A mutator that
  // returns the new state but skips broadcast() leaves every client (including
  // the caller) stale until it re-reads — e.g. on refresh. See broadcast below.
  registerRpc(method: string, handler: RpcHandler): void;
  // Expose a tool to MCP clients (Claude Code panes) at the host's POST /mcp
  // endpoint. Mirrors registerRpc/registerRoute: the registration lives in the
  // module's registry and is torn down with it. Throws at activate() on a
  // duplicate exposed name within this module or a collision with a core tool.
  registerMcpTool(def: McpToolDef): void;
  // Versioned, in-process interoperability between trusted server modules.
  // Providers are tried by module id, then registration order. A provider that
  // declines must not mutate state; thrown errors propagate to the consumer.
  capabilities: {
    provide<I, O>(
      name: string,
      handler: (input: I) => ServerCapabilityHandlerResult<O> | Promise<ServerCapabilityHandlerResult<O>>,
    ): () => void;
    has(name: string): boolean;
    invoke<I, O>(name: string, input: I): Promise<ServerCapabilityInvocation<O>>;
  };
  // Register a coding-agent adapter. Core owns PTYs, synchronization, generic
  // status rendering, and attention UX; the module owns CLI setup, launch/resume
  // arguments, callback validation, and telemetry translation.
  agents: {
    register(def: AgentIntegrationDefinition): () => void;
    session(sessionId: string): AgentSessionInfo | null;
    current(sessionId: string): AgentSnapshot | undefined;
    publish(sessionId: string, snapshot: AgentSnapshot): void;
    reportStatus(sessionId: string, status: "running" | "idle"): void;
    notify(sessionId: string, message: string): void;
    setModel(sessionId: string, model: string): void;
    rename(sessionId: string, label: string): void;
  };
  // Fan a `module:event` out to ALL clients (including the action's originator;
  // see ws.ts broadcast()). This is the ONLY live-update path: the client mirror
  // is host.events.on(event, …). So every state change a client should see live
  // — RPC mutations, scheduled/timer-driven changes — must broadcast() the new
  // state. Broadcasting only on some transitions (e.g. an auto-advance but not a
  // manual start/stop) is the classic bug: those untriggered changes appear only
  // after a refresh re-reads via a getState RPC.
  broadcast(event: string, payload: unknown): void;
  kv: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  // Schema-validated, single-object config for this module (module_settings
  // table). One config blob per module, versioned (OCC). Prefer this over kv
  // for a module's user-facing settings: the host validates every write against
  // the declared schema and exposes the schema to clients for rendering a UI.
  settings: {
    // Declare the config's JSON Schema and its default. Seeds the stored config
    // with `def` on first boot (never clobbers an existing row). The schema is
    // retained for write-validation and client exposure. Call once in activate().
    define(schema: JsonSchema, def: unknown): void;
    // The current stored config (validated/coerced against the schema).
    get(): unknown;
    // Merge+validate a patch onto the current config, persist, broadcast the new
    // config to all clients, and return it. Invalid fields fall back per-field.
    set(patch: unknown): unknown;
    // The declared schema (null until define() runs).
    schema(): JsonSchema | null;
  };
  // Shared SQLite handle. The module owns its own tables via migrate().
  db: Database;
  migrate(migrations: Migration[]): void;
  // Receive client messages whose type begins with one of `prefixes`. The
  // handler returns sync effects (host.sync.*) the core router plays.
  onMessage(prefixes: string[], handler: ModuleMessageHandler): () => void;
  // Sender-aware sync. set/del broadcast a module:patch to all clients;
  // toSender unicasts to the originating socket only (OCC conflict replies).
  sync: {
    set(entity: string, data: unknown): Effect;
    del(entity: string, id: string): Effect;
    toSender(msg: unknown): Effect;
  };
  log(...args: unknown[]): void;
  schedule(delayMs: number, cb: () => void): () => void;
  interval(ms: number, cb: () => void): () => void;
  now(): number;
  // Core entities are resolved only when their persisted workspace ownership
  // matches ref.workspaceId. Note writes require the version returned by get().
  entities: {
    list(workspaceId: string): ResolvedEntity[];
    get(ref: EntityRef): ResolvedEntity | null;
    update(ref: EntityRef<"note">, patch: NoteMetadataPatch): ResolvedEntity | EntityConflict | null;
    update(ref: EntityRef<"session" | "task_list">, patch: EntityMetadataPatch): ResolvedEntity | null;
    // Optional: create a new note entity. Hosts that don't implement this omit
    // the method; modules must feature-detect (typeof create === "function").
    // ref.id is the caller-chosen id (e.g. derived from an idempotency key),
    // so a replay against an existing note id is a no-op.
    create?(ref: EntityRef<"note">, input: { noteType?: "markdown" | "excalidraw" }): ResolvedEntity | null;
  };
  // Task operations are scoped by the globally-unique task-list id; core
  // derives the authoritative workspace owner from the persisted list row.
  tasks: {
    onChange(cb: (event: { listId: string }) => void): () => void;
    getList(listId: string): TaskBundle | null;
    createList(primaryTabId: string, input: CreateTaskListInput): TaskMutationResult<TaskList>;
    updateList(listId: string, input: UpdateTaskListInput): TaskMutationResult<TaskList>;
    deleteList(listId: string): TaskMutationResult;
    claim(listId: string, input: TaskClaimInput): TaskMutationResult<{ change: TaskChangeSet; leaseToken: string }>;
    renew(listId: string, taskId: string, leaseToken: string): TaskMutationResult<TaskClaim>;
    ack(listId: string, taskId: string, leaseToken: string, lastSeenCommentId: string | null): TaskMutationResult<TaskClaim>;
    comment(listId: string, taskId: string, input: TaskCommentInput): TaskMutationResult;
    release(listId: string, taskId: string, leaseToken: string, bodyMarkdown?: string): TaskMutationResult;
    complete(listId: string, taskId: string, input: TaskCompletionInput): TaskMutationResult;
  };
  workspaces: { get(id: string): { id: string; cwd: string } | null };
  // Programmatic session control for automation modules (workflows). create()
  // persists the session, broadcasts the core patch, and boots its PTY headlessly
  // so it runs with no viewer. A worker prompt is supported only by a configured
  // adapter that advertises the capability. restart() is for explicit, user-approved replacement of
  // an existing process. ensure() boots or attaches a persisted supported
  // session and returns only once write() can immediately target its shared PTY.
  // stop() interrupts active work without deleting or archiving its persisted
  // session. onEvent() taps session status and process-exit events.
  sessions: {
    ensure(sessionId: string): Promise<"ready" | "missing" | "unsupported">;
    stop(sessionId: string): Promise<"stopped" | "already_stopped" | "missing" | "failed">;
    create(opts: {
      primaryTabId: string;
      groupId?: string;
      label: string;
      kind?: string;
      cwd?: string;
      workerPrompt?: string;
    }): Promise<{ sessionId: string } | null>;
    restart(sessionId: string, opts: { workerPrompt: string }): Promise<boolean>;
    createGroup(primaryTabId: string, label: string): { groupId: string } | null;
    write(sessionId: string, text: string): boolean;
    onEvent(cb: (e:
      | { kind: "status"; sessionId: string; status: "running" | "idle" }
      | { kind: "agent-status"; sessionId: string }
      | { kind: "exit"; sessionId: string }
    ) => void): () => void;
  };
  room(id: string, spec: RoomSpec): () => void;
}

export type ServerModule = (host: ServerHost) => void | (() => void);
