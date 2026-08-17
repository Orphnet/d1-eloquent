# Generators

Generator commands scaffold boilerplate files so you can focus on implementation rather than file structure. All generators are prefixed with `make:`.

## make:migration

Generate a new migration file with `up()` and `down()` stubs.

```bash
bunx d1-eloquent make:migration <name> [--factory] [--seeder] [--all]
```

**Output:** `src/database/migrations/<timestamp>_<name>.ts`

| Option | Description |
|--------|-------------|
| `--factory` | Also scaffold a matching factory. The model name is guessed from `<name>` with the leading `create_`/`alter_`/`update_`/`drop_` verb stripped (e.g. `create_posts` → `PostsFactory`). |
| `--seeder` | Also scaffold a matching seeder (e.g. `create_posts` → `PostsSeeder`). |
| `--all` | Scaffold both a factory and a seeder alongside the migration. |

**Example:**

```bash
bunx d1-eloquent make:migration create_posts_table
```

Generated file (`src/database/migrations/20240115_000000_create_posts_table.ts`):

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20240115_000000_create_posts_table',
  // description: 'Purpose of this migration',

  up: (schema: Schema) => {
    // schema.createTable('posts', (t) => {
    //   t.id()
    //   t.timestamps()
    // })
  },

  down: (schema: Schema) => {
    // schema.dropTable('posts')
  },
}

export default migration
```

---

## make:model

Generate a model class that extends `BaseModel` with a typed attributes interface.

```bash
bunx d1-eloquent make:model <Name> [--soft-deletes]
```

**Output:** `src/app/models/<Name>.ts`

Pass `--soft-deletes` to add a `deleted_at?: string | null` field to the attributes type and set `static softDeletes = true`.

**Example:**

```bash
bunx d1-eloquent make:model Post
```

Generated file (`src/app/models/Post.ts`):

```ts
import { BaseModel } from '@orphnet/d1-eloquent'

export type TPostAttrs = {
  id: string
  // add fields
  created_at: string
  updated_at: string
}

export class Post extends BaseModel<TPostAttrs> {
  public static table = 'posts'
  public static primaryKey = 'id'
  public static softDeletes = false

  // public static revisions = { enabled: true, mode: 'diff+after', includeRequestId: true }
  // public static eagerLoaders = { ... }
}
```

---

## make:seeder

Generate a seeder class with a `run(db)` method stub.

```bash
bunx d1-eloquent make:seeder <Name>
```

**Output:** `src/database/seeders/<Name>.ts`

**Example:**

```bash
bunx d1-eloquent make:seeder PostSeeder
```

Generated file (`src/database/seeders/PostSeeder.ts`):

```ts
import type { TSeeder, TSeederOpts } from '@orphnet/d1-eloquent/cli'
import { fake, output } from '@orphnet/d1-eloquent/cli'
// import { YourFactory } from '../factories/YourFactory'

const seeder: TSeeder = {
  name: 'PostSeeder',
  // description: 'Purpose of this seeder',
  run: async (opts: TSeederOpts): Promise<void> => {
    // const factory = new YourFactory()
    // const rows = await factory.createMany(opts, 50)
    //
    // output.log(`Seeded ${rows.length} records`, { tag: 'post' })
  },
}

export default seeder
```

The stub imports the `fake` (data generation) and `output` (formatted logging) helpers ready for use.

For usage patterns — including combining seeders with factories — see [Seeders & Factories](../guide/seeders-factories.md).

---

## make:factory

Generate a factory class with a `definition()` method that returns partial model attributes.

```bash
bunx d1-eloquent make:factory <Name>
```

**Output:** `src/database/factories/<Name>.ts`

**Example:**

```bash
bunx d1-eloquent make:factory PostFactory
```

Generated file (`src/database/factories/PostFactory.ts`):

```ts
import { Factory } from '@orphnet/d1-eloquent'

export type TPostAttrs = {
  id: string
  // add fields
  created_at: string
  updated_at: string
}

export class PostFactory extends Factory<TPostAttrs> {
  public readonly table = 'posts'

  public definition(): TPostAttrs {
    const ts = new Date().toISOString()
    return {
      id: crypto.randomUUID(),
      // define defaults
      created_at: ts,
      updated_at: ts,
    }
  }
}
```

For usage patterns — including overrides and bulk creation — see [Seeders & Factories](../guide/seeders-factories.md).

---

## make:resource

Generate a model, migration, factory, and seeder in a single command.

```bash
bunx d1-eloquent make:resource <Name> [--soft-deletes]
```

Pass `--soft-deletes` to generate the model with soft-delete support (only the model is affected — the migration and factory are unchanged).

**Example:**

```bash
bunx d1-eloquent make:resource Post
```

Example output:

```
Generating resource: Post
Created model: src/app/models/Post.ts
Created migration: src/database/migrations/20240115_000000_create_posts.ts
Created factory: src/database/factories/PostFactory.ts
Created seeder: src/database/seeders/PostSeeder.ts
Resource Post created (model + migration + factory + seeder)
```

This is equivalent to running `make:model Post`, `make:migration create_posts`, `make:factory PostFactory`, and `make:seeder PostSeeder` separately. The table name is derived by pluralizing the model name (`Post` → `posts`).

---

## make:pivot

Generate a pivot table migration for a many-to-many relationship. No model or seeder is created — pivot tables are typically managed directly through the join table.

```bash
bunx d1-eloquent make:pivot <pivot_table>
```

**Output:** `src/database/migrations/<timestamp>_create_<pivot_table>.ts`

The table name is used to derive two foreign key column names: the last underscore-separated segment is singularized for one FK, and everything before it forms the other. For example, `user_roles` produces `user_id` and `role_id`. The table name must contain at least two segments (an underscore) or the command errors out.

**Example:**

```bash
bunx d1-eloquent make:pivot user_roles
```

Generated file (`src/database/migrations/20240115_000000_create_user_roles.ts`):

```ts
import type { TMigration } from '@orphnet/d1-eloquent/cli'
import { Schema } from '@orphnet/d1-eloquent/cli'

