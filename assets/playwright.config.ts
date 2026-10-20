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
    command: "cd .. && mix phx.server",
    url: "http://localhost:4000/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MIX_ENV: process.env.MIX_ENV ?? "dev",
      PHX_HOST: "localhost",
      PORT: "4000",
      SECRET_KEY_BASE:
        process.env.SECRET_KEY_BASE ??
        "e2e-only-secret-key-base-not-used-anywhere-else-0123456789abcdefghijkl",
      DROPBOX_APP_KEY: "playwright-public-test-client",
      MSAL_CLIENT_ID: "",
    },
  },
});
