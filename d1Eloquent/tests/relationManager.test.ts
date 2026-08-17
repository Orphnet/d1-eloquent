import { describe, it, expect } from "vitest";
import { RelationManager } from "../managers/relationManager";
import type { TRelationalModel } from "../managers/relationManager";

function createModel(relations?: Record<string, any>): TRelationalModel {
    const model: TRelationalModel = {
        attrs: { id: "1", user_id: "u1" },
        relations: {},
        constructor: {
            table: "posts",
            primaryKey: "id",
            relations,
        },
    };
    return model;
}

describe("RelationManager", () => {
    describe("setRelation", () => {
        it("stores a relation value on the model", () => {
            const model = createModel();
            RelationManager.setRelation(model, "author", { name: "Alice" });
            expect(model.relations.author).toEqual({ name: "Alice" });
        });
    });

    describe("resolveRelated", () => {
        it("throws for unknown relation", () => {
            const model = createModel({});
            expect(() => RelationManager.resolveRelated(model, "nonexistent"))
                .toThrow("Unknown relation 'nonexistent' on posts");
        });

        it("throws when no relations defined", () => {
            const model = createModel(undefined);
            expect(() => RelationManager.resolveRelated(model, "author"))
                .toThrow("Unknown relation 'author' on posts");
        });
    });
});
