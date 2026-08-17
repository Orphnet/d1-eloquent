# seed

Execute seeder files to populate the database with development or test data.

## Synopsis

```bash
bunx d1-eloquent seed [SeederName] [--db=<DB_NAME>] [--remote] [--seeder=<Name>] [--idempotent] [--fresh] [--pretend]
```

## Options

| Flag | Description |
| --- | --- |
| `[SeederName]` | Optional positional argument. Run a specific seeder by name. Defaults to `DatabaseSeeder` when omitted. Must match `[A-Za-z0-9_]`. |
| `--db=<DB_NAME>` | Optional. The D1 binding name. Auto-detected from `wrangler.jsonc` (also `wrangler.json` / `wrangler.toml`), falls back to `'DB'`. |
| `--local` | Run against the local D1 database. This is the default. |
| `--remote` | Run against the Cloudflare-hosted D1 database. |
| `--seeder=<Name>` | Run a specific seeder class by name (alternative to positional arg). Also accepts `--class=<Name>`. Must match `[A-Za-z0-9_]`. |
| `--idempotent` | Use UPSERT (`INSERT ... ON CONFLICT DO UPDATE SET`) instead of `INSERT`. Re-running the seeder will update existing rows that share the same primary key instead of failing or creating duplicates. FK-safe — does not trigger `ON DELETE CASCADE`. |
| `--fresh` | Delete all existing rows from each seeded table before inserting. Each table is cleared only once per run, even if multiple factories target it. Alias: `--clear`. |
| `--pretend` | Print the SQL statements that would be executed without actually running them. |
| `--verbose`, `-v` | Show additional detail during seeding. When a seeder has a `description` field, it is printed below the seeder name. |

## Examples

Run all seeders locally (zero-config):

```bash
bunx d1-eloquent seed
```

Run a single seeder (positional arg):

```bash
bunx d1-eloquent seed UserSeeder
```

Run a single seeder (flag):

```bash
bunx d1-eloquent seed --seeder=UserSeeder
```

Run all seeders against the remote database:

```bash
bunx d1-eloquent seed --remote
```

Re-seed with upsert (overwrite existing rows on PK conflict):

```bash
bunx d1-eloquent seed --idempotent
```

Clear seeded tables then re-seed from scratch:

```bash
bunx d1-eloquent seed --fresh
```

Combine both flags — clear tables, then insert with upsert safety:

```bash
bunx d1-eloquent seed --fresh --idempotent
```

Preview what SQL would run without executing:

```bash
bunx d1-eloquent seed --fresh --idempotent --pretend
```

## Notes

- Seeder files are discovered across multiple directories, searched in order: `src/database/seeders/`, `src/seeders/`, `seeders/`, `database/seeders/`, and any `src/plugins/<name>/seeders/` or `src/plugins/<name>/database/seeders/` directories. The first match wins.
- Seeder names may only contain letters, numbers, and underscores (`[A-Za-z0-9_]`). The name is interpolated into a filesystem path before being dynamically imported, so this restriction (and a path-confinement check) prevents a crafted name like `../../evil` from escaping the seeder directories. An invalid name fails fast with a clear error.
- Relative imports inside a seeder can be written **without** a file extension — for example `import { tenantId } from "../support/ids"` — and resolve correctly under both Bun and plain Node. The CLI installs a Node resolver hook so the old requirement to append explicit `.ts` extensions no longer applies. Both extensionless and explicit-`.ts` imports work.
- When running all seeders, they execute in **alphabetical order by filename**. Use numeric prefixes to control order when seeders depend on each other — for example: `01_UserSeeder.ts`, `02_PostSeeder.ts`.
- Use `make:seeder` to generate a new seeder file. See [Generators](./generators.md).
- Seeders are not idempotent by default — running them twice may insert duplicate rows. Use `--idempotent` for UPSERT behavior (FK-safe), or `--fresh` to clear tables before seeding.
- `--fresh` only clears tables that factories actually insert into during the run. It does not drop or truncate all tables — use the `fresh` migration command for that.
- The `--idempotent` and `--fresh` flags are also available as `opts.idempotent` and `opts.fresh` inside custom seeders that use `d1Execute` directly.
