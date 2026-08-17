// coverage100.relationResolver.test.ts
// Closes the remaining coverage gaps in d1Eloquent/relationResolver.ts:
// - lazy .first() arrows for every relation kind (belongsTo, hasMany,
//   belongsToMany, morphToMany, morphedByMany, morphTo)
// - morphTo defensive paths (no parent instance, null discriminator,
//   unknown type during eager load, dangling id)
// - eager-loader early returns (empty parent set, all-null local keys)
// - distribution fallbacks (?? [] and ?? null when a parent has no match)
// - hasOneThrough first-match-wins de-duplication
// - morphToMany / morphedByMany aggregate subqueries (withCount), with and
//   without explicit localKey / relatedKey
// - pivot attach/detach/sync/toggle branch paths, including D1 result
//   envelopes that omit meta/results (the ?? 0 and ?? [] fallbacks)

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { resolveRelation } from "../relationResolver";
import type { TRelationDefinition } from "../relationTypes";

interface UserAttrs {
    id?: string;
    name?: string;
    alt_ref?: string | null;
}
interface PostAttrs {
    id?: string;
    user_id?: string | null;
    title?: string;
    alt_ref?: string | null;
}
interface CommentAttrs {
    id?: string;
    post_id?: string;
    body?: string;
}
interface ProfileAttrs {
    id?: string;
    user_id?: string;
    bio?: string;
}
interface RoleAttrs {
    id?: string;
    label?: string;
}
interface ImageAttrs {
    id?: string;
    src?: string;
    imageable_type?: string | null;
    imageable_id?: string | null;
}
interface TagAttrs {
    id?: string;
    label?: string;
    alt_ref?: string | null;
}

class CvrUser extends BaseModel<UserAttrs> {
    static table = "cvr_users";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => CvrPost, foreignKey: "user_id" },
        postsAlt: { type: "hasMany", model: () => CvrPost, foreignKey: "user_id", localKey: "alt_ref" },
        profile: { type: "hasOne", model: () => CvrProfile, foreignKey: "user_id" },
        profileAlt: { type: "hasOne", model: () => CvrProfile, foreignKey: "user_id", localKey: "alt_ref" },
        roles: {
            type: "belongsToMany",
            model: () => CvrRole,
            pivot: "cvr_role_user",
            foreignPivotKey: "user_id",
            relatedPivotKey: "role_id",
        },
        rolesAlt: {
            type: "belongsToMany",
            model: () => CvrRole,
            pivot: "cvr_role_user",
            foreignPivotKey: "user_id",
            relatedPivotKey: "role_id",
            localKey: "alt_ref",
        },
        commentsThrough: {
            type: "hasManyThrough",
            model: () => CvrComment,
            through: () => CvrPost,
            firstKey: "user_id",
            secondKey: "post_id",
        },
        commentsThroughAlt: {
            type: "hasManyThrough",
            model: () => CvrComment,
            through: () => CvrPost,
            firstKey: "user_id",
            secondKey: "post_id",
            localKey: "alt_ref",
        },
        firstComment: {
            type: "hasOneThrough",
            model: () => CvrComment,
            through: () => CvrPost,
            firstKey: "user_id",
            secondKey: "post_id",
        },
    };
}

class CvrPost extends BaseModel<PostAttrs> {
    static table = "cvr_posts";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        author: { type: "belongsTo", model: () => CvrUser, foreignKey: "user_id" },
        comments: { type: "hasMany", model: () => CvrComment, foreignKey: "post_id" },
        images: {
            type: "morphMany",
            model: () => CvrImage,
            morphName: "imageable",
            typeValue: "post",
        },
        imagesAlt: {
            type: "morphMany",
            model: () => CvrImage,
            morphName: "imageable",
            typeValue: "post",
            localKey: "alt_ref",
        },
        cover: {
            type: "morphOne",
            model: () => CvrImage,
            morphName: "imageable",
            typeValue: "post",
        },
        tags: {
            type: "morphToMany",
            model: () => CvrTag,
            pivot: "cvr_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
        },
        tagsAlt: {
            type: "morphToMany",
            model: () => CvrTag,
            pivot: "cvr_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
            localKey: "alt_ref",
        },
        tagsExplicit: {
            type: "morphToMany",
            model: () => CvrTag,
            pivot: "cvr_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
            localKey: "id",
            relatedKey: "id",
        },
    };
}

