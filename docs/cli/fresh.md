# fresh

Drop all tables and re-run every migration from scratch.

> [!CAUTION]
> **Data Loss**
> `fresh` drops all tables and re-runs all migrations. **All data is permanently deleted.** Only use this command on local or development databases. Never run it against a production database. As a guardrail, running against `--remote` requires an explicit `--force` flag.

## Synopsis

```bash
bunx d1-eloquent fresh [--seed] [--atomic] [--db=<DB_NAME>] [--remote --force]
```

## Options

| Flag | Description |
| --- | --- |
| `--seed` | After re-migrating, run the seeders (`DatabaseSeeder`) to repopulate the database. Equivalent to running `seed` immediately afterwards. |
| `--atomic` | Wrap the table drops in a single transaction, and pass `--atomic` through to the re-migration. Applies to remote execution only — ignored locally (Miniflare's D1 backing store rejects `BEGIN`/`COMMIT`). |
| `--force` | **Required** to run against `--remote`. Without it, `fresh --remote` refuses to run and exits with an error. Has no effect locally. |
| `--db=<DB_NAME>` | Optional. The D1 binding name. Auto-detected from `wrangler.jsonc` (also `wrangler.json` / `wrangler.toml`), falls back to `'DB'`. |
| `--local` | Run against the local D1 database. This is the default. Recommended — keep `fresh` local. |
| `--remote` | Run against the Cloudflare-hosted D1 database. Requires `--force`. **Use with extreme caution.** |

## Examples

Reset the local database and apply all migrations from scratch:

```bash
bunx d1-eloquent fresh
```

Reset and immediately repopulate with seed data:

```bash
bunx d1-eloquent fresh --seed
```

Reset the remote database (guarded by `--force`):

```bash
bunx d1-eloquent fresh --remote --force
```

## Notes

- `fresh` is equivalent to dropping every table manually and then running `migrate`.
- User tables are dropped in foreign-key-safe order (child tables before the parents they reference), so drops succeed even with FK constraints enforced.
- SQLite/D1 internal tables (`sqlite_*`, `_cf_*`, `_d1_*`) and the `_migrations` table itself are never dropped. The `_migrations` rows are then cleared, so every migration file is treated as new on the following re-migration.
- After `fresh` (without `--seed`), run `seed` to repopulate the database with development data.
