import { describe, it, expect } from "vitest";
import { extractJson, D1ExecuteError } from "../d1Execute";

describe("extractJson", () => {
  it("parses clean JSON array", () => {
    const input = '[{"results":[{"name":"users"}],"success":true}]';
    const result = extractJson(input) as unknown[];
    expect(result).toHaveLength(1);
    expect((result[0] as any).success).toBe(true);
  });

  it("parses clean JSON object", () => {
    const input = '{"results":[{"id":1}],"success":true}';
    const result = extractJson(input) as any;
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it("extracts JSON from noisy wrangler output", () => {
    const input = `
Wrangler v3.80.0
Using local D1 database...
[{"results":[{"name":"test"}],"success":true}]
    `;
    const result = extractJson(input) as unknown[];
    expect(result).toHaveLength(1);
    expect((result[0] as any).results[0].name).toBe("test");
  });

  it("handles ANSI codes before JSON", () => {
    const input = `\x1b[33mWarning: something\x1b[0m\n{"results":[],"success":true}`;
    // ANSI codes don't start with [ or { so bracket matching finds the JSON
    const result = extractJson(input) as any;
    expect(result.success).toBe(true);
  });

  it("handles JSON with nested brackets and strings", () => {
    const input = '[{"results":[{"data":"value with {braces} and \\"quotes\\""}],"success":true}]';
    const result = extractJson(input) as unknown[];
    expect(result).toHaveLength(1);
    expect((result[0] as any).results[0].data).toContain("braces");
  });

  it("handles trailing text after JSON", () => {
    const input = '[{"success":true}]\nSome trailing log output';
    const result = extractJson(input) as unknown[];
    expect(result).toHaveLength(1);
  });

  it("returns null for empty input", () => {
    expect(extractJson("")).toBeNull();
    expect(extractJson("   ")).toBeNull();
  });

  it("returns null for non-JSON text", () => {
    expect(extractJson("just some text without json")).toBeNull();
  });

  it("handles multi-statement result arrays", () => {
    const input = '[{"results":[],"success":true},{"results":[{"count":5}],"success":true}]';
    const result = extractJson(input) as unknown[];
    expect(result).toHaveLength(2);
  });

  it("handles wrangler progress output before JSON", () => {
    const input = `
Wrangler v3.80.0
Using local D1 database...
Executing SQL...
Done in 0.5s

[{"results":[{"name":"_migrations","batch":"1"}],"success":true,"meta":{"rows_read":1,"rows_written":0}}]
`;
    const result = extractJson(input) as unknown[];
    expect(result).toHaveLength(1);
    expect((result[0] as any).results[0].name).toBe("_migrations");
  });
});

describe("D1ExecuteError", () => {
  it("has structured properties", () => {
    const err = new D1ExecuteError("SELECT 1", "my_db", "some error", 1);
    expect(err.command).toBe("SELECT 1");
    expect(err.db).toBe("my_db");
    expect(err.stderr).toBe("some error");
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe("D1ExecuteError");
    expect(err.message).toContain("wrangler d1 execute failed");
    expect(err).toBeInstanceOf(Error);
  });
});
