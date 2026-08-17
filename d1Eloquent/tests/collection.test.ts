// collection.test.ts
// Tests for Collection wrapper

import { describe, it, expect } from "vitest";
import { Collection } from "../collection";

// ── Stub model-like objects ──────────────────────────────────────────

class FakeModel {
    private attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown>) { this.attrs = attrs; }
    get(key: string) { return this.attrs[key]; }
    toObject() { return { ...this.attrs }; }
    toJSON() { return this.toObject(); }
}

function models(data: Record<string, unknown>[]): Collection<FakeModel> {
    return Collection.from(data.map((d) => new FakeModel(d)));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Collection basics", () => {
    it("extends Array", () => {
        const col = Collection.from([1, 2, 3]);
        expect(col).toBeInstanceOf(Array);
        expect(col).toBeInstanceOf(Collection);
        expect(col.length).toBe(3);
    });

    it("isEmpty / isNotEmpty", () => {
        expect(Collection.from([]).isEmpty()).toBe(true);
        expect(Collection.from([]).isNotEmpty()).toBe(false);
        expect(Collection.from([1]).isEmpty()).toBe(false);
        expect(Collection.from([1]).isNotEmpty()).toBe(true);
    });

    it("first / last", () => {
        const col = Collection.from([10, 20, 30]);
        expect(col.first()).toBe(10);
        expect(col.last()).toBe(30);
        expect(Collection.from([]).first()).toBeUndefined();
    });

    it("first(predicate) returns first matching item", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        expect(col.first((x) => x > 3)).toBe(4);
        expect(col.first((x) => x > 10)).toBeUndefined();
    });

    it("last(predicate) returns last matching item", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        expect(col.last((x) => x < 4)).toBe(3);
        expect(col.last((x) => x > 10)).toBeUndefined();
    });

    it("map() returns a Collection", () => {
        const col = Collection.from([1, 2, 3]);
        const result = col.map((x) => x * 2);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([2, 4, 6]);
    });

    it("filter() returns a Collection", () => {
        const col = Collection.from([1, 2, 3, 4]);
        const result = col.filter((x) => x > 2);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([3, 4]);
    });

    it("flatMap() returns a Collection", () => {
        const col = Collection.from([1, 2, 3]);
        const result = col.flatMap((x) => [x, x * 10]);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([1, 10, 2, 20, 3, 30]);
    });

    it("map/filter chains preserve Collection type", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        const result = col.filter((x) => x > 2).map((x) => x * 2);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([6, 8, 10]);
    });
});

describe("Collection.reject()", () => {
    it("returns items that do NOT match the predicate", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        const result = col.reject((x) => x > 3);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([1, 2, 3]);
    });

    it("returns all items when nothing matches", () => {
        const col = Collection.from([1, 2, 3]);
        expect(col.reject(() => false).length).toBe(3);
    });
});

describe("Collection.where() / whereIn()", () => {
    it("where filters by key equality", () => {
        const col = models([
            { id: "1", status: "active" },
            { id: "2", status: "draft" },
            { id: "3", status: "active" },
        ]);
        const result = col.where("status", "active");
        expect(result).toBeInstanceOf(Collection);
        expect(result.length).toBe(2);
    });

    it("where works with plain objects", () => {
        const col = Collection.from([{ x: 1 }, { x: 2 }, { x: 1 }]);
        expect(col.where("x", 1).length).toBe(2);
    });

    it("whereIn filters by set membership", () => {
        const col = models([
            { id: "1", status: "active" },
            { id: "2", status: "draft" },
            { id: "3", status: "archived" },
        ]);
        const result = col.whereIn("status", ["active", "draft"]);
        expect(result).toBeInstanceOf(Collection);
        expect(result.length).toBe(2);
    });

    it("whereIn uses Set for efficient lookup", () => {
        const col = Collection.from([{ x: 1 }, { x: 2 }, { x: 3 }]);
        expect(col.whereIn("x", [1, 3]).length).toBe(2);
    });
});

describe("Collection.contains()", () => {
    it("accepts a predicate", () => {
        const col = Collection.from([1, 2, 3]);
        expect(col.contains((x) => x === 2)).toBe(true);
        expect(col.contains((x) => x === 5)).toBe(false);
    });

    it("accepts a key + value pair", () => {
        const col = models([
            { id: "1", name: "Alice" },
            { id: "2", name: "Bob" },
        ]);
        expect(col.contains("name", "Alice")).toBe(true);
        expect(col.contains("name", "Charlie")).toBe(false);
    });

    it("returns false for empty collection", () => {
        expect(Collection.from([]).contains(() => true)).toBe(false);
    });
});

