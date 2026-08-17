import type { TRelationDefinition } from "../relationTypes";
import type { TRelationship } from "../relationships";
import { resolveRelation } from "../relationResolver";

/**
 * Internal interface for a model instance that supports relations.
 */
export interface TRelationalModel {
    attrs: Record<string, unknown>;
    relations: Record<string, unknown>;
    constructor: {
        table: string;
        primaryKey: string;
        relations?: Record<string, TRelationDefinition>;
    };
}

/**
 * Manages relationship resolution and loading for model instances.
 */
export const RelationManager = {
    /**
     * Set a loaded relation value on the model instance.
     */
    setRelation<T>(model: TRelationalModel, name: string, value: T): void {
        model.relations[name] = value as unknown;
    },

    /**
     * Resolve a named relation from static `relations` metadata.
     * Returns a TRelationship with query/get/first for lazy loading.
     */
    resolveRelated(model: TRelationalModel, name: string): TRelationship<any> {
        const ctor = model.constructor as TRelationalModel["constructor"];
        const defs = ctor.relations;
        if (!defs || !defs[name]) {
            throw new Error(`Unknown relation '${name}' on ${ctor.table}. Define it in static relations.`);
        }

        const def = defs[name];
        let localValue: unknown;

        if (def.type === "belongsTo") {
            localValue = model.attrs[def.foreignKey];
        } else if (def.type === "belongsToMany") {
            const localKey = def.localKey ?? ctor.primaryKey;
            localValue = model.attrs[localKey];
        } else if (def.type === "morphTo") {
            // morphTo reads parent's type+id columns inside the resolver — no localValue needed.
            localValue = undefined;
        } else if (def.type === "morphMany" || def.type === "morphOne") {
            const localKey = def.localKey ?? ctor.primaryKey;
            localValue = model.attrs[localKey];
        } else {
            const localKey = def.localKey ?? ctor.primaryKey;
            localValue = model.attrs[localKey];
        }

        // Pass the model instance so morphTo can read its discriminator columns.
        const parentAccessor = { get: (k: string) => model.attrs[k] };
        return resolveRelation(def, ctor as any, localValue, parentAccessor);
    },

    /**
     * Eager-load one or more relations onto an existing model instance.
     */
    async load(model: TRelationalModel, db: D1Database | undefined, names: string[]): Promise<void> {
        for (const name of names) {
            const result = await RelationManager.resolveRelated(model, name).get(db);
            RelationManager.setRelation(model, name, result);
        }
    },
};
