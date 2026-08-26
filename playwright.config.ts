import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  outputDir: "test-results/playwright",
  use: {
    baseURL: "http://127.0.0.1:4280",
    navigationTimeout: 15_000,
    actionTimeout: 8_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "desktop-chromium",
      testIgnore: ["**/mobile-workspace.spec.ts", "**/visual-layout.spec.ts"],
      use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } }
    },
    {
      name: "mobile-chromium",
      testMatch: ["**/mobile-workspace.spec.ts", "**/visual-layout.spec.ts"],
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    },
    {
      name: "reduced-motion-chromium",
      testMatch: "**/visual-layout.spec.ts",
      use: { browserName: "chromium", viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }
    }
  ]
});
