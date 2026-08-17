import type { TModelCtor } from "./types";

/**
 * Declarative relation definitions for `static relations` on models.
 *
 * Model references use lazy `() => Ctor` functions to avoid circular import issues
 * that arise when two models reference each other (e.g., User ↔ Post).
 */

// ── Individual relation types ──────────────────────────────────────────

export type TBelongsToDefinition = {
    type: "belongsTo";
    /** Lazy reference to the related model constructor. */
    model: () => TModelCtor<any>;
    /** Column on THIS model that references the related model's key. */
    foreignKey: string;
    /** Column on the RELATED model (default: related.primaryKey). */
    ownerKey?: string;
};

export type THasManyDefinition = {
    type: "hasMany";
    /** Lazy reference to the related model constructor. */
    model: () => TModelCtor<any>;
    /** Column on the RELATED model that references this model's key. */
    foreignKey: string;
    /** Column on THIS model (default: this.primaryKey). */
    localKey?: string;
};

export type THasOneDefinition = {
    type: "hasOne";
    /** Lazy reference to the related model constructor. */
    model: () => TModelCtor<any>;
    /** Column on the RELATED model that references this model's key. */
    foreignKey: string;
    /** Column on THIS model (default: this.primaryKey). */
    localKey?: string;
};

export type TBelongsToManyDefinition = {
    type: "belongsToMany";
    /** Lazy reference to the related model constructor. */
    model: () => TModelCtor<any>;
    /** Name of the pivot/junction table. */
    pivot: string;
    /** Column on the PIVOT table referencing this model. */
    foreignPivotKey: string;
    /** Column on the PIVOT table referencing the related model. */
    relatedPivotKey: string;
    /** Column on THIS model (default: this.primaryKey). */
    localKey?: string;
    /** Column on the RELATED model (default: related.primaryKey). */
    relatedKey?: string;
};

/**
 * Has-many-through — reach a distant relation via an intermediate model's FK
 * chain. e.g. a `Country` has many `Posts` THROUGH `Users`
 * (`users.country_id` → `posts.user_id`).
 *
 * @example
 * static relations = {
 *   posts: {
 *     type: 'hasManyThrough',
 *     model: () => Post,        // final / related model
 *     through: () => User,      // intermediate model
 *     firstKey: 'country_id',   // FK on `through` → this model
 *     secondKey: 'user_id',     // FK on `model` → `through`
 *   },
 * }
 */
export type THasManyThroughDefinition = {
    type: "hasManyThrough";
    /** Lazy reference to the final / related model constructor. */
    model: () => TModelCtor<any>;
    /** Lazy reference to the intermediate (through) model constructor. */
    through: () => TModelCtor<any>;
    /** FK on the THROUGH table referencing THIS model. */
    firstKey: string;
    /** FK on the RELATED table referencing the THROUGH model. */
    secondKey: string;
    /** Key on THIS model (default: this.primaryKey). */
    localKey?: string;
    /** Key on the THROUGH model (default: through.primaryKey). */
    secondLocalKey?: string;
};

/** Has-one-through — same config as {@link THasManyThroughDefinition}; returns the first match. */
export type THasOneThroughDefinition = Omit<THasManyThroughDefinition, "type"> & { type: "hasOneThrough" };

// ── Polymorphic relations ───────────────────────────────────────────────

/**
 * Inverse side of a polymorphic association — e.g. a `Comment` that may belong
 * to either a `Post` or a `Video`. Stores both a `<morph>_type` discriminator
 * and a `<morph>_id` foreign key.
 *
 * @example
 * static relations = {
 *   commentable: {
 *     type: 'morphTo',
 *     morphName: 'commentable',           // → commentable_type + commentable_id
 *     morphMap: { post: () => Post, video: () => Video },
 *   },
 * }
 */
export type TMorphToDefinition = {
    type: "morphTo";
    /**
     * Logical name of the polymorphic association. By default we derive
     * `<morphName>_type` and `<morphName>_id` from this. Override via
     * `typeColumn` / `idColumn` for legacy schemas.
     */
    morphName: string;
    /** Override the type column (default `<morphName>_type`). */
    typeColumn?: string;
    /** Override the id column (default `<morphName>_id`). */
    idColumn?: string;
    /**
     * Map of type discriminator values to model constructor factories. The
     * keys are the values stored in `typeColumn` (lowercase model names by
     * convention).
     */
    morphMap: Record<string, () => TModelCtor<any>>;
};

/**
 * Owning side of a one-to-many polymorphic association — e.g. a `Post` that
 * has many `Comments`.
 *
 * @example
 * static relations = {
 *   comments: {
 *     type: 'morphMany',
 *     model: () => Comment,
 *     morphName: 'commentable',
 *     typeValue: 'post',
 *   },
 * }
 */
