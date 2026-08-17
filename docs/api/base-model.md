# BaseModel API Reference

`BaseModel<TAttrs, TVirtuals, TRels>` is the base class for all ORM models. Extend it with a typed attributes interface or type alias that mirrors your database columns. The optional `TVirtuals` generic (defaults to `{}`) types virtual attribute access through the proxy — see [Proxy Access](../guide/accessors-mutators.md#proxy-access). The optional `TRels` generic (defaults to `Record<string, unknown>`) types the `.relations` property — see [Typed Relations](#typed-relations) below.

All model-returning methods (`find`, `create`, `query().first()`, etc.) return **proxy-wrapped instances by default**. This means you can access typed attributes directly as properties — no `.toObject()` needed.

> [!TIP]
> **`db` is optional after `configure(env)`**
>
> Every method below is shown with two signatures: the explicit-`db` form and the auto-resolved form. After calling [`configure(env)`](../guide/configuration.md) once at startup you can **omit `db` everywhere** — `Model.create(attrs)`, `Model.find(id)`, `Model.query()`, `model.delete()`. Passing `db` explicitly still works and takes priority over the configured default.

```ts
import { BaseModel } from '@orphnet/d1-eloquent'

// Both `type` and `interface` work for attrs definitions
interface PostAttrs {
  id: string
  title: string
  user_id: string
  created_at?: string
  updated_at?: string
  deleted_at?: string
}

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
}

// Proxy-by-default: typed property access works immediately
const post = await Post.find(env.DB, postId)
console.log(post?.title)  // typed as string — no cast needed
```

## Model Configuration

Static properties that configure ORM behavior. Set them directly on the class body.

| Property | Type | Default | Description |
|---|---|---|---|
| `table` | `string` | required | D1 table name |
| `primaryKey` | `string` | `'id'` | Primary key column name |
| `keyStrategy` | `'uuid' \| 'uuidv7' \| 'ulid' \| false \| (ctx) => string` | `'uuid'` | How the primary key is auto-generated on insert when absent — see [keyStrategy](#keystrategy-auto-primary-keys) |
| `softDeletes` | `boolean` | `false` | Enable soft-delete via `deleted_at` column |
| `timestamps` | `boolean` | `true` | Auto-manage `created_at` / `updated_at` |
| `casts` | `Record<string, CastDefinition>` | `undefined` | Attribute type casting — see [Casting guide](../guide/casting.md) |
| `revisions` | `RevisionConfig` | `undefined` | Enable immutable audit log |
| `revisionRedact` | `string[]` | `[]` | Fields excluded from revision data |
| `revisionOnly` | `string[]` | `[]` | Only these fields captured in revision data |
| `accessors` | `Record<string, Attribute>` | `undefined` | Accessor/mutator definitions — see [Accessors & Mutators guide](../guide/accessors-mutators.md) |
| `appends` | `string[]` | `undefined` | Virtual attribute keys included in `toObject()` |
| `hidden` | `string[]` | `undefined` | Attribute keys excluded from `toObject()` |
| `fillable` | `string[]` | `undefined` | Whitelist of keys allowed via `fill()` |
| `guarded` | `string[]` | `undefined` | Blacklist of keys blocked via `fill()` |
| `relations` | `Record<string, TRelationDefinition>` | `undefined` | Declarative relationship definitions — see [Relationships API](./relationships.md) |
| `scopes` | `Record<string, (q) => void>` | `undefined` | Named query scopes — see [Scopes](#scopes) |
| `globalScopes` | `Record<string, (q) => void>` | `undefined` | Scopes auto-applied to every query - see [Global Scopes](#global-scopes) |
| `hooks` | `THooks<T>` | `undefined` | Lifecycle hooks — see [Lifecycle Hooks](#lifecycle-hooks) |
| `eagerLoaders` | `Record<string, (db, models) => Promise<void>>` | `{}` | Custom eager-load definitions for `.with()` |
| `modelName` | `string` | `undefined` | Human-readable name used in exception messages (defaults to `table`) |
| `connection` | `D1Database \| string` | `undefined` | Default DB connection for this model |

### RevisionConfig Type

```ts
interface RevisionConfig {
  enabled: boolean
  mode: 'diff' | 'snapshot' | 'diff+after' | 'before+after'
  includeRequestId?: boolean
}
```

| Mode | What is stored |
|---|---|
| `'diff'` | Changed fields only |
| `'snapshot'` | Full record after change |
| `'diff+after'` | Changed fields + full record after (recommended) |
| `'before+after'` | Full record before + full record after |

### RevisionContext Type

```ts
interface RevisionContext {
  actorId?: string
  requestId?: string
  reason?: string
}
```

Pass this as `opts.revision` to `save()` and `delete()`.

## Static Methods

### `create(db, attrs)`

```ts
static create(
  attrs: TAttrs,
  opts?: { revision?: RevisionContext; cache?: CacheAdapter },
): Promise<TModel>                                              // auto-resolve db
static create(
  db: D1Database,
  attrs: TAttrs,
  opts?: { revision?: RevisionContext; cache?: CacheAdapter },
): Promise<TModel>
```

Inserts a new row and returns a proxy-wrapped model instance with typed property access. Pass `opts.revision` to record an initial `create` audit revision (when `revisions.enabled`), or `opts.cache` to invalidate a cache adapter — the same options accepted by `save()`.

```ts
const post = await Post.create(env.DB, {
  title: 'Hello world',   // `id` auto-generated (UUID v4) — pass one to override
  user_id: userId,
})
console.log(post.id)     // e.g. '550e8400-…' — typed as string
console.log(post.title)  // 'Hello world' — typed as string
```

> [!TIP]
> Text primary keys are the convention. Since `v0.1.0-beta.2` the key is generated for you when you omit it (default `crypto.randomUUID()`); pass `id` explicitly to supply your own, or change the format via [`keyStrategy`](#keystrategy-auto-primary-keys).

---

<a id="keystrategy-auto-primary-keys"></a>

### keyStrategy — auto primary keys

`create()`, `createMany()`, and `save()` mint the primary key for you when the caller doesn't supply one, so `id: crypto.randomUUID()` is no longer required on every insert. An explicitly-provided key is always respected. Control the format per model with `static keyStrategy`:

```ts
class Event extends BaseModel<EventAttrs> {
  static table = 'events'
  static keyStrategy = 'uuidv7'   // time-sortable keys (better index locality)
}
```

| Value | Generated key |
|---|---|
| `'uuid'` *(default)* | RFC 4122 v4 UUID via `crypto.randomUUID()` |
| `'uuidv7'` | RFC 9562 v7 UUID — 48-bit ms timestamp prefix + random; sorts in creation order |
| `'ulid'` | 26-char Crockford base32 — sortable to the ms, URL-safe, case-insensitive |
| `(ctx) => string` | Custom generator; `ctx` is `{ table, keyName }` |
| `false` | Disabled — a missing key throws on insert (the pre-`beta.2` behaviour) |

Set it once on a shared base class to apply a format app-wide via static inheritance, or per model / per [`BaseModel.dynamic({ keyStrategy })`](#dynamic). The standalone generators are also exported for foreign keys and seeders:

```ts
import { uuid, uuidv7, ulid, generateId } from '@orphnet/d1-eloquent'

const fk = uuid()                  // '9f1c…'
const sortable = uuidv7()          // time-ordered
const id = generateId('ulid', { table: 'events', keyName: 'id' })
```

> [!WARNING]
> **Raw inserts are not covered**
>
> The lifecycle methods (`create`/`createMany`/`save`) auto-generate; the raw `QueryBuilder.insert()` / `insertMany()` escape hatches do **not** — supply the `id` yourself there.

---

### `find(db, id)`

```ts
static find(id: string): Promise<TModel | null>                    // auto-resolve db
static find(db: D1Database, id: string): Promise<TModel | null>
```

Fetches a single row by primary key. Returns `null` if not found. When `softDeletes` is enabled, soft-deleted rows are excluded.

```ts
const post = await Post.find(env.DB, postId)
if (post) {
  console.log(post.title)      // direct property access (proxy-by-default)
  console.log(post.get('title')) // typed accessor alternative
}
```

---

### `findOrFail(db, id)`

```ts
static findOrFail(db: D1Database, id: string): Promise<TModel>
static findOrFail(id: string): Promise<TModel>  // auto-resolve
```

Fetches a single row by primary key. Throws `ModelNotFoundException` if not found.

```ts
import { ModelNotFoundException } from '@orphnet/d1-eloquent'

const post = await Post.findOrFail(env.DB, postId)

try {
  await Post.findOrFail('nonexistent-id')
} catch (e) {
  if (e instanceof ModelNotFoundException) {
    console.log(e.model) // "posts"
    console.log(e.id)    // "nonexistent-id"
  }
}
```

---

### `all(db?)`

```ts
static all(db?: D1Database): Promise<TModel[]>
```

Fetches every row via `query().get(db)`, returning a [`Collection`](./query-builder.md#collection) of proxy-wrapped instances. Soft-deleted rows are excluded when `softDeletes` is enabled. Equivalent to `Model.query().get(db)` — use a filtered `query()` for anything but a full-table read.

```ts
const users = await User.all(env.DB)
const users = await User.all()          // auto-resolved db
```

---

### `query(db?)`

```ts
static query(): QueryBuilder<TModel>                       // auto-resolve db
static query(db: D1Database): QueryBuilder<TModel>
```

Returns a `QueryBuilder` for constructing a SELECT query. All filter, shape, and terminal methods are available on the returned builder.

When `db` is provided, it becomes the default database for all terminal methods on this query — no need to pass `db` again to `.get()`, `.first()`, etc. Explicit `db` at a terminal call still takes priority.

```ts
// Set db once at query creation
const posts = await Post.query(env.DB)
  .whereEq('user_id', userId)
  .orderBy('created_at', 'DESC')
  .limit(10)
  .get()

// Or pass db at terminal call (existing pattern still works)
const posts = await Post.query()
  .whereEq('user_id', userId)
  .get(env.DB)
```

See [QueryBuilder reference](./query-builder.md) for all chainable methods.

---

### `asOf(db, id, isoTimestamp)`

```ts
static asOf(
  db: D1Database,
  id: string,
  isoTimestamp: string
): Promise<TModel | null>
static asOf(id: string, isoTimestamp: string): Promise<TModel | null>  // auto-resolve db
```

Reconstructs the model state as it existed at the given ISO 8601 timestamp. Returns `null` if no revision exists at or before that point.

Requires `revisions.enabled = true` and a mode that stores a full snapshot to rebuild from — `'snapshot'`, `'diff+after'`, or `'before+after'`. Pure `'diff'` mode records only per-change field diffs with no snapshot, so `asOf()` (and `revertTo()`) **throws** for a diff-only model.

```ts
const post = await Post.asOf(env.DB, postId, '2026-01-15T12:00:00Z')
if (post) {
  console.log(post.attrs.title)  // value at that timestamp
}
```

---

### `revertTo(db, revision)`

```ts
static revertTo(
  db: D1Database,
  revision: ModelRevision
): Promise<TModel>
static revertTo(revision: ModelRevision): Promise<TModel>  // auto-resolve db
```

Restores a model to the state captured in a revision record. Obtain `ModelRevision` objects by querying the `ModelRevision` model directly, or via its `latestAsOf` / `listUpTo` helpers.

```ts
import { ModelRevision } from '@orphnet/d1-eloquent'

// Revision rows are keyed by `model_table` + `model_id` (not `model_type`)
const revisions = await ModelRevision.query()
  .whereEq('model_table', 'posts')
  .whereEq('model_id', postId)
  .orderBy('created_at', 'DESC')
  .get(env.DB)

await Post.revertTo(env.DB, revisions[0])
```

> [!TIP]
> **ModelRevision helpers**
>
> `ModelRevision.latestAsOf(db, { table, id, asOfIso })` returns the most recent
> revision at or before `asOfIso`, and `ModelRevision.listUpTo(db, { table, id, asOfIso })`
> returns all revisions up to that point in ascending order. Both take the options
> object as the second argument and back the `asOf()` time-travel path.

<a id="dynamic"></a>

### `dynamic(config)`

```ts
static dynamic<TAttrs>(config: TDynamicModelConfig<TAttrs>): TModelCtor<BaseModel<TAttrs>>
```

Creates a fully functional `BaseModel` subclass at runtime from a configuration object. No pre-defined model file needed. The returned class works identically to a hand-written model class — all features are supported (CRUD, relations, casts, hooks, scopes, soft deletes, revisions, eager loading).

The optional `TAttrs` generic provides opt-in type safety when you know the schema at compile time.

```ts
import { BaseModel } from '@orphnet/d1-eloquent'
import type { TDynamicModelConfig } from '@orphnet/d1-eloquent'

// Untyped — attributes are Record<string, unknown>
const Product = BaseModel.dynamic({
  table: 'products',
  modelName: 'Product',
  softDeletes: true,
  casts: { price: 'real', specs: 'json', is_active: 'boolean' },
  fillable: ['id', 'name', 'price', 'specs', 'is_active'],
})

const product = await Product.find(env.DB, 'some-id')

// Typed — opt-in compile-time safety
interface ProductAttrs {
  id: string
  name: string
  price: number
  specs: Record<string, unknown>
  is_active: boolean
}

const TypedProduct = BaseModel.dynamic<ProductAttrs>({
  table: 'products',
  casts: { price: 'real', specs: 'json', is_active: 'boolean' },
  fillable: ['id', 'name', 'price', 'specs', 'is_active'],
})
```

**Config properties** — all optional except `table`:

| Property | Type | Default | Description |
|---|---|---|---|
| `table` | `string` | required | D1 table name |
| `primaryKey` | `string` | `'id'` | Primary key column |
| `keyStrategy` | `'uuid' \| 'uuidv7' \| 'ulid' \| false \| (ctx) => string` | `'uuid'` | Auto primary-key generation — see [keyStrategy](#keystrategy-auto-primary-keys) |
| `modelName` | `string` | — | Human-readable name for error messages |
| `timestamps` | `boolean` | `true` | Auto-manage created_at/updated_at |
| `softDeletes` | `boolean` | `false` | Enable soft-delete |
| `casts` | `Record<string, CastDefinition>` | — | Attribute casting |
| `relations` | `Record<string, TRelationDefinition>` | — | Declarative relationships |
| `scopes` | `Record<string, (q) => void>` | — | Named query scopes |
| `globalScopes` | `Record<string, (q) => void>` | - | Scopes auto-applied to every query |
| `hooks` | `THooks<any>` | — | Lifecycle hooks |
| `fillable` | `string[]` | — | Mass-assignment whitelist |
| `guarded` | `string[]` | — | Mass-assignment blacklist |
| `connection` | `D1Database \| string` | — | Default DB connection |
| `accessors` | `Record<string, Attribute>` | — | Accessor/mutator definitions |
| `appends` | `string[]` | — | Virtual keys in toObject() |
| `hidden` | `string[]` | — | Keys excluded from toObject() |
| `revisions` | `RevisionConfig \| false` | — | Audit trail config |
| `revisionRedact` | `string[]` | — | Fields excluded from revisions |
| `revisionOnly` | `string[] \| null` | — | Fields included in revisions |

The factory automatically validates the config and throws `EloquentException` if `table` is missing or empty.

---

### `validateDynamicModel(ctor)`

```ts
function validateDynamicModel(ctor: unknown): asserts ctor is TModelCtor<any>
```

Validates that a constructor has the required static properties (`table`, `primaryKey`) to function as a model. Called automatically by `dynamic()`. Also useful for validating manually-constructed model classes.

```ts
import { validateDynamicModel } from '@orphnet/d1-eloquent'

class ManualModel extends BaseModel {
  static table = 'items'
  static primaryKey = 'id'
}

validateDynamicModel(ManualModel) // passes
validateDynamicModel({})           // throws EloquentException
```

---

## Instance Methods

### `set(key, value)`

```ts
set<K extends keyof TAttrs>(key: K, value: TAttrs[K]): this
```

Sets a single attribute `key` to `value` in the in-memory model state. Returns `this` for chaining, so multiple fields are set with one call each. Changes are not persisted until you call `.save()`.

The value is routed through the mutator defined for `key` in `static accessors`. If a mutator returns a plain object, fan-out occurs: the object's keys are spread to their respective columns. See [Mutator Fan-Out](../guide/accessors-mutators.md#mutator-fan-out). To assign many fields at once, use `fill(values)` instead.

```ts
post.set('title', 'Updated title').set('user_id', newUserId)
await post.save(env.DB)
```

---

### `save(db, opts?)`

```ts
save(opts?: {                         // auto-resolve db
  revision?: RevisionContext
  cache?: CacheAdapter
}): Promise<this>
save(
  db: D1Database,
  opts?: {
    revision?: RevisionContext
    cache?: CacheAdapter
  }
): Promise<this>
```

Persists the current in-memory state and returns the model instance (`this`) for chaining. Issues an `UPDATE` for only the changed fields (dirty tracking). If the model has not been persisted yet, issues an `INSERT`. When a `saving` / `creating` / `updating` hook returns `false` the write is cancelled and the unchanged instance is still returned.

```ts
post.set('title', 'New title')
await post.save(env.DB, {
  revision: { actorId: userId, reason: 'user edit' },
})
```

> [!TIP]
> **In-place mutation of cast values is tracked**
>
> Mutating a `json`, `array`, or `Date` cast attribute in place — e.g.
> `post.attrs.tags.push('new')` or `post.get('metadata').key = 'val'` — is now
> detected on `save()` and emits an `UPDATE`. The original-snapshot used for
> dirty diffing and the revision **before** value are deep-copied at hydration
> time, so an in-place edit no longer corrupts the revision before-snapshot.
>
> Replacing the whole value via `set()` (e.g. `post.set('tags', [...post.get('tags'), 'new'])`)
> remains the clearest, most explicit pattern and is still recommended for readability.

---

### `wasRecentlyCreated`

```ts
get wasRecentlyCreated(): boolean
```

`true` only for the current instance's lifecycle after it was **INSERTed** (via `create()`,
`createMany()`, or a `save()` that inserted); `false` for models loaded from the database or
persisted via an `UPDATE`. Useful after `firstOrCreate` / `updateOrCreate`:

```ts
const user = await User.firstOrCreate(env.DB, { email })
if (user.wasRecentlyCreated) await sendWelcomeEmail(user)
```

---

### `replicate(except?)`

```ts
replicate(except?: (keyof TAttrs & string)[]): this
```

Returns a new **unsaved** copy with the primary key, `created_at`/`updated_at` (and `deleted_at`
for soft-delete models) stripped, plus any keys in `except`. Call `save()` to persist it - a fresh
primary key is generated per the model's [`keyStrategy`](#keystrategy-auto-primary-keys).

```ts
const original = await Post.findOrFail(env.DB, id)
const draft = original.replicate(['slug'])   // don't copy the unique slug
draft.set('slug', newSlug)
await draft.save(env.DB)                     // new row, new id
```

---

### `increment(column, amount?, extra?)` / `decrement(column, amount?, extra?)`

```ts
increment(column: keyof TAttrs & string, amount?: number, extra?: Partial<TAttrs>): Promise<this>
increment(column: keyof TAttrs & string, extra: Partial<TAttrs>): Promise<this>  // extra without amount (+1)
decrement(column: keyof TAttrs & string, amount?: number, extra?: Partial<TAttrs>): Promise<this>
decrement(column: keyof TAttrs & string, extra: Partial<TAttrs>): Promise<this>
// db-first overloads also available: increment(db, column, amount?, extra?) etc.
```

Atomically bump a numeric column on **this row**
(`UPDATE ... SET <column> = COALESCE(<column>, 0) +/- ? WHERE <pk> = ?`) and sync the in-memory
attribute. `amount` defaults to `1`; `extra` sets additional columns in the same UPDATE.
`updated_at` is touched when `timestamps` is enabled. Returns the model (`this`).

- **NULL handling:** the target column is `COALESCE`d to `0`, so incrementing a `NULL` counter yields `amount`, not `NULL`.
- **Casts:** `extra` values are dehydrated through the model's casts before binding (a `Date` binds as an ISO string), and the in-memory sync re-hydrates through the same casts.
- This is a **direct atomic write** - it does not fire lifecycle hooks or write revisions, and it leaves any unrelated dirty fields untouched (only the incremented column, `extra`, and `updated_at` are synced).

```ts
const post = await Post.findOrFail(env.DB, id)
await post.increment('views')            // +1, updated_at touched
await post.increment('views', 10, { last_viewed_at: nowIso() })
await post.increment('views', { last_viewed_at: nowIso() })   // extra without amount (+1)
await wallet.decrement('balance', 500)
```

For the bulk, row-set version see the [QueryBuilder reference](./query-builder.md).

---

### `delete(db, opts?)`

```ts
delete(opts?: {                       // auto-resolve db
  revision?: RevisionContext
  cache?: CacheAdapter
}): Promise<boolean>
delete(
  db: D1Database,
  opts?: {
    revision?: RevisionContext
    cache?: CacheAdapter
  }
): Promise<boolean>
```

When `softDeletes = false` (default): issues `DELETE FROM table WHERE id = ?`.

When `softDeletes = true`: sets `deleted_at` to the current UTC timestamp and issues an `UPDATE`. The row remains in the database and can be restored.

Returns `true` when a row was actually removed (or soft-deleted). Returns `false` if the model has no primary key, or if a `deleting` hook cancelled the operation by returning `false`.

```ts
await post.delete(env.DB, {
  revision: { actorId: userId, reason: 'content removed' },
})
```

---

### `restore(db?, opts?)`

```ts
restore(opts?: {                      // auto-resolve db
  revision?: RevisionContext
  cache?: CacheAdapter
}): Promise<boolean>
restore(
  db: D1Database,
  opts?: {
    revision?: RevisionContext
    cache?: CacheAdapter
  }
): Promise<boolean>
```

Clears `deleted_at`, making the record visible to normal queries again. Only meaningful when `softDeletes = true`. Touches `updated_at` when `timestamps` is on, writes an `update` revision when `revisions.enabled`, and invalidates `opts.cache` when supplied. Returns `true` if a row was restored; `false` when the model isn't soft-deleting or has no primary key.

```ts
const post = await Post.query().onlyTrashed().whereEq('id', postId).first(env.DB)
if (post) {
  await post.restore(env.DB)
}
```

### `get(key)`

```ts
get<K extends keyof TAttrs>(key: K): TAttrs[K]
```

Returns the value for `key`, resolved through the accessor pipeline (cast first, then accessor). If the key has a get-only accessor with no backing column, returns the computed virtual value.

```ts
const name = user.get('name')       // accessor-transformed value
const full = user.get('full_name')  // virtual attribute (if defined)
```

---

### `getRaw(key)`

```ts
getRaw<K extends keyof TAttrs>(key: K): TAttrs[K]
```

Returns the cast-hydrated value for `key`, bypassing the accessor pipeline. Useful when you need the raw stored value without accessor transformation.

```ts
user.get('email')     // "alice@example.com" (accessor lowercased it)
user.getRaw('email')  // "Alice@Example.com" (cast-hydrated, no accessor)
```

---

### `getOriginal(key)`

```ts
getOriginal<K extends keyof TAttrs>(key: K): TAttrs[K]
```

Returns the value for `key` from the construction-time or last-save snapshot. Useful for comparing current vs. original state.

```ts
user.set('name', 'Bob')
user.get('name')          // "Bob"
user.getOriginal('name')  // "Alice" (value at load time)
```

---

### `clearAccessorCache()`

```ts
clearAccessorCache(): void
```

Clears the per-instance accessor result cache. The cache is automatically invalidated on any write operation (`set`, `fill`, `setRaw`, `forceFill`), but call this manually if external state that an accessor depends on has changed.

---

### `isDirty(key?)` / `getDirty()`

```ts
isDirty(key?: keyof TAttrs): boolean
getDirty(): Partial<TAttrs>
```

Dirty tracking reflects **unsaved** changes since the model was loaded or last persisted. `isDirty()` returns `true` when any attribute has changed; pass a `key` to test a single attribute. `getDirty()` returns a map of the changed attributes to their current values. Both reset after a successful `save()`, `restore()`, or soft `delete()`.

```ts
const post = await Post.find(env.DB, id)
post.isDirty()            // false — freshly loaded
post.set('title', 'New')
post.isDirty()            // true
post.isDirty('title')     // true
post.isDirty('body')      // false
post.getDirty()           // { title: 'New' }
await post.save(env.DB)
post.isDirty()            // false again
```

> [!TIP]
> In-place edits of `json` / `array` / `Date` cast attributes (e.g. `post.attrs.tags.push('x')`) are detected because the load-time snapshot is deep-copied — see the `save()` note above.

---

### `asProxy()`

```ts
asProxy(): ModelProxy<TAttrs, TVirtuals>
```

Returns a `Proxy` wrapper that enables direct property access (`proxy.key`) routing through the accessor/mutator pipeline. The proxy is lazily created and cached on the instance.

- `proxy.key` is equivalent to `model.get('key')`
- `proxy.key = value` is equivalent to `model.set('key', value)`
- `proxy.$model` returns the underlying `BaseModel` instance
- `JSON.stringify(proxy)` matches `model.toObject()`
- `proxy instanceof Model` returns `true`

See [Proxy Access](../guide/accessors-mutators.md#proxy-access) for full details.

---

### `fill(values)` / `forceFill(values)`

```ts
fill(values: Partial<TAttrs>): this
forceFill(values: Partial<TAttrs>): this
```

Merges `values` into the model. Both methods route each key through its mutator (if defined in `static accessors`).

- `fill()` respects `static fillable` (whitelist) and `static guarded` (blacklist). Keys not permitted are silently skipped.
- `forceFill()` bypasses fillable/guarded restrictions — all keys are accepted.

```ts
class User extends BaseModel<UserAttrs> {
  static guarded = ['id', 'role']  // block mass-assignment of id and role
}

user.fill({ id: 'x', name: 'Alice', role: 'admin' })
// Only name is set — id and role are guarded

user.forceFill({ role: 'admin' })
// role is set — forceFill bypasses guarded
```

---

### `toRaw()`

```ts
toRaw(): Record<string, unknown>
```

Returns all attributes dehydrated back to DB-safe primitives. Useful for manual SQL queries, serialization, or debugging.

`toRaw()` never includes virtual or appended keys — it returns only real column data in DB-safe format.

```ts
const raw = post.toRaw()
// { id: "...", is_published: 1, metadata: '{"key":"val"}', created_at: "2026-01-15T...", ... }
```

See also: `toObject()` returns cast (application) values.

---

### `toObject()`

```ts
toObject(): TAttrs
```

Returns all attributes with cast values applied. This is the primary way to access model data for API responses or UI rendering.

Virtual attribute keys listed in `static appends` are included. Keys listed in `static hidden` are excluded. Hidden takes precedence over appends.

```ts
const obj = post.toObject()
// { id: "...", is_published: true, metadata: { key: "val" }, created_at: Date, ... }
// Includes appended virtuals, excludes hidden keys
```

### `toJSON()` vs `toObject()` vs `toRaw()`

Three serialization methods, three jobs. Pick by **what you're handing the value to**:

| Method | Returns | Relations? | Values | Reach for it when… |
|---|---|---|---|---|
| `toObject()` | `TAttrs` | ✗ (attributes only) | Cast/application values (`Date`, `boolean`, parsed JSON) | You want a plain attribute object — UI props, a single-record API payload, logging |
| `toJSON()` | `Record<string, unknown>` | ✓ (recursively serialized) | Same cast values, relations folded in | The model has **eager-loaded relations** you want nested in the response |
| `toRaw()` | `Record<string, unknown>` | ✗ | DB-safe primitives (`0/1`, ISO strings, stringified JSON) | You're feeding values back into raw SQL, a cache key, or another datastore |

For **API responses**:

```ts
// Single record, no relations → toObject()
return c.json(user.toObject())

// Record with eager-loaded relations → toJSON() (relations nested automatically)
const post = await Post.query().with(['author', 'comments']).first()
return c.json(post.toJSON())
// { id, title, author: { ... }, comments: [ ... ] }

// A Collection → map each model (use toObject for flat, toJSON to include relations)
const users = await User.query().get()
return c.json(users.map(u => u.toObject()))
```

`JSON.stringify(model)` calls `toObject()` under the hood (via the proxy), so returning a raw model from `c.json()` serializes its attributes — but **without relations**. Call `toJSON()` explicitly when you need nested relations in the payload.

> [!WARNING]
> **`toRaw()` is not for API responses**
>
> `toRaw()` emits `0`/`1` for booleans and `'{"k":"v"}'` strings for JSON columns — correct for SQL binding, wrong for clients expecting `true`/`false` and real objects. Use `toObject()` / `toJSON()` for anything a consumer reads.

## Typed Relations

The third optional generic on `BaseModel<TAttrs, TVirtuals, TRels>` types the
`.relations` property so eager-loaded results are statically known.

```ts
interface UserAttrs {
  id: string
  name: string
}

// Declare the relations shape ↓
type UserRels = {
  posts: Post[]
  profile: Profile | null
}

class User extends BaseModel<UserAttrs, {}, UserRels> {
  static table = 'users'
  static relations: Record<string, TRelationDefinition> = {
    posts: { type: 'hasMany', model: () => Post, foreignKey: 'user_id' },
    profile: { type: 'hasOne', model: () => Profile, foreignKey: 'user_id' },
  }
}

const user = await User.query().with(['posts', 'profile']).first(db)
user!.relations.posts     // Post[]  — typed, no `as any`
user!.relations.profile   // Profile | null
```

When a relation isn't loaded, `relations[name]` is `undefined`. Declare relation
values as `T | null` (hasOne / belongsTo / morphTo) or `T[]` (hasMany / many-to-many)
based on the relation's cardinality.

Default: `TRels = Record<string, unknown>`, so existing models without the third
generic continue to behave exactly as before.

### `TModelRelationsOf<TModel>`

Utility type that extracts the relations type from a model class:

```ts
import type { TModelRelationsOf } from '@orphnet/d1-eloquent'

type UserRelations = TModelRelationsOf<User>  // { posts: Post[]; profile: Profile | null }
```

## Instance Properties

### `attrs`

```ts
get attrs(): TAttrs
```

Returns the current attribute state of the model as a plain object. Access field values here. Values are cast according to `static casts`.

```ts
console.log(post.attrs.title)
console.log(post.attrs.created_at)  // Date instance (auto-cast from ISO string)
```

---

### `toJSON()`

```ts
toJSON(): Record<string, unknown>
```

Serializes the model to a plain object including loaded relations. Relations are recursively serialized via their own `toJSON()` / `toObject()` methods.

```ts
const user = await User.query().with(['posts']).first(db)
const json = user.toJSON()
// { id: "u1", name: "Alice", posts: [{ id: "p1", title: "Hello", ... }] }
```

Use `toObject()` for attributes only (no relations). Use `toJSON()` for API responses that include eagerly-loaded relations.

---

### `related(name)`

```ts
related(name: string): TRelationship<any>
```

Resolve a named relation from `static relations` metadata for lazy loading.

```ts
const posts = await user.related('posts').get(db)
const author = await post.related('author').first(db)
```

See [Relationships API](./relationships.md) for full details.

---

### `attach()` / `detach()` / `sync()` / `toggle()`

```ts
attach(name: string, ids: string | number | (string | number)[], opts?: { extras?: Record<string, unknown>; db?: D1Database }): Promise<number>
detach(name: string, ids?: string | number | (string | number)[], opts?: { db?: D1Database }): Promise<number>
sync(name: string, ids: (string | number)[], opts?: { extras?: Record<string, unknown>; db?: D1Database }): Promise<TPivotSyncResult>
toggle(name: string, ids: string | number | (string | number)[], opts?: { extras?: Record<string, unknown>; db?: D1Database }): Promise<TPivotSyncResult>
```

Direct-on-the-model shortcuts for the four pivot-management methods, letting you
skip the `.related(name)` hop on pivot-backed relationships (`belongsToMany`,
`morphToMany`, `morphedByMany`). Each is exactly equivalent to
`model.related(name).<method>(...)` and **throws** if the named relation is not
pivot-backed.

```ts
// These two lines are equivalent:
await post.attach('tags', [tagId1, tagId2])
await post.related('tags').attach([tagId1, tagId2])

await post.detach('tags', tagId1)          // remove one pivot row
await post.sync('tags', [tagId1, tagId3])  // make pivot rows exactly this set
await post.toggle('tags', tagId2)          // attach if absent, detach if present
```

See [Relationships API](./relationships.md) for `attach` / `detach` / `sync` / `toggle` semantics and the `TPivotSyncResult` shape.

---

### `load(...relations)`

```ts
load(db: D1Database, ...relations: string[]): Promise<this>
load(...relations: string[]): Promise<this>  // auto-resolve
```

Eager-loads relations onto an existing model instance. Mutates the instance's `relations` and returns `this` for chaining.

```ts
const user = await User.find(env.DB, userId)
await user.load(env.DB, 'posts', 'profile')
console.log(user.relations.posts) // Post[]
```

---

### `fresh(db?)`

```ts
fresh(db?: D1Database): Promise<TModel | null>
```

Re-fetches the model from the database, returning a **new** instance. Does not mutate the caller. Returns `null` if the record no longer exists. Compare with `refresh()` which updates the current instance in place.

```ts
const fresh = await user.fresh(env.DB)
// user is unchanged, fresh is a new instance with latest DB state
```

---

### `refresh(db?)`

```ts
refresh(db?: D1Database): Promise<this>
```

Re-fetches the row and reloads it **into the current instance** (mutates `attrs` and resyncs the dirty baseline), returning `this`. The mirror of `fresh()`, which returns a new instance instead. Throws if the model has no primary key or the row no longer exists.

```ts
await user.refresh(env.DB)   // user now reflects the latest DB state
```

---

### `trashed()`

```ts
trashed(): boolean
```

Returns `true` if the model has been soft-deleted (`deleted_at` is set). Always returns `false` when `softDeletes` is not enabled.

```ts
const post = await Post.find(env.DB, postId)
await post.delete(env.DB)
post.trashed() // true
```

---

### `is(other)` / `isNot(other)`

```ts
is(other: BaseModel | null | undefined): boolean
isNot(other: BaseModel | null | undefined): boolean
```

Compare two model instances by constructor and primary key. `is()` returns `true` only when both instances are the same model class with the same primary key value.

```ts
const a = await User.find(env.DB, userId)
const b = await User.find(env.DB, userId)
a.is(b)    // true  — same class, same PK
a.isNot(b) // false

const post = await Post.find(env.DB, postId)
a.is(post) // false — different class
a.is(null) // false
```

## Convenience Static Methods

### `createMany(rows, opts?)`

```ts
static createMany(db?, rows: Partial<TAttrs>[], opts?: {
  cache?: CacheAdapter
  skipRevisions?: boolean
}): Promise<TModel[]>
```

Bulk-create multiple rows in a single `db.batch()` round-trip while still running
per-row mutators, casts, timestamps, and `saving` / `creating` / `created` / `saved`
hooks. Rows whose `creating` or `saving` hook returns `false` are silently
filtered out — they appear in neither the database nor the returned array.

```ts
const users = await User.createMany([
  { name: 'Alice', email: 'a@x.com' },   // ids auto-generated per row (see keyStrategy)
  { name: 'Bob',   email: 'b@x.com' },
  { name: 'Carol', email: 'c@x.com' },
])
// users: TModel[] of proxy-wrapped instances
```

**Limitations vs. looping `create()`:**

- Revisions are **not** written. If the model has `revisions.enabled = true`,
  this method throws unless the caller passes `{ skipRevisions: true }`. Use
  `create()` in a loop when you need a revision row per insert.
- Cache invalidation runs once per row after the batch (best-effort, not
  rolled back if the batch fails).

For batch insert *without* hooks/casts (faster, less safe), use
`Model.query().insertMany(rows)` on the QueryBuilder.

---

### `firstOrCreate(search, values?)`

```ts
static firstOrCreate(db?, search, values?): Promise<TModel>
```

Find the first record matching `search` conditions, or create a new one with `search` + `values` merged.

```ts
const user = await User.firstOrCreate(db,
  { email: 'alice@example.com' },
  { name: 'Alice' },   // id auto-generated if a new row is created
)
```

---

### `firstOrNew(search, values?)`

```ts
static firstOrNew(db?, search, values?): Promise<TModel>
```

Like `firstOrCreate`, but does **not** persist the new instance. Returns an unpersisted model that you can modify and save later.

```ts
const user = await User.firstOrNew(db, { email: 'new@example.com' }, { name: 'New' })
user._persisted // false
await user.save(db) // now persisted
```

---

### `updateOrCreate(search, values)`

```ts
static updateOrCreate(db?, search, values): Promise<TModel>
```

Find or create, then update with `values`. Always persists.

```ts
const user = await User.updateOrCreate(db,
  { email: 'alice@example.com' },
  { name: 'Alice Updated', last_login: now },
)
```

## Scopes

Define reusable named query constraints via `static scopes`. Apply them with `.scoped()` on QueryBuilder.

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static scopes = {
    active: (q) => q.where('status', '=', 'active'),
    recent: (q) => q.orderBy('created_at', 'desc').limit(10),
  }
}

// Apply scopes
const posts = await Post.query().scoped('active', 'recent').get(db)

// Combine with manual conditions
const posts = await Post.query()
  .scoped('active')
  .where('user_id', '=', userId)
  .get(db)
```

### Global Scopes

`static globalScopes` are **auto-applied to every query** for the model - reads (`get`/`first`,
`count()` and the relation aggregates, plus eager-loaded and relation queries) **and** bulk writes
(`update`/`delete`, `updateReturning`/`deleteReturning`, the `updateJson*` variants, and
`increment`/`decrement`) - without calling `.scoped()`. Each is a function that adds constraints to a
QueryBuilder (a common use is multi-tenant row scoping). Skip them per-query with
`.withoutGlobalScope(name)` or `.withoutGlobalScopes()`.

```ts
class Document extends BaseModel<DocAttrs> {
  static table = 'documents'
  static globalScopes = {
    current_tenant: (q) => q.whereEq('tenant_id', currentTenantId()),
  }
}

await Document.query().get(db)                          // WHERE tenant_id = ?  (auto)
await Document.query().delete(db)                       // DELETE ... WHERE tenant_id = ?  (tenant-isolated)
await Document.query().withoutGlobalScope('current_tenant').get(db)  // no tenant filter
await Document.query().withoutGlobalScopes().delete(db)             // skip all - deletes every tenant's rows
```

Each global scope is applied as a self-contained group, so it stays correctly `AND`-scoped even
when your query has a top-level `OR` (no cross-tenant leaks) - on both the read and write paths.

> [!TIP]
> **Bulk writes are tenant-isolated**
>
> `update()`/`delete()` (and the JSON-update + increment/decrement variants) inject active global
> scopes into their `WHERE`, so `Document.query().delete(db)` under a tenant scope removes only the
> current tenant's rows - never a bare `DELETE FROM documents`. Use `.withoutGlobalScopes()` to
> deliberately reach across scopes. (Soft-delete scope is *not* applied to writes - a write may target
> a trashed row on purpose; add `.withTrashed()`-style filters explicitly if you need them.)

> [!WARNING]
> **Where-clauses only**
>
> A global scope's `where`/`orWhere` predicates are honoured; `orderBy`/`limit`/`groupBy`/`join`/`having`
> added inside a scope are currently **dropped**. Use global scopes for row filtering, not ordering or
> shaping.

## Lifecycle Hooks

Register callbacks that fire during model persistence events via `static hooks`.

### Hook Events

| Event | When | Can cancel? |
|---|---|---|
| `creating` | Before first insert | Yes (`return false`) |
| `created` | After first insert | No |
| `updating` | Before update | Yes |
| `updated` | After update | No |
| `saving` | Before any save (insert or update) | Yes |
| `saved` | After any save | No |
| `deleting` | Before delete | Yes |
| `deleted` | After delete | No |

### Defining Hooks

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static hooks = {
    creating: (model) => {
      // Auto-generate slug
      model.set('slug', slugify(model.get('title')))
    },
    deleting: (model) => {
      // Prevent deletion of published posts
      if (model.get('status') === 'published') return false
    },
    deleted: (model) => {
      console.log(`Deleted post ${model.getKey()}`)
    },
  }
}
```

### Multiple Handlers

Pass an array of handlers per event. They run in order; the first `false` return cancels.

```ts
static hooks = {
  saving: [
    (model) => { /* validate */ },
    (model) => { /* audit log */ },
  ],
}
```

## Mass Assignment Protection

Control which attributes can be set via `fill()`.

### `static fillable`

Whitelist — only these keys are accepted by `fill()`.

```ts
class User extends BaseModel<UserAttrs> {
  static fillable = ['name', 'email']
}

user.fill({ id: 'x', name: 'Alice', role: 'admin' })
// Only name and email are set
```

### `static guarded`

Blacklist — these keys are blocked by `fill()`.

```ts
class User extends BaseModel<UserAttrs> {
  static guarded = ['id', 'role']
}
```

### `forceFill()`

Bypasses both `fillable` and `guarded` restrictions. Use for internal/trusted operations.

```ts
user.forceFill({ role: 'admin' }) // always works
```

## Exceptions

All ORM exceptions extend `EloquentException`, which extends `Error`.

```ts
import {
  EloquentException,
  ModelNotFoundException,
  MultipleRecordsFoundException,
} from '@orphnet/d1-eloquent'
```

| Exception | Thrown by | Properties |
|---|---|---|
| `EloquentException` | Base class for all ORM errors | `message` |
| `ModelNotFoundException` | `findOrFail()`, `firstOrFail()`, `sole()` (0 results) | `model: string`, `id?: string` |
| `MultipleRecordsFoundException` | `sole()` (>1 results) | `model: string`, `count: number` |

```ts
try {
  await User.findOrFail(env.DB, 'nonexistent')
} catch (e) {
  if (e instanceof ModelNotFoundException) {
    console.log(e.model) // "users"
    console.log(e.id)    // "nonexistent"
  }
}

try {
  await User.query().whereEq('role', 'admin').sole(env.DB)
} catch (e) {
  if (e instanceof MultipleRecordsFoundException) {
    console.log(e.count) // number of matching records
  }
}
```