class CvrComment extends BaseModel<CommentAttrs> {
    static table = "cvr_comments";
    static primaryKey = "id";
    static timestamps = false;
}

class CvrProfile extends BaseModel<ProfileAttrs> {
    static table = "cvr_profiles";
    static primaryKey = "id";
    static timestamps = false;
}

class CvrRole extends BaseModel<RoleAttrs> {
    static table = "cvr_roles";
    static primaryKey = "id";
    static timestamps = false;
}

class CvrImage extends BaseModel<ImageAttrs> {
    static table = "cvr_images";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        imageable: {
            type: "morphTo",
            morphName: "imageable",
            morphMap: { post: () => CvrPost },
        },
    };
}

class CvrTag extends BaseModel<TagAttrs> {
    static table = "cvr_tags";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: {
            type: "morphedByMany",
            model: () => CvrPost,
            pivot: "cvr_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
        },
        postsAlt: {
            type: "morphedByMany",
            model: () => CvrPost,
            pivot: "cvr_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
            localKey: "alt_ref",
        },
        postsExplicit: {
            type: "morphedByMany",
            model: () => CvrPost,
            pivot: "cvr_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
            localKey: "id",
            relatedKey: "id",
        },
    };
}

/**
 * A D1Database wrapper that executes real SQL against the live test DB but
 * strips `meta` and `results` from every response envelope. This is the real
 * triggering condition for the defensive `?? 0` / `?? []` fallbacks in the
 * pivot methods (a D1-compatible adapter that omits result metadata).
 */
function thinDb(real: D1Database): D1Database {
    const wrapStmt = (stmt: D1PreparedStatement): unknown => ({
        __real: stmt,
        bind: (...args: unknown[]) => wrapStmt(stmt.bind(...args)),
        run: async () => {
            const r = await stmt.run();
            return { success: r.success };
        },
        all: async () => {
            const r = await stmt.all();
            return { success: r.success };
        },
    });
    return {
        prepare: (sql: string) => wrapStmt(real.prepare(sql)),
        batch: async (stmts: { __real: D1PreparedStatement }[]) => {
            const res = await real.batch(stmts.map((s) => s.__real));
            return res.map((r) => ({ success: r.success }));
        },
    } as unknown as D1Database;
}

const pivotRoles = async (userId: string): Promise<string[]> => {
    const r = await env.DB.prepare("SELECT role_id FROM cvr_role_user WHERE user_id = ?")
        .bind(userId)
        .all<{ role_id: string }>();
    return (r.results ?? []).map((x) => x.role_id).sort();
};

const clearRoles = async (userId: string): Promise<void> => {
    await env.DB.prepare("DELETE FROM cvr_role_user WHERE user_id = ?").bind(userId).run();
};

