# Attribute Casting

D1 stores only four primitive types: `TEXT`, `INTEGER`, `REAL`, and `BLOB`. Attribute casting lets you declare how columns map to JavaScript types — d1-eloquent handles the conversion automatically in both directions.

**Without d1-eloquent**

```ts
// Reading — manual conversion scattered across your codebase
const row = results[0]
const isPublished = row.is_published === 1        // remember: D1 returns 0/1
const metadata = JSON.parse(row.metadata as string) // hope it's valid JSON
const createdAt = new Date(row.created_at as string) // don't forget this one

// Writing — mirror every conversion in reverse
await env.DB.prepare(
  'INSERT INTO posts (id, is_published, metadata, created_at) VALUES (?, ?, ?, ?)'
).bind(
  id,
  post.isPublished ? 1 : 0,             // boolean → integer
  JSON.stringify(post.metadata),          // object → JSON string
  post.createdAt.toISOString()            // Date → ISO string
).run()

// Every read site and every write site must agree on the conversion.
// Forget one? Silent data corruption.
```

**With d1-eloquent**

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static casts = {
    is_published: 'boolean',   // D1 INTEGER 0/1 ↔ JS boolean
    metadata: 'json',          // D1 TEXT ↔ JS object
  }
}

// Reading — automatic, everywhere
post.get('is_published')   // true (boolean, not 1)
post.get('metadata')       // { key: "val" } (object, not string)
post.get('created_at')     // Date instance (auto-cast for timestamps)

// Writing — automatic, everywhere
post.set('is_published', false)
post.set('metadata', { key: 'new' })
await post.save()          // d1-eloquent dehydrates to DB-safe values
```

## Declaring Casts

Add a `static casts` object to your model. Keys are column names, values are cast type strings:

```ts
import { BaseModel } from '@orphnet/d1-eloquent'

interface PostAttrs {
  id: string
  title: string
  is_published: boolean
  metadata: Record<string, unknown>
  view_count: number
  created_at: Date
  updated_at: Date
}

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static casts = {
    is_published: 'boolean',
    metadata: 'json',
    view_count: 'integer',
  }
}
```

After casting, `post.get('is_published')` returns a `boolean` (not `0`/`1`), and `post.get('metadata')` returns an object (not a JSON string).

## Built-in Cast Types

| Cast | D1 type | JS type | Get example | Set example |
|---|---|---|---|---|
| `'boolean'` | INTEGER (0/1) | `boolean` | `1` → `true` | `true` → `1` |
| `'integer'` | INTEGER | `number` | `"42"` → `42` | `3.7` → `3` |
| `'float'` / `'real'` | REAL | `number` | `"3.14"` → `3.14` | passthrough |
| `'string'` | TEXT | `string` | `123` → `"123"` | passthrough |
| `'datetime'` | TEXT (ISO 8601) | `Date` | `"2026-01-15T..."` → `Date` | `Date` → ISO string |
| `'date'` | TEXT (YYYY-MM-DD) | `Date` | `"2026-01-15"` → `Date` (midnight UTC) | `Date` → `"2026-01-15"` |
| `'timestamp'` | INTEGER (unix) | `Date` | `1700000000` → `Date` | `Date` → `1700000000` |
| `'json'` | TEXT | `unknown` | `'{"a":1}'` → `{a: 1}` | `{a: 1}` → `'{"a":1}'` |
| `'array'` | TEXT | `unknown[]` | `'["a","b"]'` → `["a","b"]` | `["a","b"]` → `'["a","b"]'` |
| `'blob'` | BLOB | `ArrayBuffer` | passthrough | passthrough |
| `enumCast([...])` | TEXT or INTEGER | union of `values` | validated - see [Enum Casts](#enum-casts) | validated - throws on invalid |

The `'blob'` cast is a passthrough for binary columns: D1 returns `BLOB` values as `ArrayBuffer`, and set accepts an `ArrayBuffer` or typed array unchanged. It exists so binary columns are tracked in the attribute manager and can be typed explicitly via `casts: { col: 'blob' }`.

## Enum Casts

SQLite has no native enum type, so `enumCast(values)` provides a **runtime-validated** cast:
the value is checked against the allowed set on both read (DB → app) and write (app → DB, and
in cast-aware `where` clauses). Pair it with a TS union on your attrs interface for compile-time
safety too. `null` / `undefined` pass through (use a `NOT NULL` column to forbid them).

```ts
import { BaseModel, enumCast } from '@orphnet/d1-eloquent'

