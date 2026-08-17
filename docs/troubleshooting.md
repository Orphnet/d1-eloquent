# Troubleshooting

Runtime and type traps that `tsc` does **not** catch, with verified fixes. Each
entry names the exact source location that produces the behaviour so you can
confirm it against the checkout.

---

## 1. `fillable` silently strips `id` → `Missing primary key` 500 at runtime

**The single most common runtime failure.** It type-checks, then throws on the
first `create()`.

### Symptom

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static fillable = ['title', 'body', 'user_id']   // ← no 'id'
}

await Post.create(db, {
  id: crypto.randomUUID(),                          // you pass id explicitly
  title: 'Hello',
  body: '…',
  user_id: userId,
})
// 💥 throws: Missing primary key 'id'
//    → in a Worker this surfaces as an HTTP 500 on the create endpoint
```

> [!TIP]
> **Auto-resolved by default since `v0.1.0-beta.2`.**
> With the default `keyStrategy = 'uuid'`, this **no longer throws** — the key is
> auto-generated when it's absent. Note the subtlety: because `'id'` is not in
> `fillable`, the UUID you passed is still dropped by `fill()`, so the row is saved
> under a **freshly-generated** key, not the one you passed (the secure default —
> `fillable` protects `id` from client input while the server assigns it). The
> throw below only occurs if you opt out with `static keyStrategy = false`, or if
> you genuinely need to honour a caller-supplied id under a `fillable` whitelist.

`tsc` is **green** — `id` is a valid key of `PostAttrs`, so the call compiles.
When auto-id is disabled the failure only appears when the code actually runs.

### Why it happens (verified)

`Model.create()` routes every attribute through `fill()` before insert
(`d1Eloquent/baseModel.ts:606` — `model.fill(_attrs)`). `fill()` enforces the
mass-assignment whitelist:

```ts
// d1Eloquent/managers/attributeManager.ts:99-108
fill(model, values) {
    const fillable = model.constructor.fillable;
    const guarded = model.constructor.guarded;
    for (const [k, v] of Object.entries(values)) {
        if (fillable && !fillable.includes(k)) continue;   // ← line 104: 'id' dropped here
        if (guarded && guarded.includes(k)) continue;
        AttributeManager.set(model, k, v);
    }
}
```

Because `'id'` is not in `fillable`, line 104 `continue`s past it — the UUID you
passed never reaches the model. `save()` then can't find a primary key and the
assertion fires:

```ts
// d1Eloquent/managers/persistenceManager.ts:110 (creating branch of save())
assert(id, `Missing primary key '${getKeyName(model)}'`);
```

The two other `Missing primary key` asserts in the codebase are on different
code paths that `create()` never reaches: `persistenceManager.ts:68` is inside
`performUpdate()` (only an UPDATE of an already-persisted model) and
`baseModel.ts:1017` is inside `refresh()`. The create path is `save()` →
`creating = !model._persisted` (true for a fresh `new this()`) → the assert at
line 110 → `performInsert()` (which itself has no assert).

### The three fixes

**(a) Include `'id'` in `fillable`** — explicit and local:

```ts
static fillable = ['id', 'title', 'body', 'user_id']
```

**(b) Use `guarded` instead of `fillable`** — blacklist the few protected
columns and let everything else (including `id`) through:

```ts
static guarded = ['created_at', 'updated_at']   // id is NOT guarded → passes
```

With no `fillable`, the `fillable && …` check on line 104 is skipped entirely, so
`id` is set normally.

**(c) Let the ORM mint the PK — now the built-in default.** As of `v0.1.0-beta.2`
this is exactly what [`keyStrategy`](./api/base-model.md#keystrategy-auto-primary-keys)
does out of the box, so you no longer need a hand-rolled `creating` hook — just
don't pass `id`:

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static fillable = ['title', 'body', 'user_id']   // id deliberately omitted
  // static keyStrategy = 'uuid'  // the default — the key is generated for you
}

await Post.create(db, { title: 'Hello', body: '…', user_id: userId })  // id auto-generated
```

> `tsc` does **not** catch the disabled-auto-id case. It is a mass-assignment
> runtime rule, not a type. If you set `static keyStrategy = false` on a model
> that uses a `fillable` whitelist, add `'id'` to `fillable` (fix a) or switch to
> `guarded` (fix b) so a caller-supplied UUID reaches the model.

---

## 2. `static casts` type widening → TS2417 / TS2322

`static casts` is typed as `Record<string, CastDefinition>` on `BaseModel`
(`d1Eloquent/baseModel.ts:150`). `CastDefinition` is a **literal union** —
`'boolean' | 'integer' | 'json' | …` (the `BuiltInCast` union) **or** an
`AttributeCast` object (`d1Eloquent/castManager.ts:27`).

