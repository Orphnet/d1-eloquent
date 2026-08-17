# Relationships API Reference

## Declarative Relations (Recommended)

Define relationships declaratively on your model using `static relations`. This enables:
- **`has()` / `whereHas()`** — filter by related model existence
- **`model.related(name)`** — lazy-load relations from instances
- **Auto-derived eager loaders** — `with()` works without manual `eagerLoaders`

```ts
import { BaseModel } from '@orphnet/d1-eloquent'
import type { TRelationDefinition } from '@orphnet/d1-eloquent'

class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static primaryKey = 'id'

  static relations: Record<string, TRelationDefinition> = {
    posts:   { type: 'hasMany',   model: () => Post,    foreignKey: 'user_id' },
    profile: { type: 'hasOne',    model: () => Profile,  foreignKey: 'user_id' },
    roles:   {
      type: 'belongsToMany',
      model: () => Role,
      pivot: 'user_roles',
      foreignPivotKey: 'user_id',
      relatedPivotKey: 'role_id',
    },
  }
}

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'

  static relations: Record<string, TRelationDefinition> = {
    author:   { type: 'belongsTo', model: () => User,    foreignKey: 'user_id' },
    comments: { type: 'hasMany',   model: () => Comment,  foreignKey: 'post_id' },
  }
}
```

> [!TIP]
> **Lazy model references**
>
> Use `() => Model` instead of `Model` directly to avoid circular import issues when two models reference each other.

## Relation Types

### belongsTo

The foreign key is on **this** model, pointing to the related model's key.

```ts
{ type: 'belongsTo', model: () => User, foreignKey: 'user_id' }
// ownerKey defaults to User.primaryKey
```

| Option | Description | Default |
|---|---|---|
| `foreignKey` | Column on THIS model referencing the related model | required |
| `ownerKey` | Column on the RELATED model | `related.primaryKey` |

### hasMany

The foreign key is on the **related** model, pointing back to this model.

```ts
{ type: 'hasMany', model: () => Comment, foreignKey: 'post_id' }
```

| Option | Description | Default |
|---|---|---|
| `foreignKey` | Column on the RELATED model referencing this model | required |
| `localKey` | Column on THIS model | `this.primaryKey` |

### hasOne

Same as `hasMany` semantically — the distinction is conventional (returns single model vs array).

```ts
{ type: 'hasOne', model: () => Profile, foreignKey: 'user_id' }
```

### belongsToMany

Many-to-many through a pivot table.

```ts
{
  type: 'belongsToMany',
  model: () => Role,
  pivot: 'user_roles',
  foreignPivotKey: 'user_id',    // pivot column → this model
  relatedPivotKey: 'role_id',    // pivot column → related model
}
```

| Option | Description | Default |
|---|---|---|
| `pivot` | Name of the pivot/junction table | required |
| `foreignPivotKey` | Pivot column referencing this model | required |
| `relatedPivotKey` | Pivot column referencing the related model | required |
| `localKey` | Column on THIS model | `this.primaryKey` |
| `relatedKey` | Column on the RELATED model | `related.primaryKey` |

> [!WARNING]
> **Pivot tables must not have a `deleted_at` column**
>
> When the related model has `softDeletes = true`, the soft-delete scope appends an unqualified `deleted_at IS NULL` condition, which becomes ambiguous if the pivot table also has that column.

### hasManyThrough / hasOneThrough

Reach a distant relation through an intermediate model's FK chain - e.g. a `Country`
has many `Post`s **through** `User`s (`users.country_id` → `posts.user_id`).

```ts
{
  type: 'hasManyThrough',   // or 'hasOneThrough' (returns the first match)
  model: () => Post,        // final / related model
  through: () => User,      // intermediate model
  firstKey: 'country_id',   // FK on `through` (users) → this model (country)
  secondKey: 'user_id',     // FK on `model` (posts) → `through` (user)
  // localKey?: 'id'        // key on THIS model      (default primaryKey)
  // secondLocalKey?: 'id'  // key on `through` model (default through.primaryKey)
}
```

| Option | Description | Default |
|---|---|---|
| `through` | Lazy ref to the intermediate model | required |
| `firstKey` | FK on the through table referencing this model | required |
| `secondKey` | FK on the related table referencing the through model | required |
| `localKey` | Key on THIS model | `this.primaryKey` |
| `secondLocalKey` | Key on the THROUGH model | `through.primaryKey` |

Compiles to a single joined query (`related JOIN through`) - no N+1. Works with eager
loading (`with`), lazy `related()`, `whereHas` / `has`, and the relation aggregates
(`withCount` etc.).

