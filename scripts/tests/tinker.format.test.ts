import { describe, it, expect } from "vitest";
import { formatValue, renderTable, formatQueries } from "../tinker/format";
import type { QueryRecord } from "../tinker/d1Sqlite";

// In vitest (no TTY) colour is disabled, so these assert on plain strings.

const model = (attrs: Record<string, unknown>) => ({ toObject: () => attrs });

describe("tinker/format · formatValue", () => {
  it("renders undefined", () => {
    expect(formatValue(undefined)).toContain("undefined");
  });

  it("unwraps a model via toObject()", () => {
    const out = formatValue(model({ id: "u1", name: "Alice" }));
    expect(out).toContain("u1");
    expect(out).toContain("Alice");
  });

  it("unwraps an array (Collection) of models", () => {
    const out = formatValue([model({ id: "a" }), model({ id: "b" })]);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("inspects plain values", () => {
    expect(formatValue({ n: 42 })).toContain("42");
  });
});

describe("tinker/format · renderTable", () => {
  it("renders rows with a header, separator and count", () => {
    const out = renderTable([
      { id: "1", label: "urgent" },
      { id: "2", label: "bug" },
    ]);
    expect(out).toContain("id");
    expect(out).toContain("label");
    expect(out).toContain("urgent");
    expect(out).toContain("│"); // column divider
    expect(out).toContain("(2 rows)");
  });

  it("handles an empty array", () => {
    expect(renderTable([])).toContain("(0 rows)");
  });

  it("unwraps models and renders null/Date cells", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    const out = renderTable([model({ id: "x", deleted_at: null, created_at: d })]);
    expect(out).toContain("∅"); // null cell
    expect(out).toContain("2026-01-02T03:04:05.000Z"); // Date as ISO, unquoted
    expect(out).toContain("(1 row)");
  });

  it("singularises the row count", () => {
    expect(renderTable([{ a: 1 }])).toContain("(1 row)");
  });
});

describe("tinker/format · formatQueries", () => {
  it("shows SQL, bindings, timing and row count for a read", () => {
    const rec: QueryRecord = {
      sql: "SELECT * FROM users WHERE id = ?",
      params: ["u1"],
      kind: "all",
      durationMs: 0.73,
      rows: 3,
    };
    const out = formatQueries([rec]);
    expect(out).toContain("SELECT * FROM users WHERE id = ?");
    expect(out).toContain('"u1"');
    expect(out).toContain("0.7ms");
    expect(out).toContain("3 rows");
  });

  it("shows changed-row count for a write", () => {
    const rec: QueryRecord = {
      sql: "UPDATE users SET name = ? WHERE id = ?",
      params: ["Bob", "u1"],
      kind: "run",
      durationMs: 1.2,
      changes: 1,
    };
    expect(formatQueries([rec])).toContain("1 changed");
  });
});
