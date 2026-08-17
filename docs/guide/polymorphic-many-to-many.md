# Polymorphic Many-to-Many

Extends the existing polymorphic relation set (`morphTo` / `morphMany` /
`morphOne`) with `morphToMany` and `morphedByMany` — for the classic case
where one model attaches to *several different* parent types via a shared
pivot table.

## When to use it

The canonical example: **Tags** that can be attached to either **Posts** or
**Videos**, all through a single `taggables` pivot table.

| Table | Columns |
|---|---|
| `posts` | `id`, `title`, … |
| `videos` | `id`, `name`, … |
| `tags` | `id`, `label` |
| `taggables` (pivot) | `tag_id`, `taggable_type`, `taggable_id` |

`taggable_type` discriminates between `'post'` / `'video'` / …; `taggable_id`
points back at the corresponding parent row.

## Schema

```ts
schema.createTable('posts', (t) => {
  t.id()
  t.text('title').notNull()
})
schema.createTable('videos', (t) => {
  t.id()
  t.text('name').notNull()
})
schema.createTable('tags', (t) => {
  t.id()
  t.text('label').notNull()
})
schema.createTable('taggables', (t) => {
  t.text('tag_id').notNull()
  t.text('taggable_type').notNull()
  t.text('taggable_id').notNull()
  t.primary('tag_id, taggable_type, taggable_id')
  // Critical: lookup index for the inverse-side queries
  t.index('taggable_type, taggable_id')
})
```

> Pivot tables for polymorphic many-to-many should not have a `deleted_at`
> column — same caveat as plain `belongsToMany`.

## Owning side — `morphToMany`

The model that "has many tags":

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static relations: Record<string, TRelationDefinition> = {
    tags: {
      type: 'morphToMany',
      model: () => Tag,
      pivot: 'taggables',
      morphName: 'taggable',       // → taggable_type + taggable_id on the pivot
      typeValue: 'post',           // stored in taggable_type
      relatedPivotKey: 'tag_id',   // pivot column that points at Tag
    },
  }
}

class Video extends BaseModel<VideoAttrs> {
  static table = 'videos'
  static relations: Record<string, TRelationDefinition> = {
    tags: {
      type: 'morphToMany',
      model: () => Tag,
      pivot: 'taggables',
      morphName: 'taggable',
      typeValue: 'video',          // only thing that differs from Post.tags
      relatedPivotKey: 'tag_id',
    },
  }
}
```

| Option | Description | Default |
|---|---|---|
| `model` | Lazy factory for the related (Tag-side) model | required |
| `pivot` | Pivot table name | required |
| `morphName` | Logical name; derives `<name>_type` + `<name>_id` on the pivot | required |
| `typeValue` | Value written into the pivot's type column for this parent | required |
| `relatedPivotKey` | Pivot column pointing at the related model | required |
| `typeColumn` | Override the pivot's type column | `<morphName>_type` |
| `idColumn` | Override the pivot's id column | `<morphName>_id` |
| `localKey` | Column on THIS model | `this.primaryKey` |
| `relatedKey` | Column on the related (Tag) model | `Tag.primaryKey` |

## Inverse side — `morphedByMany`

The Tag model wants to list "all Posts I'm attached to" and "all Videos I'm
attached to" — **one relation per parent type**:

```ts
class Tag extends BaseModel<TagAttrs> {
  static table = 'tags'
  static relations: Record<string, TRelationDefinition> = {
    posts: {
      type: 'morphedByMany',
      model: () => Post,
      pivot: 'taggables',
      morphName: 'taggable',
      typeValue: 'post',
      relatedPivotKey: 'tag_id',
    },
    videos: {
      type: 'morphedByMany',
      model: () => Video,
      pivot: 'taggables',
      morphName: 'taggable',
      typeValue: 'video',
      relatedPivotKey: 'tag_id',
    },
  }
}
```

`morphedByMany` takes the same options as `morphToMany`. The `model` factory
returns the parent class for the relation; the resolver joins `parent.id` to
`pivot.taggable_id`, filtered by `taggable_type = typeValue`.

## Lazy loading

```ts
// Owning side
const post = await Post.findOrFail(postId)
const tags = await post.related('tags').get()

