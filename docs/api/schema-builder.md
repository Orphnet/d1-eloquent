# Schema Builder API Reference

The schema builder generates DDL SQL inside migration files. Import `Schema` and `TMigration` from `@orphnet/d1-eloquent/cli`. The `up` and `down` functions receive a `Schema` instance — no `db` argument, no `exec` call needed. SQL execution is handled by the CLI.

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'
```

---

## Schema methods

### `schema.createTable(name, callback)`

Creates a new table. Passes a `TableBuilder` to the callback for defining columns, constraints, and indexes.

```ts
schema.createTable('posts', (t) => {
  t.id()
  t.text('title')
  t.timestamps()
})
// CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY NOT NULL, ...)
```

### `schema.dropTable(name)`

Drops a table.

```ts
schema.dropTable('posts')
// DROP TABLE IF EXISTS posts
```

### `schema.table(name, callback)`

Alters an existing table. Use `t.addText()`, `t.addInteger()`, or `t.addReal()` inside the callback to add columns.

```ts
schema.table('posts', (t) => {
  t.addText('slug', { nullable: true })
})
// ALTER TABLE posts ADD COLUMN slug TEXT
```

### `schema.raw(sql)`

Appends a raw SQL statement as-is.

```ts
schema.raw('CREATE INDEX idx_posts_slug ON posts (slug)')
```

---

## TableBuilder — create mode

Methods available inside `schema.createTable()` callbacks.

Column methods (`text`, `integer`, `real`, `boolean`) return a `ColumnBuilder` that supports [chainable modifiers](#chainable-column-modifiers) and [foreign key constraints](#foreign-key-constraints). You can use either the options object, the chainable API, or both.

### `t.id(name?)`

Adds a `TEXT PRIMARY KEY NOT NULL` column. Defaults to `"id"`. Returns `this` (the `TableBuilder`).

```ts
t.id()         // id TEXT PRIMARY KEY NOT NULL
t.id('uuid')   // uuid TEXT PRIMARY KEY NOT NULL
```

### `t.text(name, opts?)`

```ts
t.text(name: string, opts?: {
  nullable?: boolean   // default: true
  unique?: boolean     // default: false
  default?: string
}): ColumnBuilder
```

```ts
// Options object style
t.text('title')
t.text('email', { unique: true })
t.text('status', { default: 'draft' })
t.text('bio', { nullable: true })

// Chainable style
t.text('email').unique()
t.text('status').default('draft')
t.text('title').notNull()
```

### `t.integer(name, opts?)`

```ts
t.integer(name: string, opts?: {
  nullable?: boolean
  unique?: boolean
  default?: number
}): ColumnBuilder
```

```ts
t.integer('score')
t.integer('view_count', { default: 0 })

// Chainable
t.integer('view_count').notNull().default(0)
```

### `t.real(name, opts?)`

```ts
t.real(name: string, opts?: {
  nullable?: boolean
  unique?: boolean
  default?: number
}): ColumnBuilder
```

```ts
t.real('price')
t.real('latitude', { nullable: true })
t.real('rating', { default: 0.0 })

// Chainable
t.real('price').notNull().default(0.0)
```

### `t.boolean(name, opts?)`

Stored as `INTEGER` (`0` / `1`).

```ts
t.boolean(name: string, opts?: {
  nullable?: boolean
  default?: boolean
}): ColumnBuilder
```

```ts
t.boolean('is_active', { default: true })

// Chainable
t.boolean('is_active').default(true)
t.boolean('is_draft').notNull().default(false)
```

### `t.json(name, opts?)`

Stored as `TEXT` (SQLite has no JSON storage class) but labelled `JSON` in the generated SQL for tooling. Pair with `static casts = { col: 'json' }` on the model to auto serialize/parse. Pass `validate: true` to add a `CHECK (json_valid(...))` constraint so D1 rejects malformed JSON at write time.

```ts
t.json(name: string, opts?: {
  nullable?: boolean
  unique?: boolean
  default?: string
  validate?: boolean
}): ColumnBuilder
```

```ts
t.json('metadata')
t.json('settings', { validate: true })            // + CHECK (settings IS NULL OR json_valid(settings))
t.json('tags').notNull().default('[]')
```

### `t.blob(name, opts?)`

Adds a `BLOB` column for raw binary data (e.g. encrypted bytes, small images). D1 returns these values as `ArrayBuffer`.

```ts
t.blob(name: string, opts?: {
  nullable?: boolean
  unique?: boolean
}): ColumnBuilder
```

```ts
t.blob('payload')
t.blob('thumbnail', { nullable: true })
```

### `t.timestamps(opts?)`

Adds `created_at TEXT NOT NULL` and `updated_at TEXT NOT NULL`. Returns `this` (the `TableBuilder`).

```ts
t.timestamps(opts?: {
  useCurrentTimestamp?: boolean   // add DEFAULT (datetime('now'))
  nullable?: boolean              // relax the default NOT NULL
}): this
```

```ts
t.timestamps()

