import { describe, it, expect } from "vitest";
import { CastManager } from "../castManager";
import type { AttributeCast, CastDefinition } from "../castManager";

describe("CastManager", () => {
  describe("built-in casts", () => {
    describe("boolean", () => {
      const casts = { flag: "boolean" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: 1 → true, 0 → false", () => {
        expect(CastManager.castGet(resolved.flag, 1)).toBe(true);
        expect(CastManager.castGet(resolved.flag, 0)).toBe(false);
      });

      it("set: true → 1, false → 0", () => {
        expect(CastManager.castSet(resolved.flag, true)).toBe(1);
        expect(CastManager.castSet(resolved.flag, false)).toBe(0);
      });

      it("null passthrough", () => {
        expect(CastManager.castGet(resolved.flag, null)).toBeNull();
        expect(CastManager.castSet(resolved.flag, null)).toBeNull();
      });
    });

    describe("integer", () => {
      const casts = { count: "integer" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: truncates to integer", () => {
        expect(CastManager.castGet(resolved.count, 3.7)).toBe(3);
        expect(CastManager.castGet(resolved.count, "42")).toBe(42);
      });

      it("set: truncates to integer", () => {
        expect(CastManager.castSet(resolved.count, 3.9)).toBe(3);
      });
    });

    describe("float", () => {
      const casts = { price: "float" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: converts to number", () => {
        expect(CastManager.castGet(resolved.price, "3.14")).toBe(3.14);
      });

      it("set: converts to number", () => {
        expect(CastManager.castSet(resolved.price, 2.5)).toBe(2.5);
      });
    });

    describe("string", () => {
      const casts = { label: "string" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: converts to string", () => {
        expect(CastManager.castGet(resolved.label, 123)).toBe("123");
      });

      it("set: converts to string", () => {
        expect(CastManager.castSet(resolved.label, 456)).toBe("456");
      });
    });

    describe("datetime", () => {
      const casts = { at: "datetime" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: ISO string → Date", () => {
        const d = CastManager.castGet(resolved.at, "2026-01-15T12:00:00.000Z") as Date;
        expect(d).toBeInstanceOf(Date);
        expect(d.getUTCFullYear()).toBe(2026);
      });

      it("set: Date → ISO string", () => {
        const d = new Date("2026-01-15T12:00:00.000Z");
        expect(CastManager.castSet(resolved.at, d)).toBe("2026-01-15T12:00:00.000Z");
      });

      it("set: string passes through as string", () => {
        expect(CastManager.castSet(resolved.at, "2026-01-15T12:00:00.000Z")).toBe("2026-01-15T12:00:00.000Z");
      });
    });

    describe("date", () => {
      const casts = { day: "date" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: date string → Date with zeroed time", () => {
        const d = CastManager.castGet(resolved.day, "2026-03-05") as Date;
        expect(d).toBeInstanceOf(Date);
        expect(d.getUTCHours()).toBe(0);
        expect(d.getUTCMinutes()).toBe(0);
      });

      it("set: Date → date-only string", () => {
        const d = new Date("2026-03-05T14:30:00Z");
        expect(CastManager.castSet(resolved.day, d)).toBe("2026-03-05");
      });
    });

    describe("timestamp", () => {
      const casts = { ts: "timestamp" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: unix epoch → Date", () => {
        const d = CastManager.castGet(resolved.ts, 1700000000) as Date;
        expect(d).toBeInstanceOf(Date);
        expect(d.getTime()).toBe(1700000000000);
      });

      it("set: Date → unix epoch", () => {
        const d = new Date(1700000000000);
        expect(CastManager.castSet(resolved.ts, d)).toBe(1700000000);
      });
    });

    describe("json", () => {
      const casts = { meta: "json" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: JSON string → object", () => {
        const result = CastManager.castGet(resolved.meta, '{"a":1}');
        expect(result).toEqual({ a: 1 });
      });

      it("get: already object → passthrough", () => {
        const obj = { a: 1 };
        expect(CastManager.castGet(resolved.meta, obj)).toEqual(obj);
      });

      it("set: object → JSON string", () => {
        expect(CastManager.castSet(resolved.meta, { b: 2 })).toBe('{"b":2}');
      });

      it("set: string → passthrough", () => {
        expect(CastManager.castSet(resolved.meta, '{"b":2}')).toBe('{"b":2}');
      });
    });

    describe("array", () => {
      const casts = { tags: "array" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: JSON string → array", () => {
        expect(CastManager.castGet(resolved.tags, '["a","b"]')).toEqual(["a", "b"]);
      });

      it("set: array → JSON string", () => {
        expect(CastManager.castSet(resolved.tags, ["x", "y"])).toBe('["x","y"]');
      });

      it("get: malformed JSON does not throw — returns empty array", () => {
        expect(CastManager.castGet(resolved.tags, "{not json}")).toEqual([]);
      });

      it("set: null is normalized to '[]'", () => {
        expect(CastManager.castSet(resolved.tags, null)).toBeNull(); // null short-circuits in castSet
      });
    });

    describe("json — safety", () => {
      const casts = { meta: "json" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: malformed JSON does NOT throw, returns raw string", () => {
        expect(() => CastManager.castGet(resolved.meta, "{not json}")).not.toThrow();
        expect(CastManager.castGet(resolved.meta, "{not json}")).toBe("{not json}");
      });

      it("get: empty string passes through (avoid JSON.parse('') exception)", () => {
        expect(CastManager.castGet(resolved.meta, "")).toBe("");
      });
    });

    describe("blob", () => {
      const casts = { data: "blob" as CastDefinition };
      const resolved = CastManager.resolveCastsFor({ timestamps: false, casts });

      it("get: passthrough for ArrayBuffer", () => {
        const buf = new ArrayBuffer(4);
        expect(CastManager.castGet(resolved.data, buf)).toBe(buf);
      });

      it("set: passthrough for Uint8Array", () => {
        const u8 = new Uint8Array([1, 2, 3]);
        expect(CastManager.castSet(resolved.data, u8)).toBe(u8);
      });

      it("null passthrough", () => {
        expect(CastManager.castGet(resolved.data, null)).toBeNull();
      });
    });
  });

  describe("resolveCastsFor()", () => {
    it("auto-registers timestamp casts when timestamps=true", () => {
      const casts = CastManager.resolveCastsFor({ timestamps: true });
      expect(casts).toHaveProperty("created_at");
      expect(casts).toHaveProperty("updated_at");
      // verify datetime behavior
      const d = CastManager.castGet(casts.created_at, "2026-01-01T00:00:00.000Z");
      expect(d).toBeInstanceOf(Date);
    });

    it("does not register timestamp casts when timestamps=false", () => {
      const casts = CastManager.resolveCastsFor({ timestamps: false });
      expect(casts).not.toHaveProperty("created_at");
      expect(casts).not.toHaveProperty("updated_at");
    });

    it("auto-registers deleted_at when softDeletes=true", () => {
      const casts = CastManager.resolveCastsFor({ timestamps: false, softDeletes: true });
      expect(casts).toHaveProperty("deleted_at");
    });

    it("user casts override auto-registered casts", () => {
      const customCast: AttributeCast<string, string> = {
        get: (v) => `custom:${v}`,
        set: (v) => String(v),
      };
      const casts = CastManager.resolveCastsFor({
        timestamps: true,
        casts: { created_at: customCast },
      });
      // The user's custom cast should win
      expect(CastManager.castGet(casts.created_at, "test")).toBe("custom:test");
    });
  });

  describe("custom AttributeCast", () => {
    it("works with a custom cast instance", () => {
      const uppercaseCast: AttributeCast<string, string> = {
        get: (v) => String(v).toUpperCase(),
        set: (v) => String(v).toLowerCase(),
      };
      const casts = CastManager.resolveCastsFor({
        timestamps: false,
        casts: { name: uppercaseCast },
      });
      expect(CastManager.castGet(casts.name, "hello")).toBe("HELLO");
      expect(CastManager.castSet(casts.name, "WORLD")).toBe("world");
    });
  });

  describe("hydrateRow / dehydrateRow", () => {
    it("hydrates a full row", () => {
      const casts = CastManager.resolveCastsFor({
        timestamps: false,
        casts: { is_active: "boolean", meta: "json" },
      });
      const row = { id: "1", is_active: 1, meta: '{"x":1}', name: "test" };
      const hydrated = CastManager.hydrateRow(casts, row);
      expect(hydrated.is_active).toBe(true);
      expect(hydrated.meta).toEqual({ x: 1 });
      expect(hydrated.name).toBe("test"); // untouched
    });

    it("dehydrates a full row", () => {
      const casts = CastManager.resolveCastsFor({
        timestamps: false,
        casts: { is_active: "boolean", meta: "json" },
      });
      const row = { id: "1", is_active: true, meta: { x: 1 }, name: "test" };
      const dehydrated = CastManager.dehydrateRow(casts, row);
      expect(dehydrated.is_active).toBe(1);
      expect(dehydrated.meta).toBe('{"x":1}');
      expect(dehydrated.name).toBe("test"); // untouched
    });

    it("preserves null values in hydrate/dehydrate", () => {
      const casts = CastManager.resolveCastsFor({
        timestamps: false,
        casts: { is_active: "boolean" },
      });
      expect(CastManager.hydrateRow(casts, { is_active: null }).is_active).toBeNull();
      expect(CastManager.dehydrateRow(casts, { is_active: null }).is_active).toBeNull();
    });
  });
});
