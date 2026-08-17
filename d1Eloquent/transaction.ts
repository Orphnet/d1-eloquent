// transaction.ts
// Write-only unit-of-work for D1: collect model writes during a closure,
// flush them as ONE atomic db.batch(). D1 has no interactive transactions —
// batch() is the only atomicity primitive — so `tx` never reads, and no
// statement executes until the closure returns.

import type { TModelCtor, TModelAttrsOf } from "./baseModel";
import type { TD1ResultMeta } from "./types";
import type { TRevisionAction, TRevisionContext, TRevisionConfig } from "./revisionTypes";
import type { CacheAdapter } from "./cacheAdapter";
import type { THookEvent } from "./hookTypes";
import type { TModelInternals } from "./managers/types";
import type { TTimestampModel, TKeyModel, TDirtyModel } from "./managers";
import { HookManager, TimestampManager, KeyManager, DirtyManager } from "./managers";
import { AttributeManager as AttrMgr } from "./managers/attributeManager";
import { CastManager } from "./castManager";
import { RevisionManager } from "./revisionManager";
import { resolveDb } from "./registry";
import { assert, nowIso } from "./utils";

/**
 * Thrown when a before-hook (`saving` / `creating` / `updating` / `deleting`)
 * returns `false` inside a transaction closure — the whole unit of work is
 * discarded and nothing is written.
 */
export class TransactionAborted extends Error {
    constructor(hook: string, model: string) {
        super(`Transaction aborted: ${model}'s ${hook} hook returned false.`);
        this.name = "TransactionAborted";
    }
}

export type TxOptions = {
    revision?: TRevisionContext;
    skipRevisions?: boolean;
    cache?: CacheAdapter;
};

/** Minimal instance surface the collector needs (mirrors baseModel internals). */
export type BaseModelLike = { getKey(): unknown };

/**
 * Minimal query-builder surface accepted by the bulk `tx.update` / `tx.delete`
 * ops — any `QueryBuilder` satisfies it structurally.
 */
export type QueryBuilderLike = {
    toUpdatePrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement;
    toDeletePrepared(db: D1Database): D1PreparedStatement;
};

/**
 * Query-builder surface for the JSON ops (`tx.updateJsonSet|Patch|Remove`) —
 * any `QueryBuilder` satisfies it structurally.
 */
export type JsonQueryBuilderLike = {
    toUpdateJsonSetPrepared(db: D1Database, col: string, path: string, value: unknown): D1PreparedStatement;
    toUpdateJsonPatchPrepared(db: D1Database, col: string, patch: Record<string, unknown>): D1PreparedStatement;
    toUpdateJsonRemovePrepared(db: D1Database, col: string, path: string | string[]): D1PreparedStatement;
};

/**
 * Query-builder surface for the atomic counter ops (`tx.increment`/`tx.decrement`)
 * - any `QueryBuilder` satisfies it structurally.
 */
export type StepQueryBuilderLike = {
    toIncrementPrepared(db: D1Database, column: string, amount?: number, extra?: Record<string, unknown>): D1PreparedStatement;
    toDecrementPrepared(db: D1Database, column: string, amount?: number, extra?: Record<string, unknown>): D1PreparedStatement;
};

/** Minimal static surface the collector needs from a model constructor. */
type TxCtorLike = {
    name?: string;
    table: string;
    primaryKey: string;
    connection?: D1Database | string;
    softDeletes?: boolean;
    timestamps?: boolean;
    revisions?: TRevisionConfig | false;
    revisionRedact?: string[];
    revisionOnly?: string[] | null;
    query(): {
        toInsertPrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement;
        toUpsertPrepared(
            db: D1Database,
            values: Record<string, unknown>,
            conflictCols: string[],
            updateCols?: string[],
        ): D1PreparedStatement;
        whereEq(column: string, value: unknown): QueryBuilderLike;
    };
};

type RecordedOp = {
    model?: BaseModelLike; // present for instance ops (after-hooks, persisted flag)
    dataIdx: number; // index of the data statement in the batch
    afterHooks: THookEvent[]; // hooks to fire post-commit
    persistedAfter?: boolean; // `_persisted` value stamped post-commit (instance ops only)
    recentlyCreated?: boolean; // stamp `_wasRecentlyCreated = true` post-commit (INSERT terminals)
    gateHooksOnChange?: boolean; // update/delete: fire after-hooks only if the row actually changed
    result?: D1Result; // the op's data-statement result, mapped back post-flush
};

