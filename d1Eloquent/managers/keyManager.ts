import { CastManager } from "../castManager";
import type { CastDefinition } from "../castManager";
import { generateId } from "../idGenerator";
import type { TKeyStrategy } from "../idGenerator";

/**
 * Internal structural interface for a model instance that supports
 * auto-generated primary keys.
 */
export interface TKeyModel {
    attrs: Record<string, unknown>;
    dirty: Set<string>;
    lastChanges: Record<string, unknown>;
    _accessorCache: Map<string, unknown>;
    constructor: {
        table: string;
        primaryKey: string;
        keyStrategy?: TKeyStrategy;
        casts?: Record<string, CastDefinition>;
    };
}

/**
 * Manages automatic primary-key generation on insert.
 *
 * Mirrors {@link TimestampManager}: invoked from the create / bulk-create paths
 * just before a row is persisted. Generates a key only when the model's primary
 * key is absent AND the configured `keyStrategy` is not `false`, so an
 * explicitly-supplied id is always respected.
 */
export const KeyManager = {
    /**
     * Assign an auto-generated primary key to `model` when one is missing.
     * No-op when `keyStrategy` is `false` or the key is already set.
     */
    applyKeyStrategy(model: TKeyModel): void {
        const ctor = model.constructor;
        const strategy: TKeyStrategy = ctor.keyStrategy ?? "uuid";
        if (strategy === false) return;

        const pk = ctor.primaryKey;
        // Respect an explicitly-provided key; only generate when absent.
        if (model.attrs[pk] != null) return;

        const value = generateId(strategy, { table: ctor.table, keyName: pk });
        setRawField(model, ctor, pk, value);
    },
};

/**
 * Write a value to attrs, hydrating through any configured cast. Mirrors the
 * private helper in {@link TimestampManager}.
 */
function setRawField(
    model: TKeyModel,
    ctor: { casts?: Record<string, CastDefinition> },
    key: string,
    value: unknown,
): void {
    const casts = CastManager.resolveCastsFor(ctor as any);
    const cast = casts[key];
    const hydrated = cast ? CastManager.castGet(cast, value) : value;
    model.attrs[key] = hydrated;
    model.dirty.add(key);
    model.lastChanges[key] = hydrated;
    model._accessorCache.clear();
}
