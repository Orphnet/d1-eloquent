# Quick Start

If you have not installed the package yet, see the [Installation guide](./installation.md).

This guide walks through defining a model, writing a migration, and performing all five core CRUD operations — no Cloudflare console visit required.

## Why d1-eloquent?

**Without d1-eloquent**

```ts
// Find and update a user with raw D1 prepared statements
const { results } = await env.DB.prepare(
  'SELECT * FROM users WHERE id = ?'
).bind(id).all()
const user = results[0]
if (user) {
  await env.DB.prepare(
    'UPDATE users SET name = ?, updated_at = ? WHERE id = ?'
  ).bind('Alice Smith', new Date().toISOString(), user.id).run()
}
```

**With d1-eloquent**

```ts
// Same operation — type-safe, declarative, no SQL strings
const user = await User.find(id)
if (user) {
  user.set('name', 'Alice Smith')
  await user.save()
}
```

## 1. Define a Model

Create a TypeScript file for your model. Start with an attributes interface that mirrors your database columns, then extend `BaseModel`:

```ts
// src/models/User.ts
import { BaseModel } from '@orphnet/d1-eloquent'

interface UserAttrs {
  id: string
  name: string
  email: string
  is_admin: boolean
  settings: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

export class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'
  static casts = {
    is_admin: 'boolean',   // D1 INTEGER 0/1 ↔ JS boolean
    settings: 'json',      // D1 TEXT ↔ JS object
  }
}
```

`BaseModel<TAttrs>` gives you `create`, `find`, `query`, `set`, `save`, and `delete` without any additional setup. Timestamp columns (`created_at`, `updated_at`) are automatically cast to `Date` — see [Attribute Casting](./casting.md) for all built-in casts.

> [!TIP]
> **Primary keys are TEXT**
> d1-eloquent uses TEXT primary keys (UUIDs) by default. Since `v0.1.0-beta.2` the key is **auto-generated on insert** when you don't pass one, so `id` is optional on `create()` — see the create example below. Configure the format (or turn it off) with [`static keyStrategy`](../api/base-model.md#keystrategy-auto-primary-keys).

## 2. Generate a Migration

> New to the migration workflow? The [Migrations guide](./migrations.md) walks through scaffold → write → apply → rollback → fresh end to end. The steps below are the short version.

Use the CLI to scaffold a migration file:

```sh
# bun
bunx d1-eloquent make:migration create_users_table
```

```sh
# npm
npx d1-eloquent make:migration create_users_table
```

```sh
# pnpm
pnpm dlx d1-eloquent make:migration create_users_table
```

```sh
# yarn
yarn dlx d1-eloquent make:migration create_users_table
```

This creates `src/database/migrations/TIMESTAMP_create_users_table.ts` with commented schema stubs.

## 3. Write the Migration

Open the generated file and define your table using the schema builder:

```ts
// src/database/migrations/20260101000000_create_users_table.ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260101000000_create_users_table',

  up: (schema: Schema) => {
    schema.createTable('users', (t) => {
      t.id()
      t.text('name')
      t.text('email', { unique: true })
      t.timestamps()
    })
  },

  down: (schema: Schema) => {
    schema.dropTable('users')
  },
}

export default migration
```

See the [Schema Builder reference](../api/schema-builder.md) for all column types and options.

## 4. Run the Migration

Apply the migration to your local D1 database:

```sh
# bun
bunx d1-eloquent migrate
```

```sh
# npm
npx d1-eloquent migrate
```

```sh
# pnpm
pnpm dlx d1-eloquent migrate
```

```sh
# yarn
yarn dlx d1-eloquent migrate
```

The CLI auto-detects the D1 binding from your `wrangler.jsonc` and runs against local D1 by default. You should see output confirming the migration ran:

```
Running: 20260101000000_create_users_table
✓ Applied 1 migration
```

## 5. CRUD Operations

With the table in place, your Worker can create and query records. The examples below show both styles — auto-resolved (after calling [`configure(env)`](./configuration.md)) and explicit `db`. Pick whichever fits your project; they can be mixed freely.

### Create