export type TMorphManyDefinition = {
    type: "morphMany";
    /** Lazy reference to the related (morph-owning) model. */
    model: () => TModelCtor<any>;
    /** Matches the morphName on the related model's morphTo relation. */
    morphName: string;
    /** Value written into the related model's type column for this parent. */
    typeValue: string;
    /** Override the type column on the related model (default `<morphName>_type`). */
    typeColumn?: string;
    /** Override the id column on the related model (default `<morphName>_id`). */
    idColumn?: string;
    /** Column on THIS model (default: this.primaryKey). */
    localKey?: string;
};

/**
 * Owning side of a one-to-one polymorphic association. Identical configuration
 * to `morphMany` — the resolver simply returns the first match.
 */
export type TMorphOneDefinition = Omit<TMorphManyDefinition, "type"> & { type: "morphOne" };

/**
 * Polymorphic many-to-many (parent → related, through a shared pivot table).
 *
 * Example: a `Post` (or `Video`) can have many `Tag`s through a `taggables`
 * pivot. The pivot has a `taggable_type` / `taggable_id` column pair pointing
 * back at the morph parent, and a `tag_id` column pointing at the related model.
 *
 * @example
 * // On the parent side (Post)
 * static relations = {
 *   tags: {
 *     type: 'morphToMany',
 *     model: () => Tag,
 *     pivot: 'taggables',
 *     morphName: 'taggable',       // → pivot.taggable_type + pivot.taggable_id
 *     typeValue: 'post',           // value stored in pivot.taggable_type
 *     relatedPivotKey: 'tag_id',
 *   },
 * }
 */
export type TMorphToManyDefinition = {
    type: "morphToMany";
    /** Lazy reference to the related model constructor (e.g. `() => Tag`). */
    model: () => TModelCtor<any>;
    /** Name of the pivot/junction table (e.g. `'taggables'`). */
    pivot: string;
    /** Morph base name on the pivot — `<morphName>_type` + `<morphName>_id`. */
    morphName: string;
    /** Value stored in `<morphName>_type` for this parent model. */
    typeValue: string;
    /** Column on the pivot referencing the related model (e.g. `'tag_id'`). */
    relatedPivotKey: string;
    /** Override the pivot's type column (default `<morphName>_type`). */
    typeColumn?: string;
    /** Override the pivot's id column (default `<morphName>_id`). */
    idColumn?: string;
    /** Column on THIS model (default: this.primaryKey). */
    localKey?: string;
    /** Column on the RELATED model (default: related.primaryKey). */
    relatedKey?: string;
};

/**
 * Inverse of `morphToMany` — defined on the related-side model (e.g. `Tag`),
 * pointing back at one specific parent class (e.g. `Post` or `Video`).
 *
 * Each parent class needs its own `morphedByMany` entry — same `pivot` /
 * `morphName`, different `typeValue` and `model`. Use this to list all
 * `Post`s for a given `Tag`, plus a separate relation for all `Video`s.
 *
 * @example
 * // On the Tag model
 * static relations = {
 *   posts: {
 *     type: 'morphedByMany',
 *     model: () => Post,
 *     pivot: 'taggables',
 *     morphName: 'taggable',
 *     typeValue: 'post',
 *     relatedPivotKey: 'tag_id',
 *   },
 *   videos: {
 *     type: 'morphedByMany',
 *     model: () => Video,
 *     pivot: 'taggables',
 *     morphName: 'taggable',
 *     typeValue: 'video',
 *     relatedPivotKey: 'tag_id',
 *   },
 * }
 */
export type TMorphedByManyDefinition = {
    type: "morphedByMany";
    /** Lazy reference to the morph-parent model (e.g. `() => Post`). */
    model: () => TModelCtor<any>;
    /** Name of the pivot table (must match the corresponding `morphToMany`). */
    pivot: string;
    /** Morph base name on the pivot. */
    morphName: string;
    /** Discriminator value identifying the parent model on the pivot. */
    typeValue: string;
    /** Column on the pivot referencing the related (Tag-side) model. */
    relatedPivotKey: string;
    /** Override the pivot's type column (default `<morphName>_type`). */
    typeColumn?: string;
    /** Override the pivot's id column (default `<morphName>_id`). */
    idColumn?: string;
    /** Column on THIS (related-side) model (default: this.primaryKey). */
    localKey?: string;
    /** Column on the parent model (default: parent.primaryKey). */
    relatedKey?: string;
};

// ── Union type ─────────────────────────────────────────────────────────

export type TRelationDefinition =
    | TBelongsToDefinition
    | THasManyDefinition
    | THasOneDefinition
    | TBelongsToManyDefinition
    | THasManyThroughDefinition
    | THasOneThroughDefinition
    | TMorphToDefinition
    | TMorphManyDefinition
    | TMorphOneDefinition
    | TMorphToManyDefinition
    | TMorphedByManyDefinition;
