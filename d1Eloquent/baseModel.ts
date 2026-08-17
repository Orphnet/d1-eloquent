import {QueryBuilder} from "./queryBuilder";
import {assert, nowIso} from "./utils";
import type {TRevisionConfig, TRevisionContext} from "./revisionTypes";
import type {CacheAdapter} from "./cacheAdapter";
import {resolveDb} from "./registry";
import {CastManager} from "./castManager";
import type {CastDefinition, AttributeCast} from "./castManager";
import {AccessorManager} from "./accessorManager";
import type {Attribute} from "./attribute";
import {createModelProxy} from "./proxy";
import type {ModelProxy} from "./proxy";
import type {TRelationDefinition} from "./relationTypes";
import {resolveRelation, deriveEagerLoaders} from "./relationResolver";
import type {TRelationship, TPivotSyncResult} from "./relationships";
import {EloquentException, ModelNotFoundException} from "./exceptions";
import type {THooks, THookEvent, THookHandler} from "./hookTypes";
import {DirtyManager, snapshotOriginal} from "./managers/dirtyManager";
import type {TDirtyModel} from "./managers/dirtyManager";
import {TimestampManager} from "./managers/timestampManager";
import type {TTimestampModel} from "./managers/timestampManager";
import {KeyManager} from "./managers/keyManager";
import type {TKeyModel} from "./managers/keyManager";
import type {TKeyStrategy} from "./idGenerator";
import {HookManager} from "./managers/hookManager";
import {SoftDeleteManager} from "./managers/softDeleteManager";
import type {TSoftDeleteModel} from "./managers/softDeleteManager";
import {RelationManager} from "./managers/relationManager";
import type {TRelationalModel} from "./managers/relationManager";
import {AttributeManager as AttrMgr} from "./managers/attributeManager";
import {PersistenceManager as PersistMgr} from "./managers/persistenceManager";
import type {TModelInternals} from "./managers/types";
import {transaction} from "./transaction";
import type {Tx, TxOptions} from "./transaction";

export type TBaseModelAttrs = Record<string, unknown>;

/**
 * Default fallback for the third `BaseModel<…, …, TRels>` generic — opaque
 * map. Subclasses may pass a concrete shape like
 * `{ posts: Post[]; profile: Profile | null }` to type the `.relations`
 * property and downstream `setRelation` / `relations[name]` reads.
 */
export type TRelations = Record<string, unknown>;

/**
 * Extracts the attribute type from a BaseModel<TAttrs>.
 * Falls back to TBaseModelAttrs for non-BaseModel structural types.
 */
export type TModelAttrsOf<TModel> = TModel extends BaseModel<infer TAttrs, any, any>
    ? TAttrs
    : TBaseModelAttrs;

/**
 * Extracts the relations type from a BaseModel<…, …, TRels>.
 * Falls back to TRelations (Record<string, unknown>) when not narrowed.
 *
 * Useful for typed access patterns:
 * ```ts
 * type UserRels = TModelRelationsOf<User>;  // { posts: Post[]; profile: Profile | null }
 * ```
 */
export type TModelRelationsOf<TModel> = TModel extends BaseModel<any, any, infer TRels>
    ? TRels
    : TRelations;

/**
 * Constructor + static metadata for your models.
 *
 * Uses a structural constraint ({ toObject(): ... }) rather than the nominal BaseModel<any>
 * to avoid circular imports between baseModel.ts ↔ queryBuilder.ts.
 * All concrete model classes will satisfy this constraint since BaseModel implements toObject().
 */
export type TModelCtor<TModel extends { toObject(): object }> = {
    new (attrs?: Partial<TModelAttrsOf<TModel>>): TModel;

    table: string;
    primaryKey: string;

    timestamps?: boolean;
    casts?: Record<string, CastDefinition>;
    accessors?: Record<string, Attribute>;
    appends?: string[];
    hidden?: string[];
    fillable?: string[];
    guarded?: string[];

    revisions?: TRevisionConfig | false;
    revisionRedact?: string[];
    revisionOnly?: string[] | null;

    softDeletes?: boolean;

    connection?: D1Database | string;

    relations?: Record<string, TRelationDefinition>;
    scopes?: Record<string, (q: QueryBuilder<any, string>) => void>;
    globalScopes?: Record<string, (q: QueryBuilder<any, string>) => void>;
    hooks?: THooks<any>;
    eagerLoaders?: Record<string, (db: D1Database, models: any[]) => Promise<void>>;

    modelName?: string;

    /** @internal Used by static methods — inferred return type breaks circularity */
    query<T extends { toObject(): object } = TModel>(this: unknown): QueryBuilder<T, string>;
};

/**
 * Configuration object for creating dynamic model classes at runtime via BaseModel.dynamic().
 */
export type TDynamicModelConfig<TAttrs extends TBaseModelAttrs = TBaseModelAttrs> = {
    table: string;
    primaryKey?: string;
    modelName?: string;
    timestamps?: boolean;
    softDeletes?: boolean;
    keyStrategy?: TKeyStrategy;
    casts?: Record<string, CastDefinition>;
    relations?: Record<string, TRelationDefinition>;
    scopes?: Record<string, (q: QueryBuilder<any, string>) => void>;
    globalScopes?: Record<string, (q: QueryBuilder<any, string>) => void>;
    hooks?: THooks<any>;
    fillable?: string[];
    guarded?: string[];
    connection?: D1Database | string;
    accessors?: Record<string, Attribute>;
    appends?: string[];
    hidden?: string[];
    revisions?: TRevisionConfig | false;
    revisionRedact?: string[];
    revisionOnly?: string[] | null;
};

/**
 * Validates that a constructor has the required static properties to function as a model.
 * Called automatically by BaseModel.dynamic(). Also useful for manually-constructed model classes.
 */
export function validateDynamicModel(ctor: unknown): asserts ctor is TModelCtor<any> {
    if (!ctor || typeof ctor !== 'function') {
        throw new EloquentException('validateDynamicModel: expected a class constructor');
    }
    const c = ctor as unknown as Record<string, unknown>;
    if (!c.table || typeof c.table !== 'string') {
        throw new EloquentException("Dynamic model missing required static property 'table'");
    }
    if (!c.primaryKey || typeof c.primaryKey !== 'string') {
        throw new EloquentException("Dynamic model missing required static property 'primaryKey'");
    }
}

export abstract class BaseModel<
    TAttrs extends object = TBaseModelAttrs,
    TVirtuals extends Record<string, unknown> = {},
    TRels extends Record<string, unknown> = TRelations,
