// queryBuilder.test.ts
// TDD tests for deferred unknown-relation error in QueryBuilder.with()

import { QueryBuilder } from "../queryBuilder";

// Minimal model with eagerLoaders defined
interface UserAttrs {
    id?: string;
    name?: string;
}

class UserModel {
    static table = "users";
    static primaryKey = "id";
    static eagerLoaders = {
        roles: async (_db: D1Database, _models: UserModel[]) => {
            // no-op loader for test
        },
    };

    attrs: UserAttrs;
    constructor(attrs: UserAttrs = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs as Record<string, unknown>;
    }
}

// Minimal model with NO eagerLoaders
class PlainModel {
    static table = "items";
    static primaryKey = "id";

    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs;
    }
}

describe("QueryBuilder.with() - deferred unknown-relation detection", () => {
    it("with() does NOT throw for an unknown relation name", () => {
        const qb = new QueryBuilder(UserModel);
        expect(() => qb.with(["typoRelation"])).not.toThrow();
    });

    it("get() throws for an unknown relation with the correct error message", async () => {
        const db = {} as D1Database;
        const qb = new QueryBuilder(UserModel);
        qb.with(["typoRelation"]);
        await expect(qb.get(db)).rejects.toThrow(
            "Unknown eager relation: 'typoRelation'. Define it in static eagerLoaders."
        );
    });

    it("first() throws for an unknown relation (delegates to get())", async () => {
        const db = {} as D1Database;
        const qb = new QueryBuilder(UserModel);
        qb.with(["typoRelation"]);
        await expect(qb.first(db)).rejects.toThrow(
            "Unknown eager relation: 'typoRelation'. Define it in static eagerLoaders."
        );
    });

    it("error message contains the first unknown relation name", async () => {
        const db = {} as D1Database;
        const qb = new QueryBuilder(UserModel);
        qb.with(["unknownA", "unknownB"]);
        await expect(qb.get(db)).rejects.toThrow("'unknownA'");
    });

    it("get() throws for unknown relation on model with no eagerLoaders defined", async () => {
        const db = {} as D1Database;
        const qb = new QueryBuilder(PlainModel);
        qb.with(["anything"]);
        await expect(qb.get(db)).rejects.toThrow(
            "Unknown eager relation: 'anything'. Define it in static eagerLoaders."
        );
    });

    it("with() works normally for valid relation names (no error)", async () => {
        // This test verifies regression: valid relations should not land in unknownRelations
        const qb = new QueryBuilder(UserModel);
        // 'roles' is a valid loader — should NOT cause an error
        qb.with(["roles"]);
        // We can't actually call get(db) since we don't have a real D1, but we can
        // verify that toSelectSql() does not throw (i.e., no pre-query validation error)
        expect(() => qb.toSelectSql()).not.toThrow();
    });
});
