import { QueryBuilder } from "../queryBuilder";
import { assert, nowIso } from "../utils";
import { CastManager } from "../castManager";
import { RevisionManager } from "../revisionManager";
import { resolveDb } from "../registry";
import { HookManager } from "./hookManager";
import { TimestampManager } from "./timestampManager";
import { KeyManager } from "./keyManager";
import { DirtyManager } from "./dirtyManager";
import { AttributeManager as AttrMgr } from "./attributeManager";
import type { TModelInternals, TModelCtorMeta } from "./types";
import type { TTimestampModel } from "./timestampManager";
import type { TKeyModel } from "./keyManager";
import type { TDirtyModel } from "./dirtyManager";
import type { TRevisionContext } from "../revisionTypes";
import type { CacheAdapter } from "../cacheAdapter";

/**
 * Options for save/delete/restore persistence operations.
 */
type TPersistOpts = { revision?: TRevisionContext; cache?: CacheAdapter };

/**
 * Read the primary key value from a model's attrs.
 */
function getKey(model: TModelInternals): string | null {
    const pk = model.constructor.primaryKey;
    const v = model.attrs[pk];
    return (v ?? null) as string | null;
}

/**
 * Read the primary key column name from a model's constructor.
 */
function getKeyName(model: TModelInternals): string {
    return model.constructor.primaryKey;
}

/**
 * Build a QueryBuilder for the model's table/constructor.
 * We need a TModelCtor-compatible object; the model's constructor satisfies this at runtime.
 *
 * Instance persistence (save/delete/restore) targets a single row by its own PK, so
 * it must NOT apply the model's `globalScopes` — mirroring Laravel's
 * `newQueryWithoutScopes()`. Otherwise a row loaded outside the current scope (e.g.
 * cross-tenant) would compile to `... WHERE id = ? AND (tenant = ?)` and silently
 * match zero rows, so the update/delete no-ops with no error and no audit record.
 */
function queryFor(model: TModelInternals): QueryBuilder<any, string> {
    return new QueryBuilder(model.constructor as any).withoutGlobalScopes();
}

/**
 * Manages persistence operations (insert, update, save, delete, restore) for model instances.
 * All functions are stateless — the model owns the state, this module provides the logic.
 */