> {
    public static table: string;
    public static primaryKey = "id";
    public static timestamps: boolean = true;
    public static casts?: Record<string, CastDefinition>;
    public static accessors?: Record<string, Attribute>;
    public static appends?: string[];
    public static hidden?: string[];

    /**
     * Whitelist of attributes that can be mass-assigned via fill().
     * If set, only these keys are accepted. Mutually exclusive with guarded.
     */
    public static fillable?: string[];

    /**
     * Blacklist of attributes that cannot be mass-assigned via fill().
     * Default: ["id"]. Set to empty array to allow all.
     */
    public static guarded?: string[];

    declare protected attrs: TAttrs;
    declare protected original: Partial<TAttrs>;
    declare protected dirty: Set<keyof TAttrs>;
    declare protected lastChanges: Partial<TAttrs>;

    /** Whether this model has been persisted to (or loaded from) the database. */
    declare public _persisted: boolean;

    /** Internal backing for {@link wasRecentlyCreated}. */
    declare public _wasRecentlyCreated: boolean;

    /** Per-instance cache of accessor get() results. Cleared on any set/setRaw/fill. */
    declare private _accessorCache: Map<string, unknown>;

    /** Lazily-created proxy instance. @see asProxy() */
    declare private _proxy: ModelProxy<TAttrs, TVirtuals> | undefined;

    public static revisions: TRevisionConfig | false = false;
    public static revisionRedact: string[] = [];
    public static revisionOnly: string[] | null = null; // if set → whitelist mode

    public static softDeletes: boolean = false;

    /**
     * Strategy for auto-generating the primary key on insert when the caller
     * does not supply one. Defaults to `'uuid'` (RFC 4122 v4 via
     * `crypto.randomUUID()`). Set to `'uuidv7'` or `'ulid'` for sortable keys, a
     * generator function for full control, or `false` to disable auto-generation
     * (a missing key then throws on insert). An explicitly-provided key is always
     * respected regardless of this setting.
     */
    public static keyStrategy: TKeyStrategy = "uuid";

    /**
     * Declarative relation definitions.
     * Used by has()/whereHas() on QueryBuilder and for auto-derived eager loaders.
     */
    public static relations?: Record<string, TRelationDefinition>;

    /**
     * Named query scopes. Each scope is a function that modifies a QueryBuilder.
     * Apply via `Model.query().scoped("active")` or `Model.query().scoped("active", "recent")`.
     */
    public static scopes?: Record<string, (q: QueryBuilder<any, string>) => void>;

    /**
     * Global query scopes — auto-applied to EVERY query for this model (and its
     * eager-loaded / relation queries) unless skipped per-query via
     * `query().withoutGlobalScope(name)` / `withoutGlobalScopes()`. Each is a
     * function that adds constraints to a QueryBuilder (e.g. a tenant filter).
     *
     * @example
     * static globalScopes = {
     *   current_tenant: (q) => q.whereEq("tenant_id", currentTenantId()),
     * }
     */
    public static globalScopes?: Record<string, (q: QueryBuilder<any, string>) => void>;

    /**
     * Lifecycle hooks. "Before" hooks (creating, updating, saving, deleting) can
     * return `false` to cancel the operation. "After" hooks run post-write.
     *
     * @example
     * static hooks = {
     *   creating: (model) => { model.set("slug", slugify(model.get("title"))); },
     *   deleted: (model) => { console.log("Deleted:", model.getKey()); },
     * }
     */
    public static hooks?: THooks<any>;

    /**
     * Optional default database connection for this model.
     * Can be a D1Database binding directly, or a string key registered via configure().
     * Bypassed automatically in test mode (NODE_ENV=test), which uses the "test" connection instead.
     */
    public static connection?: D1Database | string;

    /**
     * Human-readable name for this model, used in exception messages.
     * Falls back to `table` if not set. Particularly useful for dynamic models.
     */
    public static modelName?: string;

    public relations: TRels = {} as TRels;

    public constructor(attrs?: Partial<TAttrs>) {
        const raw = { ...(attrs ?? {}) } as Record<string, unknown>;
        const casts = CastManager.resolveCastsFor(this.constructor as typeof BaseModel);
        const initial = CastManager.hydrateRow(casts, raw) as TAttrs;

        Object.defineProperty(this, 'attrs', {
            value: initial,
            writable: true,
            enumerable: false,
            configurable: false,
        });
        Object.defineProperty(this, 'original', {
            value: snapshotOriginal(initial as Record<string, unknown>),
            writable: true,
            enumerable: false,
            configurable: false,
        });
        Object.defineProperty(this, 'dirty', {
            value: new Set<keyof TAttrs>(),
            writable: true,
            enumerable: false,
            configurable: false,
        });
        Object.defineProperty(this, 'lastChanges', {
            value: {} as Partial<TAttrs>,
            writable: true,
            enumerable: false,
            configurable: false,
        });
        Object.defineProperty(this, '_persisted', {
            value: false,
            writable: true,
            enumerable: false,
            configurable: false,
        });
        Object.defineProperty(this, '_wasRecentlyCreated', {
            value: false,
            writable: true,
            enumerable: false,
            configurable: false,
        });
        Object.defineProperty(this, '_accessorCache', {
            value: new Map<string, unknown>(),
            writable: true,
            enumerable: false,
            configurable: false,
        });
    }

    /**
     * ---- Static meta helpers ----
     */
    public static getTable<TModel extends { toObject(): object }>(this: TModelCtor<TModel>): string {
        return this.table;
    }

    public static getKeyName<TModel extends { toObject(): object }>(this: TModelCtor<TModel>): string {
        return this.primaryKey;
    }

    public static getPrimaryKeyName<TModel extends { toObject(): object }>(this: TModelCtor<TModel>): string {
        return this.primaryKey;
    }

    /**
     * ---- Attribute helpers ----
     */
    public get<K extends keyof TAttrs>(key: K): TAttrs[K] {
        return AttrMgr.get(this as unknown as TModelInternals, key as string) as TAttrs[K];
    }

    public getRaw<K extends keyof TAttrs>(key: K): TAttrs[K] {
        return AttrMgr.getRaw(this as unknown as TModelInternals, key as string) as TAttrs[K];
    }

    public getOriginal<K extends keyof TAttrs>(key: K): TAttrs[K] {
        return AttrMgr.getOriginal(this as unknown as TModelInternals, key as string) as TAttrs[K];
    }

    public clearAccessorCache(): void {
        AttrMgr.clearAccessorCache(this as unknown as TModelInternals);
    }

    /**
     * Returns a Proxy wrapper enabling direct property access (proxy.key).
     * The proxy is created lazily and cached on the instance.
     * proxy.key resolves through get() (accessor pipeline).
     * proxy.key = value resolves through set() (mutator pipeline).
     */
    public asProxy(): ModelProxy<TAttrs, TVirtuals> {
        if (!this._proxy) {
            Object.defineProperty(this, '_proxy', {
                value: createModelProxy<TAttrs, TVirtuals>(this),
                writable: false,
                enumerable: false,
                configurable: false,
            });
        }
        return this._proxy!;
    }

    public set<K extends keyof TAttrs>(key: K, value: TAttrs[K]): this {
        AttrMgr.set(this as unknown as TModelInternals, key as string, value);
        return this;
    }

    public fill(values: Partial<TAttrs>): this {
        AttrMgr.fill(this as unknown as TModelInternals, values as Record<string, unknown>);
        return this;
    }

    public forceFill(values: Partial<TAttrs>): this {
        AttrMgr.forceFill(this as unknown as TModelInternals, values as Record<string, unknown>);
        return this;
    }

    public toObject(): TAttrs {
        return AttrMgr.toObject(this as unknown as TModelInternals) as TAttrs;
    }

    public toJSON(): Record<string, unknown> {
        return AttrMgr.toJSON(this as unknown as TModelInternals);
    }

    public toRaw(): Record<string, unknown> {
        return AttrMgr.toRaw(this as unknown as TModelInternals);
    }

    /**
     * ---- Primary key helpers ----
     */
    public getKeyName(): string {
        return (this.constructor as typeof BaseModel).primaryKey;
    }

    public getKey<T = unknown>(): T | null {
        const keyName = this.getKeyName() as keyof TAttrs;
        const v = this.attrs[keyName] as unknown;
        return (v ?? null) as T | null;
    }

    public key<T = unknown>(): T | null {
        return this.getKey<T>();
    }

    public setKey(value: unknown): this {
        const keyName = this.getKeyName() as keyof TAttrs;
        this.set(keyName, value as TAttrs[keyof TAttrs]);
        return this;
    }

    public exists(): boolean {
        return this.getKey() !== null;
    }

    /**
     * Whether this instance has been soft-deleted.
     */
    public trashed(): boolean {
        return SoftDeleteManager.trashed(this as unknown as TSoftDeleteModel);
    }

    /**
     * ---- Dirty / changes ----
     */
    public isDirty(key?: keyof TAttrs): boolean {
        return DirtyManager.isDirty(this as unknown as TDirtyModel, key as string);
    }

    public getDirty(): Partial<TAttrs> {
        return DirtyManager.getDirty(this as unknown as TDirtyModel) as Partial<TAttrs>;
    }

    public getChanges(): Partial<TAttrs> {
        return DirtyManager.getChanges(this as unknown as TDirtyModel) as Partial<TAttrs>;
    }

    public wasChanged(key?: keyof TAttrs): boolean {
        return DirtyManager.wasChanged(this as unknown as TDirtyModel, key as string);
    }

    protected syncOriginal(): void {
        DirtyManager.syncOriginal(this as unknown as TDirtyModel);
    }

    /**
     * Relations
     */
    public setRelation<T>(name: string, value: T): this {
        RelationManager.setRelation(this as unknown as TRelationalModel, name, value);
        return this;
    }

    /**
     * Resolve a named relation from `static relations` metadata.
     * Returns a TRelationship with query/get/first for lazy loading.
     *
     * @example
     * const comments = await post.related("comments").get(db);
     */
    public related(name: string): TRelationship<any> {
        return RelationManager.resolveRelated(this as unknown as TRelationalModel, name);
    }

    /**
     * ---- Pivot sugar ----
     *
     * Direct-on-the-model shortcuts for the four pivot-management
     * methods that already exist on `model.related(name)`. These let you
     * skip the `.related(name)` hop on pivot-backed relationships
     * (`belongsToMany`, `morphToMany`, `morphedByMany`).
     *
     * Throws if the named relation is not pivot-backed.
     */
    public attach(
        name: string,
        ids: string | number | (string | number)[],
        opts?: { extras?: Record<string, unknown>; db?: D1Database },
    ): Promise<number> {
        const rel = this.related(name);
        if (!rel.attach) {
            throw new Error(`Relation '${name}' is not pivot-backed; .attach() is unavailable.`);
        }
        return rel.attach(ids, opts);
    }

    public detach(
        name: string,
        ids?: string | number | (string | number)[],
        opts?: { db?: D1Database },
    ): Promise<number> {
        const rel = this.related(name);
        if (!rel.detach) {
            throw new Error(`Relation '${name}' is not pivot-backed; .detach() is unavailable.`);
        }
        return rel.detach(ids, opts);
    }

    public sync(
        name: string,
        ids: (string | number)[],
        opts?: { extras?: Record<string, unknown>; db?: D1Database },
    ): Promise<TPivotSyncResult> {
        const rel = this.related(name);
        if (!rel.sync) {
            throw new Error(`Relation '${name}' is not pivot-backed; .sync() is unavailable.`);
        }
        return rel.sync(ids, opts);
    }

    public toggle(
        name: string,
        ids: string | number | (string | number)[],
        opts?: { extras?: Record<string, unknown>; db?: D1Database },
    ): Promise<TPivotSyncResult> {
        const rel = this.related(name);
        if (!rel.toggle) {
            throw new Error(`Relation '${name}' is not pivot-backed; .toggle() is unavailable.`);
        }
        return rel.toggle(ids, opts);
    }

    /**
     * ---- Query helpers ----
     */
    public static query<TModel extends { toObject(): object }>(this: TModelCtor<TModel>, db?: D1Database): QueryBuilder<TModel, string> {
        const qb = new QueryBuilder<TModel, string>(this);
        if (db) qb.setDefaultDb(db);
        return qb;
    }

    /**
     * Create a configured BaseModel subclass at runtime from a config object.
     * No pre-defined model file required.
     *
     * SECURITY: `config.table` is emitted verbatim into SQL — never pass
     * user-controlled input without wrapping it with `safeIdent()` first.
     *
     * @example
     * const Product = BaseModel.dynamic({
     *     table: 'products',
     *     softDeletes: true,
     *     casts: { price: 'real', specs: 'json' },
     *     fillable: ['title', 'price', 'specs'],
     * });
     * const product = await Product.find(db, 'some-id');
     */
    public static dynamic<TAttrs extends TBaseModelAttrs = TBaseModelAttrs>(
        config: TDynamicModelConfig<TAttrs>,
    ): TModelCtor<BaseModel<TAttrs>> {
        const DynamicModel = class extends BaseModel<TAttrs> {};

        DynamicModel.table = config.table;
        DynamicModel.primaryKey = config.primaryKey ?? 'id';

        if (config.modelName !== undefined)      DynamicModel.modelName = config.modelName;
        if (config.timestamps !== undefined)     DynamicModel.timestamps = config.timestamps;
        if (config.softDeletes !== undefined)    DynamicModel.softDeletes = config.softDeletes;
        if (config.keyStrategy !== undefined)    DynamicModel.keyStrategy = config.keyStrategy;
        if (config.casts !== undefined)          DynamicModel.casts = config.casts;
        if (config.relations !== undefined)      DynamicModel.relations = config.relations;
        if (config.scopes !== undefined)         DynamicModel.scopes = config.scopes;
        if (config.globalScopes !== undefined)   DynamicModel.globalScopes = config.globalScopes;
        if (config.hooks !== undefined)          DynamicModel.hooks = config.hooks;
        if (config.fillable !== undefined)       DynamicModel.fillable = config.fillable;
        if (config.guarded !== undefined)        DynamicModel.guarded = config.guarded;
        if (config.connection !== undefined)     DynamicModel.connection = config.connection;
        if (config.accessors !== undefined)      DynamicModel.accessors = config.accessors;
        if (config.appends !== undefined)        DynamicModel.appends = config.appends;
        if (config.hidden !== undefined)         DynamicModel.hidden = config.hidden;
        if (config.revisions !== undefined)      DynamicModel.revisions = config.revisions;
        if (config.revisionRedact !== undefined) DynamicModel.revisionRedact = config.revisionRedact;
        if (config.revisionOnly !== undefined)   DynamicModel.revisionOnly = config.revisionOnly;

        validateDynamicModel(DynamicModel);

        return DynamicModel as unknown as TModelCtor<BaseModel<TAttrs>>;
    }

    public static async find<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database | null | undefined,
        id: unknown,
    ): Promise<TModel | null>;
    public static async find<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        id: unknown,
    ): Promise<TModel | null>;
    public static async find<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrId: D1Database | null | undefined | unknown,
        id?: unknown,
    ): Promise<TModel | null> {
        const isDb = dbOrId !== null && typeof dbOrId === "object" && "prepare" in (dbOrId as object);
        const _db = isDb ? (dbOrId as D1Database) : undefined;
        const _id = isDb ? id : dbOrId;
        if (typeof _id !== "string" || _id.length === 0) return null;
        return this.query().whereEq(this.primaryKey, _id).first(_db);
    }

    public static async findOrFail<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database | null | undefined,
        id: string,
    ): Promise<TModel>;
    public static async findOrFail<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        id: string,
    ): Promise<TModel>;
    public static async findOrFail<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrId: D1Database | null | undefined | string,
        id?: string,
    ): Promise<TModel> {
        const isDb = dbOrId !== null && typeof dbOrId === "object" && "prepare" in (dbOrId as object);
        const _db = isDb ? (dbOrId as D1Database) : undefined;
        const _id = isDb ? id! : (dbOrId as string);
        const model = await this.query().whereEq(this.primaryKey, _id).first(_db);
        if (!model) throw new ModelNotFoundException(this.modelName ?? this.table, _id);
        return model;
    }

    public static async all<TModel extends { toObject(): object }>(this: TModelCtor<TModel>, db?: D1Database): Promise<TModel[]> {
        return this.query().get(db);
    }

    public static async create<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database | undefined,
        attrs: Partial<TModelAttrsOf<TModel>>,
        opts?: { revision?: TRevisionContext; cache?: CacheAdapter },
    ): Promise<TModel>;
    public static async create<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        attrs: Partial<TModelAttrsOf<TModel>>,
        opts?: { revision?: TRevisionContext; cache?: CacheAdapter },
    ): Promise<TModel>;
    public static async create<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrAttrs: D1Database | undefined | Partial<TModelAttrsOf<TModel>>,
        attrsOrOpts?: Partial<TModelAttrsOf<TModel>> | { revision?: TRevisionContext; cache?: CacheAdapter },
        opts?: { revision?: TRevisionContext; cache?: CacheAdapter },
    ): Promise<TModel> {
        const isDb = dbOrAttrs !== null && typeof dbOrAttrs === "object" && "prepare" in (dbOrAttrs as object);
        const _db = isDb ? (dbOrAttrs as D1Database) : undefined;
        const _attrs = isDb ? (attrsOrOpts as Partial<TModelAttrsOf<TModel>>) : (dbOrAttrs as Partial<TModelAttrsOf<TModel>>);
        const _opts = isDb ? opts : (attrsOrOpts as { revision?: TRevisionContext; cache?: CacheAdapter } | undefined);
        const model = new this();
        (model as unknown as BaseModel<TBaseModelAttrs>).fill(_attrs as Partial<TBaseModelAttrs>);
        await (model as unknown as BaseModel<TBaseModelAttrs>).save(_db, _opts);
        return (model as unknown as BaseModel<any>).asProxy() as unknown as TModel;
    }

    /**
     * Bulk-create multiple rows in a single `db.batch()` round-trip while still
     * running per-row mutators, casts, and `saving` / `creating` / `created` /
     * `saved` hooks. Rows whose `creating` or `saving` hook returns `false` are
     * filtered out — they appear in neither the database nor the returned array.
     *
     * Returns the persisted models in the same order as input (minus filtered
     * rows). Each returned model is proxy-wrapped exactly like `create()`.
     *
     * Limitations vs. looping `create()`:
     *  - Revisions are **not** written. If the model has
     *    `static revisions.enabled = true`, this method throws unless the
     *    caller opts in via `{ skipRevisions: true }`. Use `create()` in a loop
     *    when you need a revision row per insert.
     *  - Cache invalidation runs once per row after the batch (best-effort).
     *
     * @example
     * const users = await User.createMany([
     *   { id: crypto.randomUUID(), name: 'Alice' },
     *   { id: crypto.randomUUID(), name: 'Bob' },
     * ]);
     */
    public static async createMany<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database | undefined,
        rows: Partial<TModelAttrsOf<TModel>>[],
        opts?: { cache?: CacheAdapter; skipRevisions?: boolean },
    ): Promise<TModel[]>;
    public static async createMany<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        rows: Partial<TModelAttrsOf<TModel>>[],
        opts?: { cache?: CacheAdapter; skipRevisions?: boolean },
    ): Promise<TModel[]>;
    public static async createMany<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrRows: D1Database | undefined | Partial<TModelAttrsOf<TModel>>[],
        rowsOrOpts?: Partial<TModelAttrsOf<TModel>>[] | { cache?: CacheAdapter; skipRevisions?: boolean },
        opts?: { cache?: CacheAdapter; skipRevisions?: boolean },
    ): Promise<TModel[]> {
        const isDb =
            dbOrRows !== null &&
            typeof dbOrRows === "object" &&
            !Array.isArray(dbOrRows) &&
            "prepare" in (dbOrRows as object);
        const _db = isDb ? (dbOrRows as D1Database) : undefined;
        const _rows = (isDb ? rowsOrOpts : dbOrRows) as Partial<TModelAttrsOf<TModel>>[];
        const _opts = (isDb ? opts : (rowsOrOpts as { cache?: CacheAdapter; skipRevisions?: boolean } | undefined)) ?? {};

        if (!Array.isArray(_rows) || _rows.length === 0) return [];

        const ctor = this as unknown as typeof BaseModel;
        const revCfg = ctor.revisions as TRevisionConfig | false | undefined;
        if (revCfg && revCfg.enabled && !_opts.skipRevisions) {
            throw new EloquentException(
                `${ctor.name}.createMany() will not write revisions. ` +
                    `Use create() in a loop, or pass { skipRevisions: true } to bulk-insert without revisions.`,
            );
        }

        // 1. Build candidate models, run mutators via fill(), apply timestamps,
        //    and fire saving + creating hooks. Cancelled rows are dropped.
        const candidates: { model: BaseModel<TBaseModelAttrs>; insertRow: Record<string, unknown> } [] = [];
        for (const row of _rows) {
            const model = new this() as unknown as BaseModel<TBaseModelAttrs>;
            model.fill(row as Partial<TBaseModelAttrs>);

            if (!(await HookManager.fireHook(model as unknown as TModelInternals, "saving"))) continue;
            if (!(await HookManager.fireHook(model as unknown as TModelInternals, "creating"))) continue;

            TimestampManager.applyTimestamps(model as unknown as TTimestampModel, true);
            // Auto-generate the primary key when absent (respects an explicit id).
            KeyManager.applyKeyStrategy(model as unknown as TKeyModel);

            const id = (model as unknown as { getKey(): unknown }).getKey();
            assert(id, `Missing primary key '${ctor.primaryKey}' on createMany row`);

            // Get the DB-safe row payload using existing AttributeManager → cast pipeline
            const insertRow = AttrMgr.toRaw(model as unknown as TModelInternals);
            candidates.push({ model, insertRow });
        }

        if (candidates.length === 0) return [];

        // 2. Resolve DB and build prepared statements
        const dbResolved = resolveDb(_db, ctor.connection);
        const table = ctor.table;
        const stmts = candidates.map(({ insertRow }) => {
            const cols = Object.keys(insertRow);
            const placeholders = cols.map(() => "?").join(", ");
            const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
            const bindings = cols.map((k) => insertRow[k]);
            return dbResolved.prepare(sql).bind(...bindings);
        });

        // 3. Single-batch insert
        await dbResolved.batch(stmts);

        // 4. Mark persisted, sync original, fire after-hooks, invalidate cache
        const results: TModel[] = [];
        for (const { model } of candidates) {
            (model as unknown as { _persisted: boolean; _wasRecentlyCreated: boolean })._persisted = true;
            (model as unknown as { _wasRecentlyCreated: boolean })._wasRecentlyCreated = true;
            DirtyManager.syncOriginal(model as unknown as TDirtyModel);
            await HookManager.fireHook(model as unknown as TModelInternals, "created");
            await HookManager.fireHook(model as unknown as TModelInternals, "saved");

            if (_opts.cache) {
                const id = (model as unknown as { getKey(): unknown }).getKey() as string;
                await _opts.cache.invalidate({ table, id, action: "create" });
            }

            results.push((model as unknown as BaseModel<any>).asProxy() as unknown as TModel);
        }

        return results;
    }

    /**
     * Find first matching record or create a new one.
     *
     * @param search - WHERE conditions to search by
     * @param values - Additional attributes for creation (merged with search)
     *
     * @example
     * const user = await User.firstOrCreate(db, { email: "a@b.com" }, { name: "Alice" })
     */
    public static async firstOrCreate<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database | undefined,
        search: Partial<TModelAttrsOf<TModel>>,
        values?: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel>;
    public static async firstOrCreate<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        search: Partial<TModelAttrsOf<TModel>>,
        values?: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel>;
    public static async firstOrCreate<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrSearch: D1Database | undefined | Partial<TModelAttrsOf<TModel>>,
        searchOrValues?: Partial<TModelAttrsOf<TModel>>,
        values?: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel> {
        const isDb = dbOrSearch !== null && typeof dbOrSearch === "object" && "prepare" in (dbOrSearch as object);
        const _db = isDb ? (dbOrSearch as D1Database) : undefined;
        const _search = (isDb ? searchOrValues : dbOrSearch) as Partial<TModelAttrsOf<TModel>>;
        const _values = isDb ? values : searchOrValues;

        let qb = this.query();
        for (const [k, v] of Object.entries(_search)) {
            qb = qb.whereEq(k, v);
        }
        const existing = await qb.first(_db);
        if (existing) return existing;

        const merged = { ..._search, ...(_values ?? {}) } as Partial<TModelAttrsOf<TModel>>;
        const model = new this();
        (model as unknown as BaseModel<TBaseModelAttrs>).fill(merged as Partial<TBaseModelAttrs>);
        await (model as unknown as BaseModel<TBaseModelAttrs>).save(_db);
        return (model as unknown as BaseModel<any>).asProxy() as unknown as TModel;
    }

    /**
     * Find first matching record or create a new (unpersisted) instance.
     *
     * @param search - WHERE conditions to search by
     * @param values - Additional attributes for the new instance (merged with search)
     */
    public static async firstOrNew<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database | undefined,
        search: Partial<TModelAttrsOf<TModel>>,
        values?: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel>;
    public static async firstOrNew<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        search: Partial<TModelAttrsOf<TModel>>,
        values?: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel>;
    public static async firstOrNew<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrSearch: D1Database | undefined | Partial<TModelAttrsOf<TModel>>,
        searchOrValues?: Partial<TModelAttrsOf<TModel>>,
        values?: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel> {
        const isDb = dbOrSearch !== null && typeof dbOrSearch === "object" && "prepare" in (dbOrSearch as object);
        const _db = isDb ? (dbOrSearch as D1Database) : undefined;
        const _search = (isDb ? searchOrValues : dbOrSearch) as Partial<TModelAttrsOf<TModel>>;
        const _values = isDb ? values : searchOrValues;

        let qb = this.query();
        for (const [k, v] of Object.entries(_search)) {
            qb = qb.whereEq(k, v);
        }
        const existing = await qb.first(_db);
        if (existing) return existing;

        const merged = { ..._search, ...(_values ?? {}) } as Partial<TModelAttrsOf<TModel>>;
        const model = new this();
        (model as unknown as BaseModel<TBaseModelAttrs>).fill(merged as Partial<TBaseModelAttrs>);
        return (model as unknown as BaseModel<any>).asProxy() as unknown as TModel;
    }

    /**
     * Find or create, then update with additional values.
     *
     * @param search - WHERE conditions to search by
     * @param values - Attributes to set on the found/created model
     *
     * @example
     * const user = await User.updateOrCreate(db, { email: "a@b.com" }, { name: "Alice", last_login: now })
     */
    public static async updateOrCreate<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database | undefined,
        search: Partial<TModelAttrsOf<TModel>>,
        values: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel>;
    public static async updateOrCreate<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        search: Partial<TModelAttrsOf<TModel>>,
        values: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel>;
    public static async updateOrCreate<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrSearch: D1Database | undefined | Partial<TModelAttrsOf<TModel>>,
        searchOrValues: Partial<TModelAttrsOf<TModel>>,
        values?: Partial<TModelAttrsOf<TModel>>,
    ): Promise<TModel> {
        const isDb = dbOrSearch !== null && typeof dbOrSearch === "object" && "prepare" in (dbOrSearch as object);
        const _db = isDb ? (dbOrSearch as D1Database) : undefined;
        const _search = (isDb ? searchOrValues : dbOrSearch) as Partial<TModelAttrsOf<TModel>>;
        const _values = (isDb ? values : searchOrValues) as Partial<TModelAttrsOf<TModel>>;

        let qb = this.query();
        for (const [k, v] of Object.entries(_search)) {
            qb = qb.whereEq(k, v);
        }
        const existing = await qb.first(_db);

        if (existing) {
            (existing as unknown as BaseModel<TBaseModelAttrs>).fill(_values as Partial<TBaseModelAttrs>);
            await (existing as unknown as BaseModel<TBaseModelAttrs>).save(_db);
            return existing;
        }

        const merged = { ..._search, ..._values } as Partial<TModelAttrsOf<TModel>>;
        const model = new this();
        (model as unknown as BaseModel<TBaseModelAttrs>).fill(merged as Partial<TBaseModelAttrs>);
        await (model as unknown as BaseModel<TBaseModelAttrs>).save(_db);
        return (model as unknown as BaseModel<any>).asProxy() as unknown as TModel;
    }

    /**
     * Run writes atomically. Two forms:
     * - `transaction(db, stmts[])` — batch pre-built prepared statements, returns their `D1Result[]`.
     * - `transaction(db, fn, opts?)` — closure form: `fn` receives a write-only `tx`
     *   collector (create/save/update/delete/upsert/updateJson*); everything flushes
     *   as ONE `db.batch()` when the closure returns. Delegates to `transaction()`.
     */
    public static transaction(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]>;
    public static transaction<T>(db: D1Database, fn: (tx: Tx) => T | Promise<T>, opts?: TxOptions): Promise<T>;
    public static transaction(
        db: D1Database,
        arg: D1PreparedStatement[] | ((tx: Tx) => unknown),
        opts?: TxOptions,
    ): Promise<unknown> {
        if (typeof arg === "function") return transaction(db, arg as (tx: Tx) => unknown, opts);
        return db.batch(arg);
    }

    /**
     * ---- Persistence ----
     */
    protected applyTimestamps(isCreating: boolean): void {
        TimestampManager.applyTimestamps(this as unknown as TTimestampModel, isCreating);
    }

    protected getCtor(): TModelCtor<this> {
        return this.constructor as unknown as TModelCtor<this>;
    }

    /**
     * Protected getter that provides typed access to static properties on the concrete subclass.
     * Concentrates the unavoidable `this.constructor as typeof BaseModel` cast in one place.
     * All instance methods should use `this.ctor.table`, `this.ctor.revisions`, etc.
     */
    protected get ctor(): typeof BaseModel {
        return this.constructor as typeof BaseModel;
    }

    /**
     * Run lifecycle hook(s) for the given event.
     * Returns `false` if any "before" hook explicitly returned `false` (cancel signal).
     */
    private async fireHook(event: THookEvent): Promise<boolean> {
        return HookManager.fireHook(this, event);
    }

    /**
     * Private helper for ORM-managed field writes (created_at, updated_at, deleted_at).
     * Bypasses the `keyof TAttrs` constraint intentionally — managed fields are written
     * internally by the ORM and are guaranteed to exist in the consumer's TAttrs by convention.
     */
    private setRaw(key: string, value: unknown): void {
        AttrMgr.setRaw(this as unknown as TModelInternals, key, value);
    }

    protected async performInsert(db?: D1Database): Promise<void> {
        await PersistMgr.performInsert(this as unknown as TModelInternals, db);
    }

    protected async performUpdate(db?: D1Database): Promise<number> {
        return PersistMgr.performUpdate(this as unknown as TModelInternals, db);
    }

    public async save(
        dbOrOpts?: D1Database | { revision?: TRevisionContext; cache?: CacheAdapter },
        opts?: { revision?: TRevisionContext; cache?: CacheAdapter }
    ): Promise<this> {
        const isDb = dbOrOpts != null && typeof dbOrOpts === "object" && "prepare" in (dbOrOpts as object);
        const _db = isDb ? (dbOrOpts as D1Database) : undefined;
        const _opts = isDb ? opts : (dbOrOpts as { revision?: TRevisionContext; cache?: CacheAdapter } | undefined);
        await PersistMgr.save(this as unknown as TModelInternals, _db, _opts);
        return this;
    }

    /**
     * `true` only for the current instance's lifecycle after it was INSERTed
     * (via `create()` / `createMany()` / a `save()` that inserted). `false` for
     * models loaded from the database or persisted via an UPDATE. Handy after
     * `firstOrCreate` / `updateOrCreate` to branch on "did we just create it?".
     */
    public get wasRecentlyCreated(): boolean {
        return this._wasRecentlyCreated;
    }

    /**
     * Return a new **unsaved** copy of this model with the primary key,
     * timestamps (`created_at`/`updated_at`), and — for soft-delete models —
     * `deleted_at` stripped, plus any keys in `except`. Call `save()` to persist
     * it (a fresh primary key is generated per the model's `keyStrategy`).
     *
     * @example
     * const draft = original.replicate(['slug'])
     * await draft.save()
     */
    public replicate(except?: (keyof TAttrs & string)[]): this {
        const skip = new Set<string>([
            this.getKeyName(),
            "created_at",
            "updated_at",
            ...(this.ctor.softDeletes ? ["deleted_at"] : []),
            ...((except ?? []) as string[]),
        ]);
        const Ctor = this.constructor as unknown as new () => BaseModel<TAttrs>;
        const clone = new Ctor();
        // Copy every non-skipped column as a DIRTY attribute (setRaw hydrates the raw
        // value and marks it dirty) onto an otherwise-empty clone. This mirrors a
        // freshly-created model: isDirty() reports true and a later save() records a
        // full create revision — instead of an empty-diff "clean" unsaved row.
        const internals = clone as unknown as TModelInternals;
        const raw = this.toRaw();
        for (const [k, v] of Object.entries(raw)) {
            if (!skip.has(k)) AttrMgr.setRaw(internals, k, v);
        }
        return (clone as unknown as BaseModel<any>).asProxy() as unknown as this;
    }

    /**
     * Atomically increment a numeric column on this row and sync the in-memory
     * attribute: `UPDATE <table> SET <column> = <column> + ? WHERE <pk> = ?`.
     * `amount` defaults to 1; `extra` sets additional columns in the same UPDATE.
     * `updated_at` is touched when timestamps are enabled. This is a direct atomic
     * write — it does NOT fire lifecycle hooks or write revisions.
     *
     * @example
     * await post.increment('views')
     * await wallet.increment('balance', 500, { last_topup_at: nowIso() })
     */
    public async increment(column: keyof TAttrs & string, amount?: number, extra?: Partial<TAttrs>): Promise<this>;
    public async increment(column: keyof TAttrs & string, extra: Partial<TAttrs>): Promise<this>;
    public async increment(db: D1Database, column: keyof TAttrs & string, amount?: number, extra?: Partial<TAttrs>): Promise<this>;
    public async increment(db: D1Database, column: keyof TAttrs & string, extra: Partial<TAttrs>): Promise<this>;
    public async increment(
        dbOrColumn: D1Database | (keyof TAttrs & string),
        columnOrAmount?: (keyof TAttrs & string) | number | Partial<TAttrs>,
        amountOrExtra?: number | Partial<TAttrs>,
        extra?: Partial<TAttrs>,
    ): Promise<this> {
        return this.stepColumn("+", dbOrColumn, columnOrAmount, amountOrExtra, extra);
    }

    /**
     * Atomically decrement a numeric column on this row. Mirror of {@link increment}.
     *
     * @example
     * await product.decrement('stock', qty)
     */
    public async decrement(column: keyof TAttrs & string, amount?: number, extra?: Partial<TAttrs>): Promise<this>;
    public async decrement(column: keyof TAttrs & string, extra: Partial<TAttrs>): Promise<this>;
    public async decrement(db: D1Database, column: keyof TAttrs & string, amount?: number, extra?: Partial<TAttrs>): Promise<this>;
    public async decrement(db: D1Database, column: keyof TAttrs & string, extra: Partial<TAttrs>): Promise<this>;
    public async decrement(
        dbOrColumn: D1Database | (keyof TAttrs & string),
        columnOrAmount?: (keyof TAttrs & string) | number | Partial<TAttrs>,
        amountOrExtra?: number | Partial<TAttrs>,
        extra?: Partial<TAttrs>,
    ): Promise<this> {
        return this.stepColumn("-", dbOrColumn, columnOrAmount, amountOrExtra, extra);
    }

    /** Shared impl for instance increment()/decrement(). */
    private async stepColumn(
        op: "+" | "-",
        dbOrColumn: D1Database | string,
        columnOrAmount?: string | number | Partial<TAttrs>,
        amountOrExtra?: number | Partial<TAttrs>,
        extra?: Partial<TAttrs>,
    ): Promise<this> {
        const hasDb = dbOrColumn != null && typeof dbOrColumn === "object" && "prepare" in (dbOrColumn as object);
        const _db = hasDb ? (dbOrColumn as D1Database) : undefined;
        const column = (hasDb ? columnOrAmount : dbOrColumn) as string;
        const amountArg = hasDb ? amountOrExtra : columnOrAmount;
        const amount = typeof amountArg === "number" ? amountArg : 1;
        const extraCols = (
            typeof amountArg === "object" && amountArg !== null ? amountArg : hasDb ? extra : amountOrExtra
        ) as Record<string, unknown> | undefined;

        const pk = this.getKeyName();
        const id = this.getKey();
        assert(id, `Missing primary key '${pk}'`);

        // Extra SET map — touch updated_at when timestamps are enabled.
        const dbExtra: Record<string, unknown> = { ...(extraCols ?? {}) };
        if (this.ctor.timestamps && !("updated_at" in dbExtra)) dbExtra["updated_at"] = nowIso();

        // Atomic UPDATE by primary key.
        const qb = this.getCtor().query().whereEq(pk, id);
        if (_db) {
            await (op === "+"
                ? qb.increment(_db, column, amount, dbExtra)
                : qb.decrement(_db, column, amount, dbExtra));
        } else {
            await (op === "+" ? qb.increment(column, amount, dbExtra) : qb.decrement(column, amount, dbExtra));
        }

        // Sync in-memory to the persisted values (hydrating through casts) without
        // disturbing any unrelated dirty fields. Compute from the PERSISTED value
        // (`original`), not `attrs`: the DB adds to the stored value (COALESCEd to 0),
        // so basing the delta on an unsaved dirty value — or on NULL — would diverge.
        const cur = Number((this.original as Record<string, unknown>)[column] ?? 0);
        this.setRaw(column, op === "+" ? cur + amount : cur - amount);
        for (const [k, v] of Object.entries(dbExtra)) this.setRaw(k, v);
        for (const k of [column, ...Object.keys(dbExtra)]) {
            (this.original as Record<string, unknown>)[k] = (this.attrs as Record<string, unknown>)[k];
            (this.dirty as Set<string>).delete(k);
        }
        return this;
    }

    public async delete(
        dbOrOpts?: D1Database | { revision?: import("./revisionTypes").TRevisionContext; cache?: CacheAdapter },
        opts?: { revision?: import("./revisionTypes").TRevisionContext; cache?: CacheAdapter },
    ): Promise<boolean> {
        const isDb = dbOrOpts != null && typeof dbOrOpts === "object" && "prepare" in (dbOrOpts as object);
        const _db = isDb ? (dbOrOpts as D1Database) : undefined;
        const _opts = isDb ? opts : (dbOrOpts as { revision?: import("./revisionTypes").TRevisionContext; cache?: CacheAdapter } | undefined);
        return PersistMgr.del(this as unknown as TModelInternals, _db, _opts);
    }

    public async restore(
        dbOrOpts?: D1Database | { revision?: import("./revisionTypes").TRevisionContext; cache?: CacheAdapter },
        opts?: { revision?: import("./revisionTypes").TRevisionContext; cache?: CacheAdapter },
    ): Promise<boolean> {
        const isDb = dbOrOpts != null && typeof dbOrOpts === "object" && "prepare" in (dbOrOpts as object);
        const _db = isDb ? (dbOrOpts as D1Database) : undefined;
        const _opts = isDb ? opts : (dbOrOpts as { revision?: import("./revisionTypes").TRevisionContext; cache?: CacheAdapter } | undefined);
        return PersistMgr.restore(this as unknown as TModelInternals, _db, _opts);
    }

    public static async asOf<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        id: string,
        asOfIso: string,
    ): Promise<TModel | null>;
    public static async asOf<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db: D1Database,
        id: string,
        asOfIso: string,
    ): Promise<TModel | null>;
    public static async asOf<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrId: D1Database | string,
        idOrAsOf: string,
        asOfIso?: string,
    ): Promise<TModel | null> {
        const isDb = typeof dbOrId === "object" && dbOrId !== null && "prepare" in dbOrId;
        const _db = isDb ? (dbOrId as D1Database) : resolveDb(undefined, this.connection);
        const id = isDb ? idOrAsOf : (dbOrId as string);
        const _asOfIso = isDb ? asOfIso! : idOrAsOf;

        const { ModelRevision } = await import("./modelRevision");

        const table = this.table;
        const revCfg = this.revisions as import("./revisionTypes").TRevisionConfig | false;

        if (!revCfg || !revCfg.enabled) {
            throw new Error(`Revisions not enabled for ${table}; cannot time travel.`);
        }

        // Fast path: use latest revision snapshot if available
        const latest = (await ModelRevision.latestAsOf(_db, { table, id, asOfIso: _asOfIso })) as import("./modelRevision").ModelRevision | null;
        if (!latest) return null;

        const snap = latest.after ?? latest.before;
        if (snap) {
            const m = new this(snap as Partial<TModelAttrsOf<TModel>>);
            (m as unknown as BaseModel<TBaseModelAttrs>)._persisted = true;
            return (m as unknown as BaseModel<any>).asProxy() as unknown as TModel;
        }

        // Diff-only path: attempt replay from earliest usable snapshot
        const revs = (await ModelRevision.listUpTo(_db, { table, id, asOfIso: _asOfIso })) as import("./modelRevision").ModelRevision[];

        let state: Record<string, unknown> | null = null;

        for (const r of revs) {
            const base = r.after ?? r.before;
            if (base && state === null) state = { ...base };

            if (state === null) {
                // still no snapshot: can’t apply diffs safely
                continue;
            }

            const diff = r.diff;
            if (diff) {
                for (const [k, v] of Object.entries(diff)) state[k] = v;
            }
        }

        if (state === null) {
            throw new Error(
                `No snapshots found to replay diffs for ${table}:${id}. Use revisions mode "diff+after" or "before+after".`,
            );
        }

        const m = new this(state as Partial<TModelAttrsOf<TModel>>);
        (m as unknown as BaseModel<TBaseModelAttrs>)._persisted = true;
        return (m as unknown as BaseModel<any>).asProxy() as unknown as TModel;
    }

    public async refresh(db?: D1Database): Promise<this> {
        const ctor = this.getCtor();
        const id: string | null = this.getKey<string>();
        assert(id, `Missing primary key '${ctor.primaryKey}'`);

        const fresh: this | null = await new QueryBuilder(ctor).whereEq(ctor.primaryKey, id).first(db);
        assert(fresh, `Model not found for refresh (${ctor.table}.${ctor.primaryKey}=${id})`);

        this.attrs = (fresh as unknown as BaseModel<TAttrs>).attrs;
        this.syncOriginal();
        return this;
    }

    /**
     * Re-fetch the model from the database, returning a new instance.
     * Unlike refresh(), this does not mutate the current instance.
     */
    public async fresh(db?: D1Database): Promise<BaseModel<TAttrs> | null> {
        const ctor = this.getCtor();
        const id: string | null = this.getKey<string>();
        if (!id) return null;
        return new QueryBuilder(ctor).whereEq(ctor.primaryKey, id).first(db);
    }

    /**
     * Eager-load relations onto an existing model instance.
     * Mutates this instance's relations and returns this for chaining.
     */
    public async load(db: D1Database, ...relations: string[]): Promise<this>;
    public async load(...relations: string[]): Promise<this>;
    public async load(...args: unknown[]): Promise<this> {
        const firstIsDb = args[0] !== null && typeof args[0] === "object" && "prepare" in (args[0] as object);
        const db = firstIsDb ? (args[0] as D1Database) : undefined;
        const names = (firstIsDb ? args.slice(1) : args) as string[];

        await RelationManager.load(this as unknown as TRelationalModel, db, names);
        return (this._proxy ?? this) as this;
    }

    /**
     * Check if two models are the same (same class and same primary key).
     */
    public is(other: BaseModel<any> | null | undefined): boolean {
        if (!other) return false;
        return this.constructor === other.constructor && this.getKey() === other.getKey();
    }

    /**
     * Check if two models are NOT the same.
     */
    public isNot(other: BaseModel<any> | null | undefined): boolean {
        return !this.is(other);
    }

    public static async revertTo<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        db?: D1Database,
        revision?: import("./modelRevision").ModelRevision,
    ): Promise<TModel>;
    public static async revertTo<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        revision: import("./modelRevision").ModelRevision,
    ): Promise<TModel>;
    public static async revertTo<TModel extends { toObject(): object }>(
        this: TModelCtor<TModel>,
        dbOrRevision?: D1Database | import("./modelRevision").ModelRevision,
        revision?: import("./modelRevision").ModelRevision,
    ): Promise<TModel> {
        const isDb = dbOrRevision !== null && typeof dbOrRevision === "object" && "prepare" in (dbOrRevision as object);
        const _db = isDb ? (dbOrRevision as D1Database) : undefined;
        const _revision = isDb ? revision! : (dbOrRevision as import("./modelRevision").ModelRevision);
        const after = _revision.after ?? _revision.before;
        if (!after) throw new Error("Revision has no usable snapshot");

        const model = new this(after as Partial<TModelAttrsOf<TModel>>);
        (model as unknown as BaseModel<TBaseModelAttrs>)._persisted = true;
        await (model as unknown as BaseModel<TBaseModelAttrs>).save(_db);
        return (model as unknown as BaseModel<any>).asProxy() as unknown as TModel;
    }
}
