// resolveHook.test.ts — unit tests for the extensionless-import resolution hook.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "../resolveHook";

let dir: string;
let parentURL: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "d1e-resolve-"));
    writeFileSync(join(dir, "model.ts"), "export const x = 1;");
    writeFileSync(join(dir, "legacy.js"), "export const z = 3;");
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "index.ts"), "export const y = 2;");
    parentURL = pathToFileURL(join(dir, "seeder.ts")).href;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Stand-in for Node's default resolver: succeeds for bare specifiers and for
 * file: URLs / paths that exist on disk; throws ERR_MODULE_NOT_FOUND otherwise
 * (mirroring Node's rejection of extensionless relative specifiers).
 */
const nextResolve = async (specifier: string) => {
    let p: string | null = null;
    if (specifier.startsWith("file:")) p = fileURLToPath(specifier);
    else if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
        p = specifier.startsWith("/") ? specifier : join(dir, specifier);
    } else {
        return { url: specifier, shortCircuit: true }; // bare specifier (e.g. node:fs)
    }
    const isFile = (path: string) => {
        try {
            return statSync(path).isFile();
        } catch {
            return false;
        }
    };
    if (isFile(p)) return { url: pathToFileURL(p).href, shortCircuit: true };
    const e = new Error(`not found: ${specifier}`) as Error & { code?: string };
    // Node throws ERR_UNSUPPORTED_DIR_IMPORT for a directory, ERR_MODULE_NOT_FOUND otherwise.
    e.code = existsSync(p) ? "ERR_UNSUPPORTED_DIR_IMPORT" : "ERR_MODULE_NOT_FOUND";
    throw e;
};

describe("resolveHook.resolve", () => {
    it("resolves an extensionless relative import to its .ts file", async () => {
        const r = await resolve("./model", { parentURL }, nextResolve);
        expect(fileURLToPath(r.url)).toBe(join(dir, "model.ts"));
    });

    it("resolves a directory import to <dir>/index.ts", async () => {
        const r = await resolve("./pkg", { parentURL }, nextResolve);
        expect(fileURLToPath(r.url)).toBe(join(dir, "pkg", "index.ts"));
    });

    it("falls back to a .js sibling when no .ts exists", async () => {
        const r = await resolve("./legacy", { parentURL }, nextResolve);
        expect(fileURLToPath(r.url)).toBe(join(dir, "legacy.js"));
    });

    it("leaves an already-extensioned import untouched", async () => {
        const r = await resolve("./model.ts", { parentURL }, nextResolve);
        expect(fileURLToPath(r.url)).toBe(join(dir, "model.ts"));
    });

    it("passes bare specifiers straight through (no probing)", async () => {
        const r = await resolve("node:fs", { parentURL }, nextResolve);
        expect(r.url).toBe("node:fs");
    });

    it("rethrows when no candidate file exists", async () => {
        await expect(resolve("./does-not-exist", { parentURL }, nextResolve)).rejects.toMatchObject({
            code: "ERR_MODULE_NOT_FOUND",
        });
    });

    it("does not probe on non-retryable resolution errors", async () => {
        const failing = async () => {
            const e = new Error("bad specifier") as Error & { code?: string };
            e.code = "ERR_INVALID_MODULE_SPECIFIER";
            throw e;
        };
        await expect(resolve("./model", { parentURL }, failing)).rejects.toMatchObject({
            code: "ERR_INVALID_MODULE_SPECIFIER",
        });
    });
});