beforeAll(async () => {
    for (const sql of [
        "DROP TABLE IF EXISTS cvr_taggables",
        "DROP TABLE IF EXISTS cvr_tags",
        "DROP TABLE IF EXISTS cvr_images",
        "DROP TABLE IF EXISTS cvr_role_user",
        "DROP TABLE IF EXISTS cvr_roles",
        "DROP TABLE IF EXISTS cvr_profiles",
        "DROP TABLE IF EXISTS cvr_comments",
        "DROP TABLE IF EXISTS cvr_posts",
        "DROP TABLE IF EXISTS cvr_users",
        "CREATE TABLE cvr_users (id TEXT PRIMARY KEY, name TEXT, alt_ref TEXT)",
        "CREATE TABLE cvr_posts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, alt_ref TEXT)",
        "CREATE TABLE cvr_comments (id TEXT PRIMARY KEY, post_id TEXT, body TEXT)",
        "CREATE TABLE cvr_profiles (id TEXT PRIMARY KEY, user_id TEXT, bio TEXT)",
        "CREATE TABLE cvr_roles (id TEXT PRIMARY KEY, label TEXT)",
        "CREATE TABLE cvr_role_user (user_id TEXT, role_id TEXT, PRIMARY KEY (user_id, role_id))",
        "CREATE TABLE cvr_images (id TEXT PRIMARY KEY, src TEXT, imageable_type TEXT, imageable_id TEXT)",
        "CREATE TABLE cvr_tags (id TEXT PRIMARY KEY, label TEXT, alt_ref TEXT)",
        "CREATE TABLE cvr_taggables (tag_id TEXT, taggable_type TEXT, taggable_id TEXT, PRIMARY KEY (tag_id, taggable_type, taggable_id))",
    ]) {
        await env.DB.prepare(sql).run();
    }

    const ins = async (sql: string, ...bindings: unknown[]) =>
        env.DB.prepare(sql).bind(...bindings).run();

    // Users: alt_ref intentionally NULL everywhere (drives keys.length === 0 paths)
    await ins("INSERT INTO cvr_users (id, name, alt_ref) VALUES (?, ?, NULL)", "u1", "Ada");
    await ins("INSERT INTO cvr_users (id, name, alt_ref) VALUES (?, ?, NULL)", "u2", "Bob");

    // Posts: p1/p2 belong to u1; p_dangle points at a missing user; p_null has no user
    await ins("INSERT INTO cvr_posts (id, user_id, title, alt_ref) VALUES (?, ?, ?, NULL)", "p1", "u1", "First");
    await ins("INSERT INTO cvr_posts (id, user_id, title, alt_ref) VALUES (?, ?, ?, NULL)", "p2", "u1", "Second");
    await ins("INSERT INTO cvr_posts (id, user_id, title, alt_ref) VALUES (?, ?, ?, NULL)", "p_dangle", "ghost-user", "Dangling");
    await ins("INSERT INTO cvr_posts (id, user_id, title, alt_ref) VALUES (?, NULL, ?, NULL)", "p_null", "Orphan");

    await ins("INSERT INTO cvr_comments (id, post_id, body) VALUES (?, ?, ?)", "c1", "p1", "one");
    await ins("INSERT INTO cvr_comments (id, post_id, body) VALUES (?, ?, ?)", "c2", "p1", "two");
    await ins("INSERT INTO cvr_comments (id, post_id, body) VALUES (?, ?, ?)", "c3", "p2", "three");

    await ins("INSERT INTO cvr_profiles (id, user_id, bio) VALUES (?, ?, ?)", "pr1", "u1", "hi");

    await ins("INSERT INTO cvr_roles (id, label) VALUES (?, ?)", "r1", "admin");
    await ins("INSERT INTO cvr_roles (id, label) VALUES (?, ?)", "r2", "editor");
    await ins("INSERT INTO cvr_roles (id, label) VALUES (?, ?)", "r3", "viewer");
    await ins("INSERT INTO cvr_role_user (user_id, role_id) VALUES (?, ?)", "u1", "r1");

    // Images: i1 valid morph target; i_null has no discriminator; i_dangle points
    // at a missing post; i_widget has a type absent from the morphMap
    await ins("INSERT INTO cvr_images (id, src, imageable_type, imageable_id) VALUES (?, ?, ?, ?)", "i1", "/a.jpg", "post", "p1");
    await ins("INSERT INTO cvr_images (id, src, imageable_type, imageable_id) VALUES (?, ?, ?, ?)", "i2", "/a2.jpg", "post", "p1");
    await ins("INSERT INTO cvr_images (id, src, imageable_type, imageable_id) VALUES (?, ?, NULL, NULL)", "i_null", "/b.jpg");
    await ins("INSERT INTO cvr_images (id, src, imageable_type, imageable_id) VALUES (?, ?, ?, ?)", "i_dangle", "/c.jpg", "post", "ghost-post");
    await ins("INSERT INTO cvr_images (id, src, imageable_type, imageable_id) VALUES (?, ?, ?, ?)", "i_widget", "/d.jpg", "widget", "w1");

    await ins("INSERT INTO cvr_tags (id, label, alt_ref) VALUES (?, ?, NULL)", "t1", "rust");
    await ins("INSERT INTO cvr_tags (id, label, alt_ref) VALUES (?, ?, NULL)", "t2", "workers");
    await ins("INSERT INTO cvr_tags (id, label, alt_ref) VALUES (?, ?, NULL)", "t3", "lonely");
    await ins("INSERT INTO cvr_taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)", "t1", "post", "p1");
    await ins("INSERT INTO cvr_taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)", "t2", "post", "p1");
});