// Let SQLite fill the value on raw inserts that bypass the ORM
t.timestamps({ useCurrentTimestamp: true })
// created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
```

The ORM's timestamp manager still sets these on normal `create()` / `save()`; `useCurrentTimestamp` only matters for rows written outside the ORM (e.g. raw `INSERT`).

### `t.softDeletes(opts?)`

Adds a nullable `deleted_at TEXT` column and (by default) an index on it. Returns `this` (the `TableBuilder`).

```ts
t.softDeletes(opts?: {
  column?: string    // default: 'deleted_at'
  index?: boolean    // default: true
  indexName?: string
}): this
```

```ts
t.softDeletes()                          // deleted_at TEXT + index
t.softDeletes({ index: false })          // deleted_at TEXT, no index
t.softDeletes({ column: 'removed_at' })  // custom column name
```

### `t.primary(columns)`

Adds a `PRIMARY KEY` table constraint — use for composite primary keys. For single-column primary keys, prefer `t.id()` or the chainable `.primary()` modifier.

```ts
t.primary('user_id, role_id')
// PRIMARY KEY (user_id, role_id)
```

### `t.unique(columns, indexName?)`

Creates a `CREATE UNIQUE INDEX` statement after the table definition. Auto-names as `uidx_<table>_<col>` if `indexName` is omitted. Use for composite unique constraints or when you need a custom index name. For single-column unique indexes, you can also use the chainable `.unique()` modifier.

```ts
t.unique('email')
// CREATE UNIQUE INDEX uidx_users_email ON users (email)

t.unique('first_name, last_name')
// CREATE UNIQUE INDEX uidx_users_first_name_last_name ON users (first_name, last_name)
```

### `t.index(columns, indexName?)`

Creates a `CREATE INDEX` statement after the table definition. Auto-names as `idx_<table>_<col>`. Use for composite indexes or when you need a custom index name. For single-column indexes, you can also use the chainable `.index()` modifier.

```ts
t.index('user_id')
// CREATE INDEX idx_posts_user_id ON posts (user_id)

t.index('user_id, created_at')
// CREATE INDEX idx_posts_user_id_created_at ON posts (user_id, created_at)
```

### `t.check(expression, name?)`

Adds a table-level `CHECK` constraint (create mode only). For column-level checks, use the chainable `.check()` modifier.

```ts
t.check('age >= 18')
// CHECK (age >= 18)

t.check('age >= 18', 'check_age')
// CONSTRAINT check_age CHECK (age >= 18)
```

### `t.foreign(columns, opts)`

Adds a table-level `FOREIGN KEY` constraint (create mode only). Use for composite foreign keys, or when you prefer keeping FKs separate from column definitions. In alter mode this emits a SQL comment, since SQLite cannot add foreign keys via `ALTER TABLE`.

```ts
t.foreign(columns: string | string[], opts: {
  references: string              // referenced table
  on?: string | string[]          // referenced column(s), default: 'id'
  onDelete?: FKAction             // default: 'restrict'
  onUpdate?: FKAction             // default: 'restrict'
}): this
```

Both the local `columns` and the referenced `on` accept a single name, a comma-separated string, or a `string[]` interchangeably:

```ts
t.foreign('user_id', { references: 'users' })
// FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT

t.foreign(['tenant_id', 'user_id'], { references: 'memberships', on: ['tenant_id', 'user_id'] })
// FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT ON UPDATE RESTRICT

