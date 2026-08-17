# Seeders & Factories

Seeders and factories give you a structured way to populate a local D1 database with realistic test data. Factories define how to generate a single model's attributes; seeders orchestrate how many records to create and in what order.

## Overview

| Concept | Responsibility |
|---------|----------------|
| **Factory** | Generates attribute objects for a single model; inserts rows via wrangler |
| **Seeder** | Uses factories to create records; controls count and relations |
| **Fake** | Lightweight, zero-dependency data generator (names, emails, dates, etc.) |
| **SeederOutput** | Structured console output — cards, tagged lists, highlights |
| **CLI seed** | Loads and runs a seeder file by name against a D1 database |

## Generate with the CLI

The CLI scaffolds both files for you:

```sh
# Generate a factory for the User model
bunx d1-eloquent make:factory UserFactory

# Generate a seeder for the User model
bunx d1-eloquent make:seeder UserSeeder
```

Or generate a model, migration, factory, and seeder all at once:

```sh
bunx d1-eloquent make:resource User
```

Generated files are placed in:

- `src/database/factories/UserFactory.ts`
- `src/database/seeders/UserSeeder.ts`

> [!WARNING]
> **Seeder names are restricted**
> Seeder names may only contain letters, numbers, and underscores (`[A-Za-z0-9_]`). The name is interpolated into a filesystem path and dynamically imported, so this restriction blocks path-traversal (`../../evil`). The CLI rejects any `--seeder` value with other characters, and `make:seeder` normalises the name to a `Seeder`-suffixed class identifier.

## Writing a Factory

Extend `Factory<TAttrs>` from `@orphnet/d1-eloquent`. Define `table` and `definition()` — `definition()` returns one complete set of attributes:

```ts
// src/database/factories/UserFactory.ts
import { Factory, fake } from '@orphnet/d1-eloquent/cli'

export type TUserAttrs = {
  id: string
  name: string
  email: string
  role: string
  created_at: string
  updated_at: string
}

export class UserFactory extends Factory<TUserAttrs> {
  public readonly table = 'users'

  public definition(): TUserAttrs {
    const now = fake.now()
    return {
      id: fake.uuid(),
      name: fake.name(),
      email: fake.email(),
      role: 'user',
      created_at: now,
      updated_at: now,
    }
  }
}
```

### Factory methods

| Method | Returns | Description |
|--------|---------|-------------|
| `factory.make(overrides?)` | `TAttrs` | Build one attribute object in memory |
| `factory.makeMany(count, overrides?)` | `TAttrs[]` | Build many attribute objects in memory |
| `factory.create(opts, overrides?, createOpts?)` | `Promise<TAttrs>` | Build and insert one row |
| `factory.createMany(opts, count, overrides?, createOpts?)` | `Promise<TAttrs[]>` | Build and insert many rows |

`overrides` on `makeMany` and `createMany` accepts a static object or a **per-row callback**:

```ts
// Same overrides for every row
await factory.createMany(opts, 10, { status: 'active' })

// Per-row callback — receives the row index
const roles = ['admin', 'editor', 'viewer']
await factory.createMany(opts, 3, (i) => ({ role: roles[i] }))
```

`opts` is the `TSeederOpts` passed to your seeder's `run()` function. Pass it through directly.

The optional `createOpts` parameter accepts:

| Option | Description |
|--------|-------------|
| `orIgnore` | Use `INSERT OR IGNORE` — skip rows that conflict on primary key |
| `upsert` | Use `INSERT ... ON CONFLICT DO UPDATE SET` — update rows that conflict on the target column(s). FK-safe alternative to `INSERT OR REPLACE` |
| `conflictTarget` | Column(s) for the `ON CONFLICT` clause. Defaults to `"id"`. Accepts `string` or `string[]` |

When `--idempotent` is passed to the CLI, all factory inserts automatically use UPSERT without needing `createOpts`.

