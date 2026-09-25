import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(frontendRoot, "..");
const python = process.env.E2E_PYTHON || "python3";

const desktop = {
  ...devices["Desktop Chrome"],
  locale: "en-US",
  timezoneId: "UTC",
  viewport: { width: 1440, height: 900 },
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "app",
      testIgnore: /setup\.spec\.ts/,
      use: { ...desktop, baseURL: "http://127.0.0.1:8091" },
    },
    {
      name: "setup",
      testMatch: /setup\.spec\.ts/,
      use: { ...desktop, baseURL: "http://127.0.0.1:8092" },
    },
  ],
  webServer: [
    {
      command: `${python} e2e/serve.py --mode app --port 8091`,
      cwd: repoRoot,
      url: "http://127.0.0.1:8091/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `${python} e2e/serve.py --mode setup --port 8092`,
      cwd: repoRoot,
      url: "http://127.0.0.1:8092/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
