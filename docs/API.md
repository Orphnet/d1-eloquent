# d1-eloquent API Cheatsheet

One-page consolidated reference: model config, CRUD, query builder, schema
builder, relations, and `configure(env)`. Distilled from `docs/api/*` and
`docs/guide/*`. For prose explanations see those files; for runtime traps see
[`troubleshooting.md`](./troubleshooting.md).

Package root exports: `BaseModel`, `configure`, `QueryBuilder`, `Collection`,
`ModelRevision`, `Attribute`, `KvCacheAdapter`, `transaction` /
`TransactionAborted`, `enumCast`, `placeholder` / `PreparedQuery`, the relation
helpers, the exceptions, and the registry helpers. Migration/seed helpers (`Schema`,
`Factory`, `fake`, `output`, `TMigration`, `TSeeder`) come from the
`@orphnet/d1-eloquent/cli` subpath.

---

## configure(env) — Worker wiring

```ts
import { configure } from '@orphnet/d1-eloquent'

export default {
  async fetch(req: Request, env: Env) {
    configure(env)            // call once at startup
    return app.fetch(req, env)
  },
}
```

Binding auto-detection (highest priority first):

| Binding in `env` | Registered as |
|---|---|
| `DEFAULT_DB` | `"default"` |
| `DB` (if no `DEFAULT_DB`) | `"default"` |
| `TEST_DB` | `"test"` (used when `NODE_ENV=test`) |

After `configure(env)`, `db` is **optional** on every method. Explicit `db`
still works and takes priority.

```ts
configure(env, { connections: { analytics: env.ANALYTICS_DB, read: 'default' } })
await Event.query().on('analytics').get()      // per-query routing
// static connection = 'analytics' | env.ANALYTICS_DB    // per-model
```

Registry helpers: `registerConnection(name, db)`, `unregisterConnection(name)`,
`clearConnections()`, `listConnections()`, `getConnection(name)`.

Resolution order: explicit `db` arg → `Model.query(db)` → `qb.on(name)` →
model `static connection` → `"default"`.

---

## Model configuration (static properties)

```ts
class User extends BaseModel<UserAttrs /*, TVirtuals, TRels */> {
  static table = 'users'                       // required
  static primaryKey = 'id'                      // default 'id' (TEXT/UUID)
  static softDeletes = false                    // needs deleted_at column when true
  static timestamps = true                      // created_at/updated_at auto-managed + cast to Date
  static casts = { is_admin: 'boolean', settings: 'json' }   // Record<string, CastDefinition>
  static fillable = ['id', 'name', 'email']     // whitelist for fill() — include 'id'!
  static guarded  = ['role']                    // blacklist for fill() (alternative to fillable)
  static relations = { /* see Relations */ }    // Record<string, TRelationDefinition>
  static scopes = { active: q => q.whereEq('status', 'active') }
  static globalScopes = { tenant: q => q.whereEq('tenant_id', tid) }  // applied to EVERY query
  static hooks = { creating: m => {/*…*/} }
  static accessors = { /* Attribute defs */ }
  static appends = ['full_name']                // virtuals in toObject()
  static hidden  = ['password_hash']            // keys removed from toObject()
  static revisions = { enabled: true, mode: 'diff+after', includeRequestId: false }
  static revisionRedact = ['secret']            // OR revisionOnly = [...]
  static modelName = 'User'                     // used in exception messages
  static connection = 'default'                 // D1Database | string
  static eagerLoaders = { /* manual with() loaders */ }
}
```

| Property | Type | Default |
|---|---|---|
| `table` | `string` | required |
| `primaryKey` | `string` | `'id'` |
| `softDeletes` | `boolean` | `false` |
| `timestamps` | `boolean` | `true` |
| `casts` | `Record<string, CastDefinition>` | — |
| `fillable` / `guarded` | `string[]` | — |
| `relations` | `Record<string, TRelationDefinition>` | — |
| `scopes` | `Record<string, (q) => void>` | — |
| `hooks` | `THooks<T>` | — |
| `accessors` | `Record<string, Attribute>` | — |
| `appends` / `hidden` | `string[]` | — |
| `revisions` | `RevisionConfig` | — |
| `modelName` | `string` | `table` |
| `connection` | `D1Database \| string` | — |