t.foreign('tenant_id, user_id', { references: 'memberships', on: 'tenant_id, user_id', onDelete: 'cascade' })
// FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE ON UPDATE RESTRICT
```

---

## Chainable column modifiers

Column methods (`text`, `integer`, `real`, `boolean`) return a `ColumnBuilder` instance. Chain modifier methods to configure the column. You can mix the options object with chaining — **last-wins** semantics apply when both are used.

### `.nullable(value?)`

Sets the column as nullable. Defaults to `true` when called without an argument.

```ts
t.text('bio').nullable()         // bio TEXT (nullable)
t.text('bio').nullable(false)    // bio TEXT NOT NULL
```

### `.notNull()`

Sugar for `.nullable(false)`.

```ts
t.text('title').notNull()   // title TEXT NOT NULL
```

### `.default(value)`

Sets a default value. Accepts `string`, `number`, or `boolean`. Boolean values are converted to `1`/`0`.

```ts
t.text('status').default('draft')     // status TEXT DEFAULT 'draft'
t.integer('count').default(0)         // count INTEGER DEFAULT 0
t.boolean('active').default(true)     // active INTEGER DEFAULT 1
```

### `.defaultRaw(expression)`

Sets a **raw** (un-quoted) DEFAULT expression — for SQL functions like `CURRENT_TIMESTAMP` or `(datetime('now'))`. The expression is emitted verbatim, so only pass values you generate yourself. Mutually exclusive with `.default()` (last call wins).

```ts
t.text('created_at').defaultRaw("(datetime('now'))")
// created_at TEXT DEFAULT (datetime('now'))
```

### `.collate(sequence)`

Applies a SQLite collation sequence (`NOCASE`, `BINARY`, `RTRIM`) to the column.

```ts
t.text('email').collate('NOCASE').unique()
// email TEXT COLLATE NOCASE  + a case-insensitive unique index
```

### `.unique(indexName?)`

Adds a unique index on the column. Auto-names as `uidx_<table>_<col>`.

```ts
t.text('email').unique()               // + CREATE UNIQUE INDEX uidx_users_email ...
t.text('slug').unique('my_slug_idx')   // + CREATE UNIQUE INDEX my_slug_idx ...
```

### `.index(indexName?)`

Adds a regular index on the column. Auto-names as `idx_<table>_<col>`.

```ts
t.text('user_id').index()   // + CREATE INDEX idx_posts_user_id ...
```

### `.primary()`

Marks the column as the primary key. Also sets `NOT NULL` automatically.

```ts
t.text('key').primary()   // key TEXT PRIMARY KEY NOT NULL
```

### `.check(expression)`

Adds an inline `CHECK` constraint to the column definition.

```ts
t.integer('age').check('age >= 0')
// age INTEGER CHECK (age >= 0)

t.text('status').check("status IN ('draft', 'published')")
// status TEXT CHECK (status IN ('draft', 'published'))
```

### Combining modifiers

Chain as many modifiers as needed:

```ts
t.text('sku').notNull().default('UNKNOWN').unique().check('length(sku) > 0')
// sku TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (length(sku) > 0)
// + CREATE UNIQUE INDEX uidx_products_sku ON products(sku)
```

### Last-wins semantics

When using both the options object and chaining, chain calls override options. Later chains override earlier ones.

```ts
// Options set nullable: true, chain overrides to NOT NULL
t.text('name', { nullable: true }).notNull()
// name TEXT NOT NULL

// Later chain overrides earlier chain
t.text('name').nullable(false).nullable(true)
// name TEXT (nullable)

// Chain default overrides options default
t.text('status', { default: 'old' }).default('new')
// status TEXT DEFAULT 'new'
```

---

## Foreign key constraints

The `ColumnBuilder` (create mode only) supports defining foreign key relationships via chaining. Foreign key constraints are emitted as `FOREIGN KEY` clauses inside the `CREATE TABLE` body, after all column definitions.

> [!TIP]
> Foreign keys are not available on alter-mode column builders (`addText`, `addInteger`, `addReal`) because SQLite does not support adding foreign key constraints via `ALTER TABLE`.

### `.references(table, column?)`

Defines a foreign key reference. The `column` parameter defaults to `'id'`.

```ts
t.text('user_id').references('users')
// FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT

t.text('author_email').references('users', 'email')
// FOREIGN KEY (author_email) REFERENCES users(email) ON DELETE RESTRICT ON UPDATE RESTRICT
```

The referenced `column` accepts a single name, a comma-separated string, or a
`string[]` interchangeably — pass an array (or `'a, b'`) for a composite
referenced key:

```ts
t.text('ref').references('memberships', ['tenant_id', 'user_id'])
// FOREIGN KEY (ref) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT ON UPDATE RESTRICT

