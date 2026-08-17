# Revision Tracking

Revision tracking gives you an immutable audit log of every change to a model — who changed it, when, and what changed. You can query historical states and revert records to any prior revision.

**Without d1-eloquent**

```ts
// DIY audit logging — repeated for every model, every write
async function updateUser(db: D1Database, id: string, changes: Partial<UserRow>) {
  // 1. Fetch current state for the "before" snapshot
  const { results } = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).all()
  const before = results[0]

  // 2. Apply the update
  const setClauses = Object.keys(changes).map(k => `${k} = ?`).join(', ')
  await db.prepare(`UPDATE users SET ${setClauses} WHERE id = ?`)
    .bind(...Object.values(changes), id).run()

  // 3. Manually compute diff and write audit row
  const diff: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(changes)) {
    if (before[k] !== v) diff[k] = v
  }
  await db.prepare(
    'INSERT INTO audit_logs (id, model, model_id, action, diff, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), 'users', id, 'update', JSON.stringify(diff), actorId, new Date().toISOString()).run()

  // 4. Redacting sensitive fields? Filter manually before each insert.
  // 5. Time-travel? Write a custom reconstruction query.
  // 6. Revert? Reverse-apply diffs manually.
  // Repeat all of this for every model. Every delete. Every create.
}
```

**With d1-eloquent**

```ts
class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static revisions = { enabled: true, mode: 'diff+after' as const }
  static revisionRedact = ['password_hash']  // auto-excluded from audit
}

// All writes are tracked automatically — create, update, delete
user.set('name', 'Alice Smith')
await user.save({ revision: { actorId: 'user-123', reason: 'profile update' } })

// Time-travel — reconstruct state at any point
const past = await User.asOf(userId, '2026-01-15T00:00:00Z')

// Revert — roll back to a previous revision
await User.revertTo(revision)
```

## Enable Revision Tracking on a Model

Add `static revisions` with `enabled: true` and a `mode`:

```ts
import { BaseModel } from '@orphnet/d1-eloquent'

interface UserAttrs {
  id: string
  name: string
  email: string
  password_hash: string
  created_at?: string
  updated_at?: string
}

export class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'
  static revisions = {
    enabled: true,
    mode: 'diff+after' as const,
  }
}
```

## Migration Requirement

Revision tracking writes to a `model_revisions` table. Generate the migration with:

```sh
bunx d1-eloquent make:migration create_model_revisions_table
```

Then write the migration:

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260101000000_create_model_revisions_table',

  up: (schema: Schema) => {
    schema.createTable('model_revisions', (t) => {
      t.id()                                     // id TEXT PRIMARY KEY
      t.text('model_table').notNull()            // table name of the tracked model
      t.text('model_pk').notNull()               // primary-key column name (e.g. "id")
      t.text('model_id').notNull()               // primary-key value of the tracked row
      t.text('action').notNull()                 // "create" | "update" | "delete"
      t.text('diff_json', { nullable: true })    // changed fields (diff / diff+after)
      t.text('before_json', { nullable: true })  // full state before (snapshot / before+after)
      t.text('after_json', { nullable: true })   // full state after (snapshot / diff+after / before+after)
      t.text('actor_id', { nullable: true })
      t.text('request_id', { nullable: true })
      t.text('reason', { nullable: true })
      t.text('created_at').notNull()
      t.index('model_table')
      t.index('model_id')
    })
  },

  down: (schema: Schema) => {
    schema.dropTable('model_revisions')
  },
}

export default migration
```

All models with revision tracking enabled share one `model_revisions` table, identified by `model_table` (the model's table name) and `model_id` (the tracked row's primary-key value).

## Revision Modes

d1-eloquent supports four revision modes. Choose based on how much storage you can accept and what recovery operations you need.

### `diff` — Changed Fields Only

Stores only the fields that changed. Smallest storage footprint.

```
Before: { name: "Alice",  email: "alice@example.com" }
After:  { name: "Alice Smith", email: "alice@example.com" }

Stored: { name: "Alice Smith" }   ← only the changed field
```

Limitation: you cannot reconstruct the full model state from a `diff` revision alone. Use `diff+after` if you need time-travel queries.

### `snapshot` — Full State After Change

Stores the complete model state after each change.

```
Before: { name: "Alice",  email: "alice@example.com" }
After:  { name: "Alice Smith", email: "alice@example.com" }

Stored: { name: "Alice Smith", email: "alice@example.com" }   ← full state
```

Good for time-travel, but stores redundant unchanged fields on every write.

### `diff+after` — Changed Fields and Full State (Recommended)

Stores both what changed and the complete state after the change. Best balance of auditability and storage.

```
Before: { name: "Alice",  email: "alice@example.com" }
After:  { name: "Alice Smith", email: "alice@example.com" }

