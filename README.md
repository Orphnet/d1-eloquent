<!-- orphnet-badges:start -->
![Orphnet](https://img.shields.io/badge/Orphnet-platform-7B68EE) ![Cloudflare D1](https://img.shields.io/badge/D1-Database-F38020?logo=cloudflare&logoColor=white) ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white) ![ORM](https://img.shields.io/badge/ORM-d1--eloquent-blueviolet) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
<!-- orphnet-badges:end -->

# @orphnet/d1-eloquent

<!-- BADGES:START -->
[![npm](https://img.shields.io/npm/v/@orphnet/d1-eloquent?color=blue)](https://www.npmjs.com/package/@orphnet/d1-eloquent) [![Tests](https://img.shields.io/badge/tests-1621_passed-brightgreen)](https://github.com/orphnet/d1-eloquent/actions) [![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/orphnet/d1-eloquent/actions)
<!-- BADGES:END -->

Type-safe ORM for Cloudflare D1 — soft deletes, revision tracking, and relationships, built for Workers.

- **Docs**: [d1-eloquent.orph.dev](https://d1-eloquent.orph.dev)
- **Live examples** (same domain model, two transports):
  - Hono REST API → [hono-example.d1-eloquent.orph.dev](https://hono-example.d1-eloquent.orph.dev)
  - Nuxt 4 + Nitro (direct D1, no separate API tier) → [nuxt-example.d1-eloquent.orph.dev](https://nuxt-example.d1-eloquent.orph.dev)
- **Source**: [github.com/Orphnet/d1-eloquent-examples](https://github.com/Orphnet/d1-eloquent-examples)

## Installation

```bash
bun add @orphnet/d1-eloquent
```

Or with npm / pnpm / yarn:

```bash
npm install @orphnet/d1-eloquent
pnpm add @orphnet/d1-eloquent
yarn add @orphnet/d1-eloquent
```

> Also install `@cloudflare/workers-types` — d1-eloquent's published types
> reference the ambient Cloudflare D1 globals (`D1Database`, …):
>
> ```bash
> bun add -d @cloudflare/workers-types
> ```

> [!NOTE]
> Released as a beta: the API may still shift before v1.0. See the [changelog](CHANGELOG.md) for what changes between releases.

## Database Setup

First declare a D1 binding in your `wrangler.jsonc` (use the binding name `DB` — d1-eloquent resolves `env.DEFAULT_DB ?? env.DB` automatically):

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "d1_databases": [
    {
      "binding": "DB",                        // available as env.DB
      "database_name": "my-app-db",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "migrations_dir": "src/database/migrations"
    }
  ]
}
```

Create the database with `bunx wrangler d1 create my-app-db` and paste the returned `database_id` above. Then call `configure(env)` once at startup:

```ts
import { configure } from '@orphnet/d1-eloquent'

export default {
  async fetch(req, env) {
    configure(env)              // reads env.DEFAULT_DB ?? env.DB automatically
    return app.fetch(req, env)
  }
}
```

All query methods (`get()`, `first()`, `save()`, etc.) will resolve the database automatically. Passing `db` explicitly still works and takes priority. See the [Configuration guide](https://d1-eloquent.orph.dev/guide/configuration) for named connections, per-model overrides, and test setup.

## Define a Model

```typescript
import { BaseModel } from '@orphnet/d1-eloquent'

interface UserAttrs {
  id: string
  name: string
  email: string
  is_admin: boolean
  settings: Record<string, unknown>
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'
  static softDeletes = true
  static revisions = { enabled: true, mode: 'diff+after' as const }
  static casts = {
    is_admin: 'boolean',  // D1 INTEGER 0/1 ↔ JS boolean
    settings: 'json',     // D1 TEXT ↔ JS object
  }
}
```

Timestamps (`created_at`, `updated_at`, `deleted_at`) are auto-cast to `Date`. See the [Casting guide](https://d1-eloquent.orph.dev/guide/casting) for all built-in casts and custom cast support.

## CRUD

```typescript
import { D1Database } from '@cloudflare/workers-types'

// Create — the primary key is auto-generated (UUID v4 by default), so `id` is
// optional. Pass one explicitly and it is always respected. Configure the format
// per model with `static keyStrategy = 'uuidv7' | 'ulid' | false | (ctx) => string`.
const user = await User.create(db, {
  name: 'Alice',
  email: 'alice@example.com',
})

// Find by primary key
const found = await User.find(db, user.get('id'))

// Query with filters
const admin = await User.query()
  .whereEq('email', 'alice@example.com')
  .orderBy('created_at', 'desc')
  .first(db)

// Conditional query building
const users = await User.query()
  .when(filters.search, (q, search) => q.whereLike('name', `%${search}%`))
  .when(filters.role, (q, role) => q.whereEq('role', role))
  .whereNotIn('status', ['banned', 'suspended'])
  .get(db)

// Update
user.set('name', 'Alice Smith')
await user.save(db, { revision: { actorId: 'admin-1', reason: 'name correction' } })

// Delete (soft delete because softDeletes = true)
await user.delete(db, { revision: { actorId: 'admin-1' } })
```

## Soft Deletes and Revision Tracking

```typescript
// Soft delete — sets deleted_at, does not remove the row
await user.delete(db)

// Query including deleted rows
const allUsers = await User.query().withTrashed().get(db)

// Query only deleted rows
const deleted = await User.query().onlyTrashed().get(db)

// Restore a soft-deleted record
await user.restore(db)

// Save with audit context — writes a revision row
await user.save(db, { revision: { actorId: 'admin', reason: 'profile update' } })

// Time-travel: reconstruct record state at a past timestamp
const snapshot = await User.asOf(db, user.get('id'), '2025-01-01T00:00:00Z')

// Revert to a specific revision
const revisions = await ModelRevision.listUpTo(db, {
  table: User.table,
  id: user.get('id'),
  asOfIso: new Date().toISOString(),
})
await User.revertTo(db, revisions[0])
```

## Tinker — interactive REPL

Drop into a REPL with every model already in scope, running against your **local** D1 — no Worker, no boot wait.

```bash
bunx d1-eloquent tinker
```

```
tinker> User.query().whereEq('is_admin', true).get()
Collection(2) [ User { … }, User { … } ]
tinker> .sql
SQL echo on
tinker> Post.query().whereEq('published', true).limit(5).get()
sql  SELECT * FROM posts WHERE published = ? AND (deleted_at IS NULL) LIMIT 5  ‹1›  0.7ms  5 rows
tinker> .exit
sandbox rolled back — no changes persisted
```

- **No fear of mutating data** — every session is sandboxed in a transaction that rolls back on exit (`.commit` to keep, `--live` to write directly).
- **Full SQL visibility** — `.sql` echoes SQL + bindings + timing; `.explain` runs `EXPLAIN QUERY PLAN` on the last query.
- **Instant boot** — opens the wrangler SQLite file directly, so `User.all()` returns real rows with no Worker spin-up.
- **Readable output** — `.table` renders rows as a grid; `.schema`, `.models`, and `.tables` inspect your database. Auto-`await`, persisted vars, and tab completion throughout.

Requires Bun (local D1 only for now). Full reference in the [Tinker guide](https://d1-eloquent.orph.dev/guide/tinker).

## Relationships

```typescript
import { BaseModel } from '@orphnet/d1-eloquent'
import type { TRelationDefinition } from '@orphnet/d1-eloquent'

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'

  // Declarative relations (recommended) — these also power has() / whereHas()
  // and model.related(); eager loaders are derived automatically.
  static relations: Record<string, TRelationDefinition> = {
    author: { type: 'belongsTo', model: () => User, foreignKey: 'user_id' },
    tags: {
      type: 'belongsToMany',
      model: () => Tag,
      pivot: 'post_tags',
      foreignPivotKey: 'post_id',
      relatedPivotKey: 'tag_id',
    },
  }
}

// Eager load relationships, no N+1 (after configure(env) you can omit db)
const posts = await Post.query().with(['author', 'tags']).get(db)
```

## CLI Quick Reference

The package installs a `d1-eloquent` bin. Run commands with `bunx d1-eloquent <command>`
(or `npx d1-eloquent <command>`), or wire them into `package.json` scripts.

| Command | Description |
|---------|-------------|
| `migrate` | Run pending migrations |
| `rollback` | Roll back last migration |
| `fresh` | Drop all tables and re-run migrations |
| `seed` | Run seeders (`--idempotent`, `--fresh`) |
| `status` | Show migration status |
| `make:migration <name>` | Generate migration file |
| `make:model <Name>` | Generate model file |
| `make:seeder <Name>` | Generate seeder file |
| `make:factory <Name>` | Generate factory file |
| `make:resource <Name>` | Generate model + migration + factory + seeder |
| `make:pivot <table>` | Generate pivot table migration |
| `make:dto <model>` | Generate typed attributes interface for a model |
| `make:types` | Generate typed attributes for all models + barrel index |
| `generate` | Diff models against migrations and generate a reconciling migration |
| `validate` | Check models against migrations for drift |
| `inspect <model>` | Print resolved schema for a model |
| `tinker` | Interactive REPL with your models loaded (sandboxed by default) |

The D1 binding is auto-detected from your `wrangler.jsonc` `d1_databases` array (falls back to `'DB'`), and commands run against local D1 by default. Use `--remote` to target Cloudflare.

## Seeders & Fake Data

Factories use a built-in zero-dependency faker and structured output helpers:

```ts
import { Factory, fake, output } from '@orphnet/d1-eloquent/cli'
import type { TSeeder, TSeederOpts } from '@orphnet/d1-eloquent/cli'

class UserFactory extends Factory<UserAttrs> {
  readonly table = 'users'
  definition() {
    return {
      id: fake.uuid(),
      name: fake.name(),
      email: fake.email(),
      role: 'user',
      created_at: fake.now(),
      updated_at: fake.now(),
    }
  }
}

const seeder: TSeeder = {
  name: 'UserSeeder',
  run: async (opts: TSeederOpts) => {
    const factory = new UserFactory()
    const users = await factory.createMany(opts, 50) // batched insert
    const pw = fake.password(12)
    const admin = await factory.create(opts, { role: 'admin', email: 'admin@example.com' })

    output.card('Admin Credentials', { Email: admin.email, Password: pw })
    output.log(`Seeded ${users.length + 1} users`, { tag: 'users' })
  },
}
```

See the [Seeders & Factories guide](https://d1-eloquent.orph.dev/guide/seeders-factories) for full API reference.

## Test Suite

<!-- TEST-SUMMARY:START -->
| Metric | Result |
|--------|--------|
| Tests | 1621 passed, 0 failed (1621 total) |
| Suites | 619 passed (619 total) |
| Statements | 100% |
| Branches | 100% |
| Functions | 100% |
| Lines | 100% |
<!-- TEST-SUMMARY:END -->

See the [full test and coverage report](https://d1-eloquent.orph.dev/guide/test-coverage) for per-file details.

## Documentation

Full API reference, feature guides, and an interactive SQL playground at **[d1-eloquent.orph.dev](https://d1-eloquent.orph.dev)**.

## Developing from source

Clone this repo, then `bun install && bun run build` and `bun link` here; in your project run `bun link @orphnet/d1-eloquent`. The link points at `dist/`, so re-run `bun run build` after pulling changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and PR guidelines.