t.text('ref').references('memberships', 'tenant_id, user_id')
// same — comma-separated string is normalised identically
```

### `.constrained(table)`

Sugar for `.references(table, 'id')` — for the common case where the foreign key points to the `id` column.

```ts
t.text('user_id').constrained('users')
// FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT
```

### `.onDelete(action)`

Sets the `ON DELETE` action. Defaults to `'restrict'` if not specified.

```ts
t.text('user_id').constrained('users').onDelete('cascade')
// FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT
```

### `.onUpdate(action)`

Sets the `ON UPDATE` action. Defaults to `'restrict'` if not specified.

```ts
t.text('user_id').constrained('users').onUpdate('set null')
// FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE SET NULL
```

### Available FK actions

The `FKAction` type is exported from `@orphnet/d1-eloquent/cli`:

| Action | SQL |
|--------|-----|
| `'cascade'` | `CASCADE` |
| `'restrict'` | `RESTRICT` (default) |
| `'set null'` | `SET NULL` |
| `'set default'` | `SET DEFAULT` |
| `'no action'` | `NO ACTION` |

### Full FK example

```ts
schema.createTable('comments', (t) => {
  t.id()
  t.text('user_id').notNull().constrained('users').onDelete('cascade')
  t.text('post_id').notNull().references('posts', 'id').onDelete('cascade').onUpdate('cascade')
  t.text('body').notNull()
  t.timestamps()
})
```

Generates:

```sql
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE ON UPDATE CASCADE
);
```

> [!NOTE]
> Remember to enable foreign key enforcement in your D1 database with `PRAGMA foreign_keys = ON` — SQLite disables it by default.

### Composite foreign keys

For a foreign key spanning multiple local columns, use the table-level [`t.foreign()`](#t-foreign-columns-opts). Both sides accept a single name, a comma-separated string, or a `string[]` interchangeably:

```ts
schema.createTable('memberships', (t) => {
  t.text('tenant_id').notNull()
  t.text('user_id').notNull()
  t.text('role').notNull()
  t.primary('tenant_id, user_id')
})

schema.createTable('membership_invites', (t) => {
  t.id()
  t.text('tenant_id').notNull()
  t.text('user_id').notNull()
  t.foreign(['tenant_id', 'user_id'], {
    references: 'memberships',
    on: ['tenant_id', 'user_id'],
    onDelete: 'cascade',
  })
  t.timestamps()
})
// FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE ON UPDATE RESTRICT
```

---

## TableBuilder — alter mode

Methods available inside `schema.table()` callbacks. Alter-mode column methods return an `AlterColumnBuilder` that supports the same [chainable modifiers](#chainable-column-modifiers) as create mode, **except** for foreign key methods (`.references()`, `.constrained()`, `.onDelete()`, `.onUpdate()`).

### `t.addText(name, opts?)`

```ts
t.addText(name: string, opts?: {
  nullable?: boolean
  default?: string
}): AlterColumnBuilder
```

```ts
// Options object style
schema.table('posts', (t) => {
  t.addText('slug', { nullable: true })
})
// ALTER TABLE posts ADD COLUMN slug TEXT

