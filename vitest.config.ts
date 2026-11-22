import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "*/src/**/*.test.ts",
      "site/publish.test.ts",
      "updater/main.test.ts",
    ],
  },
});
