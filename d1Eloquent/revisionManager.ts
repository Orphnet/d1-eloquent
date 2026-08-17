import { nowIso } from "./utils";
import type { TRevisionAction, TRevisionConfig, TRevisionContext } from "./revisionTypes";

const filterFields = (
    obj: Record<string, unknown> | null | undefined,
    redact: string[],
    only: string[] | null,
): Record<string, unknown> | null => {
    if (!obj) return null;

    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj)) {
        if (only && !only.includes(k)) continue;
        if (redact.includes(k)) continue;
        out[k] = v;
    }

    return out;
};

export type TWriteRevisionOpts = {
    db: D1Database;

    modelTable: string;
    modelPk: string;
    modelId: string | null;

    action: TRevisionAction;

    config: TRevisionConfig;
    ctx?: TRevisionContext;

    /**
     * Model-level filtering
     */
    redact?: string[];
    only?: string[] | null;

    diff?: Record<string, unknown> | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
};

export class RevisionManager {
    public static buildRevisionStatement(opts: TWriteRevisionOpts): D1PreparedStatement | null {
        if (!opts.config.enabled) return null;

        const id = crypto.randomUUID();

        const redact = opts.redact ?? [];
        const only = opts.only ?? null;

        const mode = opts.config.mode;

        const filteredDiff = filterFields(opts.diff ?? null, redact, only);
        const filteredBefore = filterFields(opts.before ?? null, redact, only);
        const filteredAfter = filterFields(opts.after ?? null, redact, only);

        const diff_json =
            mode === "diff" || mode === "diff+after" ? JSON.stringify(filteredDiff ?? {}) : null;

        const before_json =
            mode === "snapshot" || mode === "before+after" ? JSON.stringify(filteredBefore ?? {}) : null;

        const after_json =
            mode === "snapshot" || mode === "diff+after" || mode === "before+after"
                ? JSON.stringify(filteredAfter ?? {})
                : null;

        const created_at = nowIso();

        const actor_id = opts.ctx?.actorId ?? null;
        const request_id = opts.config.includeRequestId ? (opts.ctx?.requestId ?? null) : null;
        const reason = opts.ctx?.reason ?? null;

        const sql = `
      INSERT INTO model_revisions (
        id, model_table, model_pk, model_id,
        action, diff_json, before_json, after_json,
        actor_id, request_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `.trim();

        return opts.db
            .prepare(sql)
            .bind(
                id,
                opts.modelTable,
                opts.modelPk,
                opts.modelId,
                opts.action,
                diff_json,
                before_json,
                after_json,
                actor_id,
                request_id,
                reason,
                created_at,
            );
    }

    public static async writeRevision(opts: TWriteRevisionOpts): Promise<void> {
        const stmt = this.buildRevisionStatement(opts);
        if (stmt) await stmt.run();
    }
}
