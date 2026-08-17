import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    reporter: ["default", "json"],
    outputFile: { json: "test-results.json" },
    include: ["d1Eloquent/tests/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["d1Eloquent/**/*.ts"],
      exclude: ["d1Eloquent/tests/**", "d1Eloquent/*Types.ts", "d1Eloquent/*types.ts"],
      reporter: ["text", "text-summary", "json-summary"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
      },
    },
  },
});