// Chainable style
schema.table('posts', (t) => {
  t.addText('slug').unique()
})
// ALTER TABLE posts ADD COLUMN slug TEXT;
// CREATE UNIQUE INDEX IF NOT EXISTS uidx_posts_slug ON posts(slug);
```

### `t.addInteger(name, opts?)`

```ts
t.addInteger(name: string, opts?: {
  nullable?: boolean
  default?: number
}): AlterColumnBuilder
```

```ts
schema.table('posts', (t) => {
  t.addInteger('view_count').notNull().default(0)
})
// ALTER TABLE posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
```

### `t.addReal(name, opts?)`

```ts
t.addReal(name: string, opts?: {
  nullable?: boolean
  default?: number
}): AlterColumnBuilder
```

```ts
schema.table('products', (t) => {
  t.addReal('score').index()
})
// ALTER TABLE products ADD COLUMN score REAL;
// CREATE INDEX IF NOT EXISTS idx_products_score ON products(score);
```

### `t.addBoolean` / `t.addBlob` / `t.addJson`

Alter-mode counterparts to `t.boolean()` / `t.blob()` / `t.json()`, mirroring their create-mode options (`addJson` supports `validate`). Each returns an `AlterColumnBuilder`.

```ts
schema.table('posts', (t) => {
  t.addBoolean('is_pinned').notNull().default(false)
  t.addJson('metadata', { validate: true })
})
```

### `t.dropColumn(name)` / `t.renameColumn(from, to)`

Drop or rename a column in place. `DROP COLUMN` requires SQLite ≥ 3.35 and `RENAME COLUMN` ≥ 3.25 — both are available on D1. Alter-mode only; calling them in `createTable()` throws.

```ts
schema.table('posts', (t) => {
  t.dropColumn('legacy_flag')      // ALTER TABLE posts DROP COLUMN legacy_flag;
  t.renameColumn('body', 'content') // ALTER TABLE posts RENAME COLUMN body TO content;
})
```

### `t.dropSoftDeletes(column?)`

In **alter mode** (`schema.table()`) this drops the column via `ALTER TABLE … DROP COLUMN` (SQLite ≥ 3.35 / D1) — the inverse of `t.softDeletes()`. In **create mode** it's a no-op that emits a SQL comment.

```ts
schema.table('posts', (t) => {
  t.dropSoftDeletes()
})
// ALTER TABLE posts DROP COLUMN deleted_at;
```

> [!NOTE]
> `t.softDeletes()` also creates an index on `deleted_at`. Dropping the column does not drop that index — add `t.dropIndex('idx_posts_deleted_at')` (or your custom index name) alongside `dropSoftDeletes()` if you need it gone.

---

## Additional schema methods

Beyond the core surface above, the `Schema` instance exposes further DDL helpers (all grounded in the same builder). Reach for these when a migration needs more than tables and columns:

| Method | Purpose |
|---|---|
| `schema.createIndex(name, table, cols, opts?)` | Standalone `CREATE INDEX` (supports `unique`, partial `where`) outside a `createTable` block |
| `schema.dropIndex(name)` | `DROP INDEX IF EXISTS` |
| `schema.renameTable(from, to)` | `ALTER TABLE … RENAME TO` |
| `schema.createView(name, select)` / `schema.dropView(name)` | Create / drop a `VIEW` |
| `schema.createTrigger(name, opts)` / `schema.dropTrigger(name)` | Create / drop a `TRIGGER` |
| `schema.createVirtualTable(name, module, cb)` | Base primitive for FTS5 / R\*Tree virtual tables |
| `schema.createFts5Table(name, opts)` | Convenience for an FTS5 full-text index (tokenizer, external content, sync triggers) |
| `schema.createTable(name, cb, opts)` | `opts` toggles `strict`, `withoutRowid`, `ifNotExists` |

Column builders also support `.check(expr)`, partial indexes via `.index().where('…')` / `.unique().where('…')`, and computed columns via `.generatedAs(expr, 'virtual' | 'stored')`.

---

## Complete migration examples

### Basic table with options object

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260301000000_create_posts_table',

  up: (schema: Schema) => {
    schema.createTable('posts', (t) => {
      t.id()
      t.text('user_id')
      t.text('title')
      t.text('status', { default: 'draft' })
      t.text('body', { nullable: true })
      t.softDeletes()
      t.timestamps()
      t.index('user_id')
    })
  },

  down: (schema: Schema) => {
    schema.dropTable('posts')
  },
}

export default migration
```

### Same table with chainable API

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260301000000_create_posts_table',

  up: (schema: Schema) => {
    schema.createTable('posts', (t) => {
      t.id()
      t.text('user_id').index()
      t.text('title')
      t.text('status').default('draft')
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

### Table with foreign keys

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260301000000_create_comments_table',

  up: (schema: Schema) => {
    schema.createTable('comments', (t) => {
      t.id()
      t.text('user_id').notNull().constrained('users').onDelete('cascade')
      t.text('post_id').notNull().constrained('posts').onDelete('cascade')
      t.text('parent_id').references('comments').onDelete('set null')
      t.text('body').notNull()
      t.timestamps()
    })
  },

  down: (schema: Schema) => {
    schema.dropTable('comments')
  },
}

export default migration
```

### Adding a column later

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20260315000000_add_view_count_to_posts',

  up: (schema: Schema) => {
    schema.table('posts', (t) => {
      t.addInteger('view_count').notNull().default(0)
    })
  },

  down: (schema: Schema) => {
    schema.table('posts', (t) => {
      t.dropColumn('view_count')   // ALTER TABLE posts DROP COLUMN view_count (SQLite ≥ 3.35 / D1)
    })
  },
}

export default migration
```