**Revision modes:** `'diff'` (changed fields only), `'snapshot'` (full record),
`'diff+after'` (recommended), `'before+after'`. `asOf`/`revertTo` work on any
mode that stores a full snapshot — `'snapshot'`, `'diff+after'`, `'before+after'`
— but **not** pure `'diff'`.
**Revision context** (`opts.revision`): `{ actorId?, requestId?, reason? }`.

Runtime model (no class file): `BaseModel.dynamic<TAttrs>(config)` — same config
keys; `validateDynamicModel(ctor)` asserts a class has `table`/`primaryKey`.

---

## Casting

Built-in cast strings: `boolean`, `integer`, `float`, `real`, `string`,
`datetime`, `date`, `timestamp`, `json`, `array`, `blob`.

| Cast | D1 | JS | Notes |
|---|---|---|---|
| `boolean` | INTEGER 0/1 | `boolean` | |
| `integer` | INTEGER | `number` | truncates on set |
| `float`/`real` | REAL | `number` | |
| `string` | TEXT | `string` | |
| `datetime` | TEXT ISO | `Date` | |
| `date` | TEXT YYYY-MM-DD | `Date` | midnight UTC |
| `timestamp` | INTEGER unix | `Date` | |
| `json` | TEXT | `unknown` | tolerant parse |
| `array` | TEXT | `unknown[]` | |
| `blob` | BLOB | passthrough | |

`null`/`undefined` bypass casts. Timestamps auto-cast when `timestamps=true`;
`deleted_at` auto-casts when `softDeletes=true` (declare in `casts` to override).
Custom cast: implement `AttributeCast<TGet, TSet>` (`{ get(v), set(v) }`).
Enum cast: `enumCast(['draft', 'published'], { onInvalidRead?: 'throw' | 'null' | 'keep' })` -
runtime-validates reads AND writes against the value set (reads default to `'throw'`;
`null`/`undefined` pass through).

> Trap: extracting a casts object to a `const` widens literals to `string` →
> TS2417. Annotate `Record<string, CastDefinition>`, use `as const`, or
> `satisfies`. See troubleshooting §2.

---

## CRUD (static + instance)

```ts
// Create — id auto-generated (keyStrategy, default UUID v4); pass one to override
const u = await User.create({ name: 'Alice', email: 'a@x.com' })

await User.find(id)                 // TModel | null (excludes soft-deleted)
await User.findOrFail(id)           // throws ModelNotFoundException
await User.createMany([{…}, {…}])   // single db.batch(); no revisions unless skipRevisions
await User.firstOrCreate(search, values?)   // find or insert
await User.firstOrNew(search, values?)      // find or build (unpersisted; _persisted=false)
await User.updateOrCreate(search, values)   // find/create then update

u.set('name', 'Alice Smith')
await u.save({ revision: { actorId, reason } })   // INSERT if new, else UPDATE of dirty fields
await u.delete({ revision })        // soft-delete when softDeletes=true, else hard DELETE
await u.restore(db)                 // clears deleted_at (soft-delete only)

u.get('name'); u.getRaw('name'); u.getOriginal('name')
u.toObject()   // TAttrs, cast values, no relations
u.toJSON()     // cast values + nested loaded relations  ← API responses with eager loads
u.toRaw()      // DB-safe primitives  ← raw SQL / cache keys; NOT for clients
u.trashed(); u.is(other); u.fresh(db); await u.load(db, 'posts')

u.replicate(except?)        // unsaved copy: PK, timestamps, deleted_at (and `except` keys) stripped
u.wasRecentlyCreated        // true when this instance's save/create INSERTed (false on loaded models)
await u.increment('views')  // atomic SET views = views + 1 by PK; amount + extra-columns overloads
await u.decrement('stock', 3, { last_sold_at: now })   // NULL-safe (COALESCE(col, 0))
```

