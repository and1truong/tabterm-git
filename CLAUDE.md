# tabterm-git

The **git** module for [tabterm](https://github.com/and1truong/tabterm), extracted into
its own repository — a local Git UI (`id: git`): per-hunk stage/discard, diff viewer,
commit composer, history graph, and a Refs sidebar (branches / remotes / stashes / tags /
submodules / subtrees). A tabterm *module*, not a standalone app: it has no server/SPA of
its own; it activates inside a tabterm host through the `@tabterm/module-host` contract.

## Toolchain

- **Runtime + package manager: [Bun](https://bun.sh)** (required ≥1.3.5, see `package.json` engines).
  Use `bun` for everything. Do **not** use `npm`, `yarn`, or `pnpm`. Lockfile is `bun.lock`.
- **Typecheck:** `bun run typecheck` (`tsc --noEmit`) — or `make typecheck`.
- **Test:** `bun test` (git-parsing + subtree-service tests) — or `make test`.
- **Full local gate:** `make check` (typecheck + test).
- **Build:** `make build` → `dist/modules/git/{client.js,server.js}`.
- `make help` lists every target.

## Architecture

The module talks to the host **only** through `@tabterm/module-host` plus its own files —
no deep imports into a host's `src/`. It owns everything it needs:

- `shared.ts` — the git domain + wire types (`GitSnapshot`, `GitRefs`, `DiffPayload`,
  `LogEntry`, `Branch`/`Remote`/`Stash`/`Submodule`, `GitSubtree`, the `gitSubtree:*`
  message union). Copied from the host at extraction so the module has no deep import.
- `server.ts` — server entry: `activate(host)` opens a **room** (`host.room("git", …)`)
  that, per subscribed workspace, polls `git status` (~1.5s) and refresh­es refs (~5s),
  and routes `git:*` request messages to the git CLI wrappers. It also runs the subtree
  migration + `gitSubtree:*` message service and a `GET /subtrees` route.
- `server/git.ts` — the git CLI layer: `runGit` (spawn `git -C <root> …`), `resolveRoot`,
  `status`, `diff`, `commitDiff`, staging/discard, `stageHunk` (via `git apply`), `commit`,
  branch/stash/tag/remote/submodule/log ops. All parsing lives here.
- `server/subtree{Db,Migrations,Service}.ts` — the one persisted table this module owns
  (`git_subtrees`, workspace-scoped), its schema migration, and the `gitSubtree:*` handler
  that broadcasts changes via `host.sync`.
- `src/index.tsx` — client entry: `activate(host)` registers the **Git** rail page and
  wires the `git:*` server events into `host.store` (keyed by `tabId`). UI lives under
  `src/git/` (ChangesPane, CommitComposer, DiffView, HistoryView, RefsColumn, the create
  dialogs, ManageDialog). `DiffView` uses `highlight.js` for syntax highlighting.

## Host contract (`@tabterm/module-host`)

- **Vendored** under `vendor/module-host/`, resolved via `file:./vendor/module-host` — no
  registry dependency. Pinned to a tagged snapshot (see `vendor/README.md`).
- Refresh it with `make vendor TABTERM=<path-to-tabterm>` when the contract changes, then
  bump `vendor/module-host/package.json` and re-tag.
- `react` / `react-dom` are **host-provided** at runtime (externalized in the module
  build) — declared here as peer/dev deps for typecheck + tests only. `lucide-react` and
  `highlight.js` are real dependencies and are bundled into `client.js`.

## Building / consuming this module

This repo ships **source** and builds its own **self-contained** artifacts. `make build`
(`scripts/build-modules.ts`) compiles:
- `src/index.tsx` → `dist/modules/git/client.js` (ESM, react/react-dom external,
  no code-splitting, no CSS — Tailwind classes only; highlight.js inlined);
- `server.ts` → `dist/modules/git/server.js` (`--target bun`).

A tabterm host loads these two files via its `modules:` config. See `README.md`.

## Conventions

- Surgical changes; match existing style. The module's clean host-only boundary is the
  whole point of the extraction — never reach back into a host's internals.
- Tests are colocated (`*.test.ts`).
- **Note for the host side:** before extraction, tabterm's `src/server/shellStatus.ts`
  deep-imported `runGit` from this module. On extraction the host was given its own local
  copy of that ~8-line helper, so removing this module from the tree leaves no dangling
  host import.
