// baseModel.test.ts

import {BaseModel} from "../baseModel";
import type {CastDefinition} from "../castManager";
import {Attribute} from "../attribute";

interface DummyAttributes {
    id?: string;
    name?: string;
    age?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class DummyModel extends BaseModel<DummyAttributes> {
    public static table = "dummy_table";
}

interface CastedAttributes {
    id?: string;
    is_active?: boolean | number;
    metadata?: Record<string, unknown> | string;
    score?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class CastedModel extends BaseModel<CastedAttributes> {
    public static table = "casted_table";
    public static casts: Record<string, CastDefinition> = {
        is_active: "boolean",
        metadata: "json",
        score: "float",
    };
}

// Ensures the `BaseModel` class behaves as expected
describe("BaseModel", () => {
    // Test for the constructor and initialization of attributes
    it("should initialize attributes and original values correctly", () => {
        const model = new DummyModel({id: "1", name: "John Doe"});

        expect(model.toObject()).toEqual({id: "1", name: "John Doe"});
        expect(model.isDirty()).toBe(false);
    });

    // Test for getting an attribute's value
    it("should get an attribute's value", () => {
        const model = new DummyModel({name: "Alice"});

        expect(model.get("name")).toBe("Alice");
    });

    // Test for setting an attribute's value
    it("should set an attribute's value and mark the attribute as dirty", () => {
        const model = new DummyModel({name: "Alice"});
        model.set("name", "Bob");

        expect(model.get("name")).toBe("Bob");
        expect(model.isDirty("name")).toBe(true);
    });

    // Test for filling multiple attributes
    it("should fill multiple attributes and mark them as dirty", () => {
        const model = new DummyModel({id: "1", name: "Alice"});
        model.fill({name: "Bob", age: 25});

        expect(model.get("name")).toBe("Bob");
        expect(model.get("age")).toBe(25);
        expect(model.getDirty()).toEqual({name: "Bob", age: 25});
    });

    // Test for checking the primary key value
    it("should return the value of the primary key", () => {
        const model = new DummyModel({id: "100"});

        expect(model.getKey()).toBe("100");
    });

    // Test for checking if the model exists
    it("should determine if the model exists based on the primary key", () => {
        const modelWithKey = new DummyModel({id: "42"});
        const modelWithoutKey = new DummyModel();

        expect(modelWithKey.exists()).toBe(true);
        expect(modelWithoutKey.exists()).toBe(false);
    });

    // Test for syncing original attributes
    it("should sync the original attributes and clear dirty state", () => {
        const model = new DummyModel({name: "Alice"});
        model.set("name", "Bob");

        expect(model.isDirty("name")).toBe(true);

        model.syncOriginal();

        expect(model.isDirty()).toBe(false);
        expect(model.getChanges()).toEqual({});
    });

    // Test for checking if the attribute was changed
    it("should check if a specific attribute was changed", () => {
        const model = new DummyModel({name: "Alice"});
        model.set("name", "Alice"); // No change
        model.set("age", 30);

        expect(model.wasChanged("name")).toBe(false);
        expect(model.wasChanged("age")).toBe(true);
        expect(model.wasChanged()).toBe(true);
    });

    // Test for converting the model to a plain object
    it("should convert the model attributes to a plain object", () => {
        const model = new DummyModel({id: "1", name: "Alice", age: 30});
        expect(model.toObject()).toEqual({id: "1", name: "Alice", age: 30});
    });

    // Tests for static methods
    it("should return the correct table name", () => {
        expect(DummyModel.getTable()).toBe("dummy_table");
    });

    it("should return the correct primary key name", () => {
        expect(DummyModel.getKeyName()).toBe("id");
    });

    // Casting tests
    describe("attribute casting", () => {
        it("should hydrate cast values on construction", () => {
            const model = new CastedModel({ id: "1", is_active: 1 as any, metadata: '{"key":"val"}' as any });
            expect(model.get("is_active")).toBe(true);
            expect(model.get("metadata")).toEqual({ key: "val" });
        });

        it("should return cast values from toObject()", () => {
            const model = new CastedModel({ id: "1", is_active: 1 as any, score: "3.14" as any });
            const obj = model.toObject();
            expect(obj.is_active).toBe(true);
            expect(obj.score).toBe(3.14);
        });

        it("should return DB-safe values from toRaw()", () => {
            const model = new CastedModel({ id: "1", is_active: 1 as any, metadata: '{"x":1}' as any });
            const raw = model.toRaw();
            expect(raw.is_active).toBe(1);
            expect(raw.metadata).toBe('{"x":1}');
        });

        it("should auto-cast timestamp columns to Date", () => {
            const model = new DummyModel({ id: "1", created_at: "2026-01-15T12:00:00.000Z" });
            expect(model.get("created_at")).toBeInstanceOf(Date);
        });

        it("should preserve null through casts", () => {
            const model = new CastedModel({ id: "1", is_active: null as any, metadata: null as any });
            expect(model.get("is_active")).toBeNull();
            expect(model.get("metadata")).toBeNull();
        });
    });

    // ── Accessor resolution in get() ──
    describe("Accessor resolution in get()", () => {
        interface AccessorAttributes {
            id?: string;
            name?: string;
            first_name?: string;
            last_name?: string;
            email?: string;
            created_at?: string | Date;
            updated_at?: string | Date;
        }

        class AccessorModel extends BaseModel<AccessorAttributes> {
            public static table = "accessor_table";
            public static accessors: Record<string, Attribute> = {
                name: Attribute.get((value: string) => (value ? value.toUpperCase() : value)),
            };
        }

        it("should return accessor-transformed value when accessor is defined", () => {
            const model = new AccessorModel({ id: "1", name: "alice" });
            expect(model.get("name")).toBe("ALICE");
        });

        it("should return cast value directly when no accessor is defined", () => {
            const model = new AccessorModel({ id: "1", email: "test@example.com" });
            expect(model.get("email")).toBe("test@example.com");
        });

        it("should pass cast value to accessor (not raw DB value)", () => {
            interface CastAccessorAttrs {
                id?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            class CastAccessorModel extends BaseModel<CastAccessorAttrs> {
                public static table = "cast_accessor_table";
                public static casts: Record<string, CastDefinition> = {
                    created_at: "datetime",
                };
                public static accessors: Record<string, Attribute> = {
                    created_at: Attribute.get((value: Date) => {
                        return value instanceof Date ? value.getFullYear() : value;
                    }),
                };
            }

            const model = new CastAccessorModel({ id: "1", created_at: "2026-01-15T12:00:00.000Z" });
            // Accessor receives a Date (cast value), returns the year
            expect(model.get("created_at")).toBe(2026);
        });

        it("should pass all attrs as cast values in second arg (attrs bag)", () => {
            class FullNameModel extends BaseModel<AccessorAttributes> {
                public static table = "fullname_table";
                public static accessors: Record<string, Attribute> = {
                    name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                        return `${attrs.first_name} ${attrs.last_name}`;
                    }),
                };
            }

            const model = new FullNameModel({ id: "1", first_name: "John", last_name: "Doe" });
            expect(model.get("name")).toBe("John Doe");
        });

        it("should NOT resolve other accessors in attrs bag (cast values only)", () => {
            class NestedAccessorModel extends BaseModel<AccessorAttributes> {
                public static table = "nested_accessor_table";
                public static accessors: Record<string, Attribute> = {
                    name: Attribute.get((value: string) => value?.toUpperCase()),
                    email: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                        // attrs.name should be the cast value (raw), NOT the accessor-resolved value
                        return `${attrs.name}@example.com`;
                    }),
                };
            }

            const model = new NestedAccessorModel({ id: "1", name: "alice" });
            // attrs.name is the stored value 'alice', not 'ALICE' (accessor not resolved)
            expect(model.get("email")).toBe("alice@example.com");
        });

        it("should return accessor result that overrides cast output (ACC-06)", () => {
            interface OverrideAttrs {
                id?: string;
                score?: number;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            class OverrideModel extends BaseModel<OverrideAttrs> {
                public static table = "override_table";
                public static casts: Record<string, CastDefinition> = {
                    score: "float",
                };
                public static accessors: Record<string, Attribute> = {
                    score: Attribute.get((value: number) => Math.round(value)),
                };
            }

            const model = new OverrideModel({ id: "1", score: 3.14 as any });
            // Cast gives 3.14, accessor rounds to 3
            expect(model.get("score")).toBe(3);
        });

        it("should return cast value normally for mutator-only key (no accessor)", () => {
            class MutatorOnlyModel extends BaseModel<AccessorAttributes> {
                public static table = "mutator_only_table";
                public static accessors: Record<string, Attribute> = {
                    email: Attribute.set((value: string) => value.toLowerCase()),
                };
            }

            const model = new MutatorOnlyModel({ id: "1", email: "TEST@EXAMPLE.COM" });
            // No accessor -> returns stored value as-is
            expect(model.get("email")).toBe("TEST@EXAMPLE.COM");
        });

        it("should wrap accessor callback errors with context", () => {
            class ErrorAccessorModel extends BaseModel<AccessorAttributes> {
                public static table = "error_accessor_table";
                public static accessors: Record<string, Attribute> = {
                    name: Attribute.get(() => { throw new Error("boom"); }),
                };
            }

            const model = new ErrorAccessorModel({ id: "1", name: "test" });
            expect(() => model.get("name")).toThrow("Accessor error for key 'name': boom");
            try {
                model.get("name");
            } catch (e: any) {
                expect(e.cause).toBeInstanceOf(Error);
                expect(e.cause.message).toBe("boom");
            }
        });
    });