/** Duck-typed per-op meta sink — a model may expose `recordMeta` to receive its result. */
type TMetaRecorder = { recordMeta?: (meta: TD1ResultMeta) => void };

/**
 * Write-only transaction surface passed to the `transaction()` closure.
 * Ops run before-hooks + casts immediately, but only COLLECT prepared
 * statements — nothing executes until the closure returns.
 */
export interface Tx {
    create<M extends { toObject(): object }>(
        ctor: TModelCtor<M>,
        attrs: Partial<TModelAttrsOf<M>>,
    ): Promise<M>;
    /** INSERT if the instance is not persisted, else UPDATE its dirty attrs by PK. */
    save<M extends { toObject(): object }>(instance: M): Promise<M>;
    /** Bulk UPDATE via a query builder — no hooks, no casts, no revision. */
    update(query: QueryBuilderLike, values: Record<string, unknown>): void;
    /**
     * Delete an instance (by PK, fires `deleting`/`deleted` hooks) or a query
     * (bulk DELETE — no hooks, no revision). Await the instance form so its
     * before-hook runs before the closure returns.
     */
    delete(target: BaseModelLike | QueryBuilderLike): Promise<void>;
    /**
     * INSERT … ON CONFLICT upsert — runs `saving`/`creating` hooks + casts
     * like `create` (it is a create-or-update by conflict), returns the model.
     */
    upsert<M extends { toObject(): object }>(
        ctor: TModelCtor<M>,
        attrs: Partial<TModelAttrsOf<M>>,
        conflictCols: string[],
        updateCols?: string[],
    ): Promise<M>;
    /** Bulk `json_set()` UPDATE via a query builder — no hooks, no revision. */
    updateJsonSet(query: JsonQueryBuilderLike, col: string, path: string, value: unknown): void;
    /** Bulk `json_patch()` UPDATE via a query builder — no hooks, no revision. */
    updateJsonPatch(query: JsonQueryBuilderLike, col: string, patch: Record<string, unknown>): void;
    /** Bulk `json_remove()` UPDATE via a query builder — no hooks, no revision. */
    updateJsonRemove(query: JsonQueryBuilderLike, col: string, path: string | string[]): void;
    /**
     * Atomically increment a numeric column via a query builder - query-scoped,
     * no hooks, no revision (like `tx.update`). Composes a `SET col = COALESCE(col,0)+?`
     * UPDATE into the batch so a counter/balance adjustment commits or rolls back
     * with the rest of the transaction.
     */
    increment(query: StepQueryBuilderLike, column: string, amount?: number, extra?: Record<string, unknown>): void;
    /** Atomically decrement a numeric column via a query builder. See {@link increment}. */
    decrement(query: StepQueryBuilderLike, column: string, amount?: number, extra?: Record<string, unknown>): void;
    readonly results: D1Result[];
}

class UnitOfWork implements Tx {
    private stmts: D1PreparedStatement[] = [];
    private ops: RecordedOp[] = [];
    public results: D1Result[] = [];

    constructor(
        private db: D1Database,
        private opts: TxOptions,
    ) {}

    private push(stmt: D1PreparedStatement): number {
        this.stmts.push(stmt);
        return this.stmts.length - 1;
    }

    async create<M extends { toObject(): object }>(
        ctor: TModelCtor<M>,
        attrs: Partial<TModelAttrsOf<M>>,
    ): Promise<M> {
        const model = new ctor();
        (model as unknown as { fill(a: unknown): void }).fill(attrs);
        await this.collectInsert(model as unknown as TModelInternals);
        return model;
    }

