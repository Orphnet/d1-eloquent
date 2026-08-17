/**
 * Internal interface for dirty-tracking state on a model instance.
 * Package-internal only — not exported from the public API.
 */
export interface TDirtyModel {
    readonly attrs: Record<string, unknown>;
    original: Partial<Record<string, unknown>>;
    dirty: Set<string>;
    lastChanges: Record<string, unknown>;
}

/**
 * Deep-clone a single attribute value for the `original` baseline. Primitives
 * pass through unchanged; non-primitive values (json/array casts, Date, blobs)
 * are cloned so the baseline cannot be corrupted by later in-place mutation of
 * the live attribute. Non-cloneable values (functions, exotic class instances)
 * fall back to the reference — best-effort, those are not DB-backed attributes.
 */
function cloneAttr(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    try {
        return structuredClone(value);
    } catch {
        return value;
    }
}

/**
 * Snapshot a model's attributes for the `original` baseline, deep-cloning
 * non-primitive values. Used by the model constructor and after every
 * persist/refresh so `original` never aliases `attrs`. Without this, an
 * in-place mutation of a json/array/Date attribute would (a) silently escape
 * dirty tracking via `Object.is`, dropping the column from the next UPDATE,
 * and (b) corrupt the revision before-snapshot.
 */
export function snapshotOriginal(attrs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(attrs)) out[k] = cloneAttr(attrs[k]);
    return out;
}

/**
 * Manages dirty tracking (changed attributes) for model instances.
 * All functions are stateless — the model owns the state, this module provides the logic.
 */
export const DirtyManager = {
    isDirty(model: TDirtyModel, key?: string): boolean {
        if (!key) return model.dirty.size > 0;
        return model.dirty.has(key);
    },

    getDirty(model: TDirtyModel): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const k of model.dirty) {
            out[k] = model.attrs[k];
        }
        return out;
    },

    getChanges(model: TDirtyModel): Record<string, unknown> {
        return { ...model.lastChanges };
    },

    wasChanged(model: TDirtyModel, key?: string): boolean {
        if (!key) return Object.keys(model.lastChanges).length > 0;
        return Object.prototype.hasOwnProperty.call(model.lastChanges, key);
    },

    syncOriginal(model: TDirtyModel): void {
        model.original = snapshotOriginal(model.attrs);
        model.dirty.clear();
        model.lastChanges = {};
    },
};
