import { BaseModel } from "./baseModel";
import { QueryBuilder } from "./queryBuilder";

export type TModelRevisionAttrs = {
    id: string;
    model_table: string;
    model_pk: string;
    model_id: string;
    action: string;
    diff_json?: string | null;
    before_json?: string | null;
    after_json?: string | null;
    actor_id?: string | null;
    request_id?: string | null;
    reason?: string | null;
    created_at: string;
};

export class ModelRevision extends BaseModel<TModelRevisionAttrs> {
    public static table = "model_revisions";
    public static primaryKey = "id";

    public get diff(): Record<string, unknown> | null {
        const raw = this.get("diff_json");
        if (!raw) return null;
        try {
            return JSON.parse(raw as string);
        } catch {
            const id = this.get("id") ?? "unknown";
            const table = this.get("model_table") ?? "unknown";
            const modelId = this.get("model_id") ?? "unknown";
            const truncated = String(raw).slice(0, 100);
            throw new Error(
                `Failed to parse diff_json for revision ${id} (${table}:${modelId}): ${truncated}`
            );
        }
    }

    public get before(): Record<string, unknown> | null {
        const raw = this.get("before_json");
        if (!raw) return null;
        try {
            return JSON.parse(raw as string);
        } catch {
            const id = this.get("id") ?? "unknown";
            const table = this.get("model_table") ?? "unknown";
            const modelId = this.get("model_id") ?? "unknown";
            const truncated = String(raw).slice(0, 100);
            throw new Error(
                `Failed to parse before_json for revision ${id} (${table}:${modelId}): ${truncated}`
            );
        }
    }

    public get after(): Record<string, unknown> | null {
        const raw = this.get("after_json");
        if (!raw) return null;
        try {
            return JSON.parse(raw as string);
        } catch {
            const id = this.get("id") ?? "unknown";
            const table = this.get("model_table") ?? "unknown";
            const modelId = this.get("model_id") ?? "unknown";
            const truncated = String(raw).slice(0, 100);
            throw new Error(
                `Failed to parse after_json for revision ${id} (${table}:${modelId}): ${truncated}`
            );
        }
    }

    public static async latestAsOf(db: D1Database, opts: { table: string; id: string; asOfIso: string }): Promise<ModelRevision | null> {
        return new QueryBuilder<ModelRevision>(ModelRevision)
            .whereEq("model_table", opts.table)
            .whereEq("model_id", opts.id)
            .where("created_at", "<=", opts.asOfIso)
            .orderBy("created_at", "desc")
            .first(db);
    }

    public static async listUpTo(db: D1Database, opts: { table: string; id: string; asOfIso: string }): Promise<ModelRevision[]> {
        return new QueryBuilder<ModelRevision>(ModelRevision)
            .whereEq("model_table", opts.table)
            .whereEq("model_id", opts.id)
            .where("created_at", "<=", opts.asOfIso)
            .orderBy("created_at", "asc")
            .get(db);
    }
}