Time-travel (needs a snapshot-storing mode — `'snapshot'`, `'diff+after'`, or
`'before+after'`; not pure `'diff'`):
`User.asOf(id, isoTs)`, `User.revertTo(revision)`.
`ModelRevision.listUpTo(db, { table, id, asOfIso })` /
`ModelRevision.latestAsOf(db, {…})`.

Exceptions (all extend `EloquentException`): `ModelNotFoundException`
(`.model`, `.id`), `MultipleRecordsFoundException` (`.model`, `.count`).

---

## QueryBuilder — `Model.query(db?)`

WHERE values are run through the model's casts before binding — pass the
**application** value (`true`, a `Date`, an object), not the stored primitive.

**Filters** (chainable):

```
where(col, op, val)          orWhere(col, op, val)
whereEq(col, val)            whereLike(col, pattern)        // % wildcard
whereIn(col, vals|subquery)  whereNotIn(col, vals|subquery) // []→0 rows / all rows, never SQL error
whereNull(col)               whereNotNull(col)              // + orWhereNull / orWhereNotNull
whereBetween(col, [a,b])     whereNotBetween(col, [a,b])    // + or* variants
whereRaw(sql, bindings?)     whereColumn(c1, op?, c2)       // identifier vs identifier (no binding)
whereGroup(fn)               orWhereGroup(fn)               // parenthesised group
when(cond, ifTrue, ifFalse?)                                // conditional clause
whereExists(sql, bindings?)  whereNotExists(sql, bindings?)
whereDate(col, op?, val)     whereTime(col, op?, val)       // DATE()/TIME() part (UTC); accepts Date or string
whereYear(col, y)   whereMonth(col, m)   whereDay(col, d)   // strftime part equality
```

**Shape:**

```
select(cols[])   selectRaw(expr)   selectSub(qb, alias)   distinct()
join(table, on)  leftJoin(table, on)   from(table)
groupBy(col)     having(col, op, val) / havingRaw(sql, b?) / orHaving* / orHavingRaw
orderBy(col, 'asc'|'desc')   limit(n)   offset(n)
union(qb)        unionAll(qb)   intersect(qb)   except(qb)
```

**Soft-delete scopes** (model needs `softDeletes=true`):
`withTrashed()` (include deleted), `onlyTrashed()` (deleted only). Default query
appends `WHERE deleted_at IS NULL`, correctly grouped against top-level `OR`.

**Named scopes:** `scoped('active', 'recent')` (from `static scopes`).

**Global scopes:** `static globalScopes = { name: q => ... }` applies to every
query on the model; opt out per query with `withoutGlobalScope(name)` /
`withoutGlobalScopes()`.

**Relation existence** (needs `static relations`):
`has(rel)`, `doesntHave(rel)`, `whereHas(rel, cb?)`, `whereDoesntHave(rel, cb?)`
(+ `orHas`/`orDoesntHave`/`orWhereHas`/`orWhereDoesntHave`).
Inline shorthand: `whereRelation(rel, col, opOrValue, value?)` /
`orWhereRelation(...)` - `whereHas` with a single column condition.
Correlated aggregates: `withCount(rel, as?)`, `withSum(rel, col, as?)`,
`withAvg(rel, col, as?)`, `withMin(rel, col, as?)`, `withMax(rel, col, as?)` →
virtual columns `<rel>_count` / `<rel>_<col>_sum` / `<rel>_<col>_avg` /
`<rel>_<col>_min` / `<rel>_<col>_max` (SUM/AVG/MIN/MAX return `null` on zero
rows; `withCount` etc. throw on `morphTo`). Existence flag: `withExists(rel, as?)`
→ `<rel>_exists` as `0`/`1`.