export const PersistenceManager = {
    /**
     * Insert a new row into the database for the given model.
     */
    async performInsert(model: TModelInternals, db?: D1Database): Promise<void> {
        const values = AttrMgr.toRaw(model);
        const qb = queryFor(model);
        if (db) await qb.insert(db, values);
        else await qb.insert(values);
    },

    /**
     * Update the existing row in the database with dirty attributes.
     * Returns the number of rows changed.
     */
    async performUpdate(model: TModelInternals, db?: D1Database): Promise<number> {
        const ctor = model.constructor;
        const pk = ctor.primaryKey;
        const id = getKey(model);
        assert(id, `Missing primary key '${pk}'`);

        const dirty = DirtyManager.getDirty(model as unknown as TDirtyModel);
        // never update PK via save()
        delete dirty[pk];

        if (Object.keys(dirty).length === 0) return 0;

        const casts = CastManager.resolveCastsFor(ctor as any);
        const dehydrated = CastManager.dehydrateRow(casts, dirty);

        const qb = queryFor(model).whereEq(pk, id);
        if (db) return qb.update(db, dehydrated);
        return qb.update(dehydrated);
    },

    /**
     * Save the model (insert or update), applying timestamps, hooks, revisions, and cache invalidation.
     */
    async save(model: TModelInternals, db?: D1Database, opts?: TPersistOpts): Promise<void> {
        const ctor = model.constructor;
        const revCfg = ctor.revisions;
        const _db = revCfg && revCfg.enabled ? resolveDb(db, ctor.connection) : db;

        const creating = !model._persisted;

        // Fire "before" hooks — return early if cancelled
        if (!(await HookManager.fireHook(model, "saving"))) return;
        if (creating && !(await HookManager.fireHook(model, "creating"))) return;
        if (!creating && !(await HookManager.fireHook(model, "updating"))) return;

        // capture before snapshot BEFORE timestamps/changes if you want strictness
        const casts = CastManager.resolveCastsFor(ctor as any);
        const before = creating
            ? null
            : CastManager.dehydrateRow(casts, { ...model.original } as Record<string, unknown>);
        const dirty = DirtyManager.getDirty(model as unknown as TDirtyModel);

        TimestampManager.applyTimestamps(model as unknown as TTimestampModel, creating);

        if (creating) {
            // Auto-generate the primary key when absent (respects an explicit id).
            KeyManager.applyKeyStrategy(model as unknown as TKeyModel);
            const id = getKey(model);
            assert(id, `Missing primary key '${getKeyName(model)}'`);
            await PersistenceManager.performInsert(model, db);

            // revision: create
            if (revCfg && revCfg.enabled) {
                const dehydratedDirty = CastManager.dehydrateRow(casts, dirty);
                await RevisionManager.writeRevision({
                    db: _db!,
                    modelTable: ctor.table,
                    modelPk: getKeyName(model),
                    modelId: id,
                    action: "create",
                    config: revCfg,
                    ctx: opts?.revision,
                    diff: dehydratedDirty,
                    before: null,
                    after: AttrMgr.toRaw(model),
                    redact: ctor.revisionRedact ?? [],
                    only: ctor.revisionOnly ?? null,
                });
            }

            if (opts?.cache) {
                await opts.cache.invalidate({
                    table: ctor.table,
                    id: id!,
                    action: "create",
                });
            }

            model._persisted = true;
            model._wasRecentlyCreated = true;
            DirtyManager.syncOriginal(model as unknown as TDirtyModel);

            // Fire "after" hooks
            await HookManager.fireHook(model, "created");
            await HookManager.fireHook(model, "saved");

            return;
        }

        const id = getKey(model);
        assert(id, `Missing primary key '${getKeyName(model)}'`);

        const changed = await PersistenceManager.performUpdate(model, db);

        if (changed > 0 && revCfg && revCfg.enabled) {
            const dehydratedDirty = CastManager.dehydrateRow(casts, dirty);
            await RevisionManager.writeRevision({
                db: _db!,
                modelTable: ctor.table,
                modelPk: getKeyName(model),
                modelId: id,
                action: "update",
                config: revCfg,
                ctx: opts?.revision,
                diff: dehydratedDirty,
                before,
                after: AttrMgr.toRaw(model),
                redact: ctor.revisionRedact ?? [],
                only: ctor.revisionOnly ?? null,
            });
        }

        if (opts?.cache) {
            await opts.cache.invalidate({
                table: ctor.table,
                id: id!,
                action: "update",
            });
        }

        DirtyManager.syncOriginal(model as unknown as TDirtyModel);

        // Fire "after" hooks
        await HookManager.fireHook(model, "updated");
        await HookManager.fireHook(model, "saved");
    },

    /**
     * Delete the model (soft or hard delete), with hooks, revisions, and cache invalidation.
     * Named `del` to avoid JS keyword conflict.
     */
    async del(model: TModelInternals, db?: D1Database, opts?: TPersistOpts): Promise<boolean> {
        const ctor = model.constructor;
        const id = getKey(model);
        if (!id) return false;

        // Fire "before" hook — return early if cancelled
        if (!(await HookManager.fireHook(model, "deleting"))) return false;

        const _db = ctor.revisions && ctor.revisions.enabled ? resolveDb(db, ctor.connection) : db;

        const casts = CastManager.resolveCastsFor(ctor as any);
        const before = AttrMgr.toRaw(model);

        if (ctor.softDeletes) {
            // soft delete -> update deleted_at
            const now = nowIso();
            AttrMgr.setRaw(model, "deleted_at", now);

            // touch updated_at if timestamps on
            if (ctor.timestamps) AttrMgr.setRaw(model, "updated_at", now);

            const dirty = DirtyManager.getDirty(model as unknown as TDirtyModel);
            const dehydratedDirty = CastManager.dehydrateRow(casts, dirty);
            const qb = queryFor(model).whereEq(getKeyName(model), id);
            const changed = db ? await qb.update(db, dehydratedDirty) : await qb.update(dehydratedDirty);

            if (changed > 0 && ctor.revisions && ctor.revisions.enabled) {
                await RevisionManager.writeRevision({
                    db: _db!,
                    modelTable: ctor.table,
                    modelPk: getKeyName(model),
                    modelId: id,
                    action: "delete",
                    config: ctor.revisions,
                    ctx: opts?.revision,
                    diff: dehydratedDirty,
                    before,
                    after: AttrMgr.toRaw(model),
                    redact: ctor.revisionRedact ?? [],
                    only: ctor.revisionOnly ?? null,
                });
            }

            if (changed > 0 && opts?.cache) {
                await opts.cache.invalidate({
                    table: ctor.table,
                    id,
                    action: "delete",
                });
            }

            DirtyManager.syncOriginal(model as unknown as TDirtyModel);

            if (changed > 0) await HookManager.fireHook(model, "deleted");

            return changed > 0;
        }

        // hard delete fallback
        const n = await queryFor(model).whereEq(getKeyName(model), id).delete(db);

        if (n > 0 && ctor.revisions && ctor.revisions.enabled) {
            await RevisionManager.writeRevision({
                db: _db!,
                modelTable: ctor.table,
                modelPk: getKeyName(model),
                modelId: id,
                action: "delete",
                config: ctor.revisions,
                ctx: opts?.revision,
                diff: null,
                before: before,
                after: null,
                redact: ctor.revisionRedact ?? [],
                only: ctor.revisionOnly ?? null,
            });
        }

        if (n > 0 && opts?.cache) {
            await opts.cache.invalidate({
                table: ctor.table,
                id,
                action: "delete",
            });
        }

        if (n > 0) await HookManager.fireHook(model, "deleted");

        return n > 0;
    },

    /**
     * Restore a soft-deleted model, with revisions and cache invalidation.
     */
    async restore(model: TModelInternals, db?: D1Database, opts?: TPersistOpts): Promise<boolean> {
        const ctor = model.constructor;
        if (!ctor.softDeletes) return false;

        const id = getKey(model);
        if (!id) return false;

        const _db = ctor.revisions && ctor.revisions.enabled ? resolveDb(db, ctor.connection) : db;

        const casts = CastManager.resolveCastsFor(ctor as any);
        const before = AttrMgr.toRaw(model);

        AttrMgr.setRaw(model, "deleted_at", null);
        if (ctor.timestamps) AttrMgr.setRaw(model, "updated_at", nowIso());

        const dirty = DirtyManager.getDirty(model as unknown as TDirtyModel);
        const dehydratedDirty = CastManager.dehydrateRow(casts, dirty);
        const qb = queryFor(model).whereEq(getKeyName(model), id);
        const changed = db ? await qb.update(db, dehydratedDirty) : await qb.update(dehydratedDirty);

        if (changed > 0 && ctor.revisions && ctor.revisions.enabled) {
            await RevisionManager.writeRevision({
                db: _db!,
                modelTable: ctor.table,
                modelPk: getKeyName(model),
                modelId: id,
                action: "update",
                config: ctor.revisions,
                ctx: opts?.revision,
                diff: dehydratedDirty,
                before,
                after: AttrMgr.toRaw(model),
                redact: ctor.revisionRedact ?? [],
                only: ctor.revisionOnly ?? null,
            });
        }

        if (changed > 0 && opts?.cache) {
            await opts.cache.invalidate({
                table: ctor.table,
                id: id!,
                action: "update",
            });
        }

        DirtyManager.syncOriginal(model as unknown as TDirtyModel);
        return changed > 0;
    },
};
