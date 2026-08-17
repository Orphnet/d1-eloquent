// src/index.ts - Main entry point for @orphnet/d1-eloquent
//
// NOTE: the published .d.ts files use the ambient Cloudflare D1 globals
// (D1Database, …), which every Cloudflare Workers consumer already provides via
// `@cloudflare/workers-types` (the declared peer dependency) or a generated
// `worker-configuration.d.ts`.
//
// We deliberately do NOT inject a `/// <reference types="@cloudflare/workers-types" />`
// banner into the emitted *.d.ts. When this package is consumed via `bun link`
// (the Orphnet local-dev workflow), that reference resolves to this package's
// OWN nested `@cloudflare/workers-types`, loading a SECOND copy of the runtime
// types. The duplicate `declare namespace Cloudflare { interface Env {} }` then
// breaks the consumer's `interface CloudflareBindings extends Cloudflare.Env`
// augmentation — every binding (DB, KV, …) resolves as missing. Relying on the
// consumer's single workers-types copy avoids the duplicate entirely.

// Core classes
export { BaseModel, validateDynamicModel } from "../d1Eloquent/baseModel";
export type { TBaseModelAttrs, TRelations, TDynamicModelConfig } from "../d1Eloquent/baseModel";

// Casting
export { CastManager, enumCast } from "../d1Eloquent/castManager";
export type { AttributeCast, BuiltInCast, CastDefinition } from "../d1Eloquent/castManager";

// Accessors
export { Attribute } from "../d1Eloquent/attribute";
export type { AccessorGetFn, AccessorSetFn } from "../d1Eloquent/attribute";
export { AccessorManager } from "../d1Eloquent/accessorManager";

// Proxy
export type { ModelProxy } from "../d1Eloquent/proxy";

export { QueryBuilder, PreparedQuery, Placeholder, placeholder } from "../d1Eloquent/queryBuilder";
export type {
    TPaginationResult,
    TSelectQuery,
    TQueryResult,
    TCursorPaginateOpts,
    TCursorPaginationResult,
    TEagerConstraint,
} from "../d1Eloquent/queryBuilder";
export { Collection } from "../d1Eloquent/collection";

// Relationships
export { belongsTo, hasMany, hasOne, belongsToMany, belongsToManyFetch } from "../d1Eloquent/relationships";
export type { TRelationship, TPivotMethods, TPivotSyncResult } from "../d1Eloquent/relationships";

// Declarative Relations
export { resolveRelation, deriveEagerLoaders, buildExistsSubquery } from "../d1Eloquent/relationResolver";
export type {
    TRelationDefinition,
    TBelongsToDefinition,
    THasManyDefinition,
    THasOneDefinition,
    TBelongsToManyDefinition,
    THasManyThroughDefinition,
    THasOneThroughDefinition,
    TMorphToDefinition,
    TMorphManyDefinition,
    TMorphOneDefinition,
    TMorphToManyDefinition,
    TMorphedByManyDefinition,
} from "../d1Eloquent/relationTypes";

// Revisions
export { RevisionManager } from "../d1Eloquent/revisionManager";
export { ModelRevision } from "../d1Eloquent/modelRevision";
export type { TModelRevisionAttrs } from "../d1Eloquent/modelRevision";

// Types
export type {
  TD1Row,
  TD1ResultMeta,
  TModelAttrsOf,
  TModelCtor,
  TModelRelationsOf,
  TSessionConstraint,
  TWhereOp,
  TOrderDirection,
} from "../d1Eloquent/types";

export type {
  TRevisionAction,
  TRevisionConfig,
  TRevisionContext,
  TRevisionRow,
} from "../d1Eloquent/revisionTypes";

// Exceptions
export { EloquentException, ModelNotFoundException, MultipleRecordsFoundException } from "../d1Eloquent/exceptions";

// Lifecycle hooks
export type { THooks, THookEvent, THookHandler } from "../d1Eloquent/hookTypes";

// Cache integration
export type { CacheAdapter, CacheInvalidationEvent } from "../d1Eloquent/cacheAdapter";
export { KvCacheAdapter } from "../d1Eloquent/kvCacheAdapter";
export type { TKvCacheAdapterOpts } from "../d1Eloquent/kvCacheAdapter";

// Configuration (re-exported so configure() shares the same registry as QueryBuilder)
export { configure } from "../d1Eloquent/config";
export type { TConfigureOpts } from "../d1Eloquent/config";
export {
    registerConnection,
    unregisterConnection,
    clearConnections,
    listConnections,
    getConnection,
} from "../d1Eloquent/registry";

// Identifier-safety helpers — opt-in guards for untrusted column / table names
export { safeIdent, safeIdentList } from "../d1Eloquent/utils";

// Primary-key generation — auto-id strategies + standalone id generators
export { uuid, uuidv7, ulid, generateId } from "../d1Eloquent/idGenerator";
export type { TKeyStrategy, TKeyGeneratorFn, TKeyGeneratorContext } from "../d1Eloquent/idGenerator";

// Transactions — write-only unit-of-work flushed as one atomic db.batch()
export { transaction, TransactionAborted } from "../d1Eloquent/transaction";
export type { Tx, TxOptions } from "../d1Eloquent/transaction";