## Writing a Seeder

A seeder is a `TSeeder` object with a `name`, an optional `description`, and a `run(opts)` function. The `opts` argument contains the database config — pass it to factory methods for insertion.

The `description` field is optional metadata that documents the seeder's purpose. It is shown in CLI output when running with `--verbose` / `-v`:

```ts
const seeder: TSeeder = {
  name: 'FixCreatedAtSeeder',
  description: 'Corrects create_at → created_at to fix BUG-01',
  run: async (opts) => { /* ... */ },
}
```

```ts
// src/database/seeders/UserSeeder.ts
import type { TSeeder, TSeederOpts } from '@orphnet/d1-eloquent/cli'
import { fake, output } from '@orphnet/d1-eloquent/cli'
import { UserFactory } from '../factories/UserFactory'

const seeder: TSeeder = {
  name: 'UserSeeder',

  run: async (opts: TSeederOpts): Promise<void> => {
    const factory = new UserFactory()

    // Batch-insert 50 regular users (single SQL statement per chunk)
    const users = await factory.createMany(opts, 50)

    // Create one admin with known credentials
    const password = fake.password(12)
    const admin = await factory.create(opts, {
      role: 'admin',
      email: 'admin@example.com',
    })

    // Structured output
    output.card('Admin Credentials', {
      Email: admin.email,
      Password: password,
    })

    output.summary({ users: users.length + 1 })
  },
}

export default seeder
```

> [!TIP]
> **Extensionless relative imports just work**
> Relative imports inside seeders, factories, and models (e.g. `from '../factories/UserFactory'` or `from '../models/User'`) resolve **without** an explicit `.ts` extension. The CLI registers a `node:module` resolution hook so plain Node matches Bun and tsx here — write the clean extensionless form. Imports with explicit extensions still work too; you don't need to rewrite existing files. (The hook is a no-op under Bun, which already resolves extensionless TS natively.)

## Seeding Relational Data

When seeding models with foreign key relationships, seed parent models first:

```ts
// src/database/seeders/PostSeeder.ts
import type { TSeeder, TSeederOpts } from '@orphnet/d1-eloquent/cli'
import { UserFactory } from '../factories/UserFactory'
import { PostFactory } from '../factories/PostFactory'

const seeder: TSeeder = {
  name: 'PostSeeder',

  run: async (opts: TSeederOpts): Promise<void> => {
    const users = new UserFactory()
    const posts = new PostFactory()

    // 1. Create authors first
    const authors = await users.createMany(opts, 5)

    // 2. Create 3 posts per author
    for (const author of authors) {
      await posts.createMany(opts, 3, { author_id: author.id })
    }

    console.log(`Seeded ${authors.length} authors and ${authors.length * 3} posts`)
  },
}

export default seeder
```

> [!WARNING]
> **Seed order matters**
> If your `posts` table has a foreign key on `author_id` referencing `users.id`, you must seed users before posts. Run seeders in the correct order by invoking them with `--seeder` separately, or in separate CLI calls.

## Running Seeders

The CLI searches for seeders by name across multiple directories, in order:

1. `src/database/seeders/`
2. `src/seeders/`
3. `seeders/`
4. `database/seeders/`
5. `src/plugins/<name>/seeders/`
6. `src/plugins/<name>/database/seeders/`

The first matching file wins. The D1 binding is read from `wrangler.jsonc` automatically and defaults to local — no `--db`/`--local` flags needed. Run a single seeder by name (positional, matching the `seed [seeder]` usage):

```sh
bunx d1-eloquent seed UserSeeder
```

Run the default `DatabaseSeeder` (the name the CLI looks for when no seeder is named):

```sh
bunx d1-eloquent seed
```

Run against your remote Cloudflare D1 database:

```sh
bunx d1-eloquent seed --remote
```

