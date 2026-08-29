# @tabterm/module-git

The **git** module for [tabterm](https://github.com/and1truong/tabterm) — a local Git UI
(`id: git`), extracted from the monorepo (`modules/git/`) into its own repository.

- **Changes** — multi-file, hunk, and line staging; exact-path ignore; safe discard;
  three-way conflict resolution; and commit drafts with body, amend, sign-off, and signing.
- **Sync** — fetch/prune, selectable pull strategy, publish/push, progress, cancellation,
  remote branches, and clear non-fast-forward guidance.
- **History & refs** — searchable DAG, commit metadata/signature, compare, cherry-pick,
  revert, merge, rebase and interactive squash/fixup, tags, stashes, and blame/file history.
- **Recovery & power tools** — reflog recovery branches, safety refs and non-destructive
  resets, bisect, worktrees, submodules, and subtree pull/push.

The server half opens a `host.room("git", …)` that polls `git status` (~1.5s) and refreshes
refs (~5s) for each subscribed workspace, and routes `git:*` request messages to the git
CLI. The one persisted table it owns is `git_subtrees` (workspace-scoped).

## Layout

```
shared.ts            Git domain + wire types (GitSnapshot, GitRefs, DiffPayload,
                     LogEntry, Branch/Remote/Stash/Submodule, GitSubtree, gitSubtree:*)
server.ts            Server entry — activate(host): the git room (poll + request routing)
                     plus the subtree migration/service and a GET /subtrees route
server/git.ts        git CLI layer — runGit, resolveRoot, status, diff, staging, log, …
server/subtree*.ts   git_subtrees table: db, migration, gitSubtree:* service
src/index.tsx        Client entry — activate(host): the Git rail page + git:* event wiring
src/git/             UI: changes/diff/conflicts, commit, history/compare, refs,
                     recovery, rebase plan, stash, file insight, and management dialogs
scripts/build-modules.ts   Builds the two self-contained dist artifacts
scripts/git-ui-smoke.ts    happy-dom interaction smoke test for critical UI flows
```

The module talks to the host **only** through `@tabterm/module-host` (the type-only
contract) plus its own files — no deep imports into tabterm's `src/`. It owns its
DB schema (`host.migrate`), its message routing (`host.room` / `host.onMessage`), its
route (`host.registerRoute`), and its UI (`host.ui.registerUI`). See `docs/modules.md` in
tabterm for the full host API.

## Development

```sh
bun install        # resolves highlight.js/lucide-react + links @tabterm/module-host
bun run typecheck  # tsc --noEmit
bun test           # integration + git-parsing + subtree-service tests
bun run test:ui    # critical UI interaction smoke test
make build         # -> dist/modules/git/{client.js,server.js}
```

`@tabterm/module-host` (the type-only host contract) is **vendored** under
`vendor/module-host/` and resolved via `file:./vendor/module-host` (see `package.json`
devDependencies) — no npm/registry dependency. To update it, run
`make vendor TABTERM=<path-to-tabterm>`.

## Consuming this module in tabterm

Unlike a monorepo module, this repo builds its own artifacts. `make build` emits two
self-contained files under `dist/modules/git/`:

- **`client.js`** — ESM client bundle. `react`/`react-dom` stay external (host-provided at
  runtime); `lucide-react` and `highlight.js` are inlined. No CSS (Tailwind classes only).
  Default export is `activate(host)`.
- **`server.js`** — server half (`--target bun` ESM). Default export is `activate(host)`.

Point tabterm's config at them:

```yaml
modules:
  - { id: git, enabled: true,
      client: ~/dirs/tabterm-git/dist/modules/git/client.js,
      server: ~/dirs/tabterm-git/dist/modules/git/server.js }
```

Rebuild here (`make build`) whenever the module changes; tabterm picks up the new bundles
on its next load.
