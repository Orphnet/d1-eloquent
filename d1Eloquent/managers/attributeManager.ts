import { CastManager } from "../castManager";
import { AccessorManager } from "../accessorManager";
import type { Attribute } from "../attribute";
import type { TModelInternals } from "./types";

/**
 * Transient, call-scoped cycle detection guard for accessor resolution.
 * Uses a WeakMap keyed by model instance so each instance has its own
 * resolving set. Naturally concurrent-safe. Not instance state.
 */
const resolvingStacks = new WeakMap<object, Set<string>>();

/**
 * Manages attribute access (get/set), serialization (toObject/toJSON/toRaw),
 * and mass assignment (fill/forceFill) for model instances.
 */
export const AttributeManager = {
    get(model: TModelInternals, key: string): unknown {
        const existing = resolvingStacks.get(model);
        const isOutermost = !existing;
        const result = resolveGet(model, key, existing);
        if (isOutermost) resolvingStacks.delete(model);
        return result;
    },

    getRaw(model: TModelInternals, key: string): unknown {
        return model.attrs[key];
    },

    getOriginal(model: TModelInternals, key: string): unknown {
        return model.original[key];
    },

    set(model: TModelInternals, key: string, value: unknown): void {
        model._accessorCache.clear();
        const accessors = AccessorManager.resolveAccessorsFor(
            model.constructor as { accessors?: Record<string, Attribute>; prototype: object },
        );
        const accessor = accessors[key];

        // Virtual get-only no-op: accessor has getter but no setter, and key has no backing column
        if (accessor && accessor.hasGetter() && !accessor.hasSetter() && !(key in model.attrs)) {
            return;
        }

        if (accessor && accessor.hasSetter()) {
            let mutated: unknown;
            try {
                mutated = accessor.applySet(value);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Mutator error for key '${key}': ${msg}`, { cause: err });
            }

            // Fan-out detection: plain object (not null, not Array, not Date)
            if (
                mutated !== null &&
                mutated !== undefined &&
                typeof mutated === "object" &&
                !Array.isArray(mutated) &&
                !(mutated instanceof Date)
            ) {
                const fanOut = mutated as Record<string, unknown>;
                const casts = CastManager.resolveCastsFor(model.constructor as any);

                for (const [k, v] of Object.entries(fanOut)) {
                    const cast = casts[k];
                    const hydrated = cast ? CastManager.castGet(cast, v) : v;
                    const prev = model.attrs[k];
                    model.attrs[k] = hydrated;
                    model.dirty.add(k);
                    if (!Object.is(prev, hydrated)) {
                        model.lastChanges[k] = hydrated;
                    }
                }
                return;
            }

            storeValue(model, key, mutated);
        } else {
            storeValue(model, key, value);
        }
    },

    /**
     * ORM-managed field write (created_at, updated_at, deleted_at).
     * Hydrates through cast so get() returns the cast type.
     */
    setRaw(model: TModelInternals, key: string, value: unknown): void {
        const casts = CastManager.resolveCastsFor(model.constructor as any);
        const cast = casts[key];
        const hydrated = cast ? CastManager.castGet(cast, value) : value;
        model.attrs[key] = hydrated;
        model.dirty.add(key);
        model.lastChanges[key] = hydrated;
        model._accessorCache.clear();
    },

    fill(model: TModelInternals, values: Record<string, unknown>): void {
        const fillable = model.constructor.fillable;
        const guarded = model.constructor.guarded;

        for (const [k, v] of Object.entries(values)) {
            if (fillable && !fillable.includes(k)) continue;
            if (guarded && guarded.includes(k)) continue;
            AttributeManager.set(model, k, v);
        }
    },

    forceFill(model: TModelInternals, values: Record<string, unknown>): void {
        for (const [k, v] of Object.entries(values)) {
            AttributeManager.set(model, k, v);
        }
    },

    toObject(model: TModelInternals): Record<string, unknown> {
        const result = { ...model.attrs };

        const appends = model.constructor.appends;
        if (appends && appends.length > 0) {
            for (const key of appends) {
                result[key] = AttributeManager.get(model, key);
            }
        }

        const hidden = model.constructor.hidden;
        if (hidden && hidden.length > 0) {
            for (const key of hidden) {
                delete result[key];
            }
        }

        return result;
    },

    toJSON(model: TModelInternals): Record<string, unknown> {
        const result = AttributeManager.toObject(model);

        for (const [name, value] of Object.entries(model.relations)) {
            if (value === null || value === undefined) {
                result[name] = value;
            } else if (Array.isArray(value)) {
                result[name] = value.map((item) =>
                    typeof item === "object" && item !== null && "toJSON" in item
                        ? (item as { toJSON(): unknown }).toJSON()
                        : typeof item === "object" && item !== null && "toObject" in item
                            ? (item as { toObject(): Record<string, unknown> }).toObject()
                            : item,
                );
            } else if (typeof value === "object" && "toJSON" in (value as object)) {
                result[name] = (value as { toJSON(): unknown }).toJSON();
            } else if (typeof value === "object" && "toObject" in (value as object)) {
                result[name] = (value as { toObject(): Record<string, unknown> }).toObject();
            } else {
                result[name] = value;
            }
        }

        return result;
    },

    toRaw(model: TModelInternals): Record<string, unknown> {
        const casts = CastManager.resolveCastsFor(model.constructor as any);
        return CastManager.dehydrateRow(casts, { ...model.attrs });
    },

    clearAccessorCache(model: TModelInternals): void {
        model._accessorCache.clear();
    },
};

/**
 * Resolve a get() call through the accessor pipeline.
 */
function resolveGet(model: TModelInternals, key: string, resolving?: Set<string>): unknown {
    const value = model.attrs[key];
    const accessors = AccessorManager.resolveAccessorsFor(
        model.constructor as { accessors?: Record<string, Attribute>; prototype: object },
    );
    const accessor = accessors[key];

    if (!accessor || !accessor.hasGetter()) {
        return value;
    }

    const cache = model._accessorCache;

    if (!resolving && cache.has(key)) {
        return cache.get(key);
    }

    const resolvingSet = resolving ?? new Set<string>();

    if (resolvingSet.has(key)) {
        throw new Error(`Circular accessor detected: ${[...resolvingSet, key].join(" -> ")}`);
    }

    resolvingSet.add(key);

    if (!resolving) {
        resolvingStacks.set(model, resolvingSet);
    }

    try {
        const result = accessor.applyGet(value, { ...model.attrs });
        if (!resolving) {
            cache.set(key, result);
        }
        return result;
    } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith("Circular accessor detected")) {
            throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Accessor error for key '${key}': ${msg}`, { cause: err });
    } finally {
        resolvingSet.delete(key);
    }
}

/**
 * Store a value in attrs with dirty tracking.
 */
function storeValue(model: TModelInternals, key: string, value: unknown): void {
    model._accessorCache.clear();
    const prev = model.attrs[key];
    model.attrs[key] = value;

    const orig = model.original[key];
    const changed = !Object.is(orig, value);

    if (changed) model.dirty.add(key);
    else model.dirty.delete(key);

    if (!Object.is(prev, value)) {
        model.lastChanges[key] = value;
    }
}
