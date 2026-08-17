import type { CacheAdapter, CacheInvalidationEvent } from "./cacheAdapter";
import type { TModelCtor } from "./baseModel";

/**
 * Options accepted by `KvCacheAdapter`.
 */
export type TKvCacheAdapterOpts = {
    /**
     * Optional namespace prefix prepended to every key — e.g. `'d1e:'` so cache
     * keys read `d1e:users:abc123`. Useful when sharing a KV with other
     * subsystems. Default: `'d1e:'`.
     */
    prefix?: string;
    /**
     * Default TTL applied to `set()` and `remember()` when no per-call TTL is
     * provided. Measured in seconds. Default: `60`.
     *
     * Cloudflare KV enforces a minimum TTL of 60s — values below that are
     * silently raised by the platform.
     */
    defaultTtl?: number;
    /**
     * Function controlling how invalidation maps a write event to a key.
     * Defaults to the same key produced by `cacheKey(table, id)`.
     */
    invalidationKey?: (event: CacheInvalidationEvent) => string | string[];
};

/**
 * Minimal interface we depend on from KVNamespace — declared structurally so
 * this file compiles even when `@cloudflare/workers-types` is missing.
 */
type TKvLike = {
    get(key: string, type?: "text" | "json"): Promise<string | null | unknown>;
    put(
        key: string,
        value: string,
        opts?: { expirationTtl?: number; metadata?: unknown },
    ): Promise<void>;
    delete(key: string): Promise<void>;
};

/**
 * A `CacheAdapter` backed by a Cloudflare KV namespace. Implements the
 * write-invalidation contract (called by `save()`/`delete()`/`restore()` when
 * `opts.cache` is set) plus low-level `get`/`set`/`delete` helpers and a
 * `remember()` read-through wrapper for caching arbitrary loaders.
 *
 * @example
 * ```ts
 * import { KvCacheAdapter } from '@orphnet/d1-eloquent';
 *
 * const cache = new KvCacheAdapter(env.CACHE, { defaultTtl: 300 });
 *
 * // Read-through caching of any loader
 * const user = await cache.remember(`users:${id}`, 300, () => User.find(id));
 *
 * // Auto-invalidation on write
 * await user.save({ cache });
 *
 * // Model-aware sugar
 * const fresh = await cache.findOrLoad(User, id);
 * ```
 */
export class KvCacheAdapter implements CacheAdapter {
    private readonly kv: TKvLike;
    private readonly prefix: string;
    private readonly defaultTtl: number;
    private readonly invalidationKey: (event: CacheInvalidationEvent) => string | string[];

    public constructor(kv: TKvLike, opts: TKvCacheAdapterOpts = {}) {
        this.kv = kv;
        this.prefix = opts.prefix ?? "d1e:";
        this.defaultTtl = opts.defaultTtl ?? 60;
        this.invalidationKey =
            opts.invalidationKey ?? ((e) => this.cacheKey(e.table, e.id));
    }

    /**
     * Canonical cache key for a single record. Override at construction via
     * `opts.invalidationKey` if you need a different shape.
     */
    public cacheKey(table: string, id: string): string {
        return `${this.prefix}${table}:${id}`;
    }

    /**
     * Read a JSON-serialized value from KV. Returns `null` on miss or parse
     * failure (KV stores strings; we round-trip through `JSON.parse`).
     */
    public async get<T = unknown>(key: string): Promise<T | null> {
        const raw = await this.kv.get(this.scoped(key), "text");
        if (raw === null || typeof raw !== "string") return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }

    /**
     * Write a value to KV, serialized via `JSON.stringify`. `ttl` is in
     * seconds; falls back to `defaultTtl` when omitted. KV enforces a 60s
     * minimum — shorter values are raised by the platform.
     */
    public async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
        const expirationTtl = ttl ?? this.defaultTtl;
        await this.kv.put(this.scoped(key), JSON.stringify(value), { expirationTtl });
    }

    /**
     * Remove an entry from KV.
     */
    public async delete(key: string): Promise<void> {
        await this.kv.delete(this.scoped(key));
    }

    /**
     * Read-through caching: returns the cached value when present, otherwise
     * calls `loader()`, caches the result with `ttl`, and returns it.
     *
     * Null/undefined results from the loader are NOT cached — that lets
     * callers retry transient misses without poisoning the cache. Pass a
     * sentinel value if you want to cache "absent".
     */
    public async remember<T>(
        key: string,
        ttl: number | undefined,
        loader: () => Promise<T>,
    ): Promise<T> {
        const cached = await this.get<T>(key);
        if (cached !== null) return cached;

        const fresh = await loader();
        if (fresh !== null && fresh !== undefined) {
            await this.set(key, fresh, ttl);
        }
        return fresh;
    }

    /**
     * Sugar over `remember()` — fetches by primary key, using the canonical
     * `cacheKey(table, id)`. Returns the cached attrs hydrated as a model
     * instance, or `null` if the record doesn't exist.
     *
     * Note: cached values are *attribute objects*, not full model instances.
     * Methods like `model.isDirty()` work because a fresh instance is
     * constructed on cache hit; relations are NOT cached and will need a
     * follow-up `load()` if used.
     */
    public async findOrLoad<TAttrs extends object, TModel extends { toObject(): object }>(
        modelCtor: TModelCtor<TModel> & { find(id: string): Promise<TModel | null> },
        id: string,
        ttl?: number,
    ): Promise<TModel | null> {
        const table = (modelCtor as unknown as { table: string }).table;
        const key = this.cacheKey(table, id);
        const cachedAttrs = await this.get<TAttrs>(key);
        if (cachedAttrs) {
            return new (modelCtor as unknown as new (a: TAttrs) => TModel)(cachedAttrs);
        }
        const fresh = await modelCtor.find(id);
        if (fresh) {
            await this.set(key, (fresh as unknown as { toRaw(): object }).toRaw(), ttl);
        }
        return fresh;
    }

    /**
     * CacheAdapter contract — invoked by save/delete/restore when the model
     * is called with `opts.cache: <this>`. Deletes the canonical key (or
     * whatever `opts.invalidationKey` returns).
     */
    public async invalidate(event: CacheInvalidationEvent): Promise<void> {
        const keyOrKeys = this.invalidationKey(event);
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        await Promise.all(keys.map((k) => this.kv.delete(this.scoped(k, /* alreadyScoped */ true))));
    }

    /**
     * Apply the namespace prefix to a key. Pass `alreadyScoped=true` when the
     * key already includes the prefix (used internally by `invalidate()` so
     * `invalidationKey()` callbacks can return prefixed keys).
     */
    private scoped(key: string, alreadyScoped = false): string {
        if (alreadyScoped) return key;
        return key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
    }
}