### Symptom

When the casts object is extracted to a separate `const`, TypeScript widens each
string literal to `string`, which no longer satisfies the literal union:

```ts
const casts = { is_published: 'boolean' }   // inferred as { is_published: string }

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static casts = casts                       // ← error
}
```

```
error TS2417: Class static side 'typeof Post' incorrectly extends base class
static side 'typeof BaseModel'.
  Types of property 'casts' are incompatible.
    Type '{ is_published: string; }' is not assignable to type
    'Record<string, CastDefinition>'.
      Property 'is_published' is incompatible with index signature.
        Type 'string' is not assignable to type 'CastDefinition'.
```

(The `TS2322` variant appears when you assign a pre-widened
`Record<string, string>` straight into a `Record<string, CastDefinition>` slot —
same root cause, same fixes.)

> An **inline** literal — `static casts = { is_published: 'boolean' }` directly
> in the class body — narrows correctly and compiles clean. The error only bites
> when the object is hoisted to a `const` (or otherwise widened) first.

### The fixes

**(a) Annotate the const with the exported type** (verified export name:
`CastDefinition` from `@orphnet/d1-eloquent`):

```ts
import type { CastDefinition } from '@orphnet/d1-eloquent'

const casts: Record<string, CastDefinition> = { is_published: 'boolean' }

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static casts = casts   // ✓ compiles
}
```

**(b) `as const`** — pins the literals so they never widen to `string`:

```ts
const casts = { is_published: 'boolean', created_at: 'datetime' } as const

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static casts = casts   // ✓ compiles
}
```

**(c) `satisfies`** for an inline literal you also want to validate:

```ts
static casts = { is_published: 'boolean' } satisfies Record<string, CastDefinition>
```

All three compile clean against the current source. `AttributeCast` and
`BuiltInCast` are exported from the package root alongside `CastDefinition` if
you need to type a custom cast.

---

## 3. Circular-ESM relations → use lazy `() => Model` thunks

When two models reference each other (`User` ↔ `Post`), a **direct** model
reference in `static relations` triggers a circular-import failure at module
evaluation time.

### Symptom

```ts
// user.ts imports post.ts, post.ts imports user.ts
class User extends BaseModel<UserAttrs> {
  static relations = {
    posts: { type: 'hasMany', model: Post, foreignKey: 'user_id' },  // ← Post may be undefined here
  }
}
```

Depending on which module the bundler evaluates first, the other model is still
`undefined` when the class body runs — you get `Cannot read properties of
undefined`, a relation that resolves to `undefined`, or a silently broken eager
load.

### Why a thunk fixes it

`static relations` definitions reference the related model through a **lazy
`() => Ctor` function**, not the constructor directly. The relation type fields
are declared exactly this way in source:

```ts
// d1Eloquent/relationTypes.ts:12-20
export type TBelongsToDefinition = {
    type: "belongsTo";
    model: () => TModelCtor<any>;   // ← lazy reference
    foreignKey: string;
    ownerKey?: string;
};
```

The docblock on that file states the reason directly: *"Model references use
lazy `() => Ctor` functions to avoid circular import issues that arise when two
models reference each other (e.g., User ↔ Post)."*

The thunk defers reading the related constructor until the relation is actually
**resolved** (at query time), by which point both modules have finished
evaluating. The class body only stores a function — it never touches `Post` at
definition time.

### Fix

Wrap every `model:` in `() =>`:

```ts
import type { TRelationDefinition } from '@orphnet/d1-eloquent'

class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static relations: Record<string, TRelationDefinition> = {
    posts:   { type: 'hasMany',   model: () => Post,    foreignKey: 'user_id' },
    profile: { type: 'hasOne',    model: () => Profile, foreignKey: 'user_id' },
  }
}

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static relations: Record<string, TRelationDefinition> = {
    author: { type: 'belongsTo', model: () => User, foreignKey: 'user_id' },
  }
}
```

This is the supported pattern for **all** relation kinds (`belongsTo`,
`hasMany`, `hasOne`, `belongsToMany`, and the morph variants) — always pass
`model: () => RelatedModel`, never `model: RelatedModel`.

---

## See also

- [BaseModel API](./api/base-model.md) — full static-config table, `fillable` /
  `guarded` semantics, lifecycle hooks.
- [Attribute Casting](./guide/casting.md) — built-in cast types and custom casts.
- [Relationships API](./api/relationships.md) — relation definitions and eager
  loading.
- [Configuration](./guide/configuration.md) — `configure(env)` and connection
  resolution.