    async save<M extends { toObject(): object }>(instance: M): Promise<M> {
        const model = instance as unknown as TModelInternals;
        if (!model._persisted) {
            // INSERT path — same collection as `create`, but with the caller's instance.
            await this.collectInsert(model);
            return instance;
        }

        // UPDATE path — dirty attrs by PK (mirrors PersistenceManager.save/performUpdate).
        const ctor = model.constructor;
        const txCtor = ctor as unknown as TxCtorLike;
        const name = txCtor.name ?? txCtor.table;
        if (!(await HookManager.fireHook(model, "saving"))) {
            throw new TransactionAborted("saving", name);
        }
        if (!(await HookManager.fireHook(model, "updating"))) {
            throw new TransactionAborted("updating", name);
        }

        const casts = CastManager.resolveCastsFor(ctor);
        const before = CastManager.dehydrateRow(casts, { ...model.original } as Record<string, unknown>);

        TimestampManager.applyTimestamps(model as unknown as TTimestampModel, false);

        const pk = ctor.primaryKey;
        const id = model.attrs[pk];
        assert(id, `Missing primary key '${pk}' on ${name} passed to tx.save()`);

        const dirty = DirtyManager.getDirty(model as unknown as TDirtyModel);
        delete dirty[pk]; // never update PK via save()
        if (Object.keys(dirty).length === 0) return instance; // nothing to write

        const dehydrated = CastManager.dehydrateRow(casts, dirty);
        const db = resolveDb(this.db, txCtor.connection);
        const dataIdx = this.push(txCtor.query().whereEq(pk, id).toUpdatePrepared(db, dehydrated));
        this.maybeRevision(txCtor, model as unknown as BaseModelLike, "update", before, AttrMgr.toRaw(model), dehydrated, dataIdx);
        this.ops.push({
            model: model as unknown as BaseModelLike,
            dataIdx,
            afterHooks: ["updated", "saved"],
            persistedAfter: true,
            gateHooksOnChange: true,
        });
        return instance;
    }

    update(query: QueryBuilderLike, values: Record<string, unknown>): void {
        const dataIdx = this.push(query.toUpdatePrepared(this.db, values));
        this.ops.push({ dataIdx, afterHooks: [] });
    }

    delete(target: BaseModelLike | QueryBuilderLike): Promise<void> {
        if (typeof (target as { getKey?: unknown }).getKey === "function") {
            // Instance delete — async (fires the `deleting` hook before collecting).
            return this.collectInstanceDelete(target as unknown as TModelInternals);
        }
        // Bulk delete — collected synchronously; no hooks, no revision.
        const dataIdx = this.push((target as QueryBuilderLike).toDeletePrepared(this.db));
        this.ops.push({ dataIdx, afterHooks: [] });
        return Promise.resolve();
    }

    async upsert<M extends { toObject(): object }>(
        ctor: TModelCtor<M>,
        attrs: Partial<TModelAttrsOf<M>>,
        conflictCols: string[],
        updateCols?: string[],
    ): Promise<M> {
        const model = new ctor();
        (model as unknown as { fill(a: unknown): void }).fill(attrs);
        const internals = model as unknown as TModelInternals;
        const { txCtor, row, db, diff } = await this.prepareInsertLike(internals);
        const dataIdx = this.push(txCtor.query().toUpsertPrepared(db, row, conflictCols, updateCols));
        // Emit an optimistic 'create' revision (like tx.create) so revision-enabled
        // models get an audit row on the create-or-update path too - same optimism as
        // `recentlyCreated`: correct on an INSERT, over-reports on an on-conflict UPDATE.
        this.maybeRevision(txCtor, internals as unknown as BaseModelLike, "create", null, row, diff, dataIdx);
        this.ops.push({
            model: internals as unknown as BaseModelLike,
            dataIdx,
            afterHooks: ["created", "saved"],
            persistedAfter: true,
            // Optimistic: upsert is insert-or-update; on an INSERT this is correct,
            // on an on-conflict UPDATE it over-reports (D1 can't distinguish the two).
            recentlyCreated: true,
        });
        return model;
    }

    updateJsonSet(query: JsonQueryBuilderLike, col: string, path: string, value: unknown): void {
        const dataIdx = this.push(query.toUpdateJsonSetPrepared(this.db, col, path, value));
        this.ops.push({ dataIdx, afterHooks: [] });
    }

    updateJsonPatch(query: JsonQueryBuilderLike, col: string, patch: Record<string, unknown>): void {
        const dataIdx = this.push(query.toUpdateJsonPatchPrepared(this.db, col, patch));
        this.ops.push({ dataIdx, afterHooks: [] });
    }

    increment(query: StepQueryBuilderLike, column: string, amount = 1, extra?: Record<string, unknown>): void {
        const dataIdx = this.push(query.toIncrementPrepared(this.db, column, amount, extra));
        this.ops.push({ dataIdx, afterHooks: [] });
    }

