# QueryBuilder API Reference

`QueryBuilder` is returned by `Model.query()`. All filter and shape methods are chainable. Terminal methods (`get`, `first`, `count`, etc.) execute the query against D1 and return a `Promise`. The `get()` method returns a [`Collection`](#collection) — a lightweight array wrapper with utility methods.

Terminal methods return **proxy-wrapped model instances** with typed property access. No manual casting needed.

The `db` parameter is **optional** on all terminal methods. When omitted, the database is resolved automatically from the registry configured via [`configure(env)`](../guide/configuration.md).

The `orderBy` direction accepts both lowercase and uppercase: `'asc'`, `'desc'`, `'ASC'`, `'DESC'`.

## Where-Clause Values Are Cast

Values passed to filter methods (`whereEq`, `where`, `whereIn`, `whereBetween`, …) are run through the **model's casts** before binding — the same dehydration applied on write. You pass the *application* value and the builder binds the *stored* primitive:

```ts
class Todo extends BaseModel<TodoAttrs> {
  static table = 'todos'
  static casts = {
    done: 'boolean',       // JS boolean ↔ D1 INTEGER 0/1
    created_at: 'date',    // JS Date    ↔ D1 ISO 8601 TEXT
    tags: 'json',          // JS array   ↔ D1 TEXT
  }
}

// Booleans — pass `false`/`true`, not raw 0/1. The cast binds 0/1 for you.
Todo.query().whereEq('done', false).get()
// WHERE done = ?   ← binds 0

// Dates — pass `Date` objects to a date range. They're serialized to match storage.
const start = new Date('2026-01-01')
const end   = new Date('2026-02-01')
Todo.query().whereBetween('created_at', [start, end]).get()
// WHERE created_at BETWEEN ? AND ?   ← binds two ISO strings

// JSON columns — pass the OBJECT; it's serialized the same way it's stored.
Todo.query().whereEq('tags', ['urgent', 'home']).get()
// WHERE tags = ?   ← binds '["urgent","home"]'
```

> [!TIP]
> **JSON path / containment**
>
> Equality on a whole `json` column matches the exact serialized string. To match *inside* a JSON document — a path value, array containment, or length — use the dedicated `whereJsonPath` / `whereJsonContains` / `whereJsonLength` filters instead of `whereEq` (see the [JSON Aggregates & Updates guide](../guide/json-aggregates-updates.md)).

A column with **no** cast binds the value as-is, so non-cast columns are unaffected. `whereColumn` (identifier-vs-identifier) and `whereRaw` bindings are never cast — you control those bindings directly.

```ts
// Set db once at query creation — no need to repeat at terminal calls
const users = await User.query(env.DB)
  .whereEq('status', 'active')
  .orderBy('created_at', 'DESC')
  .limit(25)
  .get()

users[0].name  // typed as string — no .toObject() needed

// Explicit db at terminal call (existing pattern, still works)
const users = await User.query()
  .whereEq('status', 'active')
  .get(env.DB)

// Auto-resolved db (after configure(env) is called)
const users = await User.query()
  .whereEq('status', 'active')
  .get()
```

## Filter Methods

### `where(col, op, val)`

```ts
.where(col: string, op: string, val: unknown): this
```

Adds a `WHERE col op ?` clause. `op` can be any SQL comparison operator (`=`, `!=`, `<`, `>`, `<=`, `>=`, `LIKE`, `NOT LIKE`).

```ts
User.query().where('age', '>', 18)
```

---

### `orWhere(col, op, val)`

```ts
.orWhere(col: string, op: string, val: unknown): this
```

Adds an `OR col op ?` clause.

```ts
User.query().whereEq('role', 'admin').orWhere('role', '=', 'moderator')
```

---

### `whereEq(col, val)`

```ts
.whereEq(col: string, val: unknown): this
```

Shorthand for `.where(col, '=', val)`.

```ts
User.query().whereEq('email', 'alice@example.com')
```

---

### `whereLike(col, pattern)`

```ts
.whereLike(col: string, pattern: string): this
```

Adds a `WHERE col LIKE ?` clause. Use `%` as the wildcard character.

```ts
User.query().whereLike('name', 'Ali%')
```

---

### `whereIn(col, vals | subquery)`

```ts
.whereIn(col: string, vals: unknown[]): this
.whereIn(col: string, subquery: QueryBuilder): this
```

Adds a `WHERE col IN (...)` clause. Accepts either an array of values or a `QueryBuilder` subquery.

```ts
// With array
User.query().whereIn('status', ['active', 'pending'])

// With subquery
const activeUserIds = User.query().select(['id']).where('status', '=', 'active')
Post.query().whereIn('user_id', activeUserIds)
// WHERE user_id IN (SELECT id FROM users WHERE status = ?)
```

> [!TIP]
> **Empty arrays are safe**
>
> `whereIn(col, [])` does **not** emit the invalid `col IN ()` (a SQLite syntax error). An empty set matches nothing, so a constant-false predicate `0 = 1` is compiled instead — the query returns no rows, exactly as set semantics imply.
>
> ```ts
> User.query().whereIn('id', []).get(db)
> // WHERE 0 = 1  → no rows, no error
> ```

---

### `whereNotIn(col, vals | subquery)`

```ts
.whereNotIn(col: string, vals: unknown[]): this
.whereNotIn(col: string, subquery: QueryBuilder): this
```

Adds a `WHERE col NOT IN (...)` clause. Accepts arrays or subqueries.

```ts
// Exclude posts by banned users
const bannedIds = User.query().select(['id']).where('status', '=', 'banned')
Post.query().whereNotIn('user_id', bannedIds)
```

> [!TIP]
> **Empty arrays are safe**
>
> `whereNotIn(col, [])` does **not** emit the invalid `col NOT IN ()`. An empty exclusion set excludes nothing, so a constant-true predicate `1 = 1` is compiled instead — the query matches every row, exactly as set semantics imply.
>
> ```ts
> Post.query().whereNotIn('user_id', []).get(db)
> // WHERE 1 = 1  → all rows, no error
> ```

---

### `orWhereNotIn(col, vals)`

```ts
.orWhereNotIn(col: string, vals: unknown[]): this
```

Same as `whereNotIn` but connects with `OR`.

```ts
User.query().whereEq('active', true).orWhereNotIn('role', ['guest'])
```

---

### `whereNull(col)`

```ts
.whereNull(col: string): this
```

Adds a `WHERE col IS NULL` clause.

```ts
User.query().whereNull('deleted_at')
```

---

### `whereNotNull(col)`

```ts
.whereNotNull(col: string): this
```

Adds a `WHERE col IS NOT NULL` clause.

```ts
User.query().whereNotNull('email_verified_at')
```

---

### `orWhereNull(col)` / `orWhereNotNull(col)`

```ts
.orWhereNull(col: string): this
.orWhereNotNull(col: string): this
```

`OR` variants of `whereNull` and `whereNotNull`.

```ts
User.query().whereEq('status', 'active').orWhereNull('deleted_at')
```

---

### `whereBetween(col, range)`

```ts
.whereBetween(col: string, range: [unknown, unknown]): this
```

Adds a `WHERE col BETWEEN ? AND ?` clause.

```ts
User.query().whereBetween('age', [18, 65])
```

---

### `whereNotBetween(col, range)`

```ts
.whereNotBetween(col: string, range: [unknown, unknown]): this
```

Adds a `WHERE col NOT BETWEEN ? AND ?` clause.

```ts
User.query().whereNotBetween('score', [0, 10])
```

---

### `orWhereBetween(col, range)` / `orWhereNotBetween(col, range)`

```ts
.orWhereBetween(col: string, range: [unknown, unknown]): this
.orWhereNotBetween(col: string, range: [unknown, unknown]): this
```

`OR` variants of `whereBetween` and `whereNotBetween`.

```ts
User.query().whereEq('status', 'vip').orWhereBetween('points', [500, 1000])
```

---

### `whereRaw(sql, bindings?)`

```ts
.whereRaw(sql: string, bindings?: unknown[]): this
```

Appends a raw SQL fragment to the WHERE clause. Use `?` placeholders for values; pass the corresponding values as `bindings`.

```ts
User.query().whereRaw('json_extract(metadata, "$.tier") = ?', ['pro'])
```

---

### `whereDate` / `whereTime` / `whereYear` / `whereMonth` / `whereDay`

```ts
.whereDate(col: string, op?: string, value: string | Date): this   // date(col) op ?
.whereTime(col: string, op?: string, value: string | Date): this   // time(col) op ?
.whereYear(col: string, year: number | string): this               // strftime('%Y', col) = ?
.whereMonth(col: string, month: number | string): this             // strftime('%m', col) = ? (01-12)
.whereDay(col: string, day: number | string): this                 // strftime('%d', col) = ? (01-31)
```

Filter on a date/time component of a datetime column via SQLite's `date()` / `time()` /
`strftime()`. `whereDate` / `whereTime` accept an operator (two-arg form uses `=`) and a `Date`
or string; `whereYear` / `whereMonth` / `whereDay` are equality, with month/day zero-padded for
you. The column is emitted verbatim - wrap untrusted input with `safeIdent()`.

```ts
Post.query().whereDate('created_at', '2026-01-15')
Post.query().whereDate('created_at', '>=', new Date('2026-01-01'))
Post.query().whereMonth('created_at', 1).whereYear('created_at', 2026)   // January 2026
```

---

### `whereGroup(fn)`

```ts
.whereGroup(fn: (qb: QueryBuilder<TModel>) => void): this
```

Groups a set of conditions in parentheses. Pass a callback that calls filter methods on the inner `qb`.

```ts
User.query()
  .whereGroup(qb => {
    qb.whereEq('status', 'active').orWhere('role', '=', 'admin')
  })
  .get(env.DB)
// WHERE (status = ? OR role = ?)
```

---

### `orWhereGroup(fn)`

```ts
.orWhereGroup(fn: (qb: QueryBuilder<TModel>) => void): this
```

Same as `whereGroup` but connects the group with `OR` instead of `AND`.

```ts
User.query()
  .whereEq('role', 'admin')
  .orWhereGroup(qb => {
    qb.whereEq('role', 'editor').whereEq('status', 'active')
  })
  .get(env.DB)
// WHERE role = ? OR (role = ? AND status = ?)
```

### `whereColumn(col1, op?, col2)` / `orWhereColumn(col1, op?, col2)`

```ts
.whereColumn(col1: string, col2: string): this          // defaults to '='
.whereColumn(col1: string, op: string, col2: string): this
.orWhereColumn(col1: string, col2: string): this
.orWhereColumn(col1: string, op: string, col2: string): this
```

Compares two column identifiers directly — no parameter bindings are emitted. The 2-argument form defaults the operator to `=`.

```ts
// 3-arg: explicit operator
Order.query().whereColumn('price', '>', 'cost')
// WHERE price > cost

// 2-arg: defaults to =
Post.query().whereColumn('updated_at', 'created_at')
// WHERE updated_at = created_at

// OR variant
Post.query()
  .where('status', '=', 'draft')
  .orWhereColumn('price', '<', 'cost')
```

---

## Conditional Clauses

### `when(condition, ifTrue, ifFalse?)`

```ts
.when<T>(condition: T | false | null | undefined | 0 | "", ifTrue: (q: QueryBuilder, value: T) => void, ifFalse?: (q: QueryBuilder) => void): this
```

Conditionally applies query clauses based on a runtime value. When the condition is truthy, `ifTrue` is called with the query builder and the truthy value. When falsy, `ifFalse` is called if provided. Returns `this` for chaining regardless of which branch executes.

```ts
// Apply filters only when present
const search = request.query.search  // string | undefined

const users = await User.query()
  .when(search, (q, val) => q.whereLike('name', `%${val}%`))
  .when(filters.role, (q, role) => q.whereEq('role', role))
  .orderBy('created_at', 'DESC')
  .get()
```

With an `ifFalse` branch:

```ts
const users = await User.query()
  .when(
    showActive,
    (q) => q.whereEq('status', 'active'),
    (q) => q.whereEq('status', 'inactive'),
  )
  .get()
```

---

## Shape Methods

### `distinct()`

```ts
.distinct(): this
```

Adds the `DISTINCT` modifier to the SELECT clause, eliminating duplicate rows from results.

```ts
User.query().distinct().select(['email']).get(db)
// SELECT DISTINCT email FROM users

// Useful with joins to avoid duplicate rows
Post.query()
  .distinct()
  .join('tags', 'posts.id = tags.post_id')
  .select(['posts.*'])
  .get(db)
```

---

### `select(cols)`

```ts
.select(cols: string[]): this
```

Limits the columns included in the SELECT. By default all columns are selected (`*`).

```ts
User.query().select(['id', 'name', 'email'])
```

---

### `join(table, on)`

```ts
.join(table: string, on: string): this
```

Adds an `INNER JOIN` clause. `on` is the raw join condition.

```ts
Post.query()
  .join('users', 'posts.user_id = users.id')
  .select(['posts.*', 'users.name as author_name'])
```

---

### `leftJoin(table, on)`

```ts
.leftJoin(table: string, on: string): this
```

Adds a `LEFT JOIN` clause. `on` is the raw join condition.

```ts
Post.query()
  .leftJoin('comments', 'posts.id = comments.post_id')
```

---

### `selectSub(query, alias)`

```ts
.selectSub(query: QueryBuilder, alias: string): this
```

Embeds a subquery in the SELECT list as a named column. The subquery is parenthesized and its bindings are prepended before WHERE bindings in the final SQL. Calling `select()` after `selectSub()` resets subquery bindings to prevent stale state.

```ts
const commentCount = Comment.query()
  .select(['COUNT(*)'])
  .whereColumn('comments.post_id', 'posts.id')

const posts = await Post.query()
  .select(['id', 'title'])
  .selectSub(commentCount, 'comment_count')
  .get(db)
// SELECT id, title, (SELECT COUNT(*) FROM comments
//   WHERE comments.post_id = posts.id) AS comment_count FROM posts
```

---

### `groupBy(...cols)`

```ts
.groupBy(...cols: string[]): this
```

Adds a `GROUP BY` clause. Accepts one or more columns (variadic), and repeated calls append. Typically combined with an aggregate terminal method or `having()`.

```ts
Post.query()
  .select(['user_id'])
  .groupBy('user_id')
  .count(env.DB)

// Multiple grouping columns
Order.query()
  .selectRaw('customer_id, status, COUNT(*) as cnt')
  .groupBy('customer_id', 'status')
  .get(env.DB)
```

---

### `having(col, op, val)` / `orHaving(col, op, val)`

```ts
.having(col: string, op: string, val: unknown): this
.orHaving(col: string, op: string, val: unknown): this
```

Adds a `HAVING` clause to filter grouped results. Use after `groupBy()`. HAVING bindings are placed after WHERE bindings in the compiled SQL.

```ts
Post.query()
  .selectRaw('user_id, COUNT(*) as post_count')
  .groupBy('user_id')
  .having('post_count', '>', 5)
  .get(db)
// SELECT user_id, COUNT(*) as post_count FROM posts
//   GROUP BY user_id HAVING post_count > ?

// OR variant
Post.query()
  .selectRaw('status, COUNT(*) as cnt')
  .groupBy('status')
  .having('cnt', '>', 10)
  .orHaving('status', '=', 'featured')
  .get(db)
```

---

### `havingRaw(sql, bindings?)` / `orHavingRaw(sql, bindings?)`

```ts
.havingRaw(sql: string, bindings?: unknown[]): this
.orHavingRaw(sql: string, bindings?: unknown[]): this
```

Adds a raw SQL expression to the HAVING clause. Use for complex aggregate conditions.

```ts
Post.query()
  .selectRaw('user_id, COUNT(*) as cnt')
  .groupBy('user_id')
  .havingRaw('COUNT(*) > ?', [5])
  .get(db)
// ... GROUP BY user_id HAVING COUNT(*) > ?
```

---

### `union(query)` / `unionAll(query)` / `intersect(query)` / `except(query)`

```ts
.union(query: QueryBuilder): this      // both, deduplicated
.unionAll(query: QueryBuilder): this   // both, keep duplicates
.intersect(query: QueryBuilder): this  // rows in BOTH (deduplicated)
.except(query: QueryBuilder): this     // rows in this but NOT the other (deduplicated)
```

Combine results from multiple queries with SQL set operators. `INTERSECT` keeps rows present in both; `EXCEPT` keeps rows in the first query absent from the second - both deduplicate (SQLite has no `INTERSECT ALL` / `EXCEPT ALL`). Each query compiles independently, including its own soft-delete scope. Returns `this` for chaining.

```ts
// active users who are also premium
await User.query().whereEq('active', true)
  .intersect(User.query().whereEq('premium', true)).get(db)

// all users except banned ones
await User.query().except(User.query().whereEq('status', 'banned')).get(db)
```

> [!WARNING]
> **No `LIMIT` / `OFFSET` / `ORDER BY` on the left query**
>
> SQLite requires `LIMIT`/`OFFSET`/`ORDER BY` to follow the *entire* compound select, not an individual operand. The set-op clause is appended after the left query's `LIMIT`/`OFFSET`, so `User.query().limit(10).intersect(other)` compiles to `... LIMIT 10 INTERSECT ...` - which SQLite rejects (`LIMIT clause should come after INTERSECT not before`). The same applies to `union`/`unionAll`/`except` and to a left-side `ORDER BY`. Keep `LIMIT`/`OFFSET`/`ORDER BY` off the left query (wrap it as a subquery first if you need them).

```ts
const admins = User.query().where('role', '=', 'admin')
const active = User.query().whereEq('active', true)  // cast binds 1

// UNION (deduplicated)
const users = await admins.union(active).get(db)
// SELECT * FROM users WHERE role = ?
//   UNION SELECT * FROM users WHERE active = ?

// UNION ALL (keeps duplicates)
const all = await admins.unionAll(active).get(db)

// Chain multiple unions
const result = await q1.union(q2).unionAll(q3).get(db)
```

---

### `orderBy(col, dir?)`

```ts
.orderBy(col: string, dir?: 'ASC' | 'DESC'): this
```

Adds an `ORDER BY col dir` clause. Defaults to `ASC` when `dir` is omitted.

```ts
Post.query().orderBy('created_at', 'DESC')
```

---

### `limit(n)`

```ts
.limit(n: number): this
```

Adds a `LIMIT n` clause.

```ts
Post.query().limit(20)
```

---

### `offset(n)`

```ts
.offset(n: number): this
```

Adds an `OFFSET n` clause. Use with `limit` for pagination.

```ts
Post.query().orderBy('created_at', 'DESC').limit(20).offset(40)
```

### `from(table)`

```ts
.from(table: string): this
```

Overrides the table name for this query. Useful for querying archive or shadow tables that share the same schema without creating a new model.

```ts
// Query an archive table using the same model
const archived = await Post.query(env.DB).from('posts_archive').get()

// Main table is unaffected on subsequent queries
const current = await Post.query(env.DB).get()
```

---

## Soft Delete Scopes

These methods apply only when the model has `softDeletes = true`. By default, queries on a soft-deleting model automatically append `WHERE deleted_at IS NULL`, excluding soft-deleted rows.

> [!TIP]
> **Scope is grouped against top-level `OR`**
>
> The `deleted_at IS NULL` scope is AND-appended to your predicates. Because SQL `AND` binds tighter than `OR`, a naive append would bind the scope to only the final `OR` branch — leaking soft-deleted rows. The builder guards against this: when your WHERE contains a top-level `orWhere`, your predicates are wrapped in a single group **before** the scope is appended, so the scope applies to all of them.
>
> ```ts
> Post.query()                       // softDeletes model
>   .whereEq('status', 'draft')
>   .orWhere('status', '=', 'review')
>   .get(db)
> // WHERE (status = ? OR status = ?) AND deleted_at IS NULL
> //       └─ user predicates grouped ─┘    └─ scope applies to both branches ─┘
> ```
>
> The same grouping applies to the `onlyTrashed()` scope (`deleted_at IS NOT NULL`).

### `withTrashed()`

```ts
.withTrashed(): this
```

Removes the `deleted_at IS NULL` filter so soft-deleted rows are included alongside normal rows.

```ts
Post.query().withTrashed().whereEq('user_id', userId).get(env.DB)
```

---

### `onlyTrashed()`

```ts
.onlyTrashed(): this
```

Restricts results to soft-deleted rows only (`WHERE deleted_at IS NOT NULL`).

```ts
Post.query().onlyTrashed().get(env.DB)
```

## Eager Loading

### `with(relations)` / `with({ relation: constraint })`

```ts
.with(relations: string[]): this
.with(spec: Record<string, ((q: QueryBuilder) => void) | true>): this
```

Eager-loads the named relations after the primary query executes. Relations are resolved from `static relations` (auto-derived) or `static eagerLoaders` (manual). Explicit `eagerLoaders` take precedence.

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static relations = {
    comments: { type: 'hasMany', model: () => Comment, foreignKey: 'post_id' },
    author:   { type: 'belongsTo', model: () => User, foreignKey: 'user_id' },
  }
}

