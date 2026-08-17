import { describe, it, expect } from "vitest";
import { ModelRevision } from "../modelRevision";

function makeRevision(overrides: Partial<Record<string, unknown>> = {}): ModelRevision {
    return new ModelRevision({
        id: "rev-1",
        model_table: "users",
        model_pk: "id",
        model_id: "u1",
        action: "update",
        diff_json: null,
        before_json: null,
        after_json: null,
        actor_id: null,
        request_id: null,
        reason: null,
        created_at: "2025-01-01T00:00:00.000Z",
        ...overrides,
    });
}

describe("ModelRevision.diff getter", () => {
    it("returns null when diff_json is null", () => {
        const rev = makeRevision({ diff_json: null });
        expect(rev.diff).toBeNull();
    });

    it("parses valid JSON diff_json", () => {
        const rev = makeRevision({ diff_json: '{"name":"Alice"}' });
        expect(rev.diff).toEqual({ name: "Alice" });
    });

    it("throws with context on invalid JSON", () => {
        const rev = makeRevision({ diff_json: "not-json" });
        expect(() => rev.diff).toThrow(/Failed to parse diff_json.*rev-1.*users.*u1/);
    });

    it("includes truncated raw value in error", () => {
        const rev = makeRevision({ diff_json: "{bad" });
        expect(() => rev.diff).toThrow("{bad");
    });
});

describe("ModelRevision.before getter", () => {
    it("returns null when before_json is null", () => {
        const rev = makeRevision({ before_json: null });
        expect(rev.before).toBeNull();
    });

    it("parses valid JSON before_json", () => {
        const rev = makeRevision({ before_json: '{"status":"active"}' });
        expect(rev.before).toEqual({ status: "active" });
    });

    it("throws with context on invalid JSON", () => {
        const rev = makeRevision({ before_json: "bad-json" });
        expect(() => rev.before).toThrow(/Failed to parse before_json.*rev-1.*users.*u1/);
    });
});

describe("ModelRevision.after getter", () => {
    it("returns null when after_json is null", () => {
        const rev = makeRevision({ after_json: null });
        expect(rev.after).toBeNull();
    });

    it("parses valid JSON after_json", () => {
        const rev = makeRevision({ after_json: '{"status":"deleted"}' });
        expect(rev.after).toEqual({ status: "deleted" });
    });

    it("throws with context on invalid JSON", () => {
        const rev = makeRevision({ after_json: "nope" });
        expect(() => rev.after).toThrow(/Failed to parse after_json.*rev-1.*users.*u1/);
    });
});

describe("ModelRevision error context with missing fields", () => {
    it("uses 'unknown' when id/table/modelId are missing", () => {
        const rev = new ModelRevision({
            diff_json: "bad",
            created_at: "2025-01-01T00:00:00.000Z",
        } as any);
        expect(() => rev.diff).toThrow(/unknown.*unknown.*unknown/);
    });
});