    decrement(query: StepQueryBuilderLike, column: string, amount = 1, extra?: Record<string, unknown>): void {
        const dataIdx = this.push(query.toDecrementPrepared(this.db, column, amount, extra));
        this.ops.push({ dataIdx, afterHooks: [] });
    }

    updateJsonRemove(query: JsonQueryBuilderLike, col: string, path: string | string[]): void {
        const dataIdx = this.push(query.toUpdateJsonRemovePrepared(this.db, col, path));
        this.ops.push({ dataIdx, afterHooks: [] });
    }

    /**
     * Create-shaped preparation shared by `create`/`save`(insert)/`upsert`:
     * timestamps + key strategy + `saving`/`creating` before-hooks + casts.
     */
    private async prepareInsertLike(
        model: TModelInternals,
    ): Promise<{ txCtor: TxCtorLike; row: Record<string, unknown>; db: D1Database; diff: Record<string, unknown> }> {
        const txCtor = model.constructor as unknown as TxCtorLike;
        const name = txCtor.name ?? txCtor.table;
        // Fire before-hooks FIRST so they see the pre-stamped model (matches
        // PersistenceManager.save — auto timestamps/PK are applied AFTER hooks).
        if (!(await HookManager.fireHook(model, "saving"))) {
            throw new TransactionAborted("saving", name);
        }
        if (!(await HookManager.fireHook(model, "creating"))) {
            throw new TransactionAborted("creating", name);
        }
        // Capture the user-set fields for the revision diff before auto columns land.
        const casts = CastManager.resolveCastsFor(model.constructor as unknown as Parameters<typeof CastManager.resolveCastsFor>[0]);
        const diff = CastManager.dehydrateRow(casts, DirtyManager.getDirty(model as unknown as TDirtyModel));
        TimestampManager.applyTimestamps(model as unknown as TTimestampModel, true);
        KeyManager.applyKeyStrategy(model as unknown as TKeyModel);
        const row = AttrMgr.toRaw(model);
        const db = resolveDb(this.db, txCtor.connection);
        return { txCtor, row, db, diff };
    }

    /** Shared INSERT collection for `create` and the unpersisted branch of `save`. */
    private async collectInsert(model: TModelInternals): Promise<void> {
        const { txCtor, row, db, diff } = await this.prepareInsertLike(model);
        const dataIdx = this.push(txCtor.query().toInsertPrepared(db, row));
        this.maybeRevision(txCtor, model as unknown as BaseModelLike, "create", null, row, diff, dataIdx);
        this.ops.push({
            model: model as unknown as BaseModelLike,
            dataIdx,
            afterHooks: ["created", "saved"],
            persistedAfter: true,
            recentlyCreated: true,
        });
    }

    /** DELETE-by-PK collection for the instance form of `delete`. */
    private async collectInstanceDelete(model: TModelInternals): Promise<void> {
        const ctor = model.constructor;
        const txCtor = ctor as unknown as TxCtorLike;
        const name = txCtor.name ?? txCtor.table;
        if (!(await HookManager.fireHook(model, "deleting"))) {
            throw new TransactionAborted("deleting", name);
        }
        const pk = ctor.primaryKey;
        const id = model.attrs[pk];
        assert(id, `Missing primary key '${pk}' on ${name} passed to tx.delete()`);
        const before = AttrMgr.toRaw(model);
        const db = resolveDb(this.db, txCtor.connection);

        if (txCtor.softDeletes) {
            // Soft-delete models must set `deleted_at` (an UPDATE), never hard-DELETE
            // the row — mirrors PersistenceManager.del so tx.delete() doesn't destroy
            // data the non-tx path would only trash.
            const now = nowIso();
            AttrMgr.setRaw(model, "deleted_at", now);
            if (txCtor.timestamps) AttrMgr.setRaw(model, "updated_at", now);
            const casts = CastManager.resolveCastsFor(model.constructor as unknown as Parameters<typeof CastManager.resolveCastsFor>[0]);
            const dehydrated = CastManager.dehydrateRow(casts, DirtyManager.getDirty(model as unknown as TDirtyModel));
            const dataIdx = this.push(txCtor.query().whereEq(pk, id).toUpdatePrepared(db, dehydrated));
            this.maybeRevision(txCtor, model as unknown as BaseModelLike, "delete", before, AttrMgr.toRaw(model), dehydrated, dataIdx);
            this.ops.push({
                model: model as unknown as BaseModelLike,
                dataIdx,
                afterHooks: ["deleted"],
                persistedAfter: true, // the row still exists — the model is trashed, not gone
                gateHooksOnChange: true,
            });
            return;
        }

        const dataIdx = this.push(txCtor.query().whereEq(pk, id).toDeletePrepared(db));
        this.maybeRevision(txCtor, model as unknown as BaseModelLike, "delete", before, null, null, dataIdx);
        this.ops.push({
            model: model as unknown as BaseModelLike,
            dataIdx,
            afterHooks: ["deleted"],
            persistedAfter: false,
            gateHooksOnChange: true,
        });
    }

