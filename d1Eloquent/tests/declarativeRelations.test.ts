// declarativeRelations.test.ts
// Tests for declarative relations: relation types, RelationResolver, and has/whereHas SQL generation

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";
import { resolveRelation, buildExistsSubquery, deriveEagerLoaders } from "../relationResolver";
import type { TRelationDefinition } from "../relationTypes";

// ── Minimal model stubs ──────────────────────────────────────────────

interface UserAttrs {
    id?: string;
    name?: string;
    email?: string;
}

class UserModel {
    static table = "users";
    static primaryKey = "id";
    static softDeletes = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => PostModel, foreignKey: "user_id" },
        profile: { type: "hasOne", model: () => ProfileModel, foreignKey: "user_id" },
        roles: {
            type: "belongsToMany",
            model: () => RoleModel,
            pivot: "user_roles",
            foreignPivotKey: "user_id",
            relatedPivotKey: "role_id",
        },
    };
    attrs: UserAttrs;
    relations: Record<string, unknown> = {};
    constructor(attrs: UserAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
    get(key: string) { return (this.attrs as Record<string, unknown>)[key]; }
    setRelation(name: string, value: unknown) { this.relations[name] = value; return this; }
}

interface PostAttrs {
    id?: string;
    user_id?: string;
    title?: string;
    published?: number;
}

