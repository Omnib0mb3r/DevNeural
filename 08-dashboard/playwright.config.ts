import { defineConfig, devices } from "@playwright/test";

/**
 * Permanent e2e suite scaffold (Section C of the 2026-05-12 evening
 * plan). One smoke test runs without a daemon; every browser-driven
 * scenario is test.skip'd behind 'selectors-pending' until the
 * dashboard surfaces stabilise. Run with `npm run e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEVNEURAL_DASHBOARD_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