> [!NOTE]
> **Soft deletes on the through model**
>
> If the through model has `softDeletes = true`, children of soft-deleted through rows are excluded: a `through.deleted_at IS NULL` condition is added alongside the join. The related model's own soft-delete scope applies as usual.

## Polymorphic Relations

Polymorphic relations let one relation point at (or be pointed at by) more than one model type via a `<morphName>_type` discriminator + `<morphName>_id` pair. Five morph types are supported and work with `with()`, `related()`, and (for the pivot-backed ones) `attach`/`detach`/`sync`/`toggle`.

| Type | Side | Required keys |
|---|---|---|
| `morphTo` | inverse (e.g. a `Comment` belonging to a `Post` **or** `Video`) | `morphName`, `morphMap` |
| `morphMany` | owning one-to-many | `model`, `morphName`, `typeValue` |
| `morphOne` | owning one-to-one | `model`, `morphName`, `typeValue` |
| `morphToMany` | many-to-many, parent side | `model`, `pivot`, `morphName`, `typeValue`, `relatedPivotKey` |
| `morphedByMany` | many-to-many, related side (inverse of `morphToMany`) | `model`, `pivot`, `morphName`, `typeValue`, `relatedPivotKey` |

`morphTo` maps discriminator values to model constructors via `morphMap`; the others carry a fixed `typeValue` written into the type column. All support `typeColumn` / `idColumn` overrides for legacy schemas (defaults: `<morphName>_type` / `<morphName>_id`).

```ts
// Owning side — a Post has many Comments
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static relations: Record<string, TRelationDefinition> = {
    comments: { type: 'morphMany', model: () => Comment, morphName: 'commentable', typeValue: 'post' },
    // → WHERE commentable_type = 'post' AND commentable_id = <post.id>
  }
}

// Inverse side — a Comment belongs to a Post or a Video
class Comment extends BaseModel<CommentAttrs> {
  static table = 'comments'
  static relations: Record<string, TRelationDefinition> = {
    commentable: {
      type: 'morphTo',
      morphName: 'commentable',
      morphMap: { post: () => Post, video: () => Video },
    },
  }
}

// Polymorphic many-to-many — Posts (and Videos) tagged through one pivot
class Post2 extends BaseModel<PostAttrs> {
  static table = 'posts'
  static relations: Record<string, TRelationDefinition> = {
    tags: {
      type: 'morphToMany', model: () => Tag, pivot: 'taggables',
      morphName: 'taggable', typeValue: 'post', relatedPivotKey: 'tag_id',
    },
  }
}
```

