# JSON Aggregates & Updates

Building on the JSON filter helpers added in the schema-extensions release
(`whereJsonPath` / `whereJsonContains` / `whereJsonLength` / `selectJsonExtract`),
this page covers two new groups:

1. **Aggregates** — fold rows into JSON arrays or objects with `groupBy()`
2. **Updates** — in-place edits to JSON columns via SQLite's `json_set` /
   `json_patch` / `json_remove`

All helpers compile down to plain SQLite `json1` calls, so they round-trip
cleanly against D1 with no extension setup.

## Aggregates — `json_group_array` / `json_group_object`

### `qb.selectJsonGroupArray(expr, alias)`

Wrap any column or expression in `json_group_array(<expr>)`. Pair with
`groupBy()` to roll non-aggregated columns into a JSON array per group.

```ts
// Tags per post:
const rows = await Post.query()
  .select(['posts.id'])
  .selectJsonGroupArray('tags.name', 'tag_names')
  .join('tags', 'tags.post_id = posts.id')
  .groupBy('posts.id')
  .get()
// → SELECT posts.id, json_group_array(tags.name) AS tag_names ...
```

You can nest other JSON helpers inside the expression — useful for aggregating
deep paths:

```ts
Order.query()
  .selectJsonGroupArray("json_extract(line_items, '$.sku')", 'skus')
  .groupBy('customer_id')
  .get()
```

### `qb.selectJsonGroupObject(keyExpr, valueExpr, alias)`

```ts
// Settings per user as a single JSON object:
UserSetting.query()
  .select(['user_id'])
  .selectJsonGroupObject('key', 'value', 'settings')
  .groupBy('user_id')
  .get()
// → SELECT user_id, json_group_object(key, value) AS settings ...
```

`keyExpr` and `valueExpr` are emitted verbatim. Wrap untrusted identifiers
with `safeIdent()`.

### `qb.orderByJsonPath(col, path, dir?)`

```ts
const sorted = await User.query().orderByJsonPath('settings', '$.priority', 'desc').get()
// → ORDER BY json_extract(settings, '$.priority') DESC
```

The path is escaped (single quotes doubled) before inlining; `col` is emitted
verbatim. Wrap untrusted column names with `safeIdent()`.

## In-Place Updates — `json_set` / `json_patch` / `json_remove`

Each method issues a single `UPDATE` that rewrites just the targeted slice of
the JSON column. Returns the affected row count via D1's `meta.changes`.

> [!NOTE]
> On a model-backed query (`Model.query()`) the D1 handle is resolved
> automatically. When you build a standalone `QueryBuilder` that isn't bound to a
> configured default DB, pass the handle as the **leading** argument — every
> update method has a `(db, …)` overload, e.g.
> `qb.updateJsonSet(env.DB, 'settings', '$.role', 'admin')`.

### `qb.updateJsonSet(col, path, value)`

Set the value at `path` without rewriting the whole document.

```ts
await User.query().whereEq('id', uid).updateJsonSet('settings', '$.role', 'admin')
// UPDATE users SET settings = json_set(settings, ?, ?) WHERE id = ?
//   bindings: ['$.role', 'admin', uid]
```

`value` may be any JSON-serializable value (string, number, boolean, object,
array). SQLite's `json_set` will create intermediate paths as needed.

### `qb.updateJsonPatch(col, patch)`

Merge a JSON patch into the column via SQLite's `json_patch` — RFC 7396 merge
semantics: nulls in the patch delete keys, nested objects deep-merge, arrays
are replaced wholesale.

```ts
await User.query().whereEq('id', uid)
  .updateJsonPatch('settings', { theme: 'dark', notifications: { email: true } })
// UPDATE users SET settings = json_patch(settings, ?) WHERE id = ?
//   bindings: ['{"theme":"dark","notifications":{"email":true}}', uid]
```

### `qb.updateJsonRemove(col, path | paths[])`

Strip one or more paths from the JSON document.

```ts
// Single path
await Post.query().whereEq('id', pid).updateJsonRemove('metadata', '$.draft')

// Multiple paths in one statement
await Post.query().whereEq('id', pid)
  .updateJsonRemove('metadata', ['$.draft', '$.tmp', '$.legacy'])
// UPDATE posts SET metadata = json_remove(metadata, ?, ?, ?) WHERE id = ?
```

Returns `0` without issuing a query when `paths` is an empty array.

## Patterns

### Atomic counter inside a JSON column

```ts
await User.query().whereEq('id', uid)
  .updateJsonSet('stats', '$.visits', currentVisits + 1)
```

For genuine race-free atomics you still want a dedicated column with `UPDATE
... SET visits = visits + 1`. JSON updates rewrite the whole document, so
they're cheap but not atomic vs. concurrent writers.

### Strip secrets after migration

```ts
await User.query().whereNotNull('legacy_token')
  .updateJsonRemove('credentials', ['$.legacy_token', '$.api_v1_secret'])
```

### Compute a "tags by user" map for a dashboard

```ts
const byUser = await Post.query()
  .select(['user_id'])
  .selectJsonGroupArray("json_extract(tags, '$')", 'tags')
  .groupBy('user_id')
  .get()
```

## Safety notes

- `col`, `keyExpr`, `valueExpr`, and aggregate expressions are emitted
  verbatim. Wrap untrusted identifiers with `safeIdent()` from the package.
- JSON paths are escaped (single quotes doubled) before inlining. Paths
  themselves come from your application code, not user input — but treat
  them as you would any SQL fragment.
- `updateJsonPatch` serializes the patch with `JSON.stringify`. If the patch
  isn't a plain JSON-serializable object, encode it yourself and pass a
  string.