const posts = await Post.query()
  .with(['comments', 'author'])
  .limit(10)
  .get(env.DB)

// posts[0].relations.comments  → Comment[]
// posts[0].relations.author    → User | null
```

#### Constrained eager loading

Pass an **object map** to scope each eager-loaded relation with a callback - the callback
receives the batch query for that relation (already keyed by the parent ids). Use `true`
for an unconstrained relation.

```ts
const posts = await Post.query()
  .with({
    comments: q => q.where('approved', '=', 1).orderBy('created_at', 'desc'),
    author: true,
  })
  .get(env.DB)

// posts[i].relations.comments → only approved, newest first
```

> [!WARNING]
> **Select and limit inside a constraint**
>
> - A `select()` inside the callback may narrow the column list freely - the loader re-adds the
>   foreign/grouping key it needs (internally aliased), so rows still distribute back to their parents.
> - `limit()` applies **per batch-chunk**, not per-parent (the SQL window-function "limit per group"
>   is not emitted). Because parents are fetched in chunks, the cap is *per chunk* and scales with
>   the number of chunks - it is **not** a reliable global cap, and never a top-N-per-parent. Avoid
>   `limit()` in a constraint unless you understand the chunking.

Constraints apply to **auto-derived** relations (from `static relations`); a manual
`static eagerLoaders` entry ignores them.

See [Relationships API](./relationships.md) for full relation types and `has()`/`whereHas()` support.

## Terminal Methods

Terminal methods execute the query and return a `Promise`. The `db` parameter is **optional** on all terminal methods — when omitted, the database is resolved automatically via `configure(env)`. See the [Configuration guide](../guide/configuration.md) for setup details.

### `get(db?)`

```ts
.get(db?: D1Database): Promise<Collection<TModel>>
```

Executes the query and returns all matching rows as model instances wrapped in a [`Collection`](#collection).

```ts
// Explicit db
const posts = await Post.query().whereEq('user_id', userId).get(env.DB)