> [!TIP]
> **Use local seeding for development**
> Pair `seed` with `fresh` to start with a clean slate:
>
> ```sh
> # Drop all tables, rerun all migrations, then seed
> bunx d1-eloquent fresh
> bunx d1-eloquent seed UserSeeder
> ```

## Idempotent & Fresh Seeding

By default, running a seeder twice inserts duplicate rows. Two CLI flags control this behavior:

### `--idempotent`

Uses an `INSERT ... ON CONFLICT DO UPDATE` upsert so rows that conflict on the primary key are updated instead of duplicated (FK-safe, unlike `INSERT OR REPLACE`):

```sh
bunx d1-eloquent seed --idempotent
```

### `--fresh`

Deletes all existing rows from each table before inserting. Each table is cleared once per run, even when multiple factories target it:

```sh
bunx d1-eloquent seed --fresh
```

You can also use `--clear` as an alias for `--fresh`.

### `--pretend`

Dry-run mode — prints the SQL each factory would run (prefixed `-- [pretend]`) without touching the database, so you can review the generated inserts before committing to a seed:

```sh
bunx d1-eloquent seed --pretend
```

`--pretend` also applies to `--fresh`'s table-clear step: the `DELETE` is printed, not executed.

### Combining both

For maximum safety, combine both flags — clear tables then upsert:

```sh
bunx d1-eloquent seed --fresh --idempotent
```

### Using in code

Both flags are available on `opts` inside your seeder, so custom seeders using `d1Execute` directly can check them:

```ts
const seeder: TSeeder = {
  name: 'CustomSeeder',
  run: async (opts: TSeederOpts): Promise<void> => {
    if (opts.fresh) {
      // opts.fresh is true when --fresh or --clear is passed
    }
    if (opts.idempotent) {
      // opts.idempotent is true when --idempotent is passed
    }
    if (opts.pretend) {
      // opts.pretend is true when --pretend is passed (dry run — don't write)
    }
  },
}
```

> [!WARNING]
> **`--fresh` only clears seeded tables**
> The `--fresh` flag only deletes rows from tables that factories insert into during the current run. It does not drop or recreate tables — use the [`fresh`](../cli/fresh.md) migration command for that.

## Factory `make` vs `create`

Use `make`/`makeMany` when you only need attribute objects in memory (e.g., to pass into `Model.create()` yourself, or in unit tests). Use `create`/`createMany` when you want the factory to insert the rows directly via wrangler.

```ts
const factory = new UserFactory()

// In-memory only — no DB write
const attrs = factory.make({ role: 'admin' })

// Inserts into D1 via wrangler
await factory.create(opts, { role: 'admin' })
```

> [!TIP]
> **Batch inserts**
> `createMany` automatically batches rows into multi-row `INSERT` statements (up to 50 rows per statement), so seeding 500 rows is only ~10 wrangler calls instead of 500.

## Fake Data Generator

The built-in `fake` helper generates realistic seed data with zero dependencies. It uses a seeded PRNG so runs can be made reproducible.

```ts
import { fake } from '@orphnet/d1-eloquent/cli'
```

### Identity

| Method | Example output |
|--------|----------------|
| `fake.firstName()` | `"Alice"` |
| `fake.lastName()` | `"Garcia"` |
| `fake.name()` | `"Alice Garcia"` |
| `fake.email()` | `"alice_garcia42@example.com"` |
| `fake.email("acme.com")` | `"bob.smith7@acme.com"` |
| `fake.username()` | `"alice4821"` |
| `fake.company()` | `"Garcia Solutions"` |
| `fake.phone()` | `"+1-555-234-1987"` |
| `fake.address()` | `"4821 Garcia Blvd"` |

### Strings

| Method | Example output |
|--------|----------------|
| `fake.uuid()` | `"a1b2c3d4-..."` |
| `fake.password(16)` | `"kX9#mPq2vR4z!nBw"` |
| `fake.hex(8)` | `"3f8a1b2c9d4e5f67"` |
| `fake.slug(3)` | `"lorem-ipsum-dolor"` |
| `fake.url()` | `"https://example.com/lorem-ipsum"` |

