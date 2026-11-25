import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Answer `/api/health` with the real payload, but as the desktop app would. */
async function asDesktop(page: Page) {
  await page.route("**/api/health", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: { ...body, runtime: "desktop" },
    });
  });
}

/** The update panel as the server reports it, with the host watcher present or not. */
async function updateControl(page: Page, watcherConnected: boolean) {
  await page.route("**/api/system/update", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: { ...body, watcher_connected: watcherConnected },
    });
  });
}

const CRON_HELP = "One-click updates aren’t set up on this server yet";
const AUTO_RETURN = "automatically goes back to the current version";
const DOCKER_AI = "Horde runs in Docker, so";

test("on a desktop the update panel says updates are installed by hand", async ({
  page,
}) => {
  await asDesktop(page);
  await updateControl(page, false);
  await page.goto("/settings?tab=system");
  await expect(
    page.getByText("This computer installs updates by hand.")
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download the new version" })
  ).toHaveAttribute(
    "href",
    "https://github.com/jm-connell/horde/releases/latest"
  );
  await expect(page.getByText(CRON_HELP)).toHaveCount(0);
  await expect(page.getByText("cron", { exact: false })).toHaveCount(0);
});

test("on a server the update panel still explains the cron job", async ({
  page,
}) => {
  await updateControl(page, false);
  await page.goto("/settings?tab=system");
  await expect(page.getByText(CRON_HELP)).toBeVisible();
  await expect(page.getByText("installs updates by hand")).toHaveCount(0);
});

test("on a desktop the update confirmation says Horde restarts and does not promise a return", async ({
  page,
}) => {
  await asDesktop(page);
  await updateControl(page, true);
  await page.goto("/settings?tab=system");
  await page.getByRole("button", { name: /^(Update now|Run update)$/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Horde will");
  await expect(dialog).toContainText("to install the");
  await expect(dialog).toContainText("shows how to get the previous one");
  await expect(dialog).not.toContainText(AUTO_RETURN);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("on a server the update confirmation still promises the automatic return", async ({
  page,
}) => {
  await updateControl(page, true);
  await page.goto("/settings?tab=system");
  await page.getByRole("button", { name: /^(Update now|Run update)$/ }).click();
  await expect(page.getByRole("dialog")).toContainText(AUTO_RETURN);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
});

test("on a desktop the AI connection hint points at localhost", async ({
  page,
}) => {
  await asDesktop(page);
  await page.goto("/settings?tab=ai");
  await expect(page.getByText("A local Ollama is at")).toContainText(
    "http://localhost:11434"
  );
  await expect(page.getByText(DOCKER_AI)).toHaveCount(0);
  await expect(page.getByText("host.docker.internal")).toHaveCount(0);
});

test("on a server the AI connection hint still mentions Docker", async ({
  page,
}) => {
  await page.goto("/settings?tab=ai");
  await expect(page.getByText(DOCKER_AI)).toBeVisible();
  await expect(page.getByText("host.docker.internal")).toBeVisible();
});