describe("Collection.pluck()", () => {
    it("extracts values from model-like objects", () => {
        const col = models([
            { id: "u1", name: "Alice" },
            { id: "u2", name: "Bob" },
        ]);
        expect(col.pluck("name")).toEqual(["Alice", "Bob"]);
    });

    it("works with plain objects", () => {
        const col = Collection.from([{ x: 1 }, { x: 2 }]);
        expect(col.pluck("x")).toEqual([1, 2]);
    });
});

describe("Collection.keyBy()", () => {
    it("indexes by key", () => {
        const col = models([
            { id: "u1", name: "Alice" },
            { id: "u2", name: "Bob" },
        ]);
        const map = col.keyBy("id");
        expect(map.size).toBe(2);
        expect(map.get("u1")!.get("name")).toBe("Alice");
    });
});

describe("Collection.groupBy()", () => {
    it("groups items by key", () => {
        const col = models([
            { id: "p1", status: "active" },
            { id: "p2", status: "draft" },
            { id: "p3", status: "active" },
        ]);
        const grouped = col.groupBy("status");
        expect(grouped.size).toBe(2);
        expect(grouped.get("active")!.length).toBe(2);
        expect(grouped.get("draft")!.length).toBe(1);
    });

    it("returns Collection instances for groups", () => {
        const col = models([{ id: "1", cat: "a" }]);
        const grouped = col.groupBy("cat");
        expect(grouped.get("a")).toBeInstanceOf(Collection);
    });
});

describe("Collection.unique()", () => {
    it("deduplicates by key", () => {
        const col = models([
            { id: "1", cat: "a" },
            { id: "2", cat: "b" },
            { id: "3", cat: "a" },
        ]);
        expect(col.unique("cat").length).toBe(2);
    });

    it("deduplicates primitives without key", () => {
        const col = Collection.from([1, 2, 2, 3, 3, 3]);
        expect(col.unique().length).toBe(3);
    });
});

describe("Collection.partition()", () => {
    it("splits into two collections", () => {
        const col = models([
            { id: "1", score: 90 },
            { id: "2", score: 40 },
            { id: "3", score: 75 },
        ]);
        const [high, low] = col.partition((m) => (m.get("score") as number) >= 70);
        expect(high.length).toBe(2);
        expect(low.length).toBe(1);
        expect(high).toBeInstanceOf(Collection);
        expect(low).toBeInstanceOf(Collection);
    });
});

describe("Collection aggregates", () => {
    const col = models([
        { id: "1", score: 10 },
        { id: "2", score: 20 },
        { id: "3", score: 30 },
    ]);

    it("sum", () => expect(col.sum("score")).toBe(60));
    it("min", () => expect(col.min("score")).toBe(10));
    it("max", () => expect(col.max("score")).toBe(30));
    it("avg", () => expect(col.avg("score")).toBe(20));
    it("avg returns null for empty", () => expect(Collection.from([]).avg("x")).toBeNull());
    it("avg divides by the numeric count, not the full length (null values skipped)", () => {
        // (10 + 30) / 2 numeric values = 20, NOT (10 + 30) / 3 rows = 13.3
        const withNull = models([{ id: "1", score: 10 }, { id: "2", score: null }, { id: "3", score: 30 }]);
        expect(withNull.avg("score")).toBe(20);
    });
    it("avg returns null when no value is numeric", () => {
        expect(models([{ id: "1", score: null }, { id: "2" }]).avg("score")).toBeNull();
    });
});

describe("Collection.sortBy()", () => {
    it("sorts ascending by default", () => {
        const col = models([{ id: "3", n: 30 }, { id: "1", n: 10 }, { id: "2", n: 20 }]);
        const sorted = col.sortBy("n");
        expect(sorted.pluck("n")).toEqual([10, 20, 30]);
        expect(sorted).toBeInstanceOf(Collection);
    });

    it("sorts descending", () => {
        const col = models([{ id: "1", n: 10 }, { id: "2", n: 20 }]);
        expect(col.sortBy("n", "desc").pluck("n")).toEqual([20, 10]);
    });
});

describe("Collection.sortBy() edge cases", () => {
    it("handles null values (nulls sort first in asc)", () => {
        const col = models([{ id: "1", n: 10 }, { id: "2", n: null }, { id: "3", n: 5 }]);
        const sorted = col.sortBy("n");
        expect(sorted.pluck("n")).toEqual([null, 5, 10]);
    });

    it("handles ties (preserves insertion order)", () => {
        const col = models([{ id: "a", n: 10 }, { id: "b", n: 10 }, { id: "c", n: 5 }]);
        const sorted = col.sortBy("n");
        expect(sorted.pluck("id")).toEqual(["c", "a", "b"]);
    });

    it("handles empty collection", () => {
        const col = Collection.from([] as FakeModel[]);
        expect(col.sortBy("n").length).toBe(0);
    });
});

