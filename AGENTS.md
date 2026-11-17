# Repository Guidelines

Dugout is a single-user, offline Premier League football manager game. Stack: T3 (Next.js 15 App Router, tRPC 11, Drizzle ORM, PostgreSQL 18, Tailwind 4, Biome), TypeScript strict, npm.

## Hard Rules

- Keep the match/season simulation engine framework-free: no imports from `next`, `react`, `~/trpc` or `~/server/db`. It must run from the command line for batch calibration (FR-013 in @context/foundation/prd.md; rationale in @context/foundation/tech-stack.md).
- Never edit `context/archive/`. Foundation docs in `context/foundation/` are edited in place (@context/foundation/README.md); change-scoped docs go to `context/changes/<change-id>/`.
- Never commit `.env`. Add new env vars to the schema in @src/env.js and to @.env.example in the same change.
- Before declaring work done, all four must pass: `npm test`, `npm run typecheck`, `npm run check`, `npm run build`. The owner reviews schema, migrations and calibration output more easily than React code, so keep those diffs explicit.

## Project Structure

- `src/app/` — Next.js routes; put route-local client components in `_components/`.
- `src/engine/` — pure match/season engine (attributes, club strength, report); framework-free, see Hard Rules.
- `src/server/api/` — tRPC: routers in `routers/`, registered in @src/server/api/root.ts.
- `src/server/db/` — Drizzle schema (@src/server/db/schema.ts) and client.
- `src/trpc/` — client/server tRPC helpers.
- `src/import/` — API-Football (`api-football/`) and openfootball (`openfootball/`) import stages.
- `data/openfootball/` — verbatim CC0 copies of openfootball JSON; do not edit (refresh per `data/openfootball/README.md`).
- `drizzle/` — committed SQL migrations; `scripts/` — thin CLI entry points.
- `context/` — PRD, tech stack, change plans and logs. Local only: it is in `.gitignore` and not part of the public repo, so `@context/...` references resolve only in the maintainer's copy.

## Commands

- `./start-database.sh` — start the `dugout-postgres` container (Docker, `postgres:18`).
- `npm run attributes:report -- --league 39 --season 2024 [--club <name>]` — player attributes and club strength vs. the final table (needs a loaded season).
- `npm run calibration:report -- --league 39 --season 2024 [--seasons 100] [--seed 1] [--club <name|apiId>]` — simulated seasons vs. real league stats and PRD ranges, lineup test (needs a loaded season).
- `npm run open:load [-- --league <code>]` — clubs and fixtures of 8 leagues from `data/openfootball/` (no API key; run after `import:season` for a league with real squads; idempotent).
- `npm run dev` — dev server (Turbopack).
- `npm run db:generate` then `npm run db:migrate` — the only way to change the schema; SQL migrations in `drizzle/` are committed. Do not use `db:push`.
- `npx tsx scripts/<name>.ts` — run CLI scripts that import from `src/` (`tsx` resolves the `~/` alias; plain `node` does not).
- `npm run check:write` — Biome format + lint fixes.
- `npm run typecheck` — `tsc --noEmit`.

## Coding Style

- Biome (@biome.jsonc) enforces formatting (tabs), import sorting and Tailwind class order; `context/`, generated `drizzle/` and `data/openfootball/` (verbatim copies) are excluded from Biome.
- Import from `src` via the `~/` alias (@tsconfig.json). `noUncheckedIndexedAccess` is on — handle `undefined` from index access.
- Every table is created through `createTable`, so names carry the `dugout_` prefix; `drizzle.config.ts` filters on it.

## Testing

Vitest (@vitest.config.ts), Node environment. Tests sit next to the code as `src/**/*.test.ts`. Run all with `npm test`, one file with `npx vitest run <path>`. Tests must not need the network, an API key or a running database — inject `fetch`, use committed JSON fixtures.

## Commits

Conventional Commits, as in `git log`: `chore:`, `chore(deps):`, `feat:`, `fix:`. Branch: `main`. No remote configured.
