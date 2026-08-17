# Contributing to d1-eloquent

Thanks for your interest in improving d1-eloquent! This is a public **beta** — bug
reports, reproductions, and focused PRs are all welcome.

## Ground rules

- **Bun only.** This project uses [Bun](https://bun.sh) as its package manager and
  test runner. Please don't add `npm` / `pnpm` / `yarn` lockfiles (they're gitignored).
- **Cloudflare Workers runtime.** The library targets the Workers/edge runtime and is
  **ESM-only**. Keep new code free of Node-only built-ins unless they're behind the CLI
  (`scripts/`), which runs under Bun locally.
- **Types first.** No `any` in library code. Public API changes must ship with types.

## Local setup

```bash
git clone https://github.com/Orphnet/d1-eloquent.git
cd d1-eloquent
bun install
bun run build      # emits dist/ via tsup
```

## Project layout

| Path | What it is |
|------|-----------|
| `d1Eloquent/` | The ORM runtime — `BaseModel`, `QueryBuilder`, relations, casts, revisions, cache adapters (+ its `tests/`) |
| `src/` | Thin public barrels: `index.ts`, `cli-exports.ts`, `config.ts`, `bin.ts` |
| `scripts/` | The `d1-eloquent` CLI — migrations, seeders, factories, tinker REPL (+ its `tests/`) |
| `docs/` | Standalone markdown guides (the rendered site lives elsewhere) |

## Tests & quality gates

Run these before opening a PR — CI enforces all of them:

```bash
bun run test:all        # library suite + CLI suite
bun run test:coverage   # hard-fails below the thresholds in vitest.config.ts
bun run check           # publint + are-the-types-wrong on the built package
```

- Tests are **deterministic** — no network dependence. Mock D1 with the in-memory
  test worker (`wrangler.jsonc` + `@cloudflare/vitest-pool-workers`).
- **When you fix a bug, add a regression test** that fails before your fix and passes
  after.
- Coverage gates: statements/functions/lines ≥ 95%, branches ≥ 90%.

## Pull requests

1. Branch off `develop`.
2. Keep diffs small and focused — one concern per PR.
3. Update `CHANGELOG.md` under `## [Unreleased]` (Keep a Changelog format).
4. Make sure `bun run test:all`, `bun run test:coverage`, and `bun run check` are green.
5. Fill in the PR template.

## Reporting bugs

Open an issue using the **Bug report** template. A minimal reproduction (a failing test
or a small Worker snippet) is the single most useful thing you can include.

By contributing, you agree that your contributions are licensed under the MIT License.