// Auto-resolved db
const posts = await Post.query().whereEq('user_id', userId).get()
```

---

### `prepare(db?)` + `placeholder(name)`

```ts
.prepare(db?: D1Database): PreparedQuery<TModel>
placeholder(name: string): Placeholder
```

Compile a query **once** into a reusable `PreparedQuery`, using `placeholder(name)` in filter
values. Execute it repeatedly with different params - the SQL string is built a single time
(Drizzle-style prepared statements). Good for hot paths.

```ts
import { placeholder } from '@orphnet/d1-eloquent'

const byEmail = User.query().whereEq('email', placeholder('email')).prepare(env.DB)
const a = await byEmail.first({ email: 'a@x.com' })   // reuses the compiled SQL
const b = await byEmail.first({ email: 'b@x.com' })
const rows = await byEmail.get({ email: 'c@x.com' })  // Collection<TModel>
const raw  = await byEmail.all({ email: 'c@x.com' })  // raw rows
```

Static values and placeholders can be mixed (`whereEq('tier','pro').where('email','=',placeholder('email'))`).

> [!WARNING]
> **Placeholder params bind RAW**
>
> The cast layer can't run on a value it doesn't have at compile time, so **placeholder params bind
> the raw DB value** - pass `1` for a boolean column, an ISO string for a date, etc. (Non-placeholder
> values are still cast as usual.) The *result* rows are hydrated normally.

---

### `first(db?)`

```ts
.first(db?: D1Database): Promise<TModel | null>
```

Executes the query with an implicit `LIMIT 1` and returns the first row, or `null` if no rows match.

```ts
const post = await Post.query().whereEq('slug', slug).first(env.DB)
const post = await Post.query().whereEq('slug', slug).first()
```

---

### `firstWhere(column, op?, value)`

Shorthand for `.where(column, op, value).first()`. Two-arg form uses `=`; three-arg
form takes an explicit operator. db-first overloads are available, or set the db via
`Model.query(db)` / `configure(env)`.

```ts
const user = await User.query(env.DB).firstWhere('email', 'a@b.com')
const top  = await Post.query(env.DB).firstWhere('votes', '>', 100)
```

---

### `firstOrFail(db?)`

```ts
.firstOrFail(db?: D1Database): Promise<TModel>
```

Like `first()`, but throws `ModelNotFoundException` if no rows match.

```ts
const post = await Post.query().whereEq('slug', slug).firstOrFail(env.DB)
```

---

### `sole(db?)`

```ts
.sole(db?: D1Database): Promise<TModel>
```

Returns exactly one result. Throws `ModelNotFoundException` if no rows match, or `MultipleRecordsFoundException` if more than one row matches.

```ts
import { ModelNotFoundException, MultipleRecordsFoundException } from '@orphnet/d1-eloquent'