describe("relationResolver.ts - lazy first() for every relation kind", () => {
    it("belongsTo: related().first() returns the owning model", async () => {
        const post = await CvrPost.findOrFail(env.DB, "p1");
        const owner = await (post as any).related("author").first(env.DB);
        expect(owner).not.toBeNull();
        expect((owner as any).get("id")).toBe("u1");
        expect((owner as any).get("name")).toBe("Ada");
    });

    it("hasMany: related().first() returns one of the child rows", async () => {
        const user = await CvrUser.findOrFail(env.DB, "u1");
        const post = await (user as any).related("posts").first(env.DB);
        expect(post).not.toBeNull();
        expect(["p1", "p2"]).toContain((post as any).get("id"));
    });

    it("belongsToMany: related().first() returns a pivot-joined row", async () => {
        const user = await CvrUser.findOrFail(env.DB, "u1");
        const role = await (user as any).related("roles").first(env.DB);
        expect(role).not.toBeNull();
        expect((role as any).get("id")).toBe("r1");
        expect((role as any).get("label")).toBe("admin");
    });

    it("morphToMany: related().first() returns an attached tag", async () => {
        const post = await CvrPost.findOrFail(env.DB, "p1");
        const tag = await (post as any).related("tags").first(env.DB);
        expect(tag).not.toBeNull();
        expect(["rust", "workers"]).toContain((tag as any).get("label"));
    });

    it("morphedByMany: related().first() returns the attached parent", async () => {
        const tag = await CvrTag.findOrFail(env.DB, "t1");
        const post = await (tag as any).related("posts").first(env.DB);
        expect(post).not.toBeNull();
        expect((post as any).get("id")).toBe("p1");
    });

    it("morphTo: related().first() returns the concrete morph target", async () => {
        const img = await CvrImage.findOrFail(env.DB, "i1");
        const target = await (img as any).related("imageable").first(env.DB);
        expect(target).not.toBeNull();
        expect((target as any).get("id")).toBe("p1");
        expect((target as any).get("title")).toBe("First");
    });
});

describe("relationResolver.ts - lazy get() on singular relations", () => {
    it("belongsTo: related().get() returns the owning row as a one-element array", async () => {
        const post = await CvrPost.findOrFail(env.DB, "p1");
        const rows = await (post as any).related("author").get(env.DB);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBe(1);
        expect((rows[0] as any).get("id")).toBe("u1");
        expect((rows[0] as any).get("name")).toBe("Ada");
    });

    it("morphTo: related().get() returns the concrete morph target as an array", async () => {
        const img = await CvrImage.findOrFail(env.DB, "i1");
        const rows = await (img as any).related("imageable").get(env.DB);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBe(1);
        expect((rows[0] as any).get("id")).toBe("p1");
        expect((rows[0] as any).get("title")).toBe("First");
    });
});

describe("relationResolver.ts - morphTo defensive paths (lazy)", () => {
    it("throws when resolved without a parent model instance", () => {
        const def: TRelationDefinition = {
            type: "morphTo",
            morphName: "imageable",
            morphMap: { post: () => CvrPost },
        };
        expect(() => resolveRelation(def, CvrImage as any, undefined)).toThrow(
            /morphTo 'imageable': cannot resolve without parent model instance/,
        );
    });

    it("null discriminator yields an empty relationship (get [] / first null)", async () => {
        const img = await CvrImage.findOrFail(env.DB, "i_null");
        const rel = (img as any).related("imageable");
        const rows = await rel.get(env.DB);
        expect(rows).toEqual([]);
        const first = await rel.first(env.DB);
        expect(first).toBeNull();
    });
});