### Text

| Method | Example output |
|--------|----------------|
| `fake.words(5)` | `["lorem", "ipsum", "dolor", "sit", "amet"]` |
| `fake.sentence()` | `"Lorem ipsum dolor sit amet consectetur."` |
| `fake.paragraph()` | Multiple sentences |
| `fake.paragraphs(3)` | Three paragraphs separated by newlines |

### Primitives

| Method | Example output |
|--------|----------------|
| `fake.int(1, 100)` | `42` |
| `fake.float(0, 1)` | `0.7312` |
| `fake.boolean()` | `true` |
| `fake.boolean(0.8)` | `true` (80% probability) |
| `fake.pick(['a', 'b', 'c'])` | `"b"` |
| `fake.pickMany(['a', 'b', 'c'], 2)` | `["c", "a"]` |
| `fake.shuffle([1, 2, 3])` | `[3, 1, 2]` |

### Dates

By default, `fake.date()` returns an ISO string. Pass a `format` option to use PHP-style date tokens:

```ts
fake.date()                           // "2025-08-14T09:32:11.000Z"
fake.date({ format: 'Y-m-d' })       // "2025-08-14"
fake.date({ format: 'd/m/Y H:i' })   // "14/08/2025 09:32"
fake.date({ format: 'D, d M Y' })    // "Thu, 14 Aug 2025"
fake.now()                            // current ISO timestamp
fake.pastDate(30)                     // within last 30 days
fake.futureDate(90, 'Y-m-d')         // within next 90 days, formatted
```

**Supported format tokens:**

| Token | Description | Example |
|-------|-------------|---------|
| `Y` | 4-digit year | `2025` |
| `y` | 2-digit year | `25` |
| `m` | Month (zero-padded) | `08` |
| `n` | Month (no padding) | `8` |
| `F` | Full month name | `August` |
| `M` | Short month name | `Aug` |
| `d` | Day (zero-padded) | `14` |
| `j` | Day (no padding) | `14` |
| `D` | Short day name | `Thu` |
| `l` | Full day name | `Thursday` |
| `H` | Hour 24h (zero-padded) | `09` |
| `h` | Hour 12h (zero-padded) | `09` |
| `G` | Hour 24h (no padding) | `9` |
| `g` | Hour 12h (no padding) | `9` |
| `i` | Minutes (zero-padded) | `32` |
| `s` | Seconds (zero-padded) | `11` |
| `A` / `a` | AM/PM | `AM` / `am` |
| `U` | Unix timestamp | `1723628531` |
| `T` | Timezone abbreviation | `UTC` |
| `c` | ISO 8601 | `2025-08-14T09:32:11.000Z` |

Escape literal characters with `\\`: `fake.date({ format: 'Y\\-m\\-d' })`.

### Reproducible runs

Call `fake.seed(n)` at the top of your seeder for deterministic output:

```ts
fake.seed(42)
fake.name()  // always "Carol Martinez" (for seed 42)
fake.email() // always the same email
```

### Using @faker-js/faker instead

The built-in `fake` covers common seeding needs. If you need more (locales, finance, images, etc.), install `@faker-js/faker` and use it directly in your factory `definition()` — no configuration needed.

## Seeder Output

The `output` helper provides structured console output for seeders — boxed cards, tagged list lines, highlights, and summaries.

```ts
import { output } from '@orphnet/d1-eloquent/cli'
```

### Cards

Display boxed key-value cards for credentials or important data:

```ts
output.card('Orphnet — Credentials', {
  Email: 'dev@example.com',
  Password: '6983f298-1aef-4c',
  Workspaces: ['owner (Orphnet)', 'admin (Acme Corp)', 'admin (Spectra)'],
})
```

