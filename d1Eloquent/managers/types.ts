/**
 * Shared structural interface for model internals.
 * Used by AttributeManager and PersistenceManager to access model state.
 *
 * Package-internal only — not exported from the public API.
 * TypeScript access modifiers are compile-time only; at runtime,
 * BaseModel instances satisfy this interface via Object.defineProperty.
 */

import type { CastDefinition } from "../castManager";
import type { Attribute } from "../attribute";
import type { TRevisionConfig } from "../revisionTypes";
import type { THooks } from "../hookTypes";
import type { TRelationDefinition } from "../relationTypes";
import type { TKeyStrategy } from "../idGenerator";

export interface TModelInternals {
    // Instance state
    attrs: Record<string, unknown>;
    original: Partial<Record<string, unknown>>;
    dirty: Set<string>;
    lastChanges: Record<string, unknown>;
    _persisted: boolean;
    _wasRecentlyCreated: boolean;
    _accessorCache: Map<string, unknown>;
    relations: Record<string, unknown>;

    // Constructor metadata (accessed via model.constructor)
    constructor: TModelCtorMeta;
}

export interface TModelCtorMeta {
    table: string;
    primaryKey: string;
    timestamps?: boolean;
    softDeletes?: boolean;
    keyStrategy?: TKeyStrategy;
    casts?: Record<string, CastDefinition>;
    accessors?: Record<string, Attribute>;
    appends?: string[];
    hidden?: string[];
    fillable?: string[];
    guarded?: string[];
    revisions?: TRevisionConfig | false;
    revisionRedact?: string[];
    revisionOnly?: string[] | null;
    hooks?: THooks<any>;
    connection?: D1Database | string;
    relations?: Record<string, TRelationDefinition>;
}