describe("relationResolver.ts - eager loaders with an empty parent set", () => {
    it("hasMany/hasOne/belongsToMany/hasManyThrough loaders no-op on zero parents", async () => {
        const res = await CvrUser.query()
            .whereEq("id", "__none__")
            .with(["posts", "profile", "roles", "commentsThrough"])
            .get(env.DB);
        expect(res.length).toBe(0);
    });

    it("belongsTo/morphMany/morphToMany loaders no-op on zero parents", async () => {
        const res = await CvrPost.query()
            .whereEq("id", "__none__")
            .with(["author", "images", "tags"])
            .get(env.DB);
        expect(res.length).toBe(0);
    });

    it("morphTo loader no-ops on zero parents", async () => {
        const res = await CvrImage.query()
            .whereEq("id", "__none__")
            .with(["imageable"])
            .get(env.DB);
        expect(res.length).toBe(0);
    });

    it("morphedByMany loader no-ops on zero parents", async () => {
        const res = await CvrTag.query()
            .whereEq("id", "__none__")
            .with(["posts"])
            .get(env.DB);
        expect(res.length).toBe(0);
    });
});

describe("relationResolver.ts - eager loaders when every local key is null", () => {
    it("hasMany/hasOne/belongsToMany/hasManyThrough leave relations unloaded", async () => {
        const users = await CvrUser.query()
            .whereEq("id", "u1")
            .with(["postsAlt", "profileAlt", "rolesAlt", "commentsThroughAlt"])
            .get(env.DB);
        expect(users.length).toBe(1);
        const u = users[0] as any;
        expect(u.relations.postsAlt).toBeUndefined();
        expect(u.relations.profileAlt).toBeUndefined();
        expect(u.relations.rolesAlt).toBeUndefined();
        expect(u.relations.commentsThroughAlt).toBeUndefined();
    });

    it("morphMany/morphToMany leave relations unloaded", async () => {
        const posts = await CvrPost.query()
            .whereEq("id", "p1")
            .with(["imagesAlt", "tagsAlt"])
            .get(env.DB);
        expect(posts.length).toBe(1);
        const p = posts[0] as any;
        expect(p.relations.imagesAlt).toBeUndefined();
        expect(p.relations.tagsAlt).toBeUndefined();
    });

    it("morphedByMany leaves the relation unloaded", async () => {
        const tags = await CvrTag.query().whereEq("id", "t1").with(["postsAlt"]).get(env.DB);
        expect(tags.length).toBe(1);
        expect((tags[0] as any).relations.postsAlt).toBeUndefined();
    });

    it("belongsTo leaves the relation unloaded when every foreign key is null", async () => {
        const posts = await CvrPost.query().whereEq("id", "p_null").with(["author"]).get(env.DB);
        expect(posts.length).toBe(1);
        expect((posts[0] as any).relations.author).toBeUndefined();
    });
});