const admin = await User.query().whereEq('role', 'admin').sole(env.DB)
```

---

### `count(db?)`

```ts
.count(db?: D1Database): Promise<number>
```

Executes `SELECT COUNT(*) FROM ...` and returns the count as a number.

```ts
const total = await Post.query().whereEq('user_id', userId).count(env.DB)
const total = await Post.query().whereEq('user_id', userId).count()
```

---

### `sum(col)` | `sum(db, col)`

```ts
.sum(col: string): Promise<number>
.sum(db: D1Database, col: string): Promise<number>
```

Executes `SELECT SUM(col) FROM ...` and returns the sum.

```ts
const totalViews = await Post.query().sum(env.DB, 'view_count')
const totalViews = await Post.query().sum('view_count')
```

---

### `avg(col)` | `avg(db, col)`

```ts
.avg(col: string): Promise<number | null>
.avg(db: D1Database, col: string): Promise<number | null>
```

Executes `SELECT AVG(col) FROM ...` and returns the average, or `null` if no rows match.

```ts
const avgScore = await Post.query().whereEq('user_id', userId).avg(env.DB, 'score')
const avgScore = await Post.query().whereEq('user_id', userId).avg('score')
```

---

### `min(col)` | `min(db, col)`

```ts
.min(col: string): Promise<unknown>
.min(db: D1Database, col: string): Promise<unknown>
```

Executes `SELECT MIN(col) FROM ...` and returns the minimum value.

```ts
const earliest = await Post.query().min(env.DB, 'created_at')
const earliest = await Post.query().min('created_at')
```

---

### `max(col)` | `max(db, col)`

```ts
.max(col: string): Promise<unknown>
.max(db: D1Database, col: string): Promise<unknown>
```

Executes `SELECT MAX(col) FROM ...` and returns the maximum value.

```ts
const latest = await Post.query().max(env.DB, 'created_at')
const latest = await Post.query().max('created_at')
```

## Mutation Methods

### `insert(values)` | `insert(db, values)`

```ts
.insert(values: Record<string, unknown>): Promise<void>
.insert(db: D1Database, values: Record<string, unknown>): Promise<void>
```

Insert a single row. This is a raw escape hatch — unlike `Model.create()`, it runs
no lifecycle and does **not** auto-generate the primary key, so supply `id`
yourself (see [`keyStrategy`](./base-model.md#keystrategy-auto-primary-keys) for the
model-level auto-id that `create`/`createMany`/`save` use).

```ts
await User.query().insert(env.DB, { id: crypto.randomUUID(), name: 'Alice', email: 'alice@example.com' })
await User.query().insert({ id: crypto.randomUUID(), name: 'Alice', email: 'alice@example.com' })
```

---

### `insertOrIgnore(values)` | `insertOrIgnore(db, values)`

```ts
.insertOrIgnore(values: Record<string, unknown>): Promise<void>
.insertOrIgnore(db: D1Database, values: Record<string, unknown>): Promise<void>
```

Insert a single row, silently skipping if a row with the same primary key already exists.

```ts
await User.query().insertOrIgnore(env.DB, { id: 'known-id', name: 'Alice', email: 'alice@example.com' })
```

---

### `upsert(values, conflictCols, updateCols?)`

```ts
.upsert(values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): Promise<void>
.upsert(db: D1Database, values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): Promise<void>
```

Insert a row, or update it if a row with the same `conflictCols` already exists. Uses `INSERT ... ON CONFLICT(...) DO UPDATE SET ...`.

When `updateCols` is omitted, **all non-conflict columns** are updated. Pass `updateCols` to update only specific columns.

```ts
// Update all non-PK columns on conflict
await User.query().upsert(env.DB, {
  id: userId,
  name: 'Alice',
  email: 'alice@example.com',
  updated_at: new Date().toISOString(),
}, ['id'])