const migration: TMigration = {
  name: '20240115_000000_create_user_roles',

  up: (schema: Schema) => {
    schema.createTable('user_roles', (t) => {
      t.text('user_id', { nullable: false })
      t.text('role_id', { nullable: false })
      t.primary('user_id, role_id')
      t.index('user_id')
      t.index('role_id')
    })
  },

  down: (schema: Schema) => {
    schema.dropTable('user_roles')
  },
}

export default migration
```

For usage patterns after generating, see the [Seeders & Factories](../guide/seeders-factories.md) guide.

---

## make:dto

Generate a typed attributes interface for a single model. Reads the model source and its corresponding migration to produce `TModelAttrs` (all fields) and `TModelCreateAttrs` (omitting auto-generated fields like `id`, `created_at`, `updated_at`, `deleted_at`).

```bash
bunx d1-eloquent make:dto <model> [--out-dir=path] [--force]
```

**Output:** `src/types/generated/<Model>Attrs.ts` (default, override with `--out-dir`)

| Option | Description |
|--------|-------------|
| `--out-dir=path` | Output directory (default: `src/types/generated`) |
| `--force` | Overwrite without prompting |

**Example:**

```bash
bunx d1-eloquent make:dto User
```

Generated file (`src/types/generated/UserAttrs.ts`):

```ts
// Auto-generated by d1-eloquent make:dto
// Source model: User

export type TUserAttrs = {
  id: string;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
};

export type TUserCreateAttrs = {
  name: string;
  email: string;
};
```

If the file already exists, the CLI will prompt for confirmation before overwriting. Pass `--force` to skip the prompt.

---

## make:types

Generate typed attributes for **all** models in the project, plus a barrel `index.ts` that re-exports everything.

```bash
bunx d1-eloquent make:types [--out-dir=path] [--force] [--json]
```

**Output:** Individual `<Model>Attrs.ts` files + `index.ts` barrel in `src/types/generated/` (default)

| Option | Description |
|--------|-------------|
| `--out-dir=path` | Output directory (default: `src/types/generated`) |
| `--force` | Overwrite all without prompting |
| `--json` | Machine-readable output |

**Example:**

```bash
bunx d1-eloquent make:types
```

Example output:

```
Generating types for 3 model(s)...

Created DTO: src/types/generated/UserAttrs.ts
Created DTO: src/types/generated/PostAttrs.ts
Created DTO: src/types/generated/CommentAttrs.ts
Created barrel: src/types/generated/index.ts

Done: 3 generated, 0 skipped
```

Models that cannot be parsed are skipped with a warning. Use `--json` for CI integration.

---

## generate

`generate` is a different kind of generator - instead of scaffolding a stub, it diffs each model's desired schema against the migrations already on disk and emits a reconciling migration (`createTable` for a new table, add/drop-column alters for a changed one). It never opens a database - the emitted file is the review gate.

```bash
bunx d1-eloquent generate [model] [--write] [--name=<name>]
```

| Option | Description |
|--------|-------------|
| `[model]` | Optional positional argument. Diff only the named model (matched against model filenames, case-insensitive). Errors if no matching model file is found. Omit to diff every model. |
| `--write` | Emit the migration file(s). Without it, `generate` is a dry run: it prints the per-model diff and exits without writing anything. |
| `--name=<name>` | Custom base name for the emitted migration (the file becomes `<timestamp>_<name>.ts`). Only applied when exactly one migration is written; with multiple changed tables the default `create_<table>` / `update_<table>` names are used. |

**Dry run (default):**

```bash
bunx d1-eloquent generate
```

Prints the diff for every model: added columns, dropped columns (flagged as destructive), and in-place type changes. If nothing diverges, it reports the schema is in sync.

**Emit the migration:**

```bash
bunx d1-eloquent generate Post --write
```

Migration files are written to the directory your existing migrations live in (falling back to `src/database/migrations/` for a greenfield project). When several tables changed, each file gets a distinct, increasing timestamp so the apply order is stable.

> [!WARNING]
> Always review the generated file(s) before running `migrate`:
>
> - **Destructive drops.** A column present in migrations but missing from the model is emitted as a `dropColumn`. The write succeeds but is flagged with a warning - confirm the drop is intentional.
> - **Type changes.** SQLite cannot alter a column's type in place, so in-place type changes are reported as warnings and never auto-emitted. Recreate the affected table manually if you need the change.
> - **Unparseable models.** A model whose attribute type cannot be parsed derives zero columns; rather than emitting a drop-everything migration, it is skipped with a warning.
> - **FK ordering.** With multiple new tables, cross-table foreign-key ordering may still need a manual reorder of the emitted files.

After reviewing, apply the migration with [`migrate`](./migrate.md).
