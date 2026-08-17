import { nowIso } from "../utils";
import type { CastDefinition } from "../castManager";
import { CastManager } from "../castManager";

/**
 * Internal interface for a model instance that supports timestamps.
 */
export interface TTimestampModel {
    attrs: Record<string, unknown>;
    dirty: Set<string>;
    lastChanges: Record<string, unknown>;
    _accessorCache: Map<string, unknown>;
    constructor: { timestamps?: boolean; casts?: Record<string, CastDefinition> };
}

/**
 * Manages automatic created_at / updated_at timestamps.
 */
export const TimestampManager = {
    /**
     * Apply timestamps before persistence.
     * Sets created_at on insert (if null), always touches updated_at.
     */
    applyTimestamps(model: TTimestampModel, isCreating: boolean): void {
        const ctor = model.constructor as { timestamps?: boolean; casts?: Record<string, CastDefinition> };
        if (!ctor.timestamps) return;

        const now = nowIso();

        if (isCreating && model.attrs["created_at"] == null) {
            setRawField(model, ctor, "created_at", now);
        }

        setRawField(model, ctor, "updated_at", now);
    },

    freshTimestamp(): string {
        return nowIso();
    },
};

/**
 * Internal helper: writes a value to attrs, hydrating through cast.
 * Equivalent to BaseModel.setRaw() but operates on the structural interface.
 */
function setRawField(
    model: TTimestampModel,
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
