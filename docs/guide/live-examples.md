# Live Examples

Two deployed sibling apps demonstrate every major d1-eloquent feature on the same domain — a multi-tenant workspace platform. Both share the **same migrations and the same model classes**; only the HTTP transport differs. The same `curl` recipes against either deployment return identical JSON shapes.

| | URL | What it shows |
|---|---|---|
| **Hono** | <https://hono-example.d1-eloquent.orph.dev> | Hono on Cloudflare Workers — pure REST API. Smallest possible surface around d1-eloquent. |
| **Nuxt** | <https://nuxt-example.d1-eloquent.orph.dev> | Nuxt 4 + Nitro on Cloudflare. Server routes hit D1 directly — **no separate API tier**. Includes an SSR workspace view. |

Source: [github.com/Orphnet/d1-eloquent-examples](https://github.com/Orphnet/d1-eloquent-examples)

## Try it

Both apps start empty. Hit the admin seed endpoint once to populate the demo data (1 workspace, 8 users, 8 tags, 3 projects, 36 tasks, 10 posts, 30 comments):

```sh
# Hono
curl -X POST https://hono-example.d1-eloquent.orph.dev/admin/seed?fresh=1
```

```sh
# Nuxt
curl -X POST https://nuxt-example.d1-eloquent.orph.dev/api/admin/seed?fresh=1
```

> [!TIP]
> **Hono / Nuxt path difference**
> The Hono app mounts admin routes at `/admin/*`. The Nuxt app uses Nitro's filesystem-routed `server/api/admin/*`, so the path is `/api/admin/*`. All non-admin endpoints are at `/api/*` in both apps.

## Tour the API

The endpoint manifest sits at the API root of each app. Open them in a browser to see all available routes:

- <https://hono-example.d1-eloquent.orph.dev/api>
- <https://nuxt-example.d1-eloquent.orph.dev/api>

### Workspace + relation aggregates

```sh
curl https://nuxt-example.d1-eloquent.orph.dev/api/workspaces/acme
```

```jsonc
{
  "ok": true,
  "data": {
    "id": "692e6c34-...",
    "slug": "acme",
    "name": "Acme HQ",
    "settings": { "theme": "default", "invite_only": false },  // JSON cast
    "members_count": 8,                                          // withCount("members")
    "projects_count": 3,                                         // withCount("projects")
    "posts_count": 10,                                           // withCount("posts")
    "members": [ /* belongsToMany eager-loaded */ ]
  }
}
```

### Polymorphic many-to-many (`morphToMany`)

```sh
# Eager-loaded `tags` array on every Task
curl https://nuxt-example.d1-eloquent.orph.dev/api/workspaces/acme/tasks
```

### Pivot management

```sh
# Attach a tag to a task (or post — same endpoint, polymorphic)
curl -X POST https://nuxt-example.d1-eloquent.orph.dev/api/tags/<tag-id>/attach \
  -H "content-type: application/json" \
  -d '{"subject_type":"task","subject_id":"<task-id>"}'

# Replace the full tag set for a subject
curl -X POST https://nuxt-example.d1-eloquent.orph.dev/api/tags/sync \
  -H "content-type: application/json" \
  -d '{"subject_type":"task","subject_id":"<task-id>","tag_ids":["<id1>","<id2>"]}'
# → { "attached": [...], "detached": [...] }
```

### Revision tracking + time-travel

```sh
# PATCH a task — a revision row is written automatically
curl -X PATCH https://nuxt-example.d1-eloquent.orph.dev/api/workspaces/acme/tasks/<id> \
  -H "content-type: application/json" \
  -d '{"status":"done","priority":5}'

# Inspect the full create → update → delete chain
curl https://nuxt-example.d1-eloquent.orph.dev/api/audit/task/<id>

# Reconstruct the task as it was at a given ISO timestamp
curl https://nuxt-example.d1-eloquent.orph.dev/api/audit/tasks/<id>/asof/2026-05-17T15:00:00.000Z
```

### FTS5 full-text search

```sh
curl 'https://nuxt-example.d1-eloquent.orph.dev/api/search?q=lorem'
```

### Cursor pagination (`paginateCursor`)

```sh
curl 'https://nuxt-example.d1-eloquent.orph.dev/api/workspaces/acme/posts?perPage=3'
# response includes nextCursor (opaque base64url); pass back as ?after=<cursor>
```

### Polymorphic morphTo eager-load (activity feed)

```sh
# Each event has actor + the subject (Task or Post) eager-resolved
curl 'https://nuxt-example.d1-eloquent.orph.dev/api/feed?workspace=acme'
```

## What's exercised end-to-end

- Every relation type — `belongsTo`, `hasMany`, `belongsToMany`, `morphTo`, `morphMany`, `morphToMany`
- Soft deletes with auto-scope, plus `withTrashed()` escape hatches (used for FTS5 against the virtual table)
- Revision tracking in both `diff+after` and `before+after` modes
- `Task.asOf(id, isoTimestamp)` time-travel reconstruction
- Pivot management: `attach`, `detach`, `sync`, `toggle`
- Cursor pagination over published posts and the activity feed
- KV cache (`KvCacheAdapter.remember()`) on the workspace list
- Attribute casts: `boolean`, `integer`, `real`, `json`, `blob`
- FTS5 `whereMatch()` + `orderByRank()` against an external-content virtual table
- Lifecycle hooks (e.g. `Task.updating` stamps `completed_at` when `status` flips to `done`)
- `Model.createMany()` bulk insert with hooks and casts
- Atomic counter increments via `qb.update({ view_count: ... })` (doesn't churn revisions)

## Local development

Both apps run locally with Miniflare D1 + KV emulation:

```sh
git clone https://github.com/Orphnet/d1-eloquent-examples.git
cd d1-eloquent-examples
bun install

# Hono
cd packages/hono-workspace
bun run db:migrate && bun run dev   # http://localhost:8787

# Nuxt (in another shell)
cd packages/nuxt-workspace
bun run db:migrate && bun run dev   # http://localhost:3000
```
