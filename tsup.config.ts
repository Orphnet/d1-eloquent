import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli-exports": "src/cli-exports.ts",
    bin: "src/bin.ts",
    config: "src/config.ts",
    // Standalone entry: the ESM resolution hook is loaded by URL via
    // node:module register(), so it must be emitted as its own stable file
    // (dist/resolveHook.js) rather than bundled into a hashed chunk.
    resolveHook: "scripts/resolveHook.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: "node22",
  minify: false,
  // `bun:sqlite` is a Bun runtime builtin (used by the `tinker` REPL); esbuild
  // can't resolve it at build time, so keep it external.
  external: ["@cloudflare/workers-types", "bun:sqlite"],
});