Output:

```
  ┌───────────────────────────────────────┐
  │  Orphnet — Credentials                │
  ├───────────────────────────────────────┤
  │  Email:       dev@example.com         │
  │  Password:    6983f298-1aef-4c        │
  │  Workspaces:  owner (Orphnet)         │
  │               admin (Acme Corp)       │
  │               admin (Spectra)         │
  └───────────────────────────────────────┘
```

Multi-value fields (arrays) are rendered as continuation lines, aligned with the value column.

### Tagged list lines

Log progress with optional tags and counters:

```ts
output.log('User: Spectra Docs <docs@spectra.dev>', { tag: 'spectra' })
output.log('Workspace: Spectra (slug: spectra)', { tag: 'spectra' })
output.log('Workspace member: docs@spectra.dev as owner', { tag: 'spectra', counter: [15, 50] })
output.log('Project: Spectra API Reference', { tag: 'acme' })
```

Output:

```
  [spectra] ✓ User: Spectra Docs <docs@spectra.dev>
  [spectra] ✓ Workspace: Spectra (slug: spectra)
  [spectra] 15/50 ✓ Workspace member: docs@spectra.dev as owner
  [acme] ✓ Project: Spectra API Reference
```

Options:

| Option | Type | Description |
|--------|------|-------------|
| `tag` | `string` | Label in brackets |
| `counter` | `[number, number]` | Progress counter, e.g. `[15, 50]` → `15/50` |
| `symbol` | `string` | Override the default `✓`. Use `✗`, `…`, `→`, etc. |
| `indent` | `number` | Indent depth (multiples of 2 spaces, default: 1) |

### Highlights

Surface important values prominently:

```ts
output.highlight('Admin password', 'kX9#mPq2vR4z')
output.highlight('API key', 'sk_test_abc123')
```

Output:

```
  ★ Admin password: kX9#mPq2vR4z
  ★ API key: sk_test_abc123
```

### Sections and summaries

```ts
output.section('Seeding workspace: Orphnet')
// ... seed code ...

output.break()

output.summary({ users: 50, posts: 150, comments: 300 })
```

Output:

```
  ── Seeding workspace: Orphnet ──

  Table       Count
  users       50
  posts       150
  comments    300
```

### Progress tracking

Track batch progress with `tick()`, `complete()`, and `fail()`:

```ts
const tracker = output.progress('Seeding users', 50, { tag: 'users' })
for (const user of users) {
  await insertUser(user)
  tracker.tick(`Created ${user.email}`)
}
tracker.complete()
```

Output:

```
  [users]  1/50 ✓ Created alice@example.com
  [users]  2/50 ✓ Created bob@example.com
  ...
  [users] 50/50 ✓ Done — 50 items
```

For large batches, use `every` to only log at intervals:

```ts
const tracker = output.progress('Rows', 5000, { tag: 'rows', every: 500 })
for (const row of rows) {
  await insert(row)
  tracker.tick()
}
tracker.complete()
// Only outputs at 500, 1000, 1500, ... 5000
```

### Progress bar

A visual progress bar that updates in place:

```ts
const bar = output.progressBar('Seeding users', 100, { tag: 'users' })
for (const user of users) {
  await insertUser(user)
  bar.tick()
}
bar.complete()
```

Output (updates in place on a single line):

```
  [users] [████████░░░░░░░░░░░░] 40/100 … Seeding users
  [users] [████████████████████] 100/100 ✓ Done
```

Options:

| Option | Type | Description |
|--------|------|-------------|
| `tag` | `string` | Label in brackets |
| `width` | `number` | Bar width in characters (default: 20) |
| `indent` | `number` | Indent depth (default: 1) |

> [!TIP]
> **Parallel fallback**
> When used inside `runGroups()` or `runSeeders()`, progress bars automatically fall back to line-per-tick mode to avoid garbled output from multiple bars updating the same line.

