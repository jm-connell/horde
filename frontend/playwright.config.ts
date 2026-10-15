import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(frontendRoot, "..");
const python = process.env.E2E_PYTHON || "python3";

// Ports are overridable so several checkouts/agents can run e2e side by side.
const appPort = Number(process.env.E2E_APP_PORT || 8091);
const setupPort = Number(process.env.E2E_SETUP_PORT || 8092);
const appUrl = `http://127.0.0.1:${appPort}`;
const setupUrl = `http://127.0.0.1:${setupPort}`;

// CI uses the Chromium that `playwright install` fetches. On machines whose
// preinstalled browser build differs from this Playwright version, point
// PW_CHROMIUM_EXECUTABLE at a compatible Chromium binary instead.
const chromiumExecutable = process.env.PW_CHROMIUM_EXECUTABLE || undefined;

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
    launchOptions: chromiumExecutable
      ? { executablePath: chromiumExecutable }
      : {},
  },
  projects: [
    {
      name: "app",
      testIgnore: /setup\.spec\.ts/,
      use: { ...desktop, baseURL: appUrl },
    },
    {
      // Phone-sized Chromium (touch, 412x915, mobile UA) over the specs whose
      // layout or behaviour differs on small screens.
      name: "mobile",
      testMatch: /(navigation|library|watch|offline)\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        locale: "en-US",
        timezoneId: "UTC",
        baseURL: appUrl,
      },
    },
    {
      name: "setup",
      testMatch: /setup\.spec\.ts/,
      use: { ...desktop, baseURL: setupUrl },
    },
  ],
  webServer: [
    {
      command: `${python} e2e/serve.py --mode app --port ${appPort}`,
      cwd: repoRoot,
      url: `${appUrl}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `${python} e2e/serve.py --mode setup --port ${setupPort}`,
      cwd: repoRoot,
      url: `${setupUrl}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
