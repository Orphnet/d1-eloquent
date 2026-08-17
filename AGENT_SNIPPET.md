# d1-eloquent — Agent Quick Guide

Type-safe ORM for Cloudflare D1 (Workers). Package: `@orphnet/d1-eloquent`.
CLI bin: `d1-eloquent`. Use this to work without reading full source; deeper
references in `docs/` (API cheatsheet: `docs/API.md`, traps: `docs/troubleshooting.md`).

## Worker wiring — `configure(env)`

Call `configure(env)` once at startup. It auto-detects the D1 binding from `env`
(`DEFAULT_DB ?? DB` → `"default"`; `TEST_DB` → `"test"` when `NODE_ENV=test`).
After it runs, every query method resolves the DB automatically — `db` becomes
optional everywhere (explicit `db` still works and takes priority).

```ts
import { configure } from '@orphnet/d1-eloquent'

export default {
  async fetch(req: Request, env: Env) {
    configure(env)               // reads env.DEFAULT_DB ?? env.DB
    return app.fetch(req, env)
  },
}
```

`wrangler.jsonc` must declare the binding (name it `DB`):

```jsonc
{ "d1_databases": [{ "binding": "DB", "database_name": "my-app-db", "database_id": "…" }] }
```

Multi-DB: `configure(env, { connections: { analytics: env.ANALYTICS_DB } })`,
then `Model.query().on('analytics')`. Per-model: `static connection = 'analytics'`.

## Model definition

```ts
import { BaseModel } from '@orphnet/d1-eloquent'
import type { CastDefinition, TRelationDefinition } from '@orphnet/d1-eloquent'

interface UserAttrs {
  id: string
  name: string
  is_admin: boolean
  settings: Record<string, unknown>
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'             // TEXT/UUID — never integer autoincrement
  static softDeletes = true            // needs a deleted_at column
  static timestamps = true             // created_at/updated_at auto-managed + auto-cast to Date
  static casts = { is_admin: 'boolean', settings: 'json' }   // inline literal narrows fine
  static fillable = ['id', 'name', 'is_admin', 'settings']   // include 'id'! (see traps)
  static revisions = { enabled: true, mode: 'diff+after' as const }   // optional audit log
  static relations: Record<string, TRelationDefinition> = {
    posts: { type: 'hasMany', model: () => Post, foreignKey: 'user_id' },  // lazy () => Model
  }
}
```

Useful statics: `guarded`, `scopes`, `hooks`, `accessors`, `appends`, `hidden`,
`modelName`, `eagerLoaders`. Built-in casts: `boolean integer float real string
datetime date timestamp json array blob`.

Runtime models (no class file): `BaseModel.dynamic<TAttrs>({ table, casts, fillable, … })`.

## CRUD

```ts
// Create — generate the UUID yourself; 'id' must be fillable (or use guarded / a creating hook)
const user = await User.create({ id: crypto.randomUUID(), name: 'Alice', is_admin: false, settings: {} })

const found    = await User.find(id)          // null if missing
const orFail   = await User.findOrFail(id)    // throws ModelNotFoundException
const all      = await User.all?.(db)         // or User.query().get()

user.set('name', 'Alice Smith')          // set(key, value); use fill({...}) for an object
await user.save({ revision: { actorId: 'admin', reason: 'edit' } })

await user.delete({ revision: { actorId: 'admin' } })   // soft-delete when softDeletes=true
await user.restore(db)                                  // soft-delete only

// firstOrCreate / firstOrNew / updateOrCreate / createMany also available
const u = await User.firstOrCreate({ name: 'Bob' }, { id: crypto.randomUUID() })
```

Serialization: `toObject()` (cast values, no relations), `toJSON()` (cast values
+ nested loaded relations — use for API responses with eager loads), `toRaw()`
(DB-safe primitives — for raw SQL, NOT for clients).

## Query builder — `Model.query(db?)`

```ts
const rows = await User.query()
  .whereEq('is_admin', true)            // values are cast: pass true, binds 1
  .whereLike('name', 'Ali%')
  .whereIn('status', ['active', 'pending'])     // whereIn([]) is safe → 0 rows
  .whereNull('deleted_at')
  .when(search, (q, s) => q.whereLike('name', `%${s}%`))   // conditional
  .orderBy('created_at', 'desc')
  .limit(20).offset(40)
  .get()                                // Collection<User>, db auto-resolved
```

- Filters: `where`, `orWhere`, `whereEq`, `whereLike`, `whereIn`/`whereNotIn`,
  `whereNull`/`whereNotNull`, `whereBetween`, `whereRaw`, `whereColumn`,
  `whereGroup`/`orWhereGroup`, `when(cond, ifTrue, ifFalse?)`.
- Shape: `select`, `selectRaw`, `distinct`, `join`, `leftJoin`, `groupBy`,
  `having`, `orderBy`, `limit`, `offset`, `union`, `from(table)`.
- Relations: `with(['rel'])` (eager, no N+1), `has`/`doesntHave`,
  `whereHas`/`whereDoesntHave`, `withCount`/`withSum`/`withAvg`.
- Scopes: `scoped('active', 'recent')`. Soft-delete: `withTrashed`, `onlyTrashed`.
- Terminals: `get`, `first`, `firstOrFail`, `sole`, `count`, `sum`, `avg`,
  `min`, `max`, `pluck`, `value`, `chunk`.
