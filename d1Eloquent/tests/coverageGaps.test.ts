// coverageGaps.test.ts
// Targeted tests for defensive branches that weren't otherwise exercised:
// BaseModel.dynamic() full-config application, find() with an invalid id, and
// the "relation is not pivot-backed" guards on attach/detach/sync/toggle.

import { describe, it, expect } from "vitest";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

class CgComment extends BaseModel<{ id: string; post_id: string }> {
    static table = "cg_comments";
    static timestamps = false;
}

class CgPost extends BaseModel<{ id: string }> {
    static table = "cg_posts";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        comments: { type: "hasMany", model: () => CgComment, foreignKey: "post_id" },
    };
}

describe("BaseModel.dynamic() — full optional config", () => {
    it("applies every optional config field onto the generated class", () => {
        const M = BaseModel.dynamic({
            table: "cg_dyn",
            connection: "cg_conn",
            accessors: {},
            appends: [],
            hidden: ["secret"],
            revisions: { enabled: false, mode: "diff+after" as const },
            revisionRedact: [],
            revisionOnly: null,
        });
        expect((M as unknown as { connection: string }).connection).toBe("cg_conn");
        expect((M as unknown as { hidden: string[] }).hidden).toEqual(["secret"]);
        expect((M as unknown as { revisionOnly: unknown }).revisionOnly).toBeNull();
        expect((M as unknown as { appends: string[] }).appends).toEqual([]);
    });
});

describe("BaseModel.find() — invalid id", () => {
    it("returns null for an empty-string id (no query issued)", async () => {
        expect(await (CgPost as unknown as { find(id: unknown): Promise<unknown> }).find("")).toBeNull();
    });
    it("returns null for a non-string id", async () => {
        expect(await (CgPost as unknown as { find(id: unknown): Promise<unknown> }).find(123)).toBeNull();
    });
});

describe("pivot sugar guards on a non-pivot relation", () => {
    const post = new CgPost({ id: "p1" });

    it("attach() throws", () => {
        expect(() => post.attach("comments", "c1")).toThrow(/not pivot-backed/);
    });
    it("detach() throws", () => {
        expect(() => post.detach("comments", "c1")).toThrow(/not pivot-backed/);
    });
    it("sync() throws", () => {
        expect(() => post.sync("comments", ["c1"])).toThrow(/not pivot-backed/);
    });
    it("toggle() throws", () => {
        expect(() => post.toggle("comments", "c1")).toThrow(/not pivot-backed/);
    });
});