// Inverse — Tag → Posts
const tag = await Tag.findOrFail(tagId)
const posts = await tag.related('posts').get()
const videos = await tag.related('videos').get()
```

## Eager loading

```ts
// Tags for many posts in one round-trip
const posts = await Post.query().whereIn('id', ids).with(['tags']).get()
posts[0].relations.tags    // Tag[]

// Posts + Videos for many tags
const tags = await Tag.query().with(['posts', 'videos']).get()
tags[0].relations.posts    // Post[]
tags[0].relations.videos   // Video[]
```

Each `morphToMany` / `morphedByMany` `with()` results in **one** batched
SELECT joining the pivot and applying `WHERE pivot.<type> = ?` + `WHERE
pivot.<idCol> IN (?, ?, …)`.

## Existence queries — `has` / `whereHas`

```ts
// Posts that have at least one tag
const tagged = await Post.query().has('tags').get()

// Tagless posts
const orphans = await Post.query().doesntHave('tags').get()

// Posts tagged 'workers'
const workers = await Post.query()
  .whereHas('tags', (q) => q.whereEq('label', 'workers'))
  .get()

// Inverse: tags attached to a Hello post
const tags = await Tag.query()
  .whereHas('posts', (q) => q.whereLike('title', 'Hello%'))
  .get()
```

Without `whereHas` filters, the EXISTS subquery hits the pivot table alone —
no join — which is the cheap path.

## Attaching and detaching

`morphToMany` / `morphedByMany` relations are pivot-backed, so they carry the
same pivot-management sugar as `belongsToMany`: `attach`, `detach`, `sync`, and
`toggle`. The morph `typeValue` is baked into every write automatically — you
never set `taggable_type` by hand.

Call them on `model.related(name)`, or via the direct-on-the-model shortcuts:

```ts
const post = await Post.findOrFail(postId)

// Attach tags — inserts { taggable_id, tag_id, taggable_type: 'post' } rows.
// INSERT OR IGNORE, so re-attaching an existing tag is a no-op.
await post.related('tags').attach(['t1', 't2'])
await post.attach('tags', ['t1', 't2'])          // model shortcut, same effect

// Detach specific tags, or all of them
await post.related('tags').detach('t1')          // one
await post.related('tags').detach(['t1', 't2'])  // several
await post.related('tags').detach()              // every tag on this post

// Make the tag set exactly match the given ids (diffs attach/detach)
const { attached, detached } = await post.sync('tags', ['t2', 't3'])

// Flip membership — attach if missing, detach if present
await post.toggle('tags', ['t1'])
```

`attach` returns the number of pivot rows inserted; `detach` returns the number
removed; `sync` / `toggle` return `{ attached: string[]; detached: string[] }`.
Add extra pivot columns with `attach(ids, { extras: { position: 1 } })`, and pass
an explicit handle with `{ db: env.DB }` when the query isn't bound to a
configured default DB.

The inverse side works the same way — `tag.related('posts').attach(postId)` (or
`tag.attach('posts', postId)`) links the tag to a post with `taggable_type =
'post'` baked in.

## Caveats

- **Pivot must not have `deleted_at`** — soft-delete scope on the related
  model would produce an ambiguous-column error during JOIN.
- **One `morphedByMany` per parent type** on the related-side model. There's
  no built-in "give me all parents regardless of type" — model that as
  multiple relations or use a raw query.
- **Pivot extras** (timestamps, role, position…) can be *written* with
  `attach(ids, { extras })`, but are **not** read back into the relation result —
  the eager/lazy query selects only the related model's columns. To read them,
  query the pivot directly or model it as a regular model with `belongsTo` to
  both sides.
