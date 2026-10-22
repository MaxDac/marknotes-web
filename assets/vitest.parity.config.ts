import { defineConfig } from "vitest/config";
// marknotes-spec golden fixtures (needs the `spec/` submodule); kept out of `npm run check`.
export default defineConfig({
  test: { include: ["parity/**/*.test.ts"], setupFiles: ["tests/setup.ts"] },
});