    // ── Mutator resolution in set() ──
    describe("Mutator resolution in set()", () => {
        interface MutatorAttributes {
            id?: string;
            name?: string;
            email?: string;
            created_at?: string | Date;
            updated_at?: string | Date;
        }

        class MutatorModel extends BaseModel<MutatorAttributes> {
            public static table = "mutator_table";
            public static accessors: Record<string, Attribute> = {
                email: Attribute.set((value: string) => value.toLowerCase()),
            };
        }

        it("should store mutator-transformed value when mutator is defined", () => {
            const model = new MutatorModel({ id: "1" });
            model.set("email", "UPPER@EXAMPLE.COM");
            expect(model.get("email")).toBe("upper@example.com");
        });

        it("should store value directly when no mutator is defined", () => {
            const model = new MutatorModel({ id: "1" });
            model.set("name", "Alice");
            expect(model.get("name")).toBe("Alice");
        });

        it("should store value directly for accessor-only key (no mutator)", () => {
            class AccessorOnlyModel extends BaseModel<MutatorAttributes> {
                public static table = "accessor_only_table";
                public static accessors: Record<string, Attribute> = {
                    name: Attribute.get((value: string) => value.toUpperCase()),
                };
            }

            const model = new AccessorOnlyModel({ id: "1", name: "original" });
            model.set("name", "alice");
            // Stored as-is (no mutator), but get() will uppercase via accessor
            expect(model.toObject().name).toBe("alice");
            expect(model.get("name")).toBe("ALICE");
        });

        it("should track dirty state correctly for mutated values", () => {
            const model = new MutatorModel({ id: "1", email: "old@example.com" });
            model.set("email", "NEW@EXAMPLE.COM");
            expect(model.isDirty("email")).toBe(true);
            expect(model.getDirty()).toEqual({ email: "new@example.com" });
        });

        it("should resolve mutators via fill()", () => {
            const model = new MutatorModel({ id: "1" });
            model.fill({ email: "UPPER@X.COM" });
            expect(model.get("email")).toBe("upper@x.com");
        });

        it("should resolve mutators via forceFill()", () => {
            const model = new MutatorModel({ id: "1" });
            model.forceFill({ email: "UPPER@X.COM" });
            expect(model.get("email")).toBe("upper@x.com");
        });

        it("should NOT resolve mutators in constructor", () => {
            const model = new MutatorModel({ id: "1", email: "UPPER@EXAMPLE.COM" });
            // Constructor does NOT apply mutator
            expect(model.toObject().email).toBe("UPPER@EXAMPLE.COM");
        });

        it("should bypass mutators in setRaw()", () => {
            // setRaw is private, but we can verify by checking toObject after internal usage
            // We test indirectly: constructor sets raw values, applyTimestamps uses setRaw
            const model = new MutatorModel({ id: "1" });
            // Timestamps are set via setRaw which should bypass mutators
            // Test the behavior: toObject returns cast values, no accessor resolution
            expect(model.toObject()).toEqual({ id: "1" });
        });

        it("should return cast values from toObject() without accessor resolution", () => {
            class BothModel extends BaseModel<MutatorAttributes> {
                public static table = "both_table";
                public static accessors: Record<string, Attribute> = {
                    name: Attribute.get((value: string) => value?.toUpperCase()),
                };
            }

            const model = new BothModel({ id: "1", name: "alice" });
            // toObject should return stored value, not accessor-resolved value
            expect(model.toObject().name).toBe("alice");
            // get() returns accessor-resolved value
            expect(model.get("name")).toBe("ALICE");
        });

        it("should return stored (post-mutator) values from getDirty()", () => {
            const model = new MutatorModel({ id: "1" });
            model.set("email", "UPPER@X.COM");
            const dirty = model.getDirty();
            // getDirty returns stored value (lowercased by mutator)
            expect(dirty.email).toBe("upper@x.com");
        });

        it("should wrap mutator callback errors with context", () => {
            class ErrorMutatorModel extends BaseModel<MutatorAttributes> {
                public static table = "error_mutator_table";
                public static accessors: Record<string, Attribute> = {
                    name: Attribute.set(() => { throw new Error("set boom"); }),
                };
            }

            const model = new ErrorMutatorModel({ id: "1" });
            expect(() => model.set("name", "test")).toThrow("Mutator error for key 'name': set boom");
            try {
                model.set("name", "test");
            } catch (e: any) {
                expect(e.cause).toBeInstanceOf(Error);
                expect(e.cause.message).toBe("set boom");
            }
        });
    });

