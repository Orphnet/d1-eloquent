// seederName.test.ts — seeder name must be a safe identifier (no path traversal).
import { describe, it, expect } from "vitest";
import { isValidSeederName } from "../commands/seed";

describe("isValidSeederName", () => {
    it("accepts normal seeder class names", () => {
        expect(isValidSeederName("DatabaseSeeder")).toBe(true);
        expect(isValidSeederName("UserSeeder")).toBe(true);
        expect(isValidSeederName("seeder_42")).toBe(true);
    });

    it("rejects path-traversal and separator characters", () => {
        for (const bad of [
            "../../etc/passwd",
            "../evil",
            "a/b",
            "a\\b",
            ".",
            "..",
            "seed.ts",
            "with space",
            "name;rm -rf",
            "",
        ]) {
            expect(isValidSeederName(bad), bad).toBe(false);
        }
    });
});