**Eager loading:** `with(['author', 'comments'])` - no N+1. Constrained form:
`with({ comments: q => q.whereEq('approved', true).orderBy('created_at', 'desc') })`
filters/shapes each relation's loader (a narrowing `.select()` keeps the
correlation FK automatically).

**Terminals** (`db?` optional):

```
get(db?) → Collection<T>     first(db?) → T|null     firstOrFail(db?)   sole(db?)
firstWhere(col, opOrValue, value?) → T|null            // where + first in one call
count(db?)   sum(col)|sum(db,col)   avg(…)   min(…)   max(…)
pluck(col)   value(col)   chunk(size, cb)   // cb returns false to stop
```

**Pagination:**

```ts
await Post.query().paginate(page, perPage = 15)
// → { data: Collection, total, page, perPage, lastPage }

await Post.query().paginateCursor({ orderBy, direction = 'desc', perPage = 20, after?, before? })
// → { data, nextCursor, prevCursor, hasMore }   // keyset; single-column orderBy + PK tiebreaker
```

**Mutations** (bypass model hooks/casts unless noted):

```
insert(values)              insertOrIgnore(values)
insertMany(rows)            insertOrIgnoreMany(rows)        // single db.batch()
upsert(values, conflictCols, updateCols?)                   // ON CONFLICT DO UPDATE
upsertMany(rows, conflictCols, updateCols?)
update(values) → number     delete(db?) → number            // honour current WHERE
increment(col, amount = 1, extra?) → number                 // atomic SET col = COALESCE(col,0) + ?
decrement(col, amount = 1, extra?) → number                 // NULL-safe; `extra` sets sibling columns
insertReturning(values, returning?)   → row | null          // RETURNING; raw DB rows, not models
updateReturning(values, returning?)   → row[]
deleteReturning(returning?)           → row[]
```

**Atomic batches** — get unexecuted `D1PreparedStatement`s, run via `db.batch([...])`:

```
toInsertPrepared(db?, values)   toInsertOrIgnorePrepared(db?, values)
toUpsertPrepared(db?, values, conflictCols, updateCols?)
toUpdatePrepared(db?, values)   toDeletePrepared(db?)        // no WHERE ⇒ unfiltered (all rows), does NOT throw
```

```ts
await db.batch([
  Workspace.query().toInsertPrepared(db, { id, name, owner_id }),
  WorkspaceMember.query().toInsertPrepared(db, { workspace_id: id, user_id, role: 'owner' }),
])
```

**Prepared queries** - compile once, run many. Put `placeholder(name)` in filter
values, call `.prepare(db?)` → `PreparedQuery` with `get(params, db?)` /
`first(params, db?)` / `all(params, db?)`:

```ts
const byEmail = User.query().whereEq('email', placeholder('email')).prepare(env.DB)
const a = await byEmail.first({ email: 'a@x.com' })
```

---

## Transactions

`transaction(db, async tx => ...)` - an atomic unit of work over `db.batch()`.
The closure gets a **write-only** collector `tx` (`create` / `save` / `update` /
`delete` / `upsert` / `updateJson*` / `increment` / `decrement`); every op runs
its before-hooks and casts immediately but nothing executes until the closure
returns, then everything (revision rows included) flushes as ONE batch. A
before-hook returning `false` throws `TransactionAborted` and nothing is
written; per-op `D1Result`s land in `tx.results`. `Model.transaction(db, fn)`
and a raw `Model.transaction(db, stmts[])` form exist too.
Options (`TxOptions`): `revision` context, `skipRevisions`.

```ts
await transaction(env.DB, async (tx) => {
  const order = await tx.create(Order, { customer_id })
  await tx.create(OrderItem, { order_id: order.get('id'), sku: 'A-1' })
  tx.decrement(Wallet.query().whereEq('id', walletId), 'balance', 500)
})
```

