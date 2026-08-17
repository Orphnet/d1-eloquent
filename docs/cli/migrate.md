# migrate

Run all pending migrations against a D1 database. Migrations are tracked in the `_migrations` table, which is created automatically on first run. Already-applied migrations are skipped, so this command is safe to run multiple times.

## Synopsis

```bash
bunx d1-eloquent migrate [--pretend] [--only=<names>] [--atomic] [--db=<DB_NAME>] [--remote]
```

## Options

| Flag | Description |
| --- | --- |
| `--pretend` | Print the SQL each pending migration would run, without executing it. Useful for reviewing the generated DDL before applying. |
| `--only=<names>` | Run only the named migration(s). Accepts a comma-separated list matched against each migration's `name` field; pending migrations not in the list are skipped. |
| `--atomic` | Wrap each pending migration in a single transaction. Applies to remote execution only — ignored locally (Miniflare's D1 backing store rejects `BEGIN`/`COMMIT`), where statements run sequentially. |
| `--db=<DB_NAME>` | Optional. The D1 binding name. Auto-detected from `wrangler.jsonc` (also `wrangler.json` / `wrangler.toml`), falls back to `'DB'`. |
| `--local` | Run against the local D1 database. This is the default. |
| `--remote` | Run against the Cloudflare-hosted D1 database. |

## Examples

Run pending migrations locally (zero-config):

```bash
bunx d1-eloquent migrate
```

Run pending migrations against the remote Cloudflare D1 database:

```bash
bunx d1-eloquent migrate --remote
```

Run all pending migrations atomically on remote (all succeed or all roll back):

```bash
bunx d1-eloquent migrate --remote --atomic
```

Preview the SQL without applying it:

```bash
bunx d1-eloquent migrate --pretend
```

Apply only specific migrations by name:

```bash
bunx d1-eloquent migrate --only=20240110_000000_add_soft_deletes_to_posts
```

Override the auto-detected binding name:

```bash
bunx d1-eloquent migrate --db=CUSTOM_DB
```

## Notes

- The `_migrations` table is created automatically if it does not exist.
- `--only` filters the pending set to specific migration names — handy for re-running a single migration in development. It still respects applied/pending tracking, so already-applied migrations are never re-run.
- Migration files are discovered across multiple directories and sorted by filename (timestamp prefix ensures correct order). Searched in order: `src/database/migrations/`, `src/migrations/`, `migrations/`, `database/migrations/`, and any `src/plugins/<name>/migrations/` or `src/plugins/<name>/database/migrations/` directories.
- Migration files may use **extensionless relative imports** (e.g. `import { User } from "../models/User"`). The CLI registers a `node:module` resolver hook so these resolve correctly under plain Node; under Bun they already work natively. Explicit `.ts` extensions remain valid too — both styles are supported.
- Use `make:migration` to generate new migration files. See [Generators](./generators.md).

---

## status

Check which migrations have been applied and which are still pending.

### Synopsis

```bash
bunx d1-eloquent status [--db=<DB_NAME>] [--remote]
```

### Options

| Flag | Description |
| --- | --- |
| `--db=<DB_NAME>` | Optional. Auto-detected from `wrangler.jsonc` (also `wrangler.json` / `wrangler.toml`), falls back to `'DB'`. |
| `--local` | Query the local D1 database. This is the default. |
| `--remote` | Query the Cloudflare-hosted D1 database. |

### Example

```bash
bunx d1-eloquent status
```

Example output:

```
Migration                                    Status    Batch   Applied At
-----------------------------------------    -------   ------  --------------------
20240101_000000_create_users_table           ran       1       2024-01-15 10:23:41
20240102_000000_create_posts_table           ran       1       2024-01-15 10:23:42
20240110_000000_add_soft_deletes_to_posts    pending   -       -
```

Migrations support an optional `description` field. When any migration has a description, a **Description** column is automatically shown:

```
Migration                                    Description                          Status    Batch   Applied At
-----------------------------------------    -----------------------------------  -------   ------  --------------------
20240101_000000_create_users_table           -                                    ran       1       2024-01-15 10:23:41
20240315_000000_fix_created_at               Correct create_at → created_at       ran       2       2024-03-15 09:00:00
20240320_000000_add_email_index              -                                    pending   -       -
```
