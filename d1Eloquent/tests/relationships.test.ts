// relationships.test.ts
// Tests for all relationship helpers: belongsTo, hasMany, hasOne, belongsToMany, belongsToManyFetch

import { hasOne, hasMany, belongsTo, belongsToMany, belongsToManyFetch } from "../relationships";
import { QueryBuilder } from "../queryBuilder";

// Minimal model constructor for testing
interface ChildAttrs {
    id?: string;
    user_id?: string;
    name?: string;
}

class ChildModel {
    static table = "children";
    static primaryKey = "id";
    attrs: ChildAttrs;
    constructor(attrs: ChildAttrs = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs as Record<string, unknown>;
    }
}

interface RoleAttrs {
    id?: string;
    name?: string;
}

class RoleModel {
    static table = "roles";
    static primaryKey = "id";
    attrs: RoleAttrs;
    constructor(attrs: RoleAttrs = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs as Record<string, unknown>;
    }
}

interface ParentAttrs {
    id?: string;
    name?: string;
}

class ParentModel {
    static table = "parents";
    static primaryKey = "id";
    attrs: ParentAttrs;
    constructor(attrs: ParentAttrs = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs as Record<string, unknown>;
    }
}

describe("belongsTo", () => {
    it("returns an object with query, get, and first", () => {
        const rel = belongsTo(ParentModel, { foreignKey: "parent_id", localValue: "p1" });
        expect(rel).toHaveProperty("query");
        expect(rel).toHaveProperty("get");
        expect(rel).toHaveProperty("first");
    });

    it("generates WHERE ownerKey = localValue SQL (defaults to primaryKey)", () => {
        const rel = belongsTo(ParentModel, { foreignKey: "parent_id", localValue: "p1" });
        const { sql, bindings } = (rel.query as any).toSelectSql();
        expect(sql).toContain("FROM parents");
        expect(sql).toContain("id = ?");
        expect(bindings).toContain("p1");
    });

    it("uses custom ownerKey when provided", () => {
        const rel = belongsTo(ParentModel, {
            foreignKey: "parent_id",
            ownerKey: "uuid",
            localValue: "abc",
        });
        const { sql, bindings } = (rel.query as any).toSelectSql();
        expect(sql).toContain("uuid = ?");
        expect(bindings).toContain("abc");
    });
});

describe("hasMany", () => {
    it("returns an object with query, get, and first", () => {
        const rel = hasMany(ChildModel, { foreignKey: "user_id", localValue: "u1" });
        expect(rel).toHaveProperty("query");
        expect(rel).toHaveProperty("get");
        expect(rel).toHaveProperty("first");
    });

    it("generates WHERE foreignKey = localValue SQL", () => {
        const rel = hasMany(ChildModel, { foreignKey: "user_id", localValue: "u1" });
        const { sql, bindings } = (rel.query as any).toSelectSql();
        expect(sql).toContain("FROM children");
        expect(sql).toContain("user_id = ?");
        expect(bindings).toContain("u1");
    });
});

describe("hasOne", () => {
    it("returns an object with query, get, and first", () => {
        const rel = hasOne(ChildModel, { foreignKey: "user_id", localValue: "123" });
        expect(rel).toHaveProperty("query");
        expect(rel).toHaveProperty("get");
        expect(rel).toHaveProperty("first");
        expect(typeof rel.get).toBe("function");
        expect(typeof rel.first).toBe("function");
    });

    it("query is a QueryBuilder instance", () => {
        const rel = hasOne(ChildModel, { foreignKey: "user_id", localValue: "123" });
        expect(rel.query).toBeInstanceOf(QueryBuilder);
    });

    it("generates WHERE foreignKey = localValue SQL", () => {
        const rel = hasOne(ChildModel, { foreignKey: "user_id", localValue: "123" });
        const { sql, bindings } = (rel.query as any).toSelectSql();
        expect(sql).toContain("WHERE");
        expect(sql).toContain("user_id");
        expect(bindings).toContain("123");
    });

    it("queries the correct table", () => {
        const rel = hasOne(ChildModel, { foreignKey: "user_id", localValue: "abc" });
        const { sql } = (rel.query as any).toSelectSql();
        expect(sql).toContain("children");
    });
});

describe("belongsToMany", () => {
    it("returns an object with query, get, and first", () => {
        const rel = belongsToMany(RoleModel, {
            pivot: "user_roles",
            foreignKey: "user_id",
            relatedKey: "role_id",
            localValue: "123",
        });
        expect(rel).toHaveProperty("query");
        expect(rel).toHaveProperty("get");
        expect(rel).toHaveProperty("first");
        expect(typeof rel.get).toBe("function");
        expect(typeof rel.first).toBe("function");
    });

    it("query is a QueryBuilder instance", () => {
        const rel = belongsToMany(RoleModel, {
            pivot: "user_roles",
            foreignKey: "user_id",
            relatedKey: "role_id",
            localValue: "123",
        });
        expect(rel.query).toBeInstanceOf(QueryBuilder);
    });

    it("selects only related table columns (roles.*)", () => {
        const rel = belongsToMany(RoleModel, {
            pivot: "user_roles",
            foreignKey: "user_id",
            relatedKey: "role_id",
            localValue: "abc",
        });
        const { sql } = (rel.query as any).toSelectSql();
        expect(sql).toContain("roles.*");
    });

    it("emits JOIN on the pivot table with qualified ON clause", () => {
        const rel = belongsToMany(RoleModel, {
            pivot: "user_roles",
            foreignKey: "user_id",
            relatedKey: "role_id",
            localValue: "abc",
        });
        const { sql } = (rel.query as any).toSelectSql();
        expect(sql).toContain("INNER JOIN user_roles");
        expect(sql).toContain("user_roles.role_id = roles.id");
    });

    it("uses qualified foreignKey in WHERE clause", () => {
        const rel = belongsToMany(RoleModel, {
            pivot: "user_roles",
            foreignKey: "user_id",
            relatedKey: "role_id",
            localValue: "abc",
        });
        const { sql, bindings } = (rel.query as any).toSelectSql();
        expect(sql).toContain("user_roles.user_id");
        expect(bindings).toContain("abc");
    });

    it("generates correct full SQL for roles example", () => {
        const rel = belongsToMany(RoleModel, {
            pivot: "user_roles",
            foreignKey: "user_id",
            relatedKey: "role_id",
            localValue: "abc",
        });
        const { sql, bindings } = (rel.query as any).toSelectSql();
        // Expected: SELECT roles.* FROM roles INNER JOIN user_roles ON user_roles.role_id = roles.id WHERE user_roles.user_id = ?
        expect(sql).toMatch(/SELECT roles\.\* FROM roles INNER JOIN user_roles ON user_roles\.role_id = roles\.id WHERE user_roles\.user_id = \?/i);
        expect(bindings).toEqual(["abc"]);
    });
});