Full guide: [`guide/transactions.md`](./guide/transactions.md).

---

## Collection (returned by `get()`)

Array subclass; transforms return `Collection`, not `Array`.

```
pluck(col)  keyBy(col)  groupBy(col)  where(col,val)  whereIn(col,vals)  unique(col)
sortBy(col, dir?)  sortByDesc(col)  partition(fn)  take(n)  skip(n)  chunk(n)
sum/min/max/avg(col)  first(fn?)  last(fn?)  isEmpty()  isNotEmpty()  contains(…)
map/filter/flatMap(fn)  toArray()  each(fn)  tap(fn)  pipe(fn)
```

---

## Relations

Define on `static relations` with a **lazy `() => Model` thunk** (avoids
circular-import breakage). Powers `with()`, `has()`/`whereHas()`,
`model.related()`, and auto-derived eager loaders.

```ts
import type { TRelationDefinition } from '@orphnet/d1-eloquent'

static relations: Record<string, TRelationDefinition> = {
  author:   { type: 'belongsTo', model: () => User, foreignKey: 'user_id' /*, ownerKey */ },
  comments: { type: 'hasMany',   model: () => Comment, foreignKey: 'post_id' /*, localKey */ },
  profile:  { type: 'hasOne',    model: () => Profile, foreignKey: 'user_id' },
  tags: {
    type: 'belongsToMany', model: () => Tag, pivot: 'post_tags',
    foreignPivotKey: 'post_id', relatedPivotKey: 'tag_id',
    // localKey?, relatedKey?
  },
}
```

| Type | FK location | Required keys |
|---|---|---|
| `belongsTo` | this model | `foreignKey` (→ related PK via `ownerKey`) |
| `hasMany` / `hasOne` | related model | `foreignKey` (back-ref) |
| `belongsToMany` | pivot table | `pivot`, `foreignPivotKey`, `relatedPivotKey` |
| `hasManyThrough` / `hasOneThrough` | through an intermediate model | `through` (thunk), `firstKey` (through → this), `secondKey` (related → through); optional `localKey`, `secondLocalKey` |

Morph variants exist too (`morphTo`, `morphMany`, `morphOne`, `morphToMany`,
`morphedByMany`). Pivot tables must **not** have a `deleted_at` column.

**Lazy load / pivot management:**

```ts
await user.related('posts').get(db)       // { query, get, first }
await user.related('roles').attach!(['r1','r2'], { extras: {…} })   // INSERT OR IGNORE
await user.related('roles').detach!('r1')          // omit arg = detach all
await user.related('roles').sync!(['r2','r3'])      // → { attached, detached }
await user.related('roles').toggle!(['t1'])
// model-level shortcuts: user.attach('roles', ids) / detach / sync / toggle
```

Typed relations: `class User extends BaseModel<UserAttrs, {}, { posts: Post[] }>`
→ `user.relations.posts` is typed.

---

## Schema builder (migrations)

`import { Schema } from '@orphnet/d1-eloquent/cli'` — `up`/`down` get a `Schema`
(no `db`, no `exec`).

```ts
schema.createTable('posts', (t) => { /* … */ })
schema.dropTable('posts')
schema.table('posts', (t) => t.addText('slug', { nullable: true }))   // ALTER
schema.raw('CREATE INDEX …')
```

**Create-mode columns** → `ColumnBuilder`:

```
t.id(name = 'id')              // TEXT PRIMARY KEY NOT NULL
t.text(name, opts?)   t.integer(name, opts?)   t.real(name, opts?)   t.boolean(name, opts?)
t.timestamps()                 // created_at/updated_at TEXT NOT NULL
t.softDeletes({ column?, index? })   // deleted_at TEXT + index
t.primary('a, b')   t.unique('cols', name?)   t.index('cols', name?)   t.check(expr, name?)
t.foreign(cols, { references, on?, onDelete?, onUpdate? })
```

