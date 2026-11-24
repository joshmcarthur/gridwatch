import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Publisher tests write Parquet through DuckDB and often run near 5s on CI.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: [
      "*/src/**/*.test.ts",
      "site/publish.test.ts",
      "updater/main.test.ts",
    ],
  },
});
