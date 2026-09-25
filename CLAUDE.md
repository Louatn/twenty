# CLAUDE.md

This is SyncData's fork of Twenty (`Louatn/twenty`, branch `syncdata`; `upstream` = `twentyhq/twenty`), mounted as the `src/twenty` submodule of `Louatn/SyncData`. SyncData is a CRM for AXEOS.

**Server-only fork.** Twenty's web UI (`twenty-front`, `twenty-ui`, `twenty-front-component-renderer`) was removed: SyncData will ship its own interface. The server is kept whole so its core can be reused to scale the CRM and offer it to other companies. `twenty-website` stays on disk but is deactivated (out of the Yarn workspaces, hidden from Nx by `.nxignore`). The Docker image is `twenty-server` (API + worker, no `dist/front`), built by `deploy/twenty/compose.yaml` in the parent repo.

Nx / Yarn 4 monorepo. Main packages: `twenty-server` (NestJS, TypeORM, PostgreSQL, Redis, GraphQL), `twenty-shared` (isomorphic types/utils), `twenty-emails`, `twenty-client-sdk`, `twenty-sdk` (application SDK + CLI; front components depend on the npm-published `twenty-ui`).

When merging `upstream`, expect conflicts on the deleted UI packages: keep them deleted.

Match the surrounding code — the adjacent files in the directory you are editing beat any written rule, including for file naming, which varies by area.

## House rules

Where this repo differs from your defaults:

- Short-form `//` comments, never JSDoc blocks; comment only WHY (a constraint the code cannot express, still true for a reader who never saw your change), never WHAT.
- Types over interfaces (except when extending third-party interfaces); string literals over enums (except GraphQL enums); no `any`; descriptive generics (`TData`, not `T`).
- Named exports only. Functional components only.
- No abbreviations in names (`fieldMetadata`, not `fm`); constants in SCREAMING_SNAKE_CASE; component props types suffixed `Props`.
- Use `twenty-shared/utils` guards (`isDefined`, `isNonEmptyString`, …) and other existing helpers before writing your own — reimplementing an existing util is the most common AI-authored defect here.
- Lingui for user-facing strings.
- Test behavior, not implementation.

Longer-form guides remain in `.cursor/rules/` (from the Cursor era; some still mention `twenty-front`, which no longer exists here).

## Commands

```bash
bash packages/twenty-utils/setup-dev-env.sh   # Postgres/Redis + DB init; only for tasks needing a running app
yarn start                                    # server + worker (no UI)

npx jest path/to/file.spec.ts --config=packages/<pkg>/jest.config.mjs   # single test file (preferred)
npx nx test twenty-server                     # package unit tests
npx nx run twenty-server:test:integration:with-db-reset

npx nx lint:diff-with-main twenty-server      # diff-based lint (fast; add --configuration=fix); run with typecheck after changes
npx nx fmt <pkg>                              # format
npx nx build twenty-shared                    # required before building/testing packages that depend on it
npx nx database:reset twenty-server
```

## Gotchas

- **Node 24 required.** The homelab host runs Node 20; run Yarn inside `node:24` (e.g. `docker run --rm -v "$PWD":/app -w /app node:24.19.0-alpine3.23 node .yarn/releases/yarn-4.13.0.cjs install --mode=update-lockfile`).
- **`twenty-shared/dist` is per-branch state nothing tracks.** After switching branches or editing `twenty-shared`, run `npx nx build twenty-shared --skip-nx-cache` before trusting any typecheck or test failure in a dependent package.
- **Nx caching can serve a stale pass.** To verify a fix, run `npx tsgo -p tsconfig.json --noEmit` in the package directly rather than `nx typecheck`.
- **Do not commit translation catalogs unless translations are the task.** `lingui extract`/`compile` regenerate `packages/twenty-server/src/engine/core-modules/i18n/locales/*.po` and `locales/generated/*` with thousands of lines of churn as a side effect of touching any `msg` string. The i18n pipeline maintains them; leave them out of your commit.
- **Commit messages must not carry AI attribution.** Upstream CI rejects commits containing `@anthropic.com` co-author trailers or "Generated with Claude Code" lines.
- **Upgrade commands** (`packages/twenty-server/src/database/commands/upgrade-version-command/`): add or edit files only under the current `TWENTY_CURRENT_VERSION` directory, with a real epoch-ms timestamp strictly greater than every existing one in that directory — CI enforces both, and the upgrade cursor silently skips a command that sorts before an already-applied one. Include `up` and `down`; never rewrite committed command logic. See `packages/twenty-server/docs/UPGRADE_COMMANDS.md`.
- **Entity file changes need a generated instance command**: `npx nx run twenty-server:database:migrate:generate --name <name> --type <fast|slow>` (slow = adds a data-backfill step).
- A read-only Postgres MCP server is configured in `.mcp.json` for inspecting workspace data, metadata, and migration results. Writes go through the CLI commands above.
- **Upstream CI workflows** (`.github/workflows/`) still include front/e2e jobs that will fail on this fork; `twenty-e2e-testing` only targeted the removed UI.
