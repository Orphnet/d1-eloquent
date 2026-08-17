# KV Cache Adapter

`KvCacheAdapter` plugs a Cloudflare KV namespace into d1-eloquent as an
auto-invalidating read-through cache. It implements the existing `CacheAdapter`
contract (write-side invalidation) and adds read-side helpers so you can cache
arbitrary loaders with one call.

## When to use it

- Hot-path reads where D1 latency matters (e.g. user profiles, lookup tables)
- Aggregations recomputed on every request (counts, leaderboards) — cache the
  result of a heavier query under a stable key
- Anywhere you'd otherwise hand-roll `KV.get / KV.put` around a model fetch

Skip it for low-frequency reads or strongly-consistent data — KV is eventually
consistent globally and rate-limits writes to one per key per second.

## Setup

```ts
import { KvCacheAdapter } from '@orphnet/d1-eloquent'

const cache = new KvCacheAdapter(env.CACHE, {
  prefix:     'd1e:',   // default — namespaces all keys
  defaultTtl: 60,       // seconds — KV enforces a 60s minimum
})
```

`env.CACHE` is a `KVNamespace` binding declared in `wrangler.jsonc`. The class
only depends on `get` / `put` / `delete` so it also compiles when
`@cloudflare/workers-types` is missing — drop in a structural mock for tests.

## Read-through caching — `remember(key, ttl, loader)`

The most common pattern. Cache hit returns immediately; cache miss runs the
loader, stores the result, and returns it.

```ts
const user = await cache.remember(
  `users:${userId}`,
  300,                                // 5 min TTL
  () => User.find(userId),
)
```

Null / undefined results are NOT cached, so transient misses don't poison the
cache. If you want to cache "absent", pass a sentinel value (e.g. `{ found: false }`)
and unwrap it on read.

## Model-aware sugar — `findOrLoad(Model, id, ttl?)`

Same pattern as `remember`, but uses the model's `table` + `id` for the key and
serializes via `toRaw()`:

```ts
const user = await cache.findOrLoad(User, userId, 300)
```

Cached values are *attribute objects*, not full model instances — a fresh
instance is constructed on cache hit. Methods like `model.isDirty()` work; but
relations are **not** cached and will need a follow-up `load()` if used.

## Write-side invalidation — `CacheAdapter` integration

Pass the adapter as `opts.cache` to `save()` / `delete()` / `restore()`. The
canonical key `${prefix}${table}:${id}` is deleted on every write event.

```ts
const user = await User.find(userId)
user.set('name', 'Alice')
await user.save({ cache })   // KV key d1e:users:{userId} is deleted afterward
```

For invalidating *derived* keys (lists, counts, aggregates) alongside the
canonical row key, supply `opts.invalidationKey`:

```ts
const cache = new KvCacheAdapter(env.CACHE, {
  invalidationKey: (e) => [
    cache.cacheKey(e.table, e.id),         // canonical key
    `d1e:${e.table}:list`,                 // any list cache
    `d1e:${e.table}:count`,
  ],
})
```

The function receives a `CacheInvalidationEvent` (`{ table, id, action }`).
Return a string or an array of strings — every returned key is deleted.

## Low-level helpers

```ts
await cache.set('greeting', 'hello world', 120)
const v = await cache.get<string>('greeting')
await cache.delete('greeting')
```

Keys are auto-prefixed when they don't already start with the namespace prefix.
Values are JSON-serialized on `set` and `JSON.parse`-ed on `get`; parse failures
return `null` so corrupt cache entries can't crash a request.

## Options reference

| Option | Type | Default | Purpose |
|---|---|---|---|
| `prefix` | `string` | `'d1e:'` | Namespace prepended to every key |
| `defaultTtl` | `number` | `60` | Seconds — used when `set` / `remember` is called without a per-call TTL |
| `invalidationKey` | `(event) => string \| string[]` | canonical `cacheKey(table, id)` | Compute which keys to delete on each write event |

## Patterns

### Cache a "top-N" leaderboard with manual invalidation

```ts
const top = await cache.remember('users:top10', 60, () =>
  User.query().orderBy('score', 'desc').limit(10).get()
    .then((rows) => rows.map((u) => u.toObject()))
)
```

You'd manually `cache.delete('users:top10')` (or include it in
`invalidationKey`) when scores change.

### Per-tenant caches

Compose the prefix with a tenant identifier so different tenants don't collide:

```ts
const cache = new KvCacheAdapter(env.CACHE, { prefix: `d1e:tenant:${tenantId}:` })
```

### Test setup

Replace the KV with an in-memory `Map`-backed stub — the adapter only needs
`get(key)`, `put(key, value, opts?)`, and `delete(key)`. See
`d1Eloquent/tests/kvCacheAdapter.test.ts` for a working stub.
