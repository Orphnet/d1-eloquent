/**
 * Internal interface for a model instance that may support soft deletes.
 */
export interface TSoftDeleteModel {
    attrs: Record<string, unknown>;
    constructor: { softDeletes?: boolean };
}

/**
 * Manages soft-delete awareness for model instances.
 * Persistence-level soft delete execution remains in BaseModel (will move to PersistenceManager).
 */
export const SoftDeleteManager = {
    /**
     * Whether the model class supports soft deletes.
     */
    isSoftDeletable(model: TSoftDeleteModel): boolean {
        return !!(model.constructor as { softDeletes?: boolean }).softDeletes;
    },

    /**
     * Whether this instance has been soft-deleted.
     */
    trashed(model: TSoftDeleteModel): boolean {
        if (!SoftDeleteManager.isSoftDeletable(model)) return false;
        return model.attrs["deleted_at"] != null;
    },
};