describe("Collection.sortByDesc()", () => {
    it("sorts descending", () => {
        const col = models([{ id: "1", n: 10 }, { id: "2", n: 30 }, { id: "3", n: 20 }]);
        const result = col.sortByDesc("n");
        expect(result).toBeInstanceOf(Collection);
        expect(result.pluck("n")).toEqual([30, 20, 10]);
    });
});

describe("Collection.each() / tap() / pipe()", () => {
    it("each iterates with side effects and returns self", () => {
        const col = Collection.from([1, 2, 3]);
        const seen: number[] = [];
        const result = col.each((x) => seen.push(x));
        expect(seen).toEqual([1, 2, 3]);
        expect(result).toBe(col);
    });

    it("tap applies side effect to collection and returns self", () => {
        const col = Collection.from([1, 2, 3]);
        let length = 0;
        const result = col.tap((c) => { length = c.length; });
        expect(length).toBe(3);
        expect(result).toBe(col);
    });

    it("pipe transforms the collection", () => {
        const col = Collection.from([1, 2, 3]);
        const total = col.pipe((c) => c.reduce((acc, x) => acc + x, 0));
        expect(total).toBe(6);
    });

    it("each/tap/pipe chain together", () => {
        const log: string[] = [];
        const result = Collection.from([1, 2, 3])
            .tap((c) => log.push(`start:${c.length}`))
            .filter((x) => x > 1)
            .each((x) => log.push(`item:${x}`))
            .pipe((c) => c.length);
        expect(result).toBe(2);
        expect(log).toEqual(["start:3", "item:2", "item:3"]);
    });
});

describe("Collection.flatMap()", () => {
    it("flattens one level", () => {
        const col = models([
            { id: "1", tags: "a,b" },
            { id: "2", tags: "c" },
        ]);
        const result = col.flatMap((m) => (m.get("tags") as string).split(","));
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual(["a", "b", "c"]);
    });

    it("handles non-array returns", () => {
        const col = Collection.from([1, 2, 3]);
        const result = col.flatMap((x) => x * 2);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([2, 4, 6]);
    });
});

describe("Collection.take() / skip()", () => {
    it("take returns first n items", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        const result = col.take(3);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([1, 2, 3]);
    });

    it("take with negative n returns last n items", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        expect([...col.take(-2)]).toEqual([4, 5]);
    });

    it("skip returns items after first n", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        const result = col.skip(2);
        expect(result).toBeInstanceOf(Collection);
        expect([...result]).toEqual([3, 4, 5]);
    });

    it("take and skip compose for pagination", () => {
        const col = Collection.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const page2 = col.skip(3).take(3);
        expect([...page2]).toEqual([4, 5, 6]);
    });
});

describe("Collection.mapToGroups()", () => {
    it("groups by callback key with transformed values", () => {
        const col = models([
            { id: "1", department: "eng", name: "Alice" },
            { id: "2", department: "eng", name: "Bob" },
            { id: "3", department: "sales", name: "Charlie" },
        ]);
        const groups = col.mapToGroups((m) => [
            m.get("department") as string,
            m.get("name") as string,
        ]);
        expect(groups.size).toBe(2);
        expect(groups.get("eng")).toBeInstanceOf(Collection);
        expect([...groups.get("eng")!]).toEqual(["Alice", "Bob"]);
        expect([...groups.get("sales")!]).toEqual(["Charlie"]);
    });

    it("works with primitive collections", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        const groups = col.mapToGroups((x) => [x % 2 === 0 ? "even" : "odd", x]);
        expect([...groups.get("odd")!]).toEqual([1, 3, 5]);
        expect([...groups.get("even")!]).toEqual([2, 4]);
    });
});

describe("Collection.chunk()", () => {
    it("splits into chunks", () => {
        const col = Collection.from([1, 2, 3, 4, 5]);
        const chunks = col.chunk(2);
        expect(chunks.length).toBe(3);
        expect([...chunks[0]]).toEqual([1, 2]);
        expect([...chunks[1]]).toEqual([3, 4]);
        expect([...chunks[2]]).toEqual([5]);
    });

    it("guards size <= 0 so it can't infinite-loop (coerces to a step of 1)", () => {
        const col = Collection.from([1, 2, 3]);
        // Before the guard, chunk(0) spun forever (i += 0). Now it steps by 1.
        const zero = col.chunk(0);
        expect(zero.length).toBe(3);
        expect([...zero[0]]).toEqual([1]);
        const neg = col.chunk(-5);
        expect(neg.length).toBe(3);
    });
});

describe("Collection.toArray()", () => {
    it("serializes model-like objects", () => {
        const col = models([{ id: "1", name: "Alice" }]);
        const arr = col.toArray();
        expect(arr).toEqual([{ id: "1", name: "Alice" }]);
        expect(arr[0]).not.toBeInstanceOf(FakeModel);
    });
});