type Status = 'draft' | 'published' | 'archived'
interface PostAttrs { id: string; status: Status; priority: 1 | 2 | 3 | null }

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static casts = {
    status: enumCast(['draft', 'published', 'archived']),
    priority: enumCast([1, 2, 3]),   // numeric enums work too
  } as const
}

await Post.create(db, { status: 'published', priority: 2 })   // ok
await Post.create(db, { status: 'spam' })                     // throws: Invalid enum value "spam"
Post.query().whereEq('status', 'published')                   // validated + filtered
```

Validation fires on persist (`create`/`save`), on hydration (reads), and when an enum column is
used as a filter value - not on a bare `set()` (which is validated when you `save()`).

### Full signature

```ts
function enumCast<const T extends string | number>(
  values: readonly T[],
  opts?: { onInvalidRead?: 'throw' | 'null' | 'keep' },
): AttributeCast<T | null, T | null | undefined>
```

### Invalid values already in the database

Reads are strict by default (`onInvalidRead: 'throw'`): an out-of-set value coming back
from D1 throws `Invalid enum value ...`. A single legacy row would then fail a whole list
query, so `opts.onInvalidRead` lets reads degrade instead:

| `onInvalidRead` | Read behavior for an out-of-set value |
|---|---|
| `'throw'` (default) | throws `Invalid enum value ...` |
| `'null'` | returns `null` |
| `'keep'` | returns the raw value unchanged |

Writes always throw on an invalid value regardless of this option.

```ts
static casts = {
  status: enumCast(['draft', 'published', 'archived'], { onInvalidRead: 'null' }),
}
```

## Automatic Timestamp Casting

When `timestamps = true` (the default), `created_at` and `updated_at` are automatically cast to `datetime`. When `softDeletes = true`, `deleted_at` is also auto-cast.

You do **not** need to declare these in `static casts` — they are registered automatically. If you do declare them, your cast takes priority.

```ts
class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static timestamps = true   // created_at/updated_at auto-cast to Date
  static softDeletes = true  // deleted_at auto-cast to Date
}

const user = await User.find(userId)
user.get('created_at')  // Date instance, not a string
```

## Custom Casts

For types not covered by the built-in casts, implement the `AttributeCast` interface:

```ts
import { BaseModel } from '@orphnet/d1-eloquent'
import type { AttributeCast } from '@orphnet/d1-eloquent'

const pointCast: AttributeCast<{ x: number; y: number }, { x: number; y: number }> = {
  get: (value) => JSON.parse(value as string),
  set: (value) => JSON.stringify(value),
}

class Marker extends BaseModel<MarkerAttrs> {
  static table = 'markers'
  static casts = {
    position: pointCast,
  }
}
```

The `get` method transforms DB values → application values. The `set` method transforms application values → DB values.

## Null Handling

`null` and `undefined` values pass through casts unchanged — no cast function is called. This matches SQL `NULL` semantics.

```ts
const model = new Post({ is_published: null })
model.get('is_published')  // null (not false)
```

## `toObject()` vs `toRaw()`

| Method | Returns | Use case |
|---|---|---|
| `toObject()` | Cast (application) values | API responses, UI rendering |
| `toRaw()` | Dehydrated (DB-safe) values | Manual SQL, debugging, serialization |

```ts
const post = await Post.find(postId)

post.toObject()
// { id: "...", is_published: true, metadata: { key: "val" }, created_at: Date, ... }

post.toRaw()
// { id: "...", is_published: 1, metadata: '{"key":"val"}', created_at: "2026-01-15T...", ... }
```

## Revisions

Revision snapshots (`before`, `after`, `diff`) store **raw** (dehydrated) values. This ensures revisions contain DB-safe primitives that can be replayed reliably.