```ts
import { User } from './models/User'

// Auto-resolved — `id` is auto-generated (UUID v4) when omitted
const user = await User.create({
  name: 'Alice',
  email: 'alice@example.com',
})

// Explicit db — pass `id` yourself to override the generated key
const user = await User.create(env.DB, {
  id: crypto.randomUUID(),
  name: 'Alice',
  email: 'alice@example.com',
})

console.log(user.attrs.id)    // "550e8400-e29b-41d4-a716-446655440000"
console.log(user.attrs.name)  // "Alice"
```

### Find by Primary Key

```ts
const user = await User.find('550e8400-e29b-41d4-a716-446655440000')
// or: User.find(env.DB, '550e8400-e29b-41d4-a716-446655440000')

if (user) {
  console.log(user.attrs.email)  // "alice@example.com"
} else {
  console.log('Not found')
}
```

### Query with Filters

```ts
const user = await User.query()
  .whereEq('email', 'alice@example.com')
  .first()

// List all users whose name starts with "Ali"
const users = await User.query()
  .whereLike('name', 'Ali%')
  .orderBy('name', 'asc')
  .limit(20)
  .get()
```

All terminal methods (`get`, `first`, `count`, etc.) accept an optional `db` argument — pass it when you need to override the configured default.

### Update

```ts
const user = await User.find(userId)

if (user) {
  user.set('name', 'Alice Smith')
  await user.save()
}
```

`set(key, value)` updates a single attribute on the model instance (use `fill({ ... })` to assign several at once). `save()` issues an UPDATE for only the changed fields.

### Delete

```ts
const user = await User.find(userId)

if (user) {
  await user.delete()
}
```

By default, `delete()` issues a permanent `DELETE FROM users WHERE id = ?`. To soft-delete instead (set `deleted_at` and leave the row intact), see [Soft Deletes](./soft-deletes.md).

## Complete Worker Example

Here is a minimal Hono worker that wires everything together.

### With auto-configured database (recommended)

Call `configure(env)` once at startup — all query methods resolve the database automatically:

```ts
import { Hono } from 'hono'
import { configure } from '@orphnet/d1-eloquent'
import { User } from './models/User'

type Env = { Bindings: { DB: D1Database } }

const app = new Hono<Env>()

app.get('/users', async (c) => {
  const users = await User.query().limit(50).get()
  return c.json(users.map(u => u.attrs))
})

app.post('/users', async (c) => {
  const { name, email } = await c.req.json<{ name: string; email: string }>()
  const user = await User.create({
    name,        // id auto-generated (UUID v4)
    email,
  })
  return c.json(user.attrs, 201)
})

app.delete('/users/:id', async (c) => {
  const user = await User.find(c.req.param('id'))
  if (!user) return c.notFound()
  await user.delete()
  return c.body(null, 204)
})

export default {
  async fetch(req: Request, env: Env['Bindings']) {
    configure(env)
    return app.fetch(req, env)
  }
}
```

### With explicit database (also supported)

Passing `db` explicitly continues to work — it takes priority over any configured default:

```ts
app.get('/users', async (c) => {
  const users = await User.query().limit(50).get(c.env.DB)
  return c.json(users.map(u => u.attrs))
})
```

See [Configuration](./configuration.md) for binding names, per-model connections, and test setup.

## Next Steps

- [Migrations](./migrations.md) — scaffold, write, apply, roll back, and rebuild your schema; the full column DSL lives in the [Schema Builder reference](../api/schema-builder.md)
- [Attribute Casting](./casting.md) — automatic type conversion between D1 primitives and JavaScript types; `toObject()` returns cast values, `toRaw()` returns DB-safe values
- [Accessors & Mutators](./accessors-mutators.md) — transform attribute values on read/write with type-safe accessors, mutators, virtual attributes, and proxy access
- [Soft Deletes](./soft-deletes.md) — set `deleted_at` instead of removing rows permanently; supports `restore()`, `withTrashed()`, and `onlyTrashed()` query scopes
- [Revision Tracking](./revisions.md) — immutable audit log of every change; time-travel with `asOf()` and `revertTo()`
- [Seeders & Factories](./seeders-factories.md) — populate local databases with realistic test data
- [API Reference](../api/base-model.md) — full method signatures and options for `BaseModel`