class PostModel {
    static table = "posts";
    static primaryKey = "id";
    static softDeletes = false;
    static relations: Record<string, TRelationDefinition> = {
        author: { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" },
        comments: { type: "hasMany", model: () => CommentModel, foreignKey: "post_id" },
        tags: {
            type: "belongsToMany",
            model: () => TagModel,
            pivot: "post_tags",
            foreignPivotKey: "post_id",
            relatedPivotKey: "tag_id",
        },
    };
    attrs: PostAttrs;
    relations: Record<string, unknown> = {};
    constructor(attrs: PostAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
    get(key: string) { return (this.attrs as Record<string, unknown>)[key]; }
    setRelation(name: string, value: unknown) { this.relations[name] = value; return this; }
}

interface CommentAttrs {
    id?: string;
    post_id?: string;
    body?: string;
    approved?: number;
}

class CommentModel {
    static table = "comments";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: CommentAttrs;
    constructor(attrs: CommentAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
    get(key: string) { return (this.attrs as Record<string, unknown>)[key]; }
    setRelation(name: string, value: unknown) { return this; }
}

interface ProfileAttrs {
    id?: string;
    user_id?: string;
    bio?: string;
}

class ProfileModel {
    static table = "profiles";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: ProfileAttrs;
    constructor(attrs: ProfileAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
    get(key: string) { return (this.attrs as Record<string, unknown>)[key]; }
    setRelation(name: string, value: unknown) { return this; }
}

interface RoleAttrs {
    id?: string;
    name?: string;
}

class RoleModel {
    static table = "roles";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: RoleAttrs;
    constructor(attrs: RoleAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
    get(key: string) { return (this.attrs as Record<string, unknown>)[key]; }
    setRelation(name: string, value: unknown) { return this; }
}

interface TagAttrs {
    id?: string;
    name?: string;
}

class TagModel {
    static table = "tags";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: TagAttrs;
    constructor(attrs: TagAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
    get(key: string) { return (this.attrs as Record<string, unknown>)[key]; }
    setRelation(name: string, value: unknown) { return this; }
}

// Model without relations for error testing
class PlainModel {
    static table = "plain_items";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
}

// ── resolveRelation() tests ──────────────────────────────────────────

describe("resolveRelation", () => {
    describe("hasMany", () => {
        it("creates a TRelationship querying the related table by foreign key", () => {
            const def: TRelationDefinition = { type: "hasMany", model: () => PostModel, foreignKey: "user_id" };
            const rel = resolveRelation(def, UserModel as any, "u1");
            const { sql, bindings } = rel.query.toSelectSql();
            expect(sql).toBe("SELECT * FROM posts WHERE user_id = ?");
            expect(bindings).toEqual(["u1"]);
        });
    });

    describe("hasOne", () => {
        it("creates a TRelationship querying the related table by foreign key", () => {
            const def: TRelationDefinition = { type: "hasOne", model: () => ProfileModel, foreignKey: "user_id" };
            const rel = resolveRelation(def, UserModel as any, "u1");
            const { sql, bindings } = rel.query.toSelectSql();
            expect(sql).toBe("SELECT * FROM profiles WHERE user_id = ?");
            expect(bindings).toEqual(["u1"]);
        });
    });

    describe("belongsTo", () => {
        it("creates a TRelationship querying the parent table by owner key", () => {
            const def: TRelationDefinition = { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" };
            const rel = resolveRelation(def, PostModel as any, "u1");
            const { sql, bindings } = rel.query.toSelectSql();
            expect(sql).toBe("SELECT * FROM users WHERE id = ?");
            expect(bindings).toEqual(["u1"]);
        });

        it("uses custom ownerKey when specified", () => {
            const def: TRelationDefinition = { type: "belongsTo", model: () => UserModel, foreignKey: "user_email", ownerKey: "email" };
            const rel = resolveRelation(def, PostModel as any, "alice@example.com");
            const { sql, bindings } = rel.query.toSelectSql();
            expect(sql).toBe("SELECT * FROM users WHERE email = ?");
            expect(bindings).toEqual(["alice@example.com"]);
        });
    });

    describe("belongsToMany", () => {
        it("creates a TRelationship with JOIN through pivot table", () => {
            const def: TRelationDefinition = {
                type: "belongsToMany",
                model: () => RoleModel,
                pivot: "user_roles",
                foreignPivotKey: "user_id",
                relatedPivotKey: "role_id",
            };
            const rel = resolveRelation(def, UserModel as any, "u1");
            const { sql, bindings } = rel.query.toSelectSql();
            expect(sql).toContain("SELECT roles.* FROM roles");
            expect(sql).toContain("INNER JOIN user_roles ON user_roles.role_id = roles.id");
            expect(sql).toContain("user_roles.user_id = ?");
            expect(bindings).toEqual(["u1"]);
        });
    });
});

// ── buildExistsSubquery() tests ──────────────────────────────────────

describe("buildExistsSubquery", () => {
    describe("hasMany", () => {
        it("produces correlated EXISTS subquery", () => {
            const def: TRelationDefinition = { type: "hasMany", model: () => CommentModel, foreignKey: "post_id" };
            const sub = buildExistsSubquery(def, PostModel as any);
            expect(sub.sql).toBe("SELECT 1 FROM comments WHERE (comments.post_id = posts.id)");
            expect(sub.bindings).toEqual([]);
        });

        it("includes additional WHERE conditions from callback", () => {
            const def: TRelationDefinition = { type: "hasMany", model: () => CommentModel, foreignKey: "post_id" };
            const sub = buildExistsSubquery(def, PostModel as any, (q) => {
                q.where("approved", "=", 1);
            });
            expect(sub.sql).toBe("SELECT 1 FROM comments WHERE (comments.post_id = posts.id) AND approved = ?");
            expect(sub.bindings).toEqual([1]);
        });

        it("uses custom localKey when specified", () => {
            const def: TRelationDefinition = { type: "hasMany", model: () => CommentModel, foreignKey: "post_uuid", localKey: "uuid" };
            const sub = buildExistsSubquery(def, PostModel as any);
            expect(sub.sql).toContain("comments.post_uuid = posts.uuid");
        });
    });

    describe("hasOne", () => {
        it("produces correlated EXISTS subquery", () => {
            const def: TRelationDefinition = { type: "hasOne", model: () => ProfileModel, foreignKey: "user_id" };
            const sub = buildExistsSubquery(def, UserModel as any);
            expect(sub.sql).toBe("SELECT 1 FROM profiles WHERE (profiles.user_id = users.id)");
            expect(sub.bindings).toEqual([]);
        });
    });

    describe("belongsTo", () => {
        it("produces correlated EXISTS subquery referencing parent FK", () => {
            const def: TRelationDefinition = { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" };
            const sub = buildExistsSubquery(def, PostModel as any);
            expect(sub.sql).toBe("SELECT 1 FROM users WHERE (users.id = posts.user_id)");
            expect(sub.bindings).toEqual([]);
        });

        it("includes additional WHERE conditions from callback", () => {
            const def: TRelationDefinition = { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" };
            const sub = buildExistsSubquery(def, PostModel as any, (q) => {
                q.where("name", "LIKE", "%admin%");
            });
            expect(sub.sql).toBe("SELECT 1 FROM users WHERE (users.id = posts.user_id) AND name LIKE ?");
            expect(sub.bindings).toEqual(["%admin%"]);
        });
    });

    describe("belongsToMany (no callback)", () => {
        it("produces simple pivot-only subquery for efficiency", () => {
            const def: TRelationDefinition = {
                type: "belongsToMany",
                model: () => RoleModel,
                pivot: "user_roles",
                foreignPivotKey: "user_id",
                relatedPivotKey: "role_id",
            };
            const sub = buildExistsSubquery(def, UserModel as any);
            expect(sub.sql).toBe("SELECT 1 FROM user_roles WHERE user_roles.user_id = users.id");
            expect(sub.bindings).toEqual([]);
        });
    });

    describe("belongsToMany (with callback)", () => {
        it("produces JOIN through related table when callback adds conditions", () => {
            const def: TRelationDefinition = {
                type: "belongsToMany",
                model: () => RoleModel,
                pivot: "user_roles",
                foreignPivotKey: "user_id",
                relatedPivotKey: "role_id",
            };
            const sub = buildExistsSubquery(def, UserModel as any, (q) => {
                q.where("name", "=", "admin");
            });
            expect(sub.sql).toContain("SELECT 1 FROM roles");
            expect(sub.sql).toContain("INNER JOIN user_roles ON user_roles.role_id = roles.id");
            expect(sub.sql).toContain("user_roles.user_id = users.id");
            expect(sub.sql).toContain("name = ?");
            expect(sub.bindings).toEqual(["admin"]);
        });
    });
});

// ── QueryBuilder has/doesntHave/whereHas/whereDoesntHave SQL tests ───

describe("QueryBuilder has/whereHas", () => {
    describe("has()", () => {
        it("produces WHERE EXISTS subquery for hasMany relation", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.has("comments");
            const { sql, bindings } = qb.toSelectSql();
            expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM comments WHERE (comments.post_id = posts.id))");
            expect(bindings).toEqual([]);
        });

        it("produces WHERE EXISTS subquery for belongsTo relation", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.has("author");
            const { sql, bindings } = qb.toSelectSql();
            expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM users WHERE (users.id = posts.user_id))");
            expect(bindings).toEqual([]);
        });

        it("produces WHERE EXISTS for belongsToMany relation", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.has("tags");
            const { sql } = qb.toSelectSql();
            expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM post_tags WHERE post_tags.post_id = posts.id)");
        });
    });

    describe("doesntHave()", () => {
        it("produces WHERE NOT EXISTS subquery", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.doesntHave("comments");
            const { sql } = qb.toSelectSql();
            expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM comments WHERE (comments.post_id = posts.id))");
        });
    });

    describe("whereHas()", () => {
        it("produces WHERE EXISTS with additional conditions", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.whereHas("comments", (q) => q.where("approved", "=", 1));
            const { sql, bindings } = qb.toSelectSql();
            expect(sql).toContain("EXISTS (SELECT 1 FROM comments WHERE (comments.post_id = posts.id) AND approved = ?)");
            expect(bindings).toEqual([1]);
        });

        it("works without callback (same as has())", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.whereHas("comments");
            const { sql } = qb.toSelectSql();
            expect(sql).toContain("EXISTS (SELECT 1 FROM comments WHERE (comments.post_id = posts.id))");
        });

        it("combines with other WHERE clauses", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.where("published", "=", 1).whereHas("comments", (q) => q.where("approved", "=", 1));
            const { sql, bindings } = qb.toSelectSql();
            expect(sql).toContain("published = ?");
            expect(sql).toContain("AND EXISTS");
            expect(bindings).toEqual([1, 1]);
        });

        it("keeps the parent correlation when the callback uses a top-level OR", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.whereHas("comments", (q) => q.where("approved", "=", 1).orWhere("flagged", "=", 1));
            const { sql, bindings } = qb.toSelectSql();
            // The OR must be grouped so it cannot decorrelate the comments.post_id = posts.id join
            expect(sql).toContain(
                "EXISTS (SELECT 1 FROM comments WHERE (comments.post_id = posts.id) AND (approved = ? OR flagged = ?))",
            );
            expect(bindings).toEqual([1, 1]);
        });
    });

    describe("whereDoesntHave()", () => {
        it("produces WHERE NOT EXISTS with additional conditions", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.whereDoesntHave("comments", (q) => q.where("approved", "=", 0));
            const { sql, bindings } = qb.toSelectSql();
            expect(sql).toContain("NOT EXISTS (SELECT 1 FROM comments WHERE (comments.post_id = posts.id) AND approved = ?)");
            expect(bindings).toEqual([0]);
        });
    });

    describe("OR variants", () => {
        it("orHas() uses OR join", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.where("published", "=", 1).orHas("comments");
            const { sql } = qb.toSelectSql();
            expect(sql).toContain("OR EXISTS");
        });

        it("orDoesntHave() uses OR join", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.where("published", "=", 1).orDoesntHave("comments");
            const { sql } = qb.toSelectSql();
            expect(sql).toContain("OR NOT EXISTS");
        });

        it("orWhereHas() uses OR join with callback", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.where("published", "=", 1).orWhereHas("comments", (q) => q.where("approved", "=", 1));
            const { sql } = qb.toSelectSql();
            expect(sql).toContain("OR EXISTS");
        });

        it("orWhereDoesntHave() uses OR join with callback", () => {
            const qb = new QueryBuilder(PostModel as any);
            qb.where("published", "=", 1).orWhereDoesntHave("comments", (q) => q.where("approved", "=", 0));
            const { sql } = qb.toSelectSql();
            expect(sql).toContain("OR NOT EXISTS");
        });
    });

    describe("error handling", () => {
        it("throws for unknown relation name", () => {
            const qb = new QueryBuilder(PostModel as any);
            expect(() => qb.has("nonexistent")).toThrow("Unknown relation 'nonexistent'");
        });

        it("throws for model without static relations", () => {
            const qb = new QueryBuilder(PlainModel as any);
            expect(() => qb.has("anything")).toThrow("Unknown relation 'anything'");
        });
    });
});

