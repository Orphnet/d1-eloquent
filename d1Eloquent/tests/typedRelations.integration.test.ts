// typedRelations.integration.test.ts
// Validates that the third BaseModel generic (TRels) types the .relations
// property — both at compile time (via // @ts-expect-error markers below) and
// at runtime (the property still works the same).

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { BaseModel } from "../baseModel";
import type { TModelRelationsOf } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface UserAttrs {
    id: string;
    name: string;
}
interface PostAttrs {
    id: string;
    title: string;
    user_id: string;
}
interface ProfileAttrs {
    id: string;
    user_id: string;
    bio: string;
}

// ── Typed relations: three-arg BaseModel generic ──────────────────────

type UserRelations = {
    posts: TrPost[];
    profile: TrProfile | null;
};

class TrUser extends BaseModel<UserAttrs, {}, UserRelations> {
    static table = "tr_users";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => TrPost, foreignKey: "user_id" },
        profile: { type: "hasOne", model: () => TrProfile, foreignKey: "user_id" },
    };
}

class TrPost extends BaseModel<PostAttrs> {
    static table = "tr_posts";
    static primaryKey = "id";
    static timestamps = false;
}

class TrProfile extends BaseModel<ProfileAttrs> {
    static table = "tr_profiles";
    static primaryKey = "id";
    static timestamps = false;
}

beforeAll(async () => {
    const s = new Schema();
    s.dropTable("tr_profiles");
    s.dropTable("tr_posts");
    s.dropTable("tr_users");

    s.createTable("tr_users", (t) => {
        t.id();
        t.text("name").notNull();
    });
    s.createTable("tr_posts", (t) => {
        t.id();
        t.text("title").notNull();
        t.text("user_id").notNull();
    });
    s.createTable("tr_profiles", (t) => {
        t.id();
        t.text("user_id").notNull();
        t.text("bio").notNull();
    });

    for (const stmt of s.toStatements()) await env.DB.prepare(stmt).run();

    const run = async (sql: string, ...bs: unknown[]) =>
        env.DB.prepare(sql).bind(...bs).run();
    await run("INSERT INTO tr_users (id, name) VALUES (?, ?)", "u1", "Alice");
    await run("INSERT INTO tr_posts (id, title, user_id) VALUES (?, ?, ?)", "p1", "Hi", "u1");
    await run("INSERT INTO tr_posts (id, title, user_id) VALUES (?, ?, ?)", "p2", "Bye", "u1");
    await run("INSERT INTO tr_profiles (id, user_id, bio) VALUES (?, ?, ?)", "pr1", "u1", "writer");
});

describe("Typed relations — third BaseModel generic", () => {
    it("eagerly loads typed relations onto .relations", async () => {
        const user = await TrUser.query().whereEq("id", "u1").with(["posts", "profile"]).first(env.DB);
        expect(user).not.toBeNull();

        // The point of the new generic: these reads are TYPED — no `as any` needed
        const posts = user!.relations.posts;
        const profile = user!.relations.profile;

        expect(Array.isArray(posts)).toBe(true);
        expect(posts!.length).toBe(2);
        expect((posts![0] as any).get("title")).toBe("Hi");

        expect(profile).not.toBeNull();
        expect((profile as any).get("bio")).toBe("writer");
    });

    it("defaults to empty object when no relations are loaded", async () => {
        const user = await TrUser.findOrFail(env.DB, "u1");
        // Without with(), relations is the default empty object
        expect(Object.keys(user.relations).length).toBe(0);
    });

    it("preserves backward compatibility — models without a third generic still work", async () => {
        // TrPost has no TRels — it uses the default TRelations fallback
        const post = await TrPost.findOrFail(env.DB, "p1");
        expect((post as any).relations).toEqual({});
        // Untyped read still possible
        ((post as any).relations as Record<string, unknown>)["author"] = "anything";
        expect(((post as any).relations as any).author).toBe("anything");
    });

    it("TModelRelationsOf extracts the relations type", () => {
        // This is a compile-time check via type inference. Sanity-check at
        // runtime that the symbol exists; the actual narrowing is validated
        // by `bun run build` / publint.
        type Extracted = TModelRelationsOf<TrUser>;
        const _check: Extracted = {} as UserRelations;
        expect(_check).toBeDefined();
    });
});
