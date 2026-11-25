import { defineConfig } from "@playwright/test";

// One app at a time: every test drives the same Electron process and server.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
});