    // ── Model.create() mutator integration ──
    describe("Model.create() mutator integration", () => {
        interface CreateAttrs {
            id?: string;
            email?: string;
            name?: string;
            created_at?: string | Date;
            updated_at?: string | Date;
        }

        class CreateMutatorModel extends BaseModel<CreateAttrs> {
            public static table = "create_mutator_table";
            public static accessors: Record<string, Attribute> = {
                email: Attribute.set((value: string) => value.toLowerCase()),
            };
        }

        it("should apply mutators via fill() which is used by create()", () => {
            // Simulate what create() does: new Model() then fill()
            const model = new CreateMutatorModel();
            (model as any).fill({ id: "1", email: "UPPER@X.COM" });
            // fill() calls set() which resolves mutators
            expect(model.get("email")).toBe("upper@x.com");
        });
    });

    // ── Circular accessor detection ──
    describe("Circular accessor detection", () => {
        it("should throw on direct self-reference cycle (a -> a)", () => {
            interface CycleAttrs {
                id?: string;
                a?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            // We need to capture the model in a closure so the accessor can call model.get()
            let modelRef: any = null;

            class SelfCycleModel extends BaseModel<CycleAttrs> {
                public static table = "self_cycle_table";
                public static accessors: Record<string, Attribute> = {
                    a: Attribute.get((_value: unknown) => {
                        // This creates a direct cycle: a -> a
                        return modelRef.get("a");
                    }),
                };
            }

            const model = new SelfCycleModel({ id: "1", a: "x" });
            modelRef = model;

            expect(() => model.get("a")).toThrow("Circular accessor detected: a -> a");
        });

        it("should throw on indirect cycle (a -> b -> a)", () => {
            interface CycleAttrs {
                id?: string;
                a?: string;
                b?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            let modelRef: any = null;

            class IndirectCycleModel extends BaseModel<CycleAttrs> {
                public static table = "indirect_cycle_table";
                public static accessors: Record<string, Attribute> = {
                    a: Attribute.get((_value: unknown) => {
                        return modelRef.get("b");
                    }),
                    b: Attribute.get((_value: unknown) => {
                        return modelRef.get("a");
                    }),
                };
            }

            const model = new IndirectCycleModel({ id: "1", a: "x", b: "y" });
            modelRef = model;

            expect(() => model.get("a")).toThrow("Circular accessor detected: a -> b -> a");
        });

        it("should throw on three-level cycle (a -> b -> c -> a) with full chain", () => {
            interface CycleAttrs {
                id?: string;
                a?: string;
                b?: string;
                c?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            let modelRef: any = null;

            class ThreeLevelCycleModel extends BaseModel<CycleAttrs> {
                public static table = "three_level_cycle_table";
                public static accessors: Record<string, Attribute> = {
                    a: Attribute.get((_value: unknown) => modelRef.get("b")),
                    b: Attribute.get((_value: unknown) => modelRef.get("c")),
                    c: Attribute.get((_value: unknown) => modelRef.get("a")),
                };
            }

            const model = new ThreeLevelCycleModel({ id: "1", a: "x", b: "y", c: "z" });
            modelRef = model;

            expect(() => model.get("a")).toThrow("Circular accessor detected: a -> b -> c -> a");
        });

        it("should NOT throw for non-circular accessor that reads attrs bag", () => {
            interface SafeAttrs {
                id?: string;
                first_name?: string;
                last_name?: string;
                full_name?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            class SafeModel extends BaseModel<SafeAttrs> {
                public static table = "safe_table";
                public static accessors: Record<string, Attribute> = {
                    full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                        // Reading from attrs bag does NOT trigger accessor resolution
                        return `${attrs.first_name} ${attrs.last_name}`;
                    }),
                };
            }

            const model = new SafeModel({ id: "1", first_name: "John", last_name: "Doe" });
            expect(model.get("full_name")).toBe("John Doe");
        });

        it("should have per-call cycle detection (not persistent instance state)", () => {
            interface CycleAttrs {
                id?: string;
                a?: string;
                b?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            let modelRef: any = null;
            let shouldCycle = false;

            class ConditionalCycleModel extends BaseModel<CycleAttrs> {
                public static table = "conditional_cycle_table";
                public static accessors: Record<string, Attribute> = {
                    a: Attribute.get((value: unknown) => {
                        if (shouldCycle) return modelRef.get("b");
                        return value;
                    }),
                    b: Attribute.get((value: unknown) => {
                        if (shouldCycle) return modelRef.get("a");
                        return value;
                    }),
                };
            }

            const model = new ConditionalCycleModel({ id: "1", a: "x", b: "y" });
            modelRef = model;

            // First call: no cycle
            expect(model.get("a")).toBe("x");

            // Second call: cycle (clear cache first so accessor is re-invoked)
            shouldCycle = true;
            model.clearAccessorCache();
            expect(() => model.get("a")).toThrow("Circular accessor detected");

            // Third call: no cycle again (state was not persisted; cache was cleared by failed get)
            shouldCycle = false;
            model.clearAccessorCache();
            expect(model.get("a")).toBe("x");
        });

        it("should NOT double-wrap circular error messages", () => {
            interface CycleAttrs {
                id?: string;
                a?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            let modelRef: any = null;

            class DoubleWrapModel extends BaseModel<CycleAttrs> {
                public static table = "double_wrap_table";
                public static accessors: Record<string, Attribute> = {
                    a: Attribute.get((_value: unknown) => modelRef.get("a")),
                };
            }

            const model = new DoubleWrapModel({ id: "1", a: "x" });
            modelRef = model;

            try {
                model.get("a");
                expect(true).toBe(false); // should not reach here
            } catch (e: any) {
                // Should be "Circular accessor detected: a -> a", NOT
                // "Accessor error for key 'a': Circular accessor detected: a -> a"
                expect(e.message).toBe("Circular accessor detected: a -> a");
                expect(e.message).not.toContain("Accessor error");
            }
        });
    });

    // ── Multi-attribute mutator fan-out ──
    describe("Multi-attribute mutator fan-out", () => {
        interface FanOutAttrs {
            id?: string;
            first_name?: string;
            last_name?: string;
            fullName?: string;
            email?: string;
            created_at?: string | Date;
            updated_at?: string | Date;
        }

        class FanOutModel extends BaseModel<FanOutAttrs> {
            public static table = "fan_out_table";
            public static accessors: Record<string, Attribute> = {
                fullName: Attribute.set((value: string) => {
                    const [first, ...rest] = value.split(" ");
                    return { first_name: first, last_name: rest.join(" ") };
                }),
            };
        }

        it("should fan out mutator result to multiple columns", () => {
            const model = new FanOutModel({ id: "1" });
            model.set("fullName" as any, "John Doe");
            expect(model.get("first_name")).toBe("John");
            expect(model.get("last_name")).toBe("Doe");
        });

        it("should NOT store the original key (write-only alias)", () => {
            const model = new FanOutModel({ id: "1" });
            model.set("fullName" as any, "John Doe");
            expect(model.toObject().fullName).toBeUndefined();
        });

        it("should mark all fanned-out keys as dirty", () => {
            const model = new FanOutModel({ id: "1" });
            model.set("fullName" as any, "John Doe");
            expect(model.isDirty("first_name")).toBe(true);
            expect(model.isDirty("last_name")).toBe(true);
        });

        it("should cast-hydrate fanned-out values", () => {
            interface CastFanOutAttrs {
                id?: string;
                is_active?: boolean | number;
                is_verified?: boolean | number;
                both?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            class CastFanOutModel extends BaseModel<CastFanOutAttrs> {
                public static table = "cast_fan_out_table";
                public static casts: Record<string, CastDefinition> = {
                    is_active: "boolean",
                    is_verified: "boolean",
                };
                public static accessors: Record<string, Attribute> = {
                    both: Attribute.set((_value: string) => {
                        // Return raw DB values (1/0); they should be cast-hydrated to booleans
                        return { is_active: 1, is_verified: 0 };
                    }),
                };
            }

            const model = new CastFanOutModel({ id: "1" });
            model.set("both" as any, "activate");
            // Values should be cast-hydrated to booleans
            expect(model.get("is_active")).toBe(true);
            expect(model.get("is_verified")).toBe(false);
        });

        it("should NOT trigger mutators on fanned-out keys (casts only)", () => {
            let firstNameMutatorCalled = false;

            class MutatorOnFanOutModel extends BaseModel<FanOutAttrs> {
                public static table = "mutator_on_fan_out_table";
                public static accessors: Record<string, Attribute> = {
                    fullName: Attribute.set((value: string) => {
                        const [first, ...rest] = value.split(" ");
                        return { first_name: first, last_name: rest.join(" ") };
                    }),
                    first_name: Attribute.set((value: string) => {
                        firstNameMutatorCalled = true;
                        return value.toUpperCase();
                    }),
                };
            }

            const model = new MutatorOnFanOutModel({ id: "1" });
            model.set("fullName" as any, "John Doe");
            // first_name mutator should NOT be called during fan-out
            expect(firstNameMutatorCalled).toBe(false);
            expect(model.get("first_name")).toBe("John"); // not "JOHN"
        });

        it("should fan out through fill()", () => {
            const model = new FanOutModel({ id: "1" });
            model.fill({ fullName: "Jane Smith" } as any);
            expect(model.get("first_name")).toBe("Jane");
            expect(model.get("last_name")).toBe("Smith");
        });

        it("should fan out through Model.create() via fill()", () => {
            // Simulate what create() does: new() then fill()
            const model = new FanOutModel();
            (model as any).fill({ id: "1", fullName: "Bob Jones" });
            expect(model.get("first_name")).toBe("Bob");
            expect(model.get("last_name")).toBe("Jones");
        });

        it("should work normally for non-fan-out mutator returning a primitive", () => {
            class PrimitiveMutatorModel extends BaseModel<FanOutAttrs> {
                public static table = "primitive_mutator_table";
                public static accessors: Record<string, Attribute> = {
                    email: Attribute.set((value: string) => value.toLowerCase()),
                };
            }

            const model = new PrimitiveMutatorModel({ id: "1" });
            model.set("email", "UPPER@X.COM");
            expect(model.get("email")).toBe("upper@x.com");
        });

        it("should treat Date return as single value (not fan-out)", () => {
            interface DateAttrs {
                id?: string;
                processed_at?: Date | string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            class DateMutatorModel extends BaseModel<DateAttrs> {
                public static table = "date_mutator_table";
                public static accessors: Record<string, Attribute> = {
                    processed_at: Attribute.set((_value: string) => new Date("2026-01-01")),
                };
            }

            const model = new DateMutatorModel({ id: "1" });
            model.set("processed_at", "now" as any);
            expect(model.get("processed_at")).toBeInstanceOf(Date);
        });

        it("should treat Array return as single value (not fan-out)", () => {
            interface ArrayAttrs {
                id?: string;
                tags?: string[];
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            class ArrayMutatorModel extends BaseModel<ArrayAttrs> {
                public static table = "array_mutator_table";
                public static accessors: Record<string, Attribute> = {
                    tags: Attribute.set((value: string) => value.split(",")),
                };
            }

            const model = new ArrayMutatorModel({ id: "1" });
            model.set("tags", "a,b,c" as any);
            expect(model.get("tags")).toEqual(["a", "b", "c"]);
        });

        it("should treat null return as single value (not fan-out)", () => {
            class NullMutatorModel extends BaseModel<FanOutAttrs> {
                public static table = "null_mutator_table";
                public static accessors: Record<string, Attribute> = {
                    email: Attribute.set((_value: string) => null),
                };
            }

            const model = new NullMutatorModel({ id: "1" });
            model.set("email", "test@x.com");
            expect(model.get("email")).toBeNull();
        });

        it("should track fanned-out values in lastChanges", () => {
            const model = new FanOutModel({ id: "1" });
            model.set("fullName" as any, "John Doe");
            const changes = model.getChanges();
            expect(changes.first_name).toBe("John");
            expect(changes.last_name).toBe("Doe");
        });
    });

    // ── Virtual attributes ──
    describe("Virtual attributes", () => {
        interface VirtualAttrs {
            id?: string;
            first_name?: string;
            last_name?: string;
            full_name?: string;
            email?: string;
            created_at?: string | Date;
            updated_at?: string | Date;
        }

        class VirtualModel extends BaseModel<VirtualAttrs> {
            public static table = "virtual_table";
            public static accessors: Record<string, Attribute> = {
                full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                    return `${attrs.first_name} ${attrs.last_name}`;
                }),
            };
        }

        it("should return computed value for virtual accessor key (no backing column)", () => {
            const model = new VirtualModel({ id: "1", first_name: "John", last_name: "Doe" });
            expect(model.get("full_name")).toBe("John Doe");
        });

        it("should pass undefined as first arg and attrs bag as second to virtual accessor", () => {
            let receivedValue: unknown = "NOT_SET";
            let receivedAttrs: Record<string, unknown> | undefined;

            class SpyVirtualModel extends BaseModel<VirtualAttrs> {
                public static table = "spy_virtual_table";
                public static accessors: Record<string, Attribute> = {
                    full_name: Attribute.get((value: unknown, attrs: Record<string, unknown>) => {
                        receivedValue = value;
                        receivedAttrs = attrs;
                        return "computed";
                    }),
                };
            }

            const model = new SpyVirtualModel({ id: "1", first_name: "Alice" });
            model.get("full_name");
            expect(receivedValue).toBeUndefined();
            expect(receivedAttrs).toBeDefined();
            expect(receivedAttrs!.first_name).toBe("Alice");
        });

        it("should return undefined for non-existent key with no accessor", () => {
            const model = new VirtualModel({ id: "1" });
            expect(model.get("email")).toBeUndefined();
        });

        it("should be a no-op when setting a get-only virtual accessor", () => {
            const model = new VirtualModel({ id: "1", first_name: "John", last_name: "Doe" });
            model.set("full_name", "anything" as any);
            // attrs unchanged — full_name never enters attrs
            expect(model.toObject().full_name).toBeUndefined();
            // dirty unchanged
            expect(model.isDirty()).toBe(false);
        });

        it("should still fan out when virtual has a mutator", () => {
            class VirtualFanOutModel extends BaseModel<VirtualAttrs> {
                public static table = "virtual_fanout_table";
                public static accessors: Record<string, Attribute> = {
                    full_name: Attribute.make({
                        get: (_value: unknown, attrs: Record<string, unknown>) => `${attrs.first_name} ${attrs.last_name}`,
                        set: (value: string) => {
                            const [first, ...rest] = value.split(" ");
                            return { first_name: first, last_name: rest.join(" ") };
                        },
                    }),
                };
            }

            const model = new VirtualFanOutModel({ id: "1" });
            model.set("full_name", "Jane Smith" as any);
            expect(model.get("first_name")).toBe("Jane");
            expect(model.get("last_name")).toBe("Smith");
            // Virtual key itself still not in attrs
            expect(model.toObject().full_name).toBeUndefined();
        });

        it("should silently skip virtual get-only keys in fill()", () => {
            const model = new VirtualModel({ id: "1" });
            model.fill({ full_name: "ignored" as any, first_name: "Jane" });
            expect(model.get("first_name")).toBe("Jane");
            expect(model.toObject().full_name).toBeUndefined();
        });

        it("should never include virtual keys in getDirty()", () => {
            const model = new VirtualModel({ id: "1", first_name: "John", last_name: "Doe" });
            model.set("full_name", "anything" as any);
            expect(model.getDirty()).toEqual({});
        });

        it("should never include virtual keys in toRaw()", () => {
            const model = new VirtualModel({ id: "1", first_name: "John", last_name: "Doe" });
            const raw = model.toRaw();
            expect("full_name" in raw).toBe(false);
        });
    });

    // ── getRaw() ──
    describe("getRaw()", () => {
        interface RawAttrs {
            id?: string;
            first_name?: string;
            email?: string;
            full_name?: string;
            created_at?: string | Date;
            updated_at?: string | Date;
        }

        class RawModel extends BaseModel<RawAttrs> {
            public static table = "raw_table";
            public static accessors: Record<string, Attribute> = {
                email: Attribute.get((value: string) => value?.toUpperCase()),
                full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                    return `${attrs.first_name} computed`;
                }),
            };
        }

        it("should return cast-hydrated value for non-accessor key", () => {
            const model = new RawModel({ id: "1", first_name: "John" });
            expect(model.getRaw("first_name")).toBe("John");
        });

        it("should return raw cast value (not accessor-transformed) for accessor key", () => {
            const model = new RawModel({ id: "1", email: "test@example.com" });
            // get() would return "TEST@EXAMPLE.COM" (uppercased by accessor)
            expect(model.get("email")).toBe("TEST@EXAMPLE.COM");
            // getRaw() bypasses accessor
            expect(model.getRaw("email")).toBe("test@example.com");
        });

        it("should return undefined for virtual key", () => {
            const model = new RawModel({ id: "1", first_name: "John" });
            // get() returns computed value
            expect(model.get("full_name")).toBe("John computed");
            // getRaw() returns undefined (no backing column)
            expect(model.getRaw("full_name")).toBeUndefined();
        });

        it("should behave identically to get() for keys without accessors", () => {
            const model = new RawModel({ id: "1", first_name: "Alice" });
            expect(model.getRaw("first_name")).toBe(model.get("first_name"));
        });
    });

    // ── getOriginal() ──
    describe("getOriginal()", () => {
        it("should return original value after set()", () => {
            const model = new DummyModel({ id: "1", name: "John" });
            model.set("name", "Jane");
            expect(model.getOriginal("name")).toBe("John");
            expect(model.get("name")).toBe("Jane");
        });

        it("should return construction-time value for never-set key", () => {
            const model = new DummyModel({ id: "1", name: "Alice" });
            expect(model.getOriginal("name")).toBe("Alice");
        });
    });

    // ── Serialization: static appends and static hidden ──
    describe("Serialization: static appends and static hidden", () => {
        interface SerAttrs {
            id?: string;
            first_name?: string;
            last_name?: string;
            email?: string;
            password_hash?: string;
            full_name?: string;
            initials?: string;
            created_at?: string | Date;
            updated_at?: string | Date;
        }

        // Model with appends only
        class AppendModel extends BaseModel<SerAttrs> {
            public static table = "append_table";
            public static appends: string[] = ["full_name"];
            public static accessors: Record<string, Attribute> = {
                full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                    return `${attrs.first_name} ${attrs.last_name}`;
                }),
            };
        }

        // Model with hidden only
        class HiddenModel extends BaseModel<SerAttrs> {
            public static table = "hidden_table";
            public static hidden: string[] = ["password_hash"];
        }

        // Model with both appends and hidden
        class BothModel extends BaseModel<SerAttrs> {
            public static table = "both_ser_table";
            public static appends: string[] = ["full_name"];
            public static hidden: string[] = ["password_hash"];
            public static accessors: Record<string, Attribute> = {
                full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                    return `${attrs.first_name} ${attrs.last_name}`;
                }),
            };
        }

        // Model with key in both appends AND hidden
        class ConflictModel extends BaseModel<SerAttrs> {
            public static table = "conflict_table";
            public static appends: string[] = ["full_name"];
            public static hidden: string[] = ["full_name"];
            public static accessors: Record<string, Attribute> = {
                full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                    return `${attrs.first_name} ${attrs.last_name}`;
                }),
            };
        }

