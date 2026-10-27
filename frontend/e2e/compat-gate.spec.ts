import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, videoCard } from "./fixtures";

// page.route cannot intercept <video> media requests, so these specs change the
// seeded file on disk (e2e/serve.py's downloads dir) and restore it afterwards.
const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../e2e/.runtime/app/downloads/Northwind/2024/Paper Kites.mp4"
);
let original: Buffer;

test.beforeEach(() => {
  original = fs.readFileSync(file);
});

test.afterEach(() => {
  fs.writeFileSync(file, original);
});

// The seeded videos have no recorded codec, so a failing original is a candidate
// for the "couldn't play" compat gate. Only a file the server serves may be
// blamed on the device.
test("a missing original shows a playback error, not the compat gate", async ({
  page,
}) => {
  fs.rmSync(file);
  await page.goto("/");
  await videoCard(page, "Paper Kites").first().click();
  await expect(page.getByText("This video could not be played")).toBeVisible();
  await expect(page.getByText(/This device couldn.t play/)).toHaveCount(0);
});

test("an original the browser cannot decode shows the compat gate", async ({
  page,
}) => {
  fs.writeFileSync(file, Buffer.alloc(4096, 7));
  await page.goto("/");
  await videoCard(page, "Paper Kites").first().click();
  await expect(page.getByText(/This device couldn.t play/)).toBeVisible();
  await expect(page.getByText("This video could not be played")).toHaveCount(0);
});
