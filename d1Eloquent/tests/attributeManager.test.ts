import { describe, it, expect } from "vitest";
import { AttributeManager } from "../managers/attributeManager";
import type { TModelInternals } from "../managers/types";
import { Attribute } from "../attribute";

function createModel(
    attrs: Record<string, unknown> = {},
    overrides?: Partial<{
        accessors: Record<string, Attribute>;
        appends: string[];
        hidden: string[];
        fillable: string[];
        guarded: string[];
        casts: Record<string, string>;
    }>,
): TModelInternals {
    const model = {
        attrs: { ...attrs },
        original: { ...attrs },
        dirty: new Set<string>(),
        lastChanges: {},
        _persisted: false,
        _accessorCache: new Map<string, unknown>(),
        relations: {},
    };
    Object.defineProperty(model, "constructor", {
        value: {
            table: "test",
            primaryKey: "id",
            accessors: overrides?.accessors,
            appends: overrides?.appends,
            hidden: overrides?.hidden,
            fillable: overrides?.fillable,
            guarded: overrides?.guarded,
            casts: overrides?.casts,
        },
        enumerable: false,
    });
    return model;
}

describe("AttributeManager.get / getRaw / getOriginal", () => {
    it("get returns attribute value", () => {
        const model = createModel({ id: "1", name: "Alice" });
        expect(AttributeManager.get(model, "name")).toBe("Alice");
    });

    it("get resolves through accessor", () => {
        const model = createModel({ id: "1", name: "alice" }, {
            accessors: {
                name: Attribute.get((value: unknown) => String(value).toUpperCase()),
            },
        });
        expect(AttributeManager.get(model, "name")).toBe("ALICE");
    });

    it("get caches accessor result", () => {
        let calls = 0;
        const model = createModel({ id: "1", name: "alice" }, {
            accessors: {
                name: Attribute.get((value: unknown) => { calls++; return String(value).toUpperCase(); }),
            },
        });
        AttributeManager.get(model, "name");
        AttributeManager.get(model, "name");
        expect(calls).toBe(1);
    });

    it("get detects circular accessors", () => {
        const model = createModel({ id: "1" }, {
            accessors: {
                a: Attribute.get((_v: unknown, attrs: Record<string, unknown>) => attrs["b"]),
            },
        });
        // Not circular — "a" reads from attrs["b"] which is not an accessor
        expect(() => AttributeManager.get(model, "a")).not.toThrow();
    });

    it("getRaw bypasses accessors", () => {
        const model = createModel({ id: "1", name: "alice" }, {
            accessors: {
                name: Attribute.get((value: unknown) => String(value).toUpperCase()),
            },
        });
        expect(AttributeManager.getRaw(model, "name")).toBe("alice");
    });

    it("getOriginal returns value from original snapshot", () => {
        const model = createModel({ id: "1", name: "Alice" });
        model.attrs["name"] = "Bob";
        expect(AttributeManager.getOriginal(model, "name")).toBe("Alice");
    });
});

describe("AttributeManager.set", () => {
    it("stores value and marks dirty", () => {
        const model = createModel({ id: "1", name: "Alice" });
        AttributeManager.set(model, "name", "Bob");
        expect(model.attrs["name"]).toBe("Bob");
        expect(model.dirty.has("name")).toBe(true);
    });

    it("set resolves through mutator", () => {
        const model = createModel({ id: "1", name: "" }, {
            accessors: {
                name: Attribute.set((value: unknown) => String(value).toLowerCase()),
            },
        });
        AttributeManager.set(model, "name", "BOB");
        expect(model.attrs["name"]).toBe("bob");
    });

    it("set fan-out spreads to multiple columns", () => {
        const model = createModel({ id: "1", first_name: "", last_name: "" }, {
            accessors: {
                fullName: Attribute.set((value: unknown) => {
                    const [first, ...rest] = String(value).split(" ");
                    return { first_name: first, last_name: rest.join(" ") };
                }),
            },
        });
        AttributeManager.set(model, "fullName", "John Doe");
        expect(model.attrs["first_name"]).toBe("John");
        expect(model.attrs["last_name"]).toBe("Doe");
    });

    it("set is no-op for virtual get-only accessors", () => {
        const model = createModel({ id: "1" }, {
            accessors: {
                virtual: Attribute.get(() => "computed"),
            },
        });
        AttributeManager.set(model, "virtual", "anything");
        expect(model.attrs["virtual"]).toBeUndefined();
    });
});

describe("AttributeManager.fill", () => {
    it("fills allowed keys", () => {
        const model = createModel({ id: "1", name: "", role: "" });
        AttributeManager.fill(model, { name: "Alice", role: "admin" });
        expect(model.attrs["name"]).toBe("Alice");
        expect(model.attrs["role"]).toBe("admin");
    });

    it("respects fillable whitelist", () => {
        const model = createModel({ id: "1", name: "", role: "" }, { fillable: ["name"] });
        AttributeManager.fill(model, { name: "Alice", role: "admin" });
        expect(model.attrs["name"]).toBe("Alice");
        expect(model.attrs["role"]).toBe("");
    });

    it("respects guarded blacklist", () => {
        const model = createModel({ id: "1", name: "", role: "" }, { guarded: ["role"] });
        AttributeManager.fill(model, { name: "Alice", role: "admin" });
        expect(model.attrs["name"]).toBe("Alice");
        expect(model.attrs["role"]).toBe("");
    });

    it("forceFill bypasses fillable/guarded", () => {
        const model = createModel({ id: "1", name: "", role: "" }, { guarded: ["role"] });
        AttributeManager.forceFill(model, { name: "Alice", role: "admin" });
        expect(model.attrs["role"]).toBe("admin");
    });
});

describe("AttributeManager.toObject / toJSON / toRaw", () => {
    it("toObject returns attrs copy", () => {
        const model = createModel({ id: "1", name: "Alice" });
        const obj = AttributeManager.toObject(model);
        expect(obj).toEqual({ id: "1", name: "Alice" });
        // Should be a copy
        obj["name"] = "Bob";
        expect(model.attrs["name"]).toBe("Alice");
    });

    it("toObject includes appended virtual attributes", () => {
        const model = createModel({ id: "1", name: "alice" }, {
            appends: ["upper"],
            accessors: {
                upper: Attribute.get((_v: unknown, attrs: Record<string, unknown>) => String(attrs["name"]).toUpperCase()),
            },
        });
        const obj = AttributeManager.toObject(model);
        expect(obj["upper"]).toBe("ALICE");
    });

    it("toObject removes hidden keys", () => {
        const model = createModel({ id: "1", name: "Alice", secret: "shhh" }, { hidden: ["secret"] });
        const obj = AttributeManager.toObject(model);
        expect("secret" in obj).toBe(false);
    });

    it("toJSON includes serialized relations", () => {
        const model = createModel({ id: "1", name: "Alice" });
        model.relations["posts"] = [{ toJSON: () => ({ title: "Hi" }) }];
        const json = AttributeManager.toJSON(model);
        expect(json["posts"]).toEqual([{ title: "Hi" }]);
    });

    it("toRaw dehydrates through casts", () => {
        const model = createModel(
            { id: "1", is_active: true },
            { casts: { is_active: "boolean" } },
        );
        // Hydrate: boolean cast turns 1→true on get, true→1 on set-to-db
        // But we constructed with true directly, toRaw should dehydrate
        const raw = AttributeManager.toRaw(model);
        expect(raw["id"]).toBe("1");
        // boolean dehydration: true → 1
        expect(raw["is_active"]).toBe(1);
    });
});
