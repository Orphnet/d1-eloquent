import { describe, it, expect } from "vitest";
import { Attribute } from "../attribute";
import { AccessorManager } from "../accessorManager";

describe("Attribute", () => {
  describe("make() factory", () => {
    it("creates get-only accessor", () => {
      const attr = Attribute.make({
        get: (value) => String(value).toUpperCase(),
      });
      expect(attr.hasGetter()).toBe(true);
      expect(attr.hasSetter()).toBe(false);
    });

    it("creates set-only mutator", () => {
      const attr = Attribute.make({
        set: (value) => String(value).toLowerCase(),
      });
      expect(attr.hasGetter()).toBe(false);
      expect(attr.hasSetter()).toBe(true);
    });

    it("creates combined accessor+mutator", () => {
      const attr = Attribute.make({
        get: (value) => String(value).toUpperCase(),
        set: (value) => String(value).toLowerCase(),
      });
      expect(attr.hasGetter()).toBe(true);
      expect(attr.hasSetter()).toBe(true);
    });

    it("throws when neither get nor set provided", () => {
      expect(() => Attribute.make({})).toThrowError(/at least/);
    });
  });

  describe("get() shorthand", () => {
    it("creates get-only equivalent", () => {
      const fn = (value: unknown) => String(value).toUpperCase();
      const attr = Attribute.get(fn);
      expect(attr.hasGetter()).toBe(true);
      expect(attr.hasSetter()).toBe(false);
    });
  });

  describe("set() shorthand", () => {
    it("creates set-only equivalent", () => {
      const fn = (value: unknown) => String(value).toLowerCase();
      const attr = Attribute.set(fn);
      expect(attr.hasGetter()).toBe(false);
      expect(attr.hasSetter()).toBe(true);
    });
  });

  describe("introspection", () => {
    it("hasGetter/hasSetter return correct booleans for get-only", () => {
      const attr = Attribute.get((v) => v);
      expect(attr.hasGetter()).toBe(true);
      expect(attr.hasSetter()).toBe(false);
    });

    it("hasGetter/hasSetter return correct booleans for set-only", () => {
      const attr = Attribute.set((v) => v);
      expect(attr.hasGetter()).toBe(false);
      expect(attr.hasSetter()).toBe(true);
    });

    it("hasGetter/hasSetter return correct booleans for combined", () => {
      const attr = Attribute.make({ get: (v) => v, set: (v) => v });
      expect(attr.hasGetter()).toBe(true);
      expect(attr.hasSetter()).toBe(true);
    });
  });

  describe("execution", () => {
    it("applyGet invokes get callback with (value, attrs)", () => {
      const attr = Attribute.make({
        get: (value: unknown, attrs: Record<string, unknown>) => {
          return `${value}-${attrs.suffix}`;
        },
      });
      const result = attr.applyGet("hello", { suffix: "world" });
      expect(result).toBe("hello-world");
    });

    it("applySet invokes set callback with value", () => {
      const attr = Attribute.make({
        set: (value: unknown) => String(value).trim(),
      });
      const result = attr.applySet("  hello  ");
      expect(result).toBe("hello");
    });

    it("applyGet throws if no getter defined", () => {
      const attr = Attribute.set((v) => v);
      expect(() => attr.applyGet("value", {})).toThrowError(/getter/i);
    });

    it("applySet throws if no setter defined", () => {
      const attr = Attribute.get((v) => v);
      expect(() => attr.applySet("value")).toThrowError(/setter/i);
    });
  });

  describe("multi-attribute set", () => {
    it("set fn returning Record is preserved as return value", () => {
      const attr = Attribute.make({
        set: (value: unknown) => ({
          first_name: String(value).split(" ")[0],
          last_name: String(value).split(" ")[1],
        }),
      });
      const result = attr.applySet("John Doe");
      expect(result).toEqual({ first_name: "John", last_name: "Doe" });
    });
  });

  describe("immutability", () => {
    it("Attribute instances are frozen", () => {
      const attr = Attribute.get((v) => v);
      expect(Object.isFrozen(attr)).toBe(true);
    });

    it("assigning properties fails silently or throws", () => {
      const attr = Attribute.get((v) => v);
      expect(() => {
        (attr as Record<string, unknown>)["newProp"] = "value";
      }).toThrow();
    });
  });
});