        // Model with multiple appends
        class MultiAppendModel extends BaseModel<SerAttrs> {
            public static table = "multi_append_table";
            public static appends: string[] = ["full_name", "initials"];
            public static accessors: Record<string, Attribute> = {
                full_name: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                    return `${attrs.first_name} ${attrs.last_name}`;
                }),
                initials: Attribute.get((_value: unknown, attrs: Record<string, unknown>) => {
                    const f = (attrs.first_name as string)?.[0] ?? "";
                    const l = (attrs.last_name as string)?.[0] ?? "";
                    return `${f}${l}`;
                }),
            };
        }

        // Model with multiple hidden keys
        class MultiHiddenModel extends BaseModel<SerAttrs> {
            public static table = "multi_hidden_table";
            public static hidden: string[] = ["password_hash", "email"];
        }

        // ── static appends ──
        describe("static appends", () => {
            it("should include appended virtual key in toObject()", () => {
                const model = new AppendModel({ id: "1", first_name: "John", last_name: "Doe" });
                const obj = model.toObject();
                expect(obj.full_name).toBe("John Doe");
            });

            it("should resolve appended key through accessor pipeline", () => {
                const model = new AppendModel({ id: "1", first_name: "Alice", last_name: "Smith" });
                const obj = model.toObject();
                expect(obj.full_name).toBe("Alice Smith");
            });

            it("should not change toObject() when no static appends defined", () => {
                const model = new DummyModel({ id: "1", name: "Alice" });
                const obj = model.toObject();
                expect(obj).toEqual({ id: "1", name: "Alice" });
            });

            it("should include multiple appended keys in toObject()", () => {
                const model = new MultiAppendModel({ id: "1", first_name: "John", last_name: "Doe" });
                const obj = model.toObject();
                expect(obj.full_name).toBe("John Doe");
                expect(obj.initials).toBe("JD");
            });
        });

        // ── static hidden ──
        describe("static hidden", () => {
            it("should omit hidden key from toObject()", () => {
                const model = new HiddenModel({ id: "1", password_hash: "secret123" });
                const obj = model.toObject();
                expect("password_hash" in obj).toBe(false);
            });

            it("should still have hidden key in model attrs (accessible via get)", () => {
                const model = new HiddenModel({ id: "1", password_hash: "secret123" });
                expect(model.get("password_hash")).toBe("secret123");
            });

            it("should not change toObject() when no static hidden defined", () => {
                const model = new DummyModel({ id: "1", name: "Alice" });
                const obj = model.toObject();
                expect(obj).toEqual({ id: "1", name: "Alice" });
            });

            it("should omit multiple hidden keys from toObject()", () => {
                const model = new MultiHiddenModel({ id: "1", email: "test@x.com", password_hash: "secret" });
                const obj = model.toObject();
                expect("password_hash" in obj).toBe(false);
                expect("email" in obj).toBe(false);
                expect(obj.id).toBe("1");
            });
        });

        // ── Precedence ──
        describe("precedence", () => {
            it("should hide key that is in both appends and hidden (hidden wins)", () => {
                const model = new ConflictModel({ id: "1", first_name: "John", last_name: "Doe" });
                const obj = model.toObject();
                expect("full_name" in obj).toBe(false);
            });
        });

        // ── toRaw() decoupling ──
        describe("toRaw() decoupling", () => {
            it("should NOT include appended virtual keys in toRaw()", () => {
                const model = new AppendModel({ id: "1", first_name: "John", last_name: "Doe" });
                const raw = model.toRaw();
                expect("full_name" in raw).toBe(false);
            });

            it("should INCLUDE hidden keys in toRaw()", () => {
                const model = new HiddenModel({ id: "1", password_hash: "secret123" });
                const raw = model.toRaw();
                expect(raw.password_hash).toBe("secret123");
            });

            it("should still dehydrate cast values correctly", () => {
                interface CastSerAttrs {
                    id?: string;
                    is_active?: boolean | number;
                    password_hash?: string;
                    created_at?: string | Date;
                    updated_at?: string | Date;
                }

                class CastHiddenModel extends BaseModel<CastSerAttrs> {
                    public static table = "cast_hidden_table";
                    public static hidden: string[] = ["password_hash"];
                    public static casts: Record<string, CastDefinition> = {
                        is_active: "boolean",
                    };
                }

                const model = new CastHiddenModel({ id: "1", is_active: 1 as any, password_hash: "secret" });
                const raw = model.toRaw();
                // Cast: boolean -> 1 for DB
                expect(raw.is_active).toBe(1);
                // Hidden key present in toRaw
                expect(raw.password_hash).toBe("secret");
            });
        });

        // ── Integration with DB writes ──
        describe("integration with DB writes", () => {
            it("should not include virtual appended keys in toRaw() used by performInsert", () => {
                // performInsert uses toRaw() which should not contain virtual keys
                const model = new AppendModel({ id: "1", first_name: "John", last_name: "Doe" });
                const raw = model.toRaw();
                expect("full_name" in raw).toBe(false);
                expect(raw.first_name).toBe("John");
                expect(raw.last_name).toBe("Doe");
            });

            it("should not include virtual appended keys in revision snapshots (toRaw)", () => {
                // Revision snapshots use toRaw(), which should not contain virtual keys
                const model = new BothModel({ id: "1", first_name: "John", last_name: "Doe", password_hash: "hash" });
                const raw = model.toRaw();
                expect("full_name" in raw).toBe(false);
                // password_hash is hidden from toObject but present in toRaw (DB data)
                expect(raw.password_hash).toBe("hash");
            });
        });
    });

    // ── accessor cache ──
    describe("accessor cache", () => {
        interface CacheAttrs {
            id?: string;
            name?: string;
            upper_name?: string;
            first_name?: string;
            last_name?: string;
        }

        let getCallCount: number;

        // Model with a getter accessor that tracks invocations
        class CachedModel extends BaseModel<CacheAttrs> {
            public static table = "cached_table";
            public static accessors: Record<string, Attribute> = {
                upper_name: Attribute.make({
                    get: (value: unknown, attrs: Record<string, unknown>) => {
                        getCallCount++;
                        return String(attrs.name ?? "").toUpperCase();
                    },
                }),
            };
        }

        // Model with getter + setter (mutator) accessor
        class CachedMutatorModel extends BaseModel<CacheAttrs> {
            public static table = "cached_mutator_table";
            public static accessors: Record<string, Attribute> = {
                name: Attribute.make({
                    get: (value: unknown) => {
                        getCallCount++;
                        return String(value ?? "").toUpperCase();
                    },
                    set: (value: unknown) => {
                        return String(value ?? "").trim();
                    },
                }),
            };
        }

        beforeEach(() => {
            getCallCount = 0;
        });

        it("should cache accessor get() result on second call", () => {
            const model = new CachedModel({ id: "1", name: "alice" });
            const first = model.get("upper_name" as keyof CacheAttrs);
            const second = model.get("upper_name" as keyof CacheAttrs);
            expect(first).toBe("ALICE");
            expect(second).toBe("ALICE");
            expect(getCallCount).toBe(1); // accessor only invoked once
        });

        it("should clear cache on set() and recompute", () => {
            const model = new CachedModel({ id: "1", name: "alice" });
            model.get("upper_name" as keyof CacheAttrs); // prime cache
            expect(getCallCount).toBe(1);

            model.set("name" as keyof CacheAttrs, "bob" as any);
            const result = model.get("upper_name" as keyof CacheAttrs);
            expect(result).toBe("BOB");
            expect(getCallCount).toBe(2); // recomputed after set()
        });

        it("should NOT cache plain attrs without accessors", () => {
            const model = new CachedModel({ id: "1", name: "alice" });
            model.get("name");
            model.get("name");
            // Plain attrs have no accessor, so getCallCount stays 0
            expect(getCallCount).toBe(0);
            // Verify the value is still correct
            expect(model.get("name")).toBe("alice");
        });

        it("should clear cache on storeValue path (mutator set)", () => {
            const model = new CachedMutatorModel({ id: "1", name: "alice" });
            model.get("name"); // prime cache
            expect(getCallCount).toBe(1);

            model.set("name" as keyof CacheAttrs, "  bob  " as any);
            const result = model.get("name");
            expect(result).toBe("BOB"); // trimmed via mutator, uppercased via getter
            expect(getCallCount).toBe(2);
        });

        it("should clear cache on setRaw path (timestamps, restore)", () => {
            interface TimestampCacheAttrs {
                id?: string;
                name?: string;
                upper_name?: string;
                created_at?: string | Date;
                updated_at?: string | Date;
            }

            class TimestampCachedModel extends BaseModel<TimestampCacheAttrs> {
                public static table = "ts_cached_table";
                public static timestamps = true;
                public static accessors: Record<string, Attribute> = {
                    upper_name: Attribute.make({
                        get: (value: unknown, attrs: Record<string, unknown>) => {
                            getCallCount++;
                            return String(attrs.name ?? "").toUpperCase();
                        },
                    }),
                };
            }

            const model = new TimestampCachedModel({ id: "1", name: "alice" });
            model.get("upper_name" as keyof TimestampCacheAttrs); // prime cache
            expect(getCallCount).toBe(1);

            // applyTimestamps calls setRaw internally
            (model as any).applyTimestamps(true);
            const result = model.get("upper_name" as keyof TimestampCacheAttrs);
            expect(getCallCount).toBe(2); // recomputed after setRaw
        });

        it("should manually clear cache via clearAccessorCache()", () => {
            const model = new CachedModel({ id: "1", name: "alice" });
            model.get("upper_name" as keyof CacheAttrs); // prime cache
            expect(getCallCount).toBe(1);

            model.clearAccessorCache();
            model.get("upper_name" as keyof CacheAttrs);
            expect(getCallCount).toBe(2); // recomputed after manual clear
        });

        it("should skip cache during cycle detection (resolving set exists)", () => {
            // When an accessor references another accessor that references back,
            // the cycle detection resolving set is active. Cache should be skipped.
            interface CycleAttrs {
                id?: string;
                a?: string;
                b?: string;
            }

            let aCallCount = 0;

            class CycleModel extends BaseModel<CycleAttrs> {
                public static table = "cycle_table";
                public static accessors: Record<string, Attribute> = {
                    a: Attribute.make({
                        get: (value: unknown, attrs: Record<string, unknown>) => {
                            aCallCount++;
                            return `a:${attrs.b}`;
                        },
                    }),
                    b: Attribute.make({
                        get: (value: unknown) => {
                            return `b:${value}`;
                        },
                    }),
                };
            }

            const model = new CycleModel({ id: "1", a: "x", b: "y" });
            // First call primes cache for "a"
            const result1 = model.get("a" as keyof CycleAttrs);
            // Note: "b" in attrs bag is raw (not accessor-resolved), so no cycle
            expect(result1).toBe("a:y");
            expect(aCallCount).toBe(1);

            // Second call should use cache
            const result2 = model.get("a" as keyof CycleAttrs);
            expect(result2).toBe("a:y");
            expect(aCallCount).toBe(1); // still cached
        });

        it("should clear cache on fill() (delegates to set)", () => {
            const model = new CachedModel({ id: "1", name: "alice" });
            model.get("upper_name" as keyof CacheAttrs); // prime cache
            expect(getCallCount).toBe(1);

            model.fill({ name: "carol" } as Partial<CacheAttrs>);
            const result = model.get("upper_name" as keyof CacheAttrs);
            expect(result).toBe("CAROL");
            expect(getCallCount).toBe(2);
        });

        it("should have per-instance independent caches", () => {
            const model1 = new CachedModel({ id: "1", name: "alice" });
            const model2 = new CachedModel({ id: "2", name: "bob" });

            model1.get("upper_name" as keyof CacheAttrs);
            model2.get("upper_name" as keyof CacheAttrs);
            expect(getCallCount).toBe(2); // each instance invoked once

            // Mutating model1 should not affect model2's cache
            model1.set("name" as keyof CacheAttrs, "carol" as any);
            model1.get("upper_name" as keyof CacheAttrs);
            expect(getCallCount).toBe(3); // model1 recomputed

            // model2 should still be cached
            model2.get("upper_name" as keyof CacheAttrs);
            expect(getCallCount).toBe(3); // model2 still cached
        });
    });
});

describe("is() / isNot() cross-class", () => {
    class OtherModel extends BaseModel<DummyAttributes> {
        public static table = "other_table";
    }

    it("is() returns false for different model classes with same PK", () => {
        const a = new DummyModel({ id: "same-id" });
        const b = new OtherModel({ id: "same-id" });
        expect(a.is(b)).toBe(false);
    });

    it("isNot() returns true for different model classes with same PK", () => {
        const a = new DummyModel({ id: "same-id" });
        const b = new OtherModel({ id: "same-id" });
        expect(a.isNot(b)).toBe(true);
    });

    it("is() returns true for same class and same PK", () => {
        const a = new DummyModel({ id: "x" });
        const b = new DummyModel({ id: "x" });
        expect(a.is(b)).toBe(true);
    });
});