- Pagination: `paginate(page, perPage)` → `{ data, total, page, perPage, lastPage }`;
  `paginateCursor({ orderBy, direction, perPage, after?/before? })` → keyset.
- Mutations: `insert`, `insertMany`, `upsert(values, conflictCols, updateCols?)`,
  `upsertMany`, `update`, `delete`. FK-safe atomic batches: `toInsertPrepared` /
  `toUpsertPrepared` / `toUpdatePrepared` + `db.batch([...])`.

## Migrations & schema builder

Migrations live in `src/database/migrations/`. Import `Schema` + `TMigration`
from `@orphnet/d1-eloquent/cli`. `up`/`down` receive a `Schema` — no `db`, no `exec`.

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260101_000000_create_posts_table',
  up: (schema: Schema) => {
    schema.createTable('posts', (t) => {
      t.id()                                        // id TEXT PRIMARY KEY NOT NULL
      t.text('user_id').notNull().constrained('users').onDelete('cascade')
      t.text('title')
      t.text('status').default('draft')
      t.boolean('published').default(false)
      t.softDeletes()                               // deleted_at TEXT + index
      t.timestamps()                                // created_at/updated_at TEXT NOT NULL
      t.index('user_id')
    })
  },
  down: (schema: Schema) => schema.dropTable('posts'),
}
export default migration
```

Columns: `t.id(name?)`, `t.text`, `t.integer`, `t.real`, `t.boolean`,
`t.timestamps()`, `t.softDeletes()`. Modifiers (chainable): `.notNull()`,
`.nullable()`, `.default(v)`, `.unique()`, `.index()`, `.primary()`, `.check()`.
FKs (create mode): `.references(table, col?)`, `.constrained(table)`,
`.onDelete(action)`, `.onUpdate(action)`. Alter: `schema.table(name, t => t.addText/addInteger/addReal(...))`.
Composite: `t.primary('a, b')`, `t.foreign(['a','b'], { references, on })`.

## CLI — bun/bunx, local by default

The binding is auto-detected from `wrangler.jsonc`; **local D1 is the default**, so
routine local commands need no targeting flags: `--db=<name>` is unnecessary (binding
auto-detected) and `--local` is already the default. `--remote` **is** a real flag —
it points a command at **production** Cloudflare D1 and is required for prod
migrations/seeds (`fresh --remote` additionally needs `--force`). Never add `--remote`
to a routine local command.

```bash
bunx d1-eloquent make:migration create_posts_table   # scaffold a migration
bunx d1-eloquent make:model Post                      # scaffold a model
bunx d1-eloquent make:resource Post                   # model + migration + factory + seeder
bunx d1-eloquent migrate                              # run pending migrations (local)
bunx d1-eloquent status                               # migration status
bunx d1-eloquent rollback                             # roll back last batch
bunx d1-eloquent fresh                                # drop all + re-run (FK-safe order)
bunx d1-eloquent seed                                 # run seeders (--idempotent, --fresh)
bunx d1-eloquent tinker                               # local REPL with models in scope
```

Migrations are tracked in `_migrations`. (Deploying to remote Cloudflare D1 is a
separate, explicit operation — do not add `--remote` to routine local commands.)

## Transactions - atomic multi-write

```ts
import { transaction } from '@orphnet/d1-eloquent';
await transaction(env.DB, async (tx) => {
  const order = await tx.create(Order, { id: crypto.randomUUID(), total: 42 });
  await tx.save(user);                       // await every instance op
  tx.increment(Wallet.query().whereEq('id', wid), 'balance', -42);
});  // one db.batch(): all statements commit or none do; tx never reads
```

## Three traps that `tsc` does NOT catch (see docs/troubleshooting.md)

1. **`fillable` strips `id`** → `create({ id, … })` throws `Missing primary key
   'id'` at runtime (HTTP 500). `fill()` drops non-fillable keys
   (`d1Eloquent/managers/attributeManager.ts:104`). Fix: put `'id'` in
   `fillable`, OR use `guarded` instead, OR mint the id in a `creating` hook.
2. **`static casts` widening** → extracting casts to a `const` widens
   `'boolean'` to `string` → **TS2417**. Fix: annotate
   `const c: Record<string, CastDefinition> = {…}`, or `as const`, or
   `satisfies`. (Inline literals in the class body are fine.)
3. **Circular-ESM relations** → always `model: () => Post` (lazy thunk), never
   `model: Post`. Defers the constructor read past module evaluation so
   `User` ↔ `Post` don't see `undefined`.

## Conventions

- IDs are TEXT/UUID strings (`crypto.randomUUID()`), never integer autoincrement.
- Use `model._persisted` to check persistence state, not a null-check on the PK.
- Don't add `deleted_at` to pivot tables (ambiguous-column errors on joins).
- Pass revision context on writes: `{ revision: { actorId, requestId, reason } }`.
- bun/bunx only. No npm/npx. Local is the default — skip `--db`/`--local`; `--remote` targets **prod** (required for prod migrations/seeds), never on routine local runs.

## More docs

`docs/API.md` (consolidated cheatsheet) · `docs/api/*` (base-model, query-builder,
schema-builder, relationships) · `docs/guide/*` (configuration, casting,
migrations, seeders-factories, soft-deletes, revisions) ·
`docs/troubleshooting.md` (the three traps in full).