Stored: {
  diff:  { name: "Alice Smith" },
  after: { name: "Alice Smith", email: "alice@example.com" }
}
```

Recommended for most use cases — supports reliable time-travel and keeps the diff readable.

### `before+after` — Full State Before and After

Stores the complete model state before and after the change. Most verbose; best for compliance use cases where you need to prove exactly what was changed from what.

```
Before: { name: "Alice",  email: "alice@example.com" }
After:  { name: "Alice Smith", email: "alice@example.com" }

Stored: {
  before: { name: "Alice",       email: "alice@example.com" },
  after:  { name: "Alice Smith", email: "alice@example.com" }
}
```

## Passing Revision Context

Every write that triggers a revision can carry an audit context: who made the change, which request triggered it, and why.

Pass a `revision` object to `save()`, `delete()`, or `create()`:

```ts
// On update
user.set('name', 'Alice Smith')
await user.save({
  revision: {
    actorId: 'user-123',
    requestId: request.headers.get('x-request-id') ?? undefined,
    reason: 'profile update',
  },
})

// On create (revision context recorded for the initial insert)
const user = await User.create({
  name: 'Bob',              // id auto-generated (UUID v4) — pass one to override
  email: 'bob@example.com',
}, {
  revision: {
    actorId: 'admin-456',
    reason: 'user invited via admin panel',
  },
})

// On delete
await user.delete({
  revision: {
    actorId: 'user-123',
    reason: 'account deletion request',
  },
})
```

> [!TIP]
> **Optional db argument**
> All examples on this page omit the `db` argument — the database is resolved automatically via [`configure(env)`](./configuration.md). You can always pass `db` explicitly as the first argument if needed (e.g. `user.save(env.DB, { revision: ... })`).

All three fields (`actorId`, `requestId`, `reason`) are optional. Pass whatever is meaningful to your application.

## Time-Travel Queries

### Retrieve Model State at a Point in Time

`asOf()` returns the model as it existed at a given ISO timestamp. Returns `null` if the model did not exist at that point.

```ts
// Get the user's state as of January 15, 2026 at midnight UTC
const userAtDate = await User.asOf('user-id-here', '2026-01-15T00:00:00Z')

if (userAtDate) {
  console.log(userAtDate.attrs.name)   // "Alice" (before the rename)
  console.log(userAtDate.attrs.email)  // "alice@example.com"
}
```

> [!TIP]
> **asOf requires a mode that stores full state**
> `asOf()` reconstructs the model state from revision history, so it needs a mode that persists the full after-state — `snapshot`, `diff+after`, or `before+after`. With `diff` mode alone (changed fields only), reconstruction is not possible.

### Revert to a Specific Revision

`revertTo()` writes the model's attributes back to a previous revision's state. This creates a new revision entry recording the revert action.

```ts
import { ModelRevision } from '@orphnet/d1-eloquent'

// Fetch recent revisions for the user
const revisions = await ModelRevision.query()
  .whereEq('model_table', 'users')
  .whereEq('model_id', userId)
  .orderBy('created_at', 'desc')
  .limit(10)
  .get()

// Revert to the most recent revision
const target = revisions[0]
if (target) {
  await User.revertTo(target)
}
```

## Filtering Revision Fields

### Redact Sensitive Fields — `revisionRedact`

Exclude specific fields from revision storage. Use this for passwords, tokens, and other sensitive data you should not persist in audit logs:

```ts
export class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'
  static revisions = { enabled: true, mode: 'diff+after' as const }

  // These fields are never written to model_revisions
  static revisionRedact = ['password_hash', 'api_token']
}
```

### Include Only Specific Fields — `revisionOnly`

The inverse of `revisionRedact` — only store these fields in revisions:

```ts
export class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'
  static revisions = { enabled: true, mode: 'diff+after' as const }

  // Only track changes to email and name
  static revisionOnly = ['email', 'name']
}
```

> [!WARNING]
> **revisionRedact and revisionOnly are mutually exclusive**
> Define either `revisionRedact` or `revisionOnly` — not both. If both are present, `revisionOnly` takes precedence.

## Recommended Configuration

For most applications, use `diff+after` with `revisionRedact` for sensitive fields:

```ts
export class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'
  static softDeletes = true
  static revisions = {
    enabled: true,
    mode: 'diff+after' as const,
    includeRequestId: true,
  }
  static revisionRedact = ['password_hash']
}
```

`includeRequestId: true` automatically pulls the `requestId` from revision context when available — useful for correlating audit entries with HTTP request logs.

## API Reference

See the [BaseModel API reference](../api/base-model.md) for full method signatures of `asOf()` and `revertTo()`.
