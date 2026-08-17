import { describe, it, expect } from "vitest";
import { parseFlags } from "../flags";

describe("parseFlags", () => {
  it("parses boolean flags", () => {
    const f = parseFlags(["--force", "--verbose"]);
    expect(f.bool("force")).toBe(true);
    expect(f.bool("verbose")).toBe(true);
    expect(f.bool("missing")).toBe(false);
  });

  it("parses key=value flags", () => {
    const f = parseFlags(["--db=my_db", "--out-dir=/tmp/out"]);
    expect(f.get("db")).toBe("my_db");
    expect(f.get("out-dir")).toBe("/tmp/out");
    expect(f.get("missing")).toBeUndefined();
  });

  it("separates positional args from flags", () => {
    const f = parseFlags(["User", "--force", "extra", "--db=test"]);
    expect(f.positional).toEqual(["User", "extra"]);
    expect(f.bool("force")).toBe(true);
    expect(f.get("db")).toBe("test");
  });

  it("handles empty argv", () => {
    const f = parseFlags([]);
    expect(f.positional).toEqual([]);
    expect(f.bool("anything")).toBe(false);
    expect(f.get("anything")).toBeUndefined();
  });

  it("has() returns true for boolean and value flags", () => {
    const f = parseFlags(["--force", "--db=test"]);
    expect(f.has("force")).toBe(true);
    expect(f.has("db")).toBe(true);
    expect(f.has("missing")).toBe(false);
  });

  it("getRequired() throws for missing flags", () => {
    const f = parseFlags(["--force"]);
    expect(() => f.getRequired("db")).toThrow("Missing required flag: --db");
  });

  it("getRequired() returns value for present flags", () => {
    const f = parseFlags(["--db=my_db"]);
    expect(f.getRequired("db")).toBe("my_db");
  });

  it("get() returns undefined for boolean flags (no value)", () => {
    const f = parseFlags(["--force"]);
    expect(f.get("force")).toBeUndefined();
  });

  it("exposes raw record for backwards compatibility", () => {
    const f = parseFlags(["--force", "--db=test"]);
    expect(f.raw).toEqual({ force: true, db: "test" });
  });

  it("handles --key= (empty value)", () => {
    const f = parseFlags(["--db="]);
    expect(f.get("db")).toBe("");
    expect(f.has("db")).toBe(true);
  });
});