### Counter

A compact in-place counter — lighter than a full progress bar:

```ts
const c = output.counter('Inserting rows', 500, { tag: 'rows' })
for (const row of rows) {
  await insert(row)
  c.tick()
}
c.complete()
```

Output (updates in place):

```
  [rows] 247/500 … Inserting rows
  [rows] 500/500 ✓ Done — 500 items
```

Like progress bars, counters fall back to line-per-tick in parallel contexts.

### Step indicator

Show sequential phases in a seeder:

```ts
output.step(1, 5, 'Creating workspaces')
// ...work...
output.step(2, 5, 'Seeding users')
// ...work...
output.step(3, 5, 'Creating projects')
```

Output:

```
  [1/5] Creating workspaces
  [2/5] Seeding users
  [3/5] Creating projects
```

### Status messages

Semantic status lines with colored symbols:

```ts
output.info('Using cached workspace data')
output.warn('No admin user found, creating default')
output.success('Workspace seeded successfully')
output.error('Failed to create billing records')
```

Output:

```
  i Using cached workspace data
  ! No admin user found, creating default
  ✓ Workspace seeded successfully
  ✗ Failed to create billing records
```

### Timer

Measure and display elapsed time:

```ts
const t = output.timer('Seeding workspace')
// ... work ...
t.stop()
```

Output:

```
  ⏱ Seeding workspace (2.4s)
```

Access `t.elapsed` to read milliseconds without stopping.

### Table

Generic table with aligned columns:

```ts
output.table(['Name', 'Role', 'Email'], [
  ['Alice', 'admin',  'alice@example.com'],
  ['Bob',   'member', 'bob@example.com'],
])
```

Output:

```
  Name   Role    Email
  Alice  admin   alice@example.com
  Bob    member  bob@example.com
```

### Parallel group execution

Run multiple item groups in parallel with per-group progress:

```ts
const results = await output.runGroups(
  [
    { name: 'Users',    items: userEndpoints },
    { name: 'Posts',    items: postEndpoints },
    { name: 'Comments', items: commentEndpoints },
  ],
  async (item, tracker) => {
    await processItem(item)
    tracker.tick(`Processed ${item.name}`)
  },
  { concurrency: 3 },
)
```

Each group gets its own progress tracker. Results include timing, counts, and error state. A results card is printed at the end.

### Parallel seeder execution

Run multiple seeders in parallel with per-seeder completion reporting:

```ts
import WorkspaceSeeder from './WorkspaceSeeder'
import UserSeeder from './UserSeeder'
import BillingSeeder from './BillingSeeder'

await output.runSeeders(
  [WorkspaceSeeder, UserSeeder, BillingSeeder],
  opts,
  { concurrency: 3 },
)
```

Output:

```
  ┌───────────────────────────────────────┐
  │  Running 3 seeders                    │
  ├───────────────────────────────────────┤
  │  WorkspaceSeeder   pending            │
  │  UserSeeder        pending            │
  │  BillingSeeder     pending            │
  └───────────────────────────────────────┘

  [WorkspaceSeeder] ✓ Done (1.2s)
  [UserSeeder]      ✓ Done (3.4s)
  [BillingSeeder]   ✗ Failed (0.8s)

  ┌───────────────────────────────────────┐
  │  Seeder Results                       │
  ├───────────────────────────────────────┤
  │  WorkspaceSeeder   ✓  (1.2s)         │
  │  UserSeeder        ✓  (3.4s)         │
  │  BillingSeeder     ✗  (0.8s)         │
  └───────────────────────────────────────┘
```

Each seeder can use the full output API internally (cards, progress bars, log lines, etc.). Output will interleave but each line is self-identifying via tags. Failed seeders are reported with error details at the end.

Options:

| Option | Type | Description |
|--------|------|-------------|
| `concurrency` | `number` | Max seeders to run in parallel (default: 4, max: 16) |
