import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:4000",
    trace: "retain-on-failure",
    ...(process.env.PLAYWRIGHT_WS_ENDPOINT
      ? { connectOptions: { wsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT } }
      : {}),
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command: "npm run serve",
    url: "http://localhost:4000/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: "4000",
      SITE_ROOT: "dist",
    },
  },
});
