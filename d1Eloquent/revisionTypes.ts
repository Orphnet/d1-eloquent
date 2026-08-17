export type TRevisionAction = "create" | "update" | "delete";

export type TRevisionConfig = {
    enabled: boolean;

    /**
     * Store only dirty fields vs full snapshots.
     */
    mode: "diff" | "snapshot" | "diff+after" | "before+after";

    /**
     * Extra metadata
     */
    includeRequestId?: boolean;
};

export type TRevisionContext = {
    actorId?: string | null;
    requestId?: string | null;
    reason?: string | null;
};

export type TRevisionRow = {
    id: string;
    model_table: string;
    model_pk: string;
    model_id: string;
    action: TRevisionAction;
    diff_json?: string | null;
    before_json?: string | null;
    after_json?: string | null;
    actor_id?: string | null;
    request_id?: string | null;
    reason?: string | null;
    created_at: string;
};
