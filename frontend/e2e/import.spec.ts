import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, feedCard, openNav, test, videoCard } from "./fixtures";

// A copy of a seeded video laid out the way yt-dlp and Horde name files.
const downloads = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../e2e/.runtime/app/downloads"
);
const archiveDir = path.join(downloads, "Harbor Archive");
const archived = path.join(archiveDir, "2023", "Night Pier [abcdefghijk].mp4");

function dropArchivedFile() {
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.copyFileSync(
    path.join(downloads, "Northwind/2024/Paper Kites.mp4"),
    archived
  );
}

test.afterEach(() => {
  fs.rmSync(archiveDir, { recursive: true, force: true });
});

test("import queue approves a dropped file into the library", async ({
  page,
}) => {
  await page.goto("/import");
  await expect(
    page.getByText("Drop .mp4, .mkv, .webm, .m4v or .mov files here")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose files" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Scan for new files" })
  ).toBeVisible();
  await expect(page.locator("input[value='Unreviewed drop']")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save & approve" })
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

  const channel = page.getByRole("combobox");
  await channel.fill("North");
  await expect(page.getByText("Tab · Northwind")).toBeVisible();
  await channel.press("Tab");
  await expect(channel).toHaveValue("Northwind");
  await page.getByRole("button", { name: "Save & approve" }).click();

  await expect(page.getByText("Nothing to import.")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Import\b/ })).not.toContainText(
    "1"
  );

  await openNav(page, "Home");
  await expect(videoCard(page, "Unreviewed drop")).toBeVisible();
  await page.getByRole("button", { name: /Northwind/ }).click();
  await expect(feedCard(page, "Unreviewed drop")).toBeVisible();
});

test("a file from an existing archive is filled in and approved in bulk", async ({
  page,
}) => {
  dropArchivedFile();
  await page.goto("/import");
  await page.getByRole("button", { name: "Scan for new files" }).click();
  await expect(
    page.getByText("Added 1 file to the import queue")
  ).toBeVisible();

  await expect(page.locator("input[value='Night Pier']")).toBeVisible();
  await expect(
    page.getByText("Filled in from folder and file name.")
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "1 of 2 files" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Approve 1 ready" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByText("Approved 1 video")).toBeVisible();
  // The file without a channel waits; the archived one is in the library.
  await expect(page.locator("input[value='Unreviewed drop']")).toBeVisible();
  await expect(page.locator("input[value='Night Pier']")).toHaveCount(0);
  expect(fs.existsSync(archived)).toBe(true);

  await openNav(page, "Home");
  await expect(videoCard(page, "Night Pier")).toBeVisible();
});

test("Fetch details from YouTube fills the form from the file's id", async ({
  page,
}) => {
  dropArchivedFile();
  await page.goto("/import");
  await page.getByRole("button", { name: "Scan for new files" }).click();
  await expect(page.locator("input[value='Night Pier']")).toBeVisible();
  // Only the archived file has a YouTube id in its name.
  await expect(
    page.getByRole("button", { name: "Fetch details from YouTube" })
  ).toHaveCount(1);

  await page
    .getByRole("button", { name: "Fetch details from YouTube" })
    .click();
  await expect(
    page.locator("input[value='E2E looked-up title']")
  ).toBeVisible();
  await expect(page.getByText("Filled in from YouTube.")).toBeVisible();
});

test("approving one file keeps what was typed into another", async ({
  page,
}) => {
  dropArchivedFile();
  await page.goto("/import");
  await page.getByRole("button", { name: "Scan for new files" }).click();
  const item = (title: string) =>
    page
      .locator('[data-horde="import-item"]')
      .filter({ has: page.locator(`input[value='${title}']`) });
  const archived = item("Night Pier");
  // The suggested channel is corrected by hand.
  await expect(archived.getByRole("combobox")).toHaveValue("Harbor Archive");
  await archived.getByRole("combobox").fill("Real Channel");

  // Approving the other (seeded) file reloads the list.
  const drop = item("Unreviewed drop");
  await drop.getByRole("combobox").fill("Northwind");
  await drop.getByRole("combobox").press("Tab");
  await drop.getByRole("button", { name: "Save & approve" }).click();
  await expect(item("Unreviewed drop")).toHaveCount(0);

  await expect(archived.getByRole("combobox")).toHaveValue("Real Channel");
});
