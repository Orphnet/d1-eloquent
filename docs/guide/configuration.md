# Configuration

d1-eloquent is designed to work with zero configuration in most Cloudflare Workers setups. This page covers database binding detection, per-model connections, and test setup.

## Zero-Config Setup

Call `configure(env)` once at Worker startup. The package automatically reads your D1 bindings:

```ts
import { configure } from '@orphnet/d1-eloquent'

export default {
  async fetch(req, env) {
    configure(env)
    return app.fetch(req, env)
  }
}
```

After this, all query methods (`get()`, `first()`, `save()`, `delete()`, etc.) work without an explicit `db` argument:

```ts
// Before — explicit db required everywhere
const users = await User.query().limit(50).get(env.DB)

// After — db resolved automatically
const users = await User.query().limit(50).get()
```

Explicit `db` arguments still work and take priority — no breaking changes.

## Binding Name Resolution

`configure(env)` detects your database in this order:

| Binding name | Registered as |
|---|---|
| `DEFAULT_DB` | `"default"` connection |
| `DB` (fallback if `DEFAULT_DB` absent) | `"default"` connection |
| `TEST_DB` | `"test"` connection |

If both `DEFAULT_DB` and `DB` exist in your env, `DEFAULT_DB` wins.

### wrangler.toml example

```toml
[[d1_databases]]
binding = "DB"
database_name = "my-app-db"
database_id = "..."
```

No extra configuration needed — `configure(env)` picks up `DB` automatically.

If you want an explicit name:

```toml
[[d1_databases]]
binding = "DEFAULT_DB"
database_name = "my-app-db"
database_id = "..."
```

## Multi-Database Setup

For projects that bind more than one D1 database — analytics, audit, tenant shards, etc. —
register them all in a single `configure()` call:

```ts
configure(env, {
  connections: {
    analytics: env.ANALYTICS_DB,
    audit:     env.AUDIT_DB,
    read:      'default',          // string alias for an existing connection
  },
});
```

`opts.connections` registers each entry under your chosen name. A string value is treated as
an alias to an already-registered connection (auto-detected `DB`/`DEFAULT_DB` count, since they
run first). Aliases are resolved at registration time and are not recursive — the target must
already exist or registration throws.

### Per-Query Routing — `qb.on(name)`

Route a single query through a named connection:

```ts
const events = await Event.query().on('analytics').get();

// Works through paginate too — count + data both hit the named connection
const audit = await AuditLog.query().on('audit').paginate(1, 50);
```

`qb.on()` goes through the registry, so `NODE_ENV=test` still redirects to `TEST_DB`.
Multi-DB code stays testable without conditional wiring.

### Per-Model Connections

Override the default connection for a specific model using `static connection`:

```ts
import { BaseModel } from '@orphnet/d1-eloquent'

// Use a direct D1Database binding
class AnalyticsEvent extends BaseModel<AnalyticsAttrs> {
  static table = 'analytics_events'
  static connection = env.ANALYTICS_DB  // set at startup
}

// Or reference a named connection (must be registered via configure())
class AuditLog extends BaseModel<AuditAttrs> {
  static table = 'audit_logs'
  static connection = 'analytics'  // string key
}
```

### Resolution Order

Highest priority first:

1. Explicit `db` argument to a terminal method
2. `setDefaultDb(db)` / `Model.query(db)` raw binding override
3. `qb.on(name)` named connection
4. Model's `static connection` (direct binding or named key)
5. `"default"` connection from registry

### Registry Lifecycle Helpers

For tenant routing and test setups:

```ts
import {
  registerConnection,
  unregisterConnection,
  clearConnections,
  listConnections,
  getConnection,
} from '@orphnet/d1-eloquent';

// Tenant-scoped registration mid-request
registerConnection(`tenant:${tenantId}`, env[`TENANT_${tenantId.toUpperCase()}_DB`]);

// Cleanup
unregisterConnection(`tenant:${tenantId}`);

// Diagnostics
listConnections();         // ['default', 'analytics', 'tenant:foo', ...]
getConnection('analytics'); // D1Database | undefined
```

## Test Setup

When `NODE_ENV=test`, d1-eloquent automatically uses the `TEST_DB` binding instead of `DEFAULT_DB`/`DB`. Test mode is detected from `NODE_ENV=test` **or** the presence of Vitest's runtime global, so any Vitest run routes to `TEST_DB` even when `NODE_ENV` is not explicitly set. The per-model `connection` property is bypassed in test mode — all models use `TEST_DB`.

```toml
# vitest.toml or wrangler config used by vitest-pool-workers
[[d1_databases]]
binding = "TEST_DB"
database_name = "test-db"
database_id = "..."
```

```ts
// vitest.config.ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
})
```

Your test setup calls `configure(env)` the same way as production:

```ts
// test setup or beforeAll
configure(env)  // env.TEST_DB is registered automatically
```

Or continue passing `db` explicitly — that always works regardless of mode.

## Timestamps Auto-Casting

When `timestamps = true` (the default), `created_at` and `updated_at` are automatically cast to `Date` via the `datetime` cast. When `softDeletes = true`, `deleted_at` is also auto-cast. You can override these by declaring them in `static casts`. See [Attribute Casting](./casting.md) for details.

## Error Messages

If no database can be resolved, you'll see a descriptive error:

```
No database configured. Call configure(env) at Worker startup,
or pass db explicitly to query methods.
```

If `NODE_ENV=test` but no `TEST_DB` binding is configured:

```
No 'test' database configured. Call configure(env) with an env that includes TEST_DB.
```

If a model's `static connection` references an unknown string key:

```
Unknown connection: "analytics". Register it via configure(env) or check the binding name.
```