// Only update email and updated_at on conflict
await User.query().upsert(env.DB, {
  id: userId,
  name: 'Alice',
  email: 'newemail@example.com',
  updated_at: new Date().toISOString(),
}, ['id'], ['email', 'updated_at'])
```

---

### `insertMany(rows)` | `insertMany(db, rows)`

```ts
.insertMany(rows: Record<string, unknown>[]): Promise<void>
.insertMany(db: D1Database, rows: Record<string, unknown>[]): Promise<void>
```

Batch-insert multiple rows using D1's `db.batch()` for a single round-trip. All rows are inserted in one transaction.

```ts
await User.query().insertMany(env.DB, [
  { id: crypto.randomUUID(), name: 'Alice', email: 'alice@example.com' },
  { id: crypto.randomUUID(), name: 'Bob', email: 'bob@example.com' },
  { id: crypto.randomUUID(), name: 'Carol', email: 'carol@example.com' },
])
```

---

### `insertOrIgnoreMany(rows)` | `insertOrIgnoreMany(db, rows)`

```ts
.insertOrIgnoreMany(rows: Record<string, unknown>[]): Promise<void>
.insertOrIgnoreMany(db: D1Database, rows: Record<string, unknown>[]): Promise<void>
```

Batch-insert multiple rows, silently skipping any that conflict on primary key. Uses D1's `db.batch()`.

```ts
await User.query().insertOrIgnoreMany(env.DB, [
  { id: 'existing-id', name: 'Skip', email: 'skip@example.com' },
  { id: crypto.randomUUID(), name: 'New', email: 'new@example.com' },
])
```

---

### `upsertMany(rows, conflictCols, updateCols?)`

```ts
.upsertMany(rows: Record<string, unknown>[], conflictCols: string[], updateCols?: string[]): Promise<void>
.upsertMany(db: D1Database, rows: Record<string, unknown>[], conflictCols: string[], updateCols?: string[]): Promise<void>
```

Batch-upsert multiple rows. Each row is inserted or updated using `ON CONFLICT ... DO UPDATE SET`. All statements are executed in a single `db.batch()` round-trip.

```ts
await User.query().upsertMany(env.DB, [
  { id: 'u1', name: 'Updated Alice', email: 'alice@example.com' },
  { id: 'u2', name: 'New Bob', email: 'bob@example.com' },
], ['id'])

// Only update specific columns on conflict
await User.query().upsertMany(env.DB, users, ['id'], ['name', 'updated_at'])
```

---

### `update(values)` | `update(db, values)`

```ts
.update(values: Record<string, unknown>): Promise<number>
.update(db: D1Database, values: Record<string, unknown>): Promise<number>
```

Update rows matching the current WHERE clauses. Returns the number of changed rows.

```ts
const changed = await User.query()
  .whereEq('role', 'guest')
  .update(env.DB, { role: 'user' })