describe("relationResolver.ts - eager distribution fallbacks", () => {
    it("morphToMany: a parent without pivot rows gets an empty array", async () => {
        const posts = await CvrPost.query()
            .whereIn("id", ["p1", "p2"])
            .with(["tags"])
            .get(env.DB);
        const byId = Object.fromEntries(posts.map((p: any) => [p.get("id"), p.relations.tags]));
        expect((byId["p1"] as any[]).map((t: any) => t.get("label")).sort()).toEqual(["rust", "workers"]);
        expect(byId["p2"]).toEqual([]);
    });

    it("morphedByMany: a tag with no attachments gets an empty array", async () => {
        const tags = await CvrTag.query().whereIn("id", ["t1", "t3"]).with(["posts"]).get(env.DB);
        const byId = Object.fromEntries(tags.map((t: any) => [t.get("id"), t.relations.posts]));
        expect((byId["t1"] as any[]).map((p: any) => p.get("id"))).toEqual(["p1"]);
        expect(byId["t3"]).toEqual([]);
    });

    it("belongsTo: a dangling foreign key resolves to null", async () => {
        const posts = await CvrPost.query()
            .whereIn("id", ["p1", "p_dangle"])
            .with(["author"])
            .get(env.DB);
        const byId = Object.fromEntries(posts.map((p: any) => [p.get("id"), p]));
        expect((byId["p1"].relations.author as any).get("id")).toBe("u1");
        expect(byId["p_dangle"].relations.author).toBeNull();
    });

    it("hasOneThrough: duplicate through-keys keep the first match only", async () => {
        // u1 has three comments through two posts, so the loader sees the same
        // __through_fk (u1) three times and must skip the later duplicates.
        const users = await CvrUser.query().whereEq("id", "u1").with(["firstComment"]).get(env.DB);
        const first = (users[0] as any).relations.firstComment;
        expect(first).not.toBeNull();
        expect(Array.isArray(first)).toBe(false);
        expect(["c1", "c2", "c3"]).toContain((first as any).get("id"));
        expect(["p1", "p2"]).toContain((first as any).get("post_id"));
    });

    it("morphOne eager: duplicate morph keys keep the first match only", async () => {
        // p1 has two images (i1, i2), so the morphOne loader sees the same
        // imageable_id twice and must skip the later duplicate.
        const posts = await CvrPost.query().whereEq("id", "p1").with(["cover"]).get(env.DB);
        const cover = (posts[0] as any).relations.cover;
        expect(cover).not.toBeNull();
        expect(Array.isArray(cover)).toBe(false);
        expect(["i1", "i2"]).toContain((cover as any).get("id"));
        expect((cover as any).get("imageable_id")).toBe("p1");
    });

    it("morphTo eager: null discriminator sets the relation to null", async () => {
        const images = await CvrImage.query()
            .whereIn("id", ["i1", "i_null"])
            .with(["imageable"])
            .get(env.DB);
        const byId = Object.fromEntries(images.map((i: any) => [i.get("id"), i]));
        expect((byId["i1"].relations.imageable as any).get("id")).toBe("p1");
        expect(byId["i_null"].relations.imageable).toBeNull();
    });

    it("morphTo eager: a dangling id sets the relation to null", async () => {
        const images = await CvrImage.query()
            .whereIn("id", ["i1", "i_dangle"])
            .with(["imageable"])
            .get(env.DB);
        const byId = Object.fromEntries(images.map((i: any) => [i.get("id"), i]));
        expect((byId["i1"].relations.imageable as any).get("id")).toBe("p1");
        expect(byId["i_dangle"].relations.imageable).toBeNull();
    });

    it("morphTo eager: an unknown type throws with a morphMap hint", async () => {
        await expect(
            CvrImage.query().whereEq("id", "i_widget").with(["imageable"]).get(env.DB),
        ).rejects.toThrow(/morphTo 'imageable': unknown type 'widget'/);
    });
});

describe("relationResolver.ts - morphToMany / morphedByMany aggregates", () => {
    it("withCount over morphToMany (default keys)", async () => {
        const posts = await CvrPost.query()
            .whereIn("id", ["p1", "p2"])
            .withCount("tags", "tags_count")
            .get(env.DB);
        const byId = Object.fromEntries(posts.map((p: any) => [p.get("id"), Number(p.get("tags_count"))]));
        expect(byId["p1"]).toBe(2);
        expect(byId["p2"]).toBe(0);
    });

    it("withCount over morphToMany (explicit localKey/relatedKey)", async () => {
        const posts = await CvrPost.query()
            .whereIn("id", ["p1", "p2"])
            .withCount("tagsExplicit", "tags_count2")
            .get(env.DB);
        const byId = Object.fromEntries(posts.map((p: any) => [p.get("id"), Number(p.get("tags_count2"))]));
        expect(byId["p1"]).toBe(2);
        expect(byId["p2"]).toBe(0);
    });

    it("withCount over morphedByMany (default keys)", async () => {
        const tags = await CvrTag.query()
            .whereIn("id", ["t1", "t3"])
            .withCount("posts", "posts_count")
            .get(env.DB);
        const byId = Object.fromEntries(tags.map((t: any) => [t.get("id"), Number(t.get("posts_count"))]));
        expect(byId["t1"]).toBe(1);
        expect(byId["t3"]).toBe(0);
    });

    it("withCount over morphedByMany (explicit localKey/relatedKey)", async () => {
        const tags = await CvrTag.query()
            .whereIn("id", ["t1", "t3"])
            .withCount("postsExplicit", "posts_count2")
            .get(env.DB);
        const byId = Object.fromEntries(tags.map((t: any) => [t.get("id"), Number(t.get("posts_count2"))]));
        expect(byId["t1"]).toBe(1);
        expect(byId["t3"]).toBe(0);
    });
});

