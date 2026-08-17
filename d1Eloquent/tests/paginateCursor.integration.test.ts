// paginateCursor.integration.test.ts
// Live D1 integration tests for keyset / cursor pagination.

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { BaseModel } from "../baseModel";

interface PostAttrs {
    id: string;
    title: string;
    score: number;
    created_at: string;
}

class CpPost extends BaseModel<PostAttrs> {
    static table = "cp_posts";
    static primaryKey = "id";
    static timestamps = false;
    static casts = { score: "integer" } as const;
}

beforeAll(async () => {
    const schema = new Schema();
    schema.dropTable("cp_posts");
    schema.createTable("cp_posts", (t) => {
        t.id();
        t.text("title").notNull();
        t.integer("score").notNull();
        t.text("created_at").notNull();
    });
    for (const stmt of schema.toStatements()) await env.DB.prepare(stmt).run();

    // Seed 25 posts with strictly increasing created_at + some score ties
    const insert = async (id: string, title: string, score: number, when: string) =>
        env.DB
            .prepare("INSERT INTO cp_posts (id, title, score, created_at) VALUES (?, ?, ?, ?)")
            .bind(id, title, score, when)
            .run();

    for (let i = 0; i < 25; i++) {
        const id = `p${String(i + 1).padStart(2, "0")}`;
        const score = i < 5 ? 10 : (i % 5) + 1; // first 5 share score=10 to test ties
        await insert(id, `Post ${i + 1}`, score, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
    }
});

describe("paginateCursor — forward navigation", () => {
    it("returns the first page with no cursor, sorted by created_at desc + pk desc tiebreaker", async () => {
        const page = await CpPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 5 },
            env.DB,
        );
        expect(page.data.length).toBe(5);
        const ids = page.data.map((p: any) => p.get("id"));
        expect(ids).toEqual(["p25", "p24", "p23", "p22", "p21"]);
        expect(page.nextCursor).toBeTruthy();
        expect(page.prevCursor).toBeNull();
        expect(page.hasMore).toBe(true);
    });

    it("walks all pages without skipping or duplicating rows", async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let safety = 30;

        while (safety-- > 0) {
            const page: any = await CpPost.query().paginateCursor(
                {
                    orderBy: "created_at",
                    direction: "desc",
                    perPage: 7,
                    ...(cursor ? { after: cursor } : {}),
                },
                env.DB,
            );
            for (const p of page.data) seen.push(p.get("id"));
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
        }

        // Expect all 25 rows, no duplicates, sorted desc
        expect(seen.length).toBe(25);
        expect(new Set(seen).size).toBe(25);
        expect(seen[0]).toBe("p25");
        expect(seen.at(-1)).toBe("p01");
    });

    it("emits prevCursor when navigated forward from a cursor", async () => {
        const page1 = await CpPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 5 },
            env.DB,
        );
        const page2 = await CpPost.query().paginateCursor(
            {
                orderBy: "created_at",
                direction: "desc",
                perPage: 5,
                after: page1.nextCursor!,
            },
            env.DB,
        );

        const ids = page2.data.map((p: any) => p.get("id"));
        expect(ids).toEqual(["p20", "p19", "p18", "p17", "p16"]);
        expect(page2.prevCursor).toBeTruthy();
        expect(page2.nextCursor).toBeTruthy();
    });
});

describe("paginateCursor — backward navigation", () => {
    it("returns the previous page in the original order when using `before`", async () => {
        // Walk forward to page 3
        const page1 = await CpPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 5 },
            env.DB,
        );
        const page2 = await CpPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 5, after: page1.nextCursor! },
            env.DB,
        );
        const page3 = await CpPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 5, after: page2.nextCursor! },
            env.DB,
        );

        // Now go back from page3 — should match page2
        const back: any = await CpPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 5, before: page3.prevCursor! },
            env.DB,
        );
        const backIds = back.data.map((p: any) => p.get("id"));
        const page2Ids = page2.data.map((p: any) => p.get("id"));
        expect(backIds).toEqual(page2Ids);
    });
});

describe("paginateCursor — tie-breaking", () => {
    it("paginates through rows with duplicate orderBy values without dropping or duplicating", async () => {
        // p01..p05 all share score = 10. Sort by score (desc) with pk tiebreaker.
        const collected: string[] = [];
        let cursor: string | null = null;
        let safety = 30;

        while (safety-- > 0) {
            const page: any = await CpPost.query().paginateCursor(
                {
                    orderBy: "score",
                    direction: "desc",
                    perPage: 3,
                    ...(cursor ? { after: cursor } : {}),
                },
                env.DB,
            );
            for (const p of page.data) collected.push(p.get("id"));
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
        }

        expect(collected.length).toBe(25);
        expect(new Set(collected).size).toBe(25);
    });
});

describe("paginateCursor — edge cases", () => {
    it("works when orderBy is the primary key itself", async () => {
        const page: any = await CpPost.query().paginateCursor(
            { orderBy: "id", direction: "asc", perPage: 3 },
            env.DB,
        );
        const ids = page.data.map((p: any) => p.get("id"));
        expect(ids).toEqual(["p01", "p02", "p03"]);
        expect(page.hasMore).toBe(true);
    });

    it("sets hasMore = false and nextCursor = null on the last page", async () => {
        const page: any = await CpPost.query().paginateCursor(
            { orderBy: "created_at", direction: "asc", perPage: 30 },
            env.DB,
        );
        expect(page.data.length).toBe(25);
        expect(page.hasMore).toBe(false);
        expect(page.nextCursor).toBeNull();
    });

    it("throws when both after and before are provided", async () => {
        await expect(
            CpPost.query().paginateCursor(
                { orderBy: "id", after: "x", before: "y" },
                env.DB,
            ),
        ).rejects.toThrow(/either 'after' or 'before'/);
    });

    it("throws on an invalid / corrupted cursor", async () => {
        await expect(
            CpPost.query().paginateCursor(
                { orderBy: "id", after: "not-a-cursor!!" },
                env.DB,
            ),
        ).rejects.toThrow(/invalid cursor/);
    });

    it("preserves WHERE filters across pages", async () => {
        // Only posts with score = 10 (p01..p05)
        const page1: any = await CpPost.query()
            .whereEq("score", 10)
            .paginateCursor({ orderBy: "id", direction: "asc", perPage: 2 }, env.DB);
        expect(page1.data.length).toBe(2);
        expect(page1.data.map((p: any) => p.get("id"))).toEqual(["p01", "p02"]);

        const page2: any = await CpPost.query()
            .whereEq("score", 10)
            .paginateCursor(
                { orderBy: "id", direction: "asc", perPage: 2, after: page1.nextCursor! },
                env.DB,
            );
        expect(page2.data.map((p: any) => p.get("id"))).toEqual(["p03", "p04"]);
    });
});