```

---

### `delete(db?)`

```ts
.delete(db?: D1Database): Promise<number>
```

Delete rows matching the current WHERE clauses. Returns the number of deleted rows.

```ts
const deleted = await Post.query()
  .whereEq('status', 'draft')
  .where('created_at', '<', cutoff)
  .delete(env.DB)
```

---

### `insertReturning` / `updateReturning` / `deleteReturning`

```ts
.insertReturning(values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown> | null>
.insertReturning(db: D1Database, values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown> | null>

.updateReturning(values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown>[]>
.updateReturning(db: D1Database, values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown>[]>

.deleteReturning(returning?: string[]): Promise<Record<string, unknown>[]>
.deleteReturning(db: D1Database, returning?: string[]): Promise<Record<string, unknown>[]>
```

Run the mutation and return the affected rows in one round-trip via SQLite's `RETURNING` clause — handy when the table has generated columns, defaults, or triggers whose values you need immediately. `returning` defaults to `['*']`; passing an empty array throws. These return **raw DB rows** (`Record<string, unknown>`), not hydrated model instances.

```ts
// Grab a default/generated column that the DB fills in
const row = await User.query().insertReturning(env.DB, {
  id: crypto.randomUUID(), name: 'Alice',
})
// row?.created_at is populated by the column default

const [updated] = await User.query()
  .whereEq('id', userId)
  .updateReturning(env.DB, { updated_at: new Date().toISOString() })

const removed = await Token.query()
  .whereEq('user_id', userId)
  .deleteReturning(env.DB, ['id'])
```

> [!WARNING]
> `returning` columns are emitted verbatim into SQL. Wrap any untrusted column names with `safeIdentList()` first. `updateReturning` / `deleteReturning` also honour the current WHERE — with no filter they affect every row.

## Prepared Statements

For atomic multi-table operations using `db.batch()`, use prepared statement methods to get `D1PreparedStatement` objects without executing them. For reusable compiled SELECT queries with named params, see `prepare()` + `placeholder()` under Terminal Methods.

> [!IMPORTANT]
> **`db` is the *leading* argument.** Like the terminal methods, each `to…Prepared()` overload takes an optional `db` **first**, then the values — not trailing. Passing `db` after the values (e.g. `toInsertPrepared(values, db)`) silently ignores it and falls back to the auto-resolved connection.

### `toInsertPrepared(db?, values)`

```ts
.toInsertPrepared(values: Record<string, unknown>): D1PreparedStatement
.toInsertPrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement
```

### `toInsertOrIgnorePrepared(db?, values)`

```ts
.toInsertOrIgnorePrepared(values: Record<string, unknown>): D1PreparedStatement
.toInsertOrIgnorePrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement
```

### `toUpsertPrepared(db?, values, conflictCols, updateCols?)`

```ts
.toUpsertPrepared(values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): D1PreparedStatement
.toUpsertPrepared(db: D1Database, values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): D1PreparedStatement
```

### `toUpdatePrepared(db?, values)`

```ts
.toUpdatePrepared(values: Record<string, unknown>): D1PreparedStatement
.toUpdatePrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement
```

> [!WARNING]
> With no `where*` filter set, this compiles an **unfiltered** `UPDATE … SET` that rewrites every row — it does **not** throw. Always chain a filter (`whereEq(pk, id)`, etc.) before building the statement.

### `toDeletePrepared(db?)`

```ts
.toDeletePrepared(db?: D1Database): D1PreparedStatement
```

> [!WARNING]
> With no `where*` filter set, this compiles an **unfiltered** `DELETE FROM table` that removes every row — it does **not** throw. Always chain a filter first.

### Batch Example

```ts
// Atomic workspace creation: insert workspace + owner membership
await db.batch([
  Workspace.query().toInsertPrepared(db, { id: wsId, name, owner_id: userId }),
  WorkspaceMember.query().toInsertPrepared(db, {
    workspace_id: wsId, user_id: userId, role: 'owner'
  }),
])

// Atomic ownership transfer: 3 updates in one batch
await db.batch([
  WorkspaceMember.query().whereEq('user_id', oldOwner).whereEq('workspace_id', wsId)
    .toUpdatePrepared(db, { role: 'admin' }),
  WorkspaceMember.query().whereEq('user_id', newOwner).whereEq('workspace_id', wsId)
    .toUpdatePrepared(db, { role: 'owner' }),
  Workspace.query().whereEq('id', wsId)
    .toUpdatePrepared(db, { owner_id: newOwner }),
])
```

## Scopes

### `scoped(...names)`

```ts
.scoped(...names: string[]): this
```

Apply one or more named scopes from `static scopes` on the model. Scopes are functions that modify the query builder.

```ts
class Post extends BaseModel<PostAttrs> {
  static scopes = {
    active: (q) => q.where('status', '=', 'active'),
    recent: (q) => q.orderBy('created_at', 'desc').limit(10),
  }
}

Post.query().scoped('active', 'recent').get(db)
```

Throws if the scope name is not defined.

### `withoutGlobalScope(name)` / `withoutGlobalScopes()`

```ts
.withoutGlobalScope(name: string): this
.withoutGlobalScopes(): this
```

Skip a named `static globalScopes` entry - or all of them - for this query only.
Global scopes are auto-applied to every query on the model (reads and bulk writes
alike), without calling `.scoped()`; a common use is multi-tenant row scoping.

```ts
await Document.query().withoutGlobalScope('current_tenant').get(db)  // no tenant filter
await Document.query().withoutGlobalScopes().delete(db)              // skip all - deletes every tenant's rows
```

## Relation Existence Queries

These methods require `static relations` to be defined on the model. See [Relationships API](./relationships.md) for full details.

### `has(relation)` / `doesntHave(relation)`

```ts
.has(relation: string): this
.doesntHave(relation: string): this
```

Filter by existence (or absence) of related models using `EXISTS` subqueries.

```ts
// Users who have at least one post
User.query().has('posts').get(db)

// Posts with no comments
Post.query().doesntHave('comments').get(db)
```

### `whereHas(relation, cb?)` / `whereDoesntHave(relation, cb?)`

```ts
.whereHas(relation: string, cb?: (q: QueryBuilder) => void): this
.whereDoesntHave(relation: string, cb?: (q: QueryBuilder) => void): this
```

Filter by related models matching additional constraints.

```ts
// Users with admin role (belongsToMany)
User.query().whereHas('roles', q => q.where('name', '=', 'admin')).get(db)

// Posts without approved comments
Post.query().whereDoesntHave('comments', q => q.where('approved', '=', 1)).get(db)
```

#### `whereRelation(relation, column, op?, value)` / `orWhereRelation(...)`

Shorthand for a single-condition `whereHas` - `whereHas(relation, q => q.where(column, op, value))`.
Two-arg form uses `=`; three-arg form takes an explicit operator.

```ts
Post.query().whereRelation('comments', 'is_approved', false)   // = whereHas(... q.where('is_approved','=',false))
Post.query().whereRelation('comments', 'votes', '>', 5)
```

> [!TIP]
> **Inner `OR` stays correlated**
>
> The callback runs inside a correlated `EXISTS` subquery whose leading `AND` ties the related rows back to the parent row. If your callback introduces a top-level `orWhere`, its predicates are wrapped in a single group so they can't decorrelate that parent-correlation `AND` — the subquery still matches only related rows, never the whole table.
>
> ```ts
> Post.query()
>   .whereHas('comments', q =>
>     q.where('approved', '=', 1).orWhere('flagged', '=', 1),
>   )
>   .get(db)
> // ... EXISTS (SELECT 1 FROM comments
> //   WHERE comments.post_id = posts.id      ← correlation stays intact
> //     AND (approved = ? OR flagged = ?))   ← callback OR grouped
> ```
>
> A callback with no top-level `OR` is appended flat (no extra parentheses), preserving the simple-case SQL.

All four methods have `or` variants: `orHas`, `orDoesntHave`, `orWhereHas`, `orWhereDoesntHave`.

### `withCount` / `withSum` / `withAvg` / `withMin` / `withMax` / `withExists`

```ts
.withCount(relation: string, as?: string): this
.withSum(relation: string, col: string, as?: string): this
.withAvg(relation: string, col: string, as?: string): this
.withMin(relation: string, col: string, as?: string): this
.withMax(relation: string, col: string, as?: string): this
.withExists(relation: string, as?: string): this   // 0/1 flag
```

Attach correlated aggregate subqueries as virtual columns on each row. One
round-trip, no N+1. Default aliases: `<relation>_count`, `<relation>_<col>_sum`,
`<relation>_<col>_avg`, `<relation>_<col>_min`, `<relation>_<col>_max`,
`<relation>_exists` - override via the trailing `as?` arg. `withExists` yields
`1` when at least one related row matches, else `0` (compiled as `COUNT(*) > 0`).

```ts
// COUNT
const users = await User.query().withCount('posts').get(db)
users[0].get('posts_count')  // number

// SUM / AVG
const u = await User.query()
  .withSum('orders', 'total')
  .withAvg('orders', 'total')
  .get(db)
u[0].get('orders_total_sum')  // number | null (null when no rows)
u[0].get('orders_total_avg')  // number | null

// Custom alias
await User.query().withCount('posts', 'post_count').get(db)
```

Supported on `hasMany` / `hasOne` / `belongsTo` / `belongsToMany` / `hasManyThrough` /
`hasOneThrough` / `morphMany` / `morphOne` / `morphToMany` / `morphedByMany` - through
relations aggregate across the intermediate table (children of soft-deleted through-rows
are excluded). **Throws** on `morphTo` - the inverse
side spans multiple tables and can't be aggregated; aggregate on the owning
`morphMany` side instead.

For `SUM`/`AVG` on a relation with zero rows, SQLite returns `NULL` (not `0`).

### `whereExists(sql, bindings?)` / `whereNotExists(sql, bindings?)`

Low-level EXISTS clause for custom subqueries.

```ts
Post.query().whereExists('SELECT 1 FROM comments WHERE comments.post_id = posts.id', [])
```

## Additional Shape Methods

### `selectRaw(expression)`

```ts
.selectRaw(expression: string): this
```

Add raw SQL expressions to the SELECT clause. Replaces default `*` on first call, appends on subsequent.

```ts
Post.query().selectRaw('user_id, COUNT(*) as cnt').groupBy('user_id')
// SELECT user_id, COUNT(*) as cnt FROM posts GROUP BY user_id

Post.query().select(['id']).selectRaw('LENGTH(title) as title_len')
// SELECT id, LENGTH(title) as title_len FROM posts
```

## Common Table Expressions & Index Hints

### `withCte(name, query, columns?)` / `withRecursive(name, query, columns?)`

```ts
.withCte(name: string, query: QueryBuilder, columns?: string[]): this
.withRecursive(name: string, query: QueryBuilder, columns?: string[]): this
```

Prepend a Common Table Expression built from another `QueryBuilder`. `withCte` emits `WITH name AS (…)`; `withRecursive` emits `WITH RECURSIVE`. If multiple CTEs are added and any one is recursive, the whole list compiles as `WITH RECURSIVE` (SQLite syntax). The optional `columns` names the CTE's output columns.

```ts
const top = User.query().select(['id']).orderBy('score', 'desc').limit(10)

const posts = await Post.query()
  .withCte('top_users', top)
  .whereRaw('user_id IN (SELECT id FROM top_users)')
  .get(db)
// WITH top_users AS (SELECT id FROM users ORDER BY score DESC LIMIT 10)
// SELECT * FROM posts WHERE user_id IN (SELECT id FROM top_users)
```

### `indexedBy(indexName)` / `notIndexed()`

```ts
.indexedBy(indexName: string): this
.notIndexed(): this
```

SQLite planner hints on the primary `FROM` table. `indexedBy` emits `INDEXED BY <name>` to force a specific index; `notIndexed` forbids index usage. Use sparingly — the SQLite query planner is usually smarter, and `INDEXED BY` makes the query fail if the named index is later dropped.

```ts
Post.query().indexedBy('idx_posts_user_id').whereEq('user_id', id).get(db)
// SELECT * FROM posts INDEXED BY idx_posts_user_id WHERE user_id = ?
```

## Pagination & Scalar Results

### `paginate(page, perPage?)`

```ts
.paginate(page: number, perPage?: number): Promise<TPaginationResult<TModel>>
.paginate(db: D1Database, page: number, perPage?: number): Promise<TPaginationResult<TModel>>
```

Runs a count query and a data query, returning paginated results. Default `perPage` is 15.

```ts
const result = await Post.query().scoped('active').paginate(db, 1, 20)

result.data     // Collection<Post> (current page)
result.total    // number (total matching rows)
result.page     // number (current page)
result.perPage  // number
result.lastPage // number (calculated)
```

---

### `paginateCursor(opts, db?)`

Keyset (cursor) pagination — stable under concurrent writes and faster than
offset pagination on large tables. Skips the COUNT query and uses
`hasMore` derived by overfetching one row.

```ts
.paginateCursor(opts: TCursorPaginateOpts, db?: D1Database): Promise<TCursorPaginationResult<TModel>>
```

```ts
// First page
const page1 = await Post.query()
  .whereEq('user_id', uid)
  .paginateCursor({ orderBy: 'created_at', direction: 'desc', perPage: 20 })

page1.data        // Collection<Post>
page1.nextCursor  // string | null — pass as `after` on next call
page1.prevCursor  // string | null
page1.hasMore     // boolean

// Next page
const page2 = await Post.query()
  .whereEq('user_id', uid)
  .paginateCursor({
    orderBy: 'created_at',
    direction: 'desc',
    perPage: 20,
    after: page1.nextCursor!,
  })

// Go back from page2
const back = await Post.query()
  .whereEq('user_id', uid)
  .paginateCursor({
    orderBy: 'created_at',
    direction: 'desc',
    perPage: 20,
    before: page2.prevCursor!,
  })
```

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `orderBy` | `string` | required | Column to sort by. Combined with the model PK as a tiebreaker for deterministic ordering. |
| `direction` | `'asc' \| 'desc'` | `'desc'` | Sort direction. |
| `perPage` | `number` | `20` | Page size. |
| `after` | `string` | — | Cursor from a previous `nextCursor` — advance forward. |
| `before` | `string` | — | Cursor from a previous `prevCursor` — go back. |

#### Notes

- Pass either `after` **or** `before`, not both — throws otherwise.
- Only single-column `orderBy` is supported (with PK tiebreaker). Use
  `paginate()` (offset) when you need multi-column ordering.
- Cursors are opaque base64url payloads — don't parse them on the client.
  The format is implementation detail and may change.
- WHERE filters, joins, scopes, etc. are preserved across pages.

---

### `pluck(col)`

```ts
.pluck(col: string): Promise<unknown[]>
.pluck(db: D1Database, col: string): Promise<unknown[]>
```

Returns a flat array of a single column's values.

```ts
const emails = await User.query().pluck(db, 'email')
// ["alice@example.com", "bob@example.com"]
```

---

### `value(col)`

```ts
.value(col: string): Promise<unknown>
.value(db: D1Database, col: string): Promise<unknown>
```

Returns a single scalar value from the first row.

```ts
const email = await User.query().whereEq('id', 'u1').value(db, 'email')
// "alice@example.com"
```

---

### `chunk(size, cb)`

```ts
.chunk(size: number, cb: (models: TModel[]) => Promise<void | false>): Promise<void>
.chunk(db: D1Database, size: number, cb: (models: TModel[]) => Promise<void | false>): Promise<void>
```

Process query results in batches. The callback receives each batch; return `false` to stop early.

```ts
await Post.query().chunk(db, 100, async (posts) => {
  for (const post of posts) await processPost(post)
})
```

## Result Metadata & Read Replicas

### `getWithMeta(db?)` / `firstWithMeta(db?)` / `lastMeta()`

```ts
.getWithMeta(db?: D1Database): Promise<TQueryResult<Collection<TModel>>>
.firstWithMeta(db?: D1Database): Promise<TQueryResult<TModel | null>>
.lastMeta(): TD1ResultMeta | null
```

`getWithMeta` / `firstWithMeta` run the query and return `{ data, meta, bookmark }`, where `meta` is D1's result metadata (`rows_read`, `rows_written`, `duration`, `changes`, …) and `bookmark` is the active session bookmark (or `null`). `lastMeta()` returns the metadata from the most recent query executed on the builder, or `null` before any has run.

```ts
const { data, meta, bookmark } = await User.query().getWithMeta(env.DB)
res.headers.set('x-rows-read', String(meta.rows_read ?? 0))
```

### `withSession(constraint?)` / `getBookmark()`

```ts
.withSession(constraint?: TSessionConstraint): this
.getBookmark(): string | null
```

Route all queries on this builder through a [D1 read-replica session](https://developers.cloudflare.com/d1/best-practices/read-replication/). `constraint` is `'first-unconstrained'` (default — any replica), `'first-primary'` (force the primary for sequential consistency), or a bookmark string from a prior session to continue read-your-writes. After running queries, `getBookmark()` returns the latest position to hand to the next request.

### `on(name)`

```ts
.on(name: string): this
```

Route this query through a named connection registered via [`configure(env, { connections })`](../guide/configuration.md) or `registerConnection()`. Lower priority than an explicit `db` arg or `Model.query(db)`; higher than the model's `static connection`.

```ts
await Event.query().on('analytics').whereEq('user_id', uid).get()
```

## Collection

`get()` returns a `Collection<T>` — a lightweight wrapper that extends `Array` with utility methods. It's fully backward-compatible with array code.

```ts
import { Collection } from '@orphnet/d1-eloquent'

const users = await User.query().get(db) // Collection<User>

// Extraction
users.pluck('email')               // unknown[]
users.keyBy('id')                  // Map<unknown, User>
users.groupBy('role')              // Map<unknown, Collection<User>>
users.mapToGroups(u => [...])      // Map<K, Collection<V>>

// Filtering
users.where('status', 'active')    // Collection<User>
users.whereIn('role', ['admin'])   // Collection<User>
users.unique('email')              // Collection<User>
users.reject(u => ...)             // Collection<User>
users.contains('name', 'Alice')    // boolean
users.contains(u => u.get('age') > 18) // boolean

// Sorting & slicing
users.sortBy('name')               // Collection<User>
users.sortBy('name', 'desc')       // Collection<User>
users.sortByDesc('name')           // Collection<User>
users.partition(u => ...)          // [Collection<User>, Collection<User>]
users.take(5)                      // Collection<User> (first 5)
users.take(-3)                     // Collection<User> (last 3)
users.skip(10)                     // Collection<User>
users.chunk(10)                    // Collection<Collection<User>>

// Aggregates
users.sum('score')                 // number
users.min('score')                 // number | null
users.max('score')                 // number | null
users.avg('score')                 // number | null

// Element access
users.first()                      // User | undefined
users.first(u => u.get('age') > 18) // User | undefined (predicate)
users.last()                       // User | undefined
users.last(u => u.get('age') > 18)  // User | undefined (predicate)
users.isEmpty()                    // boolean
users.isNotEmpty()                 // boolean

// Transformation (all return Collection, not Array)
users.map(u => u.toObject())       // Collection<Record<...>>
users.filter(u => ...)             // Collection<User>
users.flatMap(u => ...)            // Collection<U>
users.toArray()                    // Record<string, unknown>[]

// Side effects & piping
users.each(u => console.log(u))    // Collection<User> (returns self)
users.tap(c => console.log(c.length)) // Collection<User> (returns self)
users.pipe(c => c.length)          // number (returns callback result)
```