**Chainable modifiers:** `.nullable(v?)`, `.notNull()`, `.default(v)`,
`.unique(name?)`, `.index(name?)`, `.primary()`, `.check(expr)`.
**FK (create mode only):** `.references(table, col?)`, `.constrained(table)`,
`.onDelete(action)`, `.onUpdate(action)`. `FKAction` =
`'cascade' | 'restrict'(default) | 'set null' | 'set default' | 'no action'`.

**Alter mode** (`schema.table`): `t.addText/addInteger/addReal(name, opts?)` —
same modifiers **except** FK methods (SQLite can't add FKs via ALTER).
`t.dropSoftDeletes()` emits a comment (no safe DROP COLUMN in SQLite).

```ts
const migration: TMigration = {
  name: '20260101_000000_create_comments_table',
  up: (schema) => schema.createTable('comments', (t) => {
    t.id()
    t.text('post_id').notNull().constrained('posts').onDelete('cascade')
    t.text('body').notNull()
    t.timestamps()
  }),
  down: (schema) => schema.dropTable('comments'),
}
export default migration
```

> Enable FK enforcement in D1: `PRAGMA foreign_keys = ON` (off by default).

---

## Seeders & factories (`@orphnet/d1-eloquent/cli`)

```ts
import { Factory, fake, output } from '@orphnet/d1-eloquent/cli'
import type { TSeeder, TSeederOpts } from '@orphnet/d1-eloquent/cli'

class UserFactory extends Factory<UserAttrs> {
  readonly table = 'users'
  definition() { return { id: fake.uuid(), name: fake.name(), email: fake.email(), created_at: fake.now(), updated_at: fake.now() } }
}

const seeder: TSeeder = {
  name: 'UserSeeder',
  run: async (opts: TSeederOpts) => {
    const users = await new UserFactory().createMany(opts, 50)   // batched insert
    output.log(`Seeded ${users.length} users`, { tag: 'users' })
  },
}
export default seeder
```

---

## CLI — bun/bunx only

Binding auto-detected from `wrangler.jsonc` — there is **no `--db` flag** (never
pass one). No-flag commands target the **local** miniflare D1 (dev default). Pass
**`--remote`** to run against the deployed/prod D1 — the only way to reach it
(e.g. `bunx d1-eloquent migrate --remote`). `fresh --remote` additionally
requires `--force`.

```
bunx d1-eloquent migrate          run pending migrations (local)
bunx d1-eloquent rollback         roll back last batch
bunx d1-eloquent fresh            drop all + re-run (FK-safe topological order)
bunx d1-eloquent seed             run seeders (--idempotent UPSERT, --fresh clear-first, --pretend)
bunx d1-eloquent status           migration status
bunx d1-eloquent tinker           local REPL with models in scope
bunx d1-eloquent generate [model] diff models vs migrations → reconciling migration (preview; --write saves, --name=<name>)
bunx d1-eloquent make:migration <name>
bunx d1-eloquent make:model <Name>
bunx d1-eloquent make:seeder <Name>     make:factory <Name>     make:pivot <table>
bunx d1-eloquent make:resource <Name>   # model + migration + factory + seeder
bunx d1-eloquent make:dto <model>       make:types
```

Migrations are discovered under `src/database/migrations/` (+ several fallbacks)
and tracked in `_migrations`. Generated models/migrations land in
`src/app/models/` and `src/database/migrations/`.

---

## Runtime traps (full detail in troubleshooting.md)

1. **`fillable` without `id`** → `create({ id, … })` throws `Missing primary
   key 'id'` (HTTP 500). `fill()` drops non-fillable keys. Fix: add `'id'` to
   `fillable`, use `guarded`, or a `creating` hook. `tsc` does NOT catch it.
2. **`static casts` widening** → TS2417/TS2322. Annotate / `as const` / `satisfies`.
3. **Circular-ESM relations** → always `model: () => Model`, never `model: Model`.
