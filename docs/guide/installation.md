# Installation

This guide covers everything you need to get d1-eloquent installed and wired up in a Cloudflare Workers project.

## Prerequisites

Before you start, make sure you have:

- A Cloudflare Workers project (created with `wrangler init` or `create-cloudflare`)
- A D1 database created in your Cloudflare account (`wrangler d1 create my-database`)
- Node.js 18+ or [Bun](https://bun.sh) installed

> [!TIP]
> **New to Cloudflare D1?**
> The [D1 getting started guide](https://developers.cloudflare.com/d1/get-started/) walks through creating a Workers project and provisioning a D1 database.

## Install the Package

```sh
# bun
bun add @orphnet/d1-eloquent
```

```sh
# npm
npm install @orphnet/d1-eloquent
```

```sh
# pnpm
pnpm add @orphnet/d1-eloquent
```

```sh
# yarn
yarn add @orphnet/d1-eloquent
```

### Install `@cloudflare/workers-types`

The published type declarations reference the ambient Cloudflare D1 globals (`D1Database`, `D1Result`, …). Add `@cloudflare/workers-types` as a dev dependency so those types resolve in your project:

```sh
# bun
bun add -d @cloudflare/workers-types
```

```sh
# npm
npm install -D @cloudflare/workers-types
```

```sh
# pnpm
pnpm add -D @cloudflare/workers-types
```

```sh
# yarn
yarn add -D @cloudflare/workers-types
```

It is declared as an optional peer dependency — if your project already references `@cloudflare/workers-types` (for example, via a Worker scaffolded by `create-cloudflare`), you are already covered.

## Configure Wrangler

Add your D1 database binding to `wrangler.toml`. If you have not created a D1 database yet, run `wrangler d1 create my-database` first — it will print the `database_id` you need here.

```toml
# wrangler.toml

[[d1_databases]]
binding = "DB"
database_name = "my-database"
database_id = "your-database-id-here"
```

> [!TIP]
> **Binding name**
> The `binding` value (`DB` in the example above) is how Cloudflare exposes the D1 database to your Worker via `env`. You can use any name you like — just keep it consistent with your `configure()` call or explicit `db` arguments.

## Wire Up the Binding

There are two ways to pass the D1 binding to d1-eloquent. You can use either approach — or mix them in the same project.

### Option A: Auto-configured (recommended)

Call `configure(env)` once at Worker startup. All query methods then resolve the database automatically — no need to pass `db` on every call:

```ts
import { configure } from '@orphnet/d1-eloquent'
import { User } from './models/User'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    configure(env)  // registers env.DB as the default connection

    const users = await User.query().limit(10).get()
    return Response.json(users.map(u => u.attrs))
  },
}

interface Env {
  DB: D1Database
}
```

`configure(env)` reads `DEFAULT_DB` or `DB` from your env and registers it internally. See [Configuration](./configuration.md) for binding name resolution, per-model connections, and test setup.

### Option B: Explicit `db` argument

Pass `env.DB` directly to any d1-eloquent method. This works with or without `configure()` — an explicit `db` always takes priority:

```ts
import { User } from './models/User'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const users = await User.query().limit(10).get(env.DB)
    return Response.json(users.map(u => u.attrs))
  },
}

interface Env {
  DB: D1Database
}
```

> [!TIP]
> **Type-safe bindings**
> Define an `Env` interface (as shown above) and type your handler with it. TypeScript will enforce that `env.DB` is a `D1Database` — no silent `any` types slipping through.

## Add Convenience Scripts

The package ships a `d1-eloquent` bin (declared in its `package.json`). Run it directly with `bunx d1-eloquent <command>`, or wire the commands into `package.json` scripts for quick access. The CLI auto-detects the D1 binding from your `wrangler.toml` and defaults to local, so no flags are needed for local development.

```json
{
  "scripts": {
    "db:migrate": "d1-eloquent migrate",
    "db:migrate:status": "d1-eloquent status",
    "db:migrate:rollback": "d1-eloquent rollback",
    "db:migrate:fresh": "d1-eloquent fresh",
    "db:seed": "d1-eloquent seed"
  }
}
```

> [!TIP]
> **Overriding auto-detection**
> Auto-detection reads the first `d1_databases` binding from your `wrangler.jsonc` / `wrangler.toml`, so a single binding is picked up automatically whatever its name — you rarely need this. Pass `--db=<binding>` only when you bind more than one D1 database and need to target a specific one. The `=` is required: a space-separated `--db MY_DB` is not parsed as a value.
>
> ```json
> {
>   "scripts": {
>     "db:migrate": "d1-eloquent migrate --db=MY_DB",
>     "db:migrate:fresh": "d1-eloquent fresh --db=MY_DB",
>     "db:seed": "d1-eloquent seed --db=MY_DB"
>   }
> }
> ```

Usage:

```sh
bun run db:migrate              # apply pending migrations locally
bun run db:migrate:status       # list applied / pending migrations
bun run db:migrate:rollback     # undo last migration batch
bun run db:migrate:fresh        # drop all tables and re-migrate
bun run db:seed                 # run all seeders
bun run db:seed -- UserSeeder   # run a single seeder
```

To target the remote D1 database, append `-- --remote`:

```sh
bun run db:migrate -- --remote
```

## Run Migrations

d1-eloquent includes a CLI for managing migrations. Run your first migration against a local D1 database:

```sh
bunx d1-eloquent migrate
```

The CLI auto-detects the `--db` name from your `wrangler.toml` and defaults to `--local`. To run against your remote Cloudflare D1 database:

```sh
bunx d1-eloquent migrate --remote
```

## Check Migration Status

```sh
bunx d1-eloquent status
```

This lists every migration file, whether it has been applied, and when it ran.

## Next Steps

You are ready to define your first model and run migrations. Continue to the [Quick Start](./quick-start.md) guide for a complete end-to-end walkthrough.