describe("relationResolver.ts - pivot sync/toggle branch paths", () => {
    it("sync with nothing to detach reports detached: []", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");
        await (u2 as any).attach("roles", "r1", { db: env.DB });

        const res = await (u2 as any).sync("roles", ["r1", "r2"], { db: env.DB });
        expect(res.attached).toEqual(["r2"]);
        expect(res.detached).toEqual([]);
        expect(await pivotRoles("u2")).toEqual(["r1", "r2"]);
    });

    it("toggle with every id present detaches only", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");
        await (u2 as any).attach("roles", "r1", { db: env.DB });

        const res = await (u2 as any).toggle("roles", ["r1"], { db: env.DB });
        expect(res.attached).toEqual([]);
        expect(res.detached).toEqual(["r1"]);
        expect(await pivotRoles("u2")).toEqual([]);
    });

    it("toggle with no id present attaches only", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");

        const res = await (u2 as any).toggle("roles", ["r3"], { db: env.DB });
        expect(res.attached).toEqual(["r3"]);
        expect(res.detached).toEqual([]);
        expect(await pivotRoles("u2")).toEqual(["r3"]);
    });
});

describe("relationResolver.ts - pivot methods on a D1 adapter that omits meta/results", () => {
    it("attach writes rows but reports 0 changes without meta", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");
        const rel = (u2 as any).related("roles");

        const n = await rel.attach(["r2"], { db: thinDb(env.DB) });
        expect(n).toBe(0);
        expect(await pivotRoles("u2")).toEqual(["r2"]);
    });

    it("detach(ids) deletes rows but reports 0 changes without meta", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");
        const rel = (u2 as any).related("roles");
        await rel.attach(["r1"], { db: env.DB });

        const n = await rel.detach(["r1"], { db: thinDb(env.DB) });
        expect(n).toBe(0);
        expect(await pivotRoles("u2")).toEqual([]);
    });

    it("detach() (all) deletes rows but reports 0 changes without meta", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");
        const rel = (u2 as any).related("roles");
        await rel.attach(["r1", "r2"], { db: env.DB });

        const n = await rel.detach(undefined, { db: thinDb(env.DB) });
        expect(n).toBe(0);
        expect(await pivotRoles("u2")).toEqual([]);
    });

    it("sync treats a missing results array as an empty current set", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");
        const rel = (u2 as any).related("roles");

        const res = await rel.sync(["r1"], { db: thinDb(env.DB) });
        expect(res.attached).toEqual(["r1"]);
        expect(res.detached).toEqual([]);
        expect(await pivotRoles("u2")).toEqual(["r1"]);
    });

    it("toggle treats a missing results array as nothing-present", async () => {
        await clearRoles("u2");
        const u2 = await CvrUser.findOrFail(env.DB, "u2");
        const rel = (u2 as any).related("roles");
        await rel.attach(["r1"], { db: env.DB });

        // Without result rows the current set reads as empty, so toggle
        // re-attaches (INSERT OR IGNORE keeps the row) instead of detaching.
        const res = await rel.toggle(["r1"], { db: thinDb(env.DB) });
        expect(res.attached).toEqual(["r1"]);
        expect(res.detached).toEqual([]);
        expect(await pivotRoles("u2")).toEqual(["r1"]);
    });
});