    /**
     * For revisions-enabled instance ops, build the `model_revisions` INSERT
     * and push it right after the data statement — both commit or roll back
     * together in the same batch. No-op when revisions are disabled on the
     * model or `opts.skipRevisions` is set.
     */
    private maybeRevision(
        ctor: TxCtorLike,
        model: BaseModelLike,
        action: TRevisionAction,
        before: Record<string, unknown> | null,
        after: Record<string, unknown> | null,
        diff: Record<string, unknown> | null,
        _dataIdx: number,
    ): void {
        const cfg = ctor.revisions;
        if (!cfg || !cfg.enabled || this.opts.skipRevisions) return;
        const stmt = RevisionManager.buildRevisionStatement({
            db: this.db,
            modelTable: ctor.table,
            modelPk: ctor.primaryKey,
            modelId: model.getKey() as string | null,
            action,
            config: cfg,
            ctx: this.opts.revision,
            redact: ctor.revisionRedact ?? [],
            only: ctor.revisionOnly ?? null,
            diff,
            before,
            after,
        });
        if (stmt) this.push(stmt); // appended right after the data statement
    }

    async flush(): Promise<void> {
        if (this.stmts.length === 0) return;
        this.results = await this.db.batch(this.stmts);
        // post-commit: map each op's data-statement result back, stamp
        // persisted state, sync originals + fire after-hooks.
        for (const op of this.ops) {
            op.result = this.results[op.dataIdx];
            if (op.model) {
                // Internal bookkeeping must hit the RAW instance: a proxied model
                // (from find()) routes plain property writes through its set trap
                // into target.set(), which would pollute attrs with phantom dirty
                // columns. $model is the proxy's raw-target escape hatch.
                const raw = ((op.model as { $model?: object }).$model ?? op.model) as object;
                (raw as unknown as TMetaRecorder).recordMeta?.(op.result.meta as TD1ResultMeta);
                (raw as unknown as { _persisted: boolean })._persisted = op.persistedAfter ?? true;
                if (op.recentlyCreated) (raw as unknown as { _wasRecentlyCreated: boolean })._wasRecentlyCreated = true;
                DirtyManager.syncOriginal(raw as unknown as TDirtyModel);
                // Match the non-tx path: an update/delete fires its after-hooks only when
                // a row actually changed. A batch can't know row counts at collection time,
                // so gate here post-commit (create/insert always report changes on success;
                // the revision row is already committed and stays optimistic).
                const changed = !op.gateHooksOnChange
                    || ((op.result.meta as TD1ResultMeta | undefined)?.changes ?? 0) > 0;
                if (changed) {
                    for (const h of op.afterHooks) {
                        await HookManager.fireHook(op.model as unknown as TModelInternals, h);
                    }
                }
            }
        }
    }
}

/**
 * Run `fn` with a write-only collector `tx`; on return, flush every collected
 * statement as ONE atomic `db.batch()`. Any failure (constraint violation,
 * before-hook returning false) means nothing persists.
 *
 * @example
 * const user = await transaction(env.DB, async (tx) => {
 *   const u = await tx.create(User, { id: crypto.randomUUID(), name: "Alice" });
 *   await tx.create(Post, { id: crypto.randomUUID(), user_id: u.get("id") });
 *   return u;
 * });
 */
export async function transaction<T>(
    db: D1Database,
    fn: (tx: Tx) => T | Promise<T>,
    opts: TxOptions = {},
): Promise<T> {
    const uow = new UnitOfWork(db, opts);
    const ret = await fn(uow);
    await uow.flush();
    return ret;
}
