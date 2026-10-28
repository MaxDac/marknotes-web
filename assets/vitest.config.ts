import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["js/**/*.ts"],
      exclude: ["js/**/*.d.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Ratchet: raise these when coverage improves; never lower them to make a change pass.
      thresholds: { statements: 87, branches: 78, functions: 87, lines: 89 },
    },
  },
});
