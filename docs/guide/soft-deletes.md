# Soft Deletes

Soft deletes let you "delete" a record without removing it from the database. Instead of issuing a `DELETE` statement, d1-eloquent sets a `deleted_at` timestamp on the row. This preserves the data for audit trails, undo functionality, and foreign key integrity.

**Without d1-eloquent**

```ts
// Every query must remember to exclude deleted rows
const { results } = await env.DB.prepare(
  'SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY created_at DESC'
).all()
// Forget WHERE deleted_at IS NULL in one query? Deleted data leaks to users.

// "Delete" = manual timestamp update
await env.DB.prepare(
  'UPDATE posts SET deleted_at = ? WHERE id = ?'
).bind(new Date().toISOString(), postId).run()

// "Restore" = another manual update
await env.DB.prepare(
  'UPDATE posts SET deleted_at = NULL WHERE id = ?'
).bind(postId).run()

// "Include deleted" = separate query without the WHERE clause
// "Only deleted" = WHERE deleted_at IS NOT NULL
// Every query variant is a new SQL string to maintain.
```

**With d1-eloquent**

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static softDeletes = true  // one line — that's it
}

// Queries automatically exclude deleted rows
const posts = await Post.query().get()

// Delete, restore, and scopes are built in
await post.delete()                           // sets deleted_at
await post.restore()                          // clears deleted_at
const all = await Post.query().withTrashed().get()   // include deleted
const deleted = await Post.query().onlyTrashed().get() // only deleted
```

## Enable Soft Deletes on a Model

Add `static softDeletes = true` to your model class:

```ts
import { BaseModel } from '@orphnet/d1-eloquent'

interface PostAttrs {
  id: string
  title: string
  body: string
  deleted_at?: string | null
  created_at?: string
  updated_at?: string
}

export class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static primaryKey = 'id'
  static softDeletes = true
}
```

Include `deleted_at` in your attributes interface as `string | null` — it is `null` on live records and set on deleted ones.

> [!NOTE]
> `softDeletes` auto-casts `deleted_at` to a `Date` (see [Attribute Casting](./casting.md)). A record **loaded from the database** therefore exposes `deleted_at` as a `Date` (or `null`), while the value `delete()` writes in-memory is the raw ISO string. The truthy / `!== null` checks used throughout this page work either way — only reach for `Date` methods after a fresh load.

## Migration Requirement

Your database table must have a `deleted_at TEXT` column. Add it to your migration using the schema builder:

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260101000000_create_posts_table',

  up: (schema: Schema) => {
    schema.createTable('posts', (t) => {
      t.id()
      t.text('title')
      t.text('body')
      t.softDeletes()
      t.timestamps()
    })
  },

  down: (schema: Schema) => {
    schema.dropTable('posts')
  },
}

export default migration
```

> [!TIP]
> **Existing tables**
> If you are adding soft deletes to an existing table, use `schema.table()` with `t.addText()` in a new migration instead of recreating the table:
>
> ```ts
> import type { TMigration } from '@orphnet/d1-eloquent/cli'
> import { Schema } from '@orphnet/d1-eloquent/cli'
>
> const migration: TMigration = {
>   name: '20260101000000_add_deleted_at_to_posts',
>
>   up: (schema: Schema) => {
>     schema.table('posts', (t) => {
>       t.addText('deleted_at', { nullable: true })
>     })
>   },
>
>   down: (schema: Schema) => {
>     // SQLite does not support DROP COLUMN directly
>     schema.table('posts', (t) => {
>       t.dropSoftDeletes()
>     })
>   },
> }
>
> export default migration
> ```

## Default Query Behavior

Once `softDeletes = true`, every query automatically excludes soft-deleted rows. You do not need to add `WHERE deleted_at IS NULL` yourself:

```ts
// Returns only live (non-deleted) posts
const posts = await Post.query().get()

// Returns single live post — returns null if deleted
const post = await Post.find(postId)
```

> [!TIP]
> **Optional db argument**
> All examples on this page omit the `db` argument — the database is resolved automatically via [`configure(env)`](./configuration.md). You can always pass `db` explicitly if needed: `Post.query().get(env.DB)`.

## Soft-Deleting a Record

Call `delete()` as normal — d1-eloquent detects the `softDeletes` flag and sets `deleted_at` instead of issuing a `DELETE`:

```ts
const post = await Post.find(postId)

if (post) {
  await post.delete()
  console.log(post.attrs.deleted_at)  // "2026-03-01T14:23:00.000Z"
}
```

## Restoring a Record

Call `restore()` on a soft-deleted instance to clear `deleted_at`:

```ts
// You need withTrashed() to find a deleted record first
const post = await Post.query()
  .withTrashed()
  .whereEq('id', postId)
  .first()

if (post && post.attrs.deleted_at) {
  await post.restore()
  console.log(post.attrs.deleted_at)  // null
}
```

After `restore()`, the record is visible again in normal queries.

## Query Scopes

### Include Deleted Rows — `withTrashed()`

```ts
// Returns all posts — live and deleted
const allPosts = await Post.query()
  .withTrashed()
  .orderBy('created_at', 'desc')
  .get()
```

### Only Deleted Rows — `onlyTrashed()`

```ts
// Returns only soft-deleted posts
const deletedPosts = await Post.query()
  .onlyTrashed()
  .get()

// Count how many posts have been deleted
const count = await Post.query().onlyTrashed().count()
```

## Checking Deleted Status in Code

```ts
const post = await Post.query().withTrashed().whereEq('id', postId).first()

if (post) {
  if (post.attrs.deleted_at !== null) {
    console.log(`Deleted at: ${post.attrs.deleted_at}`)
  } else {
    console.log('Post is live')
  }
}
```

## Permanent Delete

There is no force-delete method on the model — soft-delete and hard-delete are distinct operations. To permanently remove a soft-deleted row, execute the SQL directly via D1:

```ts
await env.DB.prepare('DELETE FROM posts WHERE id = ?')
  .bind(postId)
  .run()
```

Use this sparingly — permanent deletes cannot be undone and may break revision history if [revision tracking](./revisions.md) is enabled.

> [!WARNING]
> **Pivot tables must NOT have a deleted_at column**
> If you use soft deletes on a parent model that has a `belongsToMany` relationship, do **not** add `deleted_at` to the pivot table.
>
> The soft-delete scope appends `deleted_at IS NULL` without table qualification. In JOIN queries, this creates an ambiguous column reference (`deleted_at` could belong to either table) and D1 will return an error.
>
> Keep pivot tables (e.g. `post_tags`, `user_roles`) free of `deleted_at` columns. Soft delete only on the parent model itself.