// ── whereExists/whereNotExists low-level tests ──────────────────────

describe("QueryBuilder whereExists/whereNotExists", () => {
    it("whereExists adds EXISTS clause", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.whereExists("SELECT 1 FROM comments WHERE comments.post_id = posts.id");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM comments WHERE comments.post_id = posts.id)");
    });

    it("whereNotExists adds NOT EXISTS clause", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.whereNotExists("SELECT 1 FROM comments WHERE comments.post_id = posts.id");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM comments WHERE comments.post_id = posts.id)");
    });

    it("whereExists with bindings", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.whereExists("SELECT 1 FROM comments WHERE comments.post_id = posts.id AND approved = ?", [1]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("EXISTS");
        expect(bindings).toEqual([1]);
    });
});

// ── deriveEagerLoaders() type tests ─────────────────────────────────

describe("deriveEagerLoaders", () => {
    it("produces a loader for each relation in static relations", () => {
        const loaders = deriveEagerLoaders(UserModel as any, UserModel.relations);
        expect(Object.keys(loaders)).toEqual(["posts", "profile", "roles"]);
        expect(typeof loaders.posts).toBe("function");
        expect(typeof loaders.profile).toBe("function");
        expect(typeof loaders.roles).toBe("function");
    });

    it("produces a loader for belongsTo relation", () => {
        const loaders = deriveEagerLoaders(PostModel as any, PostModel.relations);
        expect(loaders).toHaveProperty("author");
        expect(typeof loaders.author).toBe("function");
    });
});

// ── with() auto-derivation from static relations ────────────────────

describe("QueryBuilder with() auto-derivation", () => {
    it("resolves relation names from static relations when no explicit eagerLoaders", () => {
        // UserModel has static relations but no explicit eagerLoaders
        const qb = new QueryBuilder(UserModel as any);
        // Should not throw — relations should be auto-derived
        expect(() => qb.with(["posts" as any])).not.toThrow();
    });

    it("throws deferred error for truly unknown relation", () => {
        const qb = new QueryBuilder(UserModel as any);
        qb.with(["nonexistent" as any]);
        // Error is deferred to get()/first()
        expect(qb.toSelectSql()).toBeDefined(); // toSelectSql should not throw
    });
});
