// Capture the README and docs screenshots from a running Horde.
//
//   npm run screenshots -- http://192.168.1.20:8686
//
// Opens a browser window. Sign in there, then for each shot the script opens
// the page and says what to set up; press Enter in this terminal to save it to
// docs/assets/screenshots/<name>.webp, or type "s" and Enter to skip it.
// Pass shot names after the URL to take only those (e.g. ... player ask).
// Needs Playwright's Chromium once: npx playwright install chromium
/* global createImageBitmap, OffscreenCanvas -- used inside page.evaluate (browser) */
import { chromium, devices } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "assets",
  "screenshots"
);
const DESKTOP = { width: 1440, height: 900 };

const SHOTS = [
  {
    name: "library",
    path: "/",
    hint: "Library tab with Continue watching showing.",
  },
  {
    name: "recommended",
    path: "/",
    hint: "Switch to the Recommended tab and let thumbnails load.",
  },
  {
    name: "player",
    path: "/",
    hint: "Open a video with chapters, a summary and comments; pause on a good frame.",
  },
  {
    name: "ask",
    path: "/",
    hint: "Open Ask (docked at the side) with an answer that cites a channel.",
  },
  {
    name: "channel-feed",
    path: "/",
    hint: "Open a channel with downloaded videos and undownloaded catalog entries.",
  },
  {
    name: "subscriptions",
    path: "/subscriptions",
    hint: "With a good number of followed channels.",
  },
  {
    name: "downloads",
    path: "/download",
    hint: "Ideally with a few items in the queue.",
  },
  {
    name: "import",
    path: "/import",
    hint: "Ideally with a file waiting for review.",
  },
  {
    name: "settings-ai",
    path: "/settings?tab=ai",
    hint: "AI settings with a provider set up.",
  },
  {
    name: "mobile",
    path: "/",
    mobile: true,
    hint: "Phone layout (iPhone 15). Any screen that looks good small, e.g. a video.",
  },
];

const [base, ...only] = process.argv.slice(2);
if (!base) {
  console.error("Usage: npm run screenshots -- <horde URL> [shot names...]");
  console.error(`Shots: ${SHOTS.map((s) => s.name).join(", ")}`);
  process.exit(1);
}
const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
const rl = createInterface({ input: process.stdin, output: process.stdout });
mkdirSync(OUT, { recursive: true });

// Playwright writes PNG or JPEG; re-encode as WebP like the others. This runs
// in a blank page because Horde's Content-Security-Policy blocks it in the app.
async function saveWebp(page, encoder, name) {
  const png = await page.screenshot({ type: "png" });
  const webp = await encoder.evaluate(async (b64) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([raw], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const out = await canvas.convertToBlob({
      type: "image/webp",
      quality: 0.85,
    });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }, png.toString("base64"));
  const file = join(OUT, `${name}.webp`);
  writeFileSync(file, Buffer.from(webp, "base64"));
  console.log(`  saved ${file}`);
}

const browser = await chromium.launch({ headless: false });
const desktop = await browser.newContext({
  viewport: DESKTOP,
  colorScheme: "dark",
});
const page = await desktop.newPage();
const encoder = await (await browser.newContext()).newPage();
await page.goto(base);
await rl.question("Sign in in the browser window, then press Enter here. ");

let mobilePage = null;
for (const shot of shots) {
  let target = page;
  if (shot.mobile) {
    if (!mobilePage) {
      const ctx = await browser.newContext({
        ...devices["iPhone 15"],
        colorScheme: "dark",
        storageState: await desktop.storageState(),
      });
      mobilePage = await ctx.newPage();
    }
    target = mobilePage;
  }
  await target.goto(new URL(shot.path, base).href);
  await target.bringToFront();
  const answer = await rl.question(
    `\n[${shot.name}] ${shot.hint}\nEnter to capture, s to skip: `
  );
  if (answer.trim().toLowerCase() === "s") continue;
  await saveWebp(target, encoder, shot.name);
}

rl.close();
await browser.close();
