# Migrations

Migrations are versioned TypeScript files that build and evolve your D1 schema. Each file exports an `up` (apply) and `down` (revert) function that receive a `Schema` instance — no `db` argument, no raw SQL execution. The CLI tracks which migrations have run in a `_migrations` table.

> The full migration DSL — every column type, constraint, foreign key, and modifier — lives in the **[Schema Builder reference](../api/schema-builder.md)**. This page covers the day-to-day workflow; reach for that page when you need the exact method signatures.

## Workflow at a glance

```sh
bunx d1-eloquent make:migration create_users_table   # 1. scaffold
# …edit the generated file…
bunx d1-eloquent migrate                              # 2. apply pending
bunx d1-eloquent status                               # 3. inspect state
bunx d1-eloquent rollback                             # 4. revert last batch
bunx d1-eloquent fresh                                # 5. drop all + re-run
```

The binding name is read from `wrangler.jsonc` automatically and defaults to local D1 — no `--db`/`--local` flags needed.

## 1. Scaffold a migration

```sh
bunx d1-eloquent make:migration create_users_table
```

This writes `src/database/migrations/TIMESTAMP_create_users_table.ts` with commented stubs. One migration per domain entity — keep them small and focused rather than monolithic. See the [Generators reference](../cli/generators.md) for all `make:*` commands.

## 2. Write the schema

```ts
// src/database/migrations/20260101000000_create_users_table.ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260101000000_create_users_table',

  up: (schema: Schema) => {
    schema.createTable('users', (t) => {
      t.id()                              // TEXT PRIMARY KEY (UUID)
      t.text('name')
      t.text('email', { unique: true })
      t.boolean('is_admin').default(false)
      t.text('settings').nullable()       // JSON stored as TEXT
      t.timestamps()                      // created_at / updated_at
      t.softDeletes()                     // deleted_at (omit if not soft-deleting)
    })
  },

  down: (schema: Schema) => {
    schema.dropTable('users')
  },
}

export default migration
```

Foreign keys, composite keys, indexes, check constraints, and altering existing tables are all covered in the [Schema Builder reference](../api/schema-builder.md).

> [!TIP]
> **Keep `down` a true inverse**
> Whatever `up` creates, `down` should undo — so `rollback` and `fresh` stay clean. For a `createTable`, that's a matching `dropTable`; for an `addColumn` alter, drop the column.

## 3. Apply migrations

```sh
bunx d1-eloquent migrate
```

Runs every pending migration in timestamp order and records each in `_migrations`:

```
Running: 20260101000000_create_users_table
✓ Applied 1 migration
```

See the [`migrate` reference](../cli/migrate.md) for remote application and dry-run options.

## 4. Roll back

```sh
bunx d1-eloquent rollback
```

Reverts the most recent batch by calling each migration's `down`. See the [`rollback` reference](../cli/rollback.md).

## 5. Fresh rebuild

```sh
bunx d1-eloquent fresh        # drop all tables, re-run every migration
bunx d1-eloquent fresh --seed # …then run seeders
```

`fresh` drops tables in FK-safe topological order, then re-applies the full migration history — ideal for resetting local dev. See the [`fresh` reference](../cli/fresh.md).

## Next steps

- [Schema Builder reference](../api/schema-builder.md) — every column type, constraint, and modifier
- [Seeders & Factories](./seeders-factories.md) — populate the schema with realistic data
- [`migrate`](../cli/migrate.md) · [`rollback`](../cli/rollback.md) · [`fresh`](../cli/fresh.md) — full CLI flags