describe("AccessorManager", () => {
  // Helper: create minimal class-like objects with accessors
  function createClass(
    accessors: Record<string, Attribute>,
    parent?: { prototype: object; accessors?: Record<string, Attribute> },
  ) {
    const ctor = function () {} as unknown as {
      new (): unknown;
      accessors?: Record<string, Attribute>;
      prototype: object;
    };
    if (parent) {
      ctor.prototype = Object.create(parent.prototype);
    }
    ctor.accessors = accessors;
    return ctor;
  }

  describe("resolveAccessorsFor", () => {
    it("returns accessors for single class", () => {
      const nameAttr = Attribute.get((v) => String(v).toUpperCase());
      const ctor = createClass({ name: nameAttr });

      const resolved = AccessorManager.resolveAccessorsFor(ctor);
      expect(resolved.name).toBe(nameAttr);
    });

    it("returns empty object for class with no accessors", () => {
      const ctor = createClass({});
      delete ctor.accessors;
      const resolved = AccessorManager.resolveAccessorsFor(ctor);
      expect(Object.keys(resolved)).toHaveLength(0);
    });

    it("merges parent+child with child override", () => {
      const parentAttr = Attribute.get((v) => `parent-${v}`);
      const childAttr = Attribute.get((v) => `child-${v}`);

      const Parent = createClass({ name: parentAttr });
      const Child = createClass({ name: childAttr }, Parent);

      const resolved = AccessorManager.resolveAccessorsFor(Child);
      expect(resolved.name).toBe(childAttr);
    });

    it("keeps parent-only keys", () => {
      const parentAttr = Attribute.get((v) => `parent-${v}`);
      const childAttr = Attribute.get((v) => `child-${v}`);

      const Parent = createClass({ email: parentAttr });
      const Child = createClass({ name: childAttr }, Parent);

      const resolved = AccessorManager.resolveAccessorsFor(Child);
      expect(resolved.email).toBe(parentAttr);
      expect(resolved.name).toBe(childAttr);
    });

    it("child additions are included", () => {
      const Parent = createClass({});
      const childAttr = Attribute.get((v) => v);
      const Child = createClass({ extra: childAttr }, Parent);

      const resolved = AccessorManager.resolveAccessorsFor(Child);
      expect(resolved.extra).toBe(childAttr);
    });
  });

  describe("caching", () => {
    it("second call returns same reference", () => {
      const ctor = createClass({ x: Attribute.get((v) => v) });
      AccessorManager.clearCache();

      const first = AccessorManager.resolveAccessorsFor(ctor);
      const second = AccessorManager.resolveAccessorsFor(ctor);
      expect(first).toBe(second);
    });

    it("clearCache resets cache", () => {
      const ctor = createClass({ x: Attribute.get((v) => v) });
      AccessorManager.clearCache();

      const first = AccessorManager.resolveAccessorsFor(ctor);
      AccessorManager.clearCache();
      const second = AccessorManager.resolveAccessorsFor(ctor);
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });

  describe("hasAccessor", () => {
    it("returns true for defined accessor", () => {
      const ctor = createClass({ name: Attribute.get((v) => v) });
      AccessorManager.clearCache();
      expect(AccessorManager.hasAccessor(ctor, "name")).toBe(true);
    });

    it("returns false for undefined accessor", () => {
      const ctor = createClass({ name: Attribute.get((v) => v) });
      AccessorManager.clearCache();
      expect(AccessorManager.hasAccessor(ctor, "age")).toBe(false);
    });
  });

  describe("frozen result", () => {
    it("resolved accessor map is frozen", () => {
      const ctor = createClass({ x: Attribute.get((v) => v) });
      AccessorManager.clearCache();
      const resolved = AccessorManager.resolveAccessorsFor(ctor);
      expect(Object.isFrozen(resolved)).toBe(true);
    });
  });
});