Pivot management for `morphToMany` / `morphedByMany` automatically scopes every operation to `<morphName>_type = typeValue` — see [Pivot Management](#pivot-management-belongstomany--morphtomany--morphedbymany) below.

## Querying by Relation Existence

### has(relation)

Filter parent models that have at least one related model.

```ts
// Users who have at least one post
const users = await User.query().has('posts').get(db)
// WHERE EXISTS (SELECT 1 FROM posts WHERE posts.user_id = users.id)
```

### doesntHave(relation)

Filter parent models with no related models.

```ts
// Users with no posts
const users = await User.query().doesntHave('posts').get(db)
// WHERE NOT EXISTS (SELECT 1 FROM posts WHERE posts.user_id = users.id)
```

### whereHas(relation, callback?)

Filter by related models matching conditions.

```ts
// Posts with at least one approved comment
const posts = await Post.query()
  .whereHas('comments', q => q.where('approved', '=', 1))
  .get(db)

// Users with admin role (belongsToMany)
const admins = await User.query()
  .whereHas('roles', q => q.where('name', '=', 'admin'))
  .get(db)
```

### whereDoesntHave(relation, callback?)

Filter by absence of related models matching conditions.

```ts
// Posts without any approved comments
const posts = await Post.query()
  .whereDoesntHave('comments', q => q.where('approved', '=', 1))
  .get(db)
```

### OR variants

All four methods have `or` variants: `orHas()`, `orDoesntHave()`, `orWhereHas()`, `orWhereDoesntHave()`.

```ts
// Published posts OR posts with comments
const posts = await Post.query()
  .where('published', '=', 1)
  .orHas('comments')
  .get(db)
```

## Lazy Loading (Instance)

Use `model.related(name)` to query a relation from a loaded model instance.

```ts
const user = await User.find(db, 'u1')

// hasMany
const posts = await user.related('posts').get(db)

// belongsTo
const author = await post.related('author').first(db)

// hasOne
const profile = await user.related('profile').first(db)

// belongsToMany
const roles = await user.related('roles').get(db)
```

The returned object has `query`, `get(db)`, and `first(db)` — you can further chain the query:

```ts
const recentPosts = await user.related('posts')
  .query.orderBy('created_at', 'desc').limit(5).get(db)
```

## Pivot Management (belongsToMany / morphToMany / morphedByMany)

Relationships backed by a pivot table also expose pivot-management helpers
on the result of `model.related(name)`: `attach`, `detach`, `sync`, `toggle`.
Non-pivot relations don't have them (typed as `Partial<TPivotMethods>`).

```ts
const user = await User.findOrFail(db, 'u1')

// Attach a single related id, or an array (single db.batch round-trip)
await user.related('roles').attach!('r1')
await user.related('roles').attach!(['r1', 'r2', 'r3'])

// Pivot extras — extra columns written on every inserted row
await user.related('roles').attach!('r1', { extras: { note: 'primary admin' } })

// Detach by id / array / nothing (= detach all)
await user.related('roles').detach!('r1')
await user.related('roles').detach!(['r1', 'r2'])
await user.related('roles').detach!()                  // remove every pivot row

// Sync — make the pivot exactly match the given target set
const result = await user.related('roles').sync!(['r2', 'r3'])
// → { attached: ['r3'], detached: ['r1'] }

// Toggle — flip membership for each id
const result = await user.related('tags').toggle!(['t1', 't2'])
// → { attached: ['t2'], detached: ['t1'] }
```

### Method reference

| Method | Args | Returns |
|---|---|---|
| `attach(ids, opts?)` | id or `id[]`; `opts.extras` for additional pivot columns | `number` — rows inserted (idempotent via `INSERT OR IGNORE`) |
| `detach(ids?, opts?)` | id, `id[]`, or omitted for detach-all | `number` — rows removed |
| `sync(ids, opts?)` | `id[]` exactly | `TPivotSyncResult` = `{ attached: string[], detached: string[] }` |
| `toggle(ids, opts?)` | id or `id[]` | `TPivotSyncResult` |

All four accept `opts.db?: D1Database` to override the resolved connection.

### Morph variants

For `morphToMany` and `morphedByMany`, the pivot helpers automatically
include the `<morphName>_type = typeValue` constraint on every operation,
so they never touch pivot rows belonging to a different morph parent type.

```ts
// Post.tags is a morphToMany with typeValue: 'post'
const post = await Post.findOrFail(db, 'p1')

await post.related('tags').attach!(['t1', 't2'])
// → INSERT (tag_id, taggable_type, taggable_id) VALUES (?, 'post', 'p1')

await post.related('tags').detach!()
// → DELETE FROM taggables WHERE taggable_id = 'p1' AND taggable_type = 'post'
//   (Video pivot rows are untouched)
```

### Notes

- `attach` uses `INSERT OR IGNORE`, so re-attaching an existing pair is a no-op.
- `sync` runs a SELECT first to compute the diff, then a batched attach + detach.
- For atomic multi-relation pivot changes, prefer composing your own
  `db.batch()` using these primitives or raw `query().toInsertPrepared()`.

## Eager Loading

### Auto-derived from static relations

When `static relations` is defined, `with()` automatically derives eager loaders — no manual `eagerLoaders` needed.

```ts
const users = await User.query()
  .with(['posts', 'profile'])
  .get(db)

users[0].relations.posts    // Post[]
users[0].relations.profile  // Profile | null
```

### Manual eagerLoaders (legacy)

You can still define `static eagerLoaders` for custom eager-loading logic. Explicit `eagerLoaders` take precedence over auto-derived ones.

```ts
class User extends BaseModel<UserAttrs> {
  static table = 'users'

  static eagerLoaders = {
    posts: async (db: D1Database, users: User[]) => {
      const ids = users.map(u => u.get('id'))
      const posts = await Post.query().whereIn('user_id', ids).get(db)
      // ... custom distribution logic
    },
  }
}
```

## Low-Level Helpers

### whereExists / whereNotExists

Low-level EXISTS clause for custom subqueries.

```ts
Post.query().whereExists(
  'SELECT 1 FROM comments WHERE comments.post_id = posts.id',
  [] // bindings
)
```

### Legacy relationship functions

The original `belongsTo()`, `hasMany()`, `hasOne()`, `belongsToMany()` functions are still exported and work as before. They require explicit `localValue` and return `{ query, get, first }`.

```ts
import { hasMany } from '@orphnet/d1-eloquent'

const rel = hasMany(Comment, { foreignKey: 'post_id', localValue: postId })
const comments = await rel.get(db)
```
