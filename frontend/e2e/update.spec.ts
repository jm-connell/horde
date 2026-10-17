import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, openNav, test } from "./fixtures";

const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist"
);

/**
 * Simulate a deploy by editing the built files the e2e server serves: a new
 * sw.js (different cache version), a marked index.html, and the removal of one
 * lazy chunk so only the previous release's cache can still provide it.
 * Everything is restored afterwards.
 */
function stageRelease() {
  const originals = new Map<string, Buffer>();
  const edit = (file: string, fn: (text: string) => string) => {
    const full = path.join(dist, file);
    originals.set(full, fs.readFileSync(full));
    fs.writeFileSync(full, fn(fs.readFileSync(full, "utf8")));
  };
  const swText = fs.readFileSync(path.join(dist, "sw.js"), "utf8");
  const version = /`\$\{\w+\}([0-9a-f]{12})`/.exec(swText)?.[1];
  expect(version, "shell version in sw.js").toBeTruthy();
  // The new release renamed the History chunk (as a rebuild would), so its
  // precache list has the new name and the old file is gone from the server.
  const chunk = fs
    .readdirSync(path.join(dist, "assets"))
    .find((f) => /^History-.*\.js$/.test(f))!;
  const renamed = "History-e2enext.js";
  edit("sw.js", (t) =>
    t.split(version!).join("e2enextrel0").split(chunk).join(renamed)
  );
  edit("index.html", (t) =>
    t.replace("</head>", '<meta name="e2e-release" content="next"></head>')
  );
  const chunkPath = path.join(dist, "assets", chunk);
  const renamedPath = path.join(dist, "assets", renamed);
  originals.set(chunkPath, fs.readFileSync(chunkPath));
  fs.copyFileSync(chunkPath, renamedPath);
  fs.rmSync(chunkPath);
  return () => {
    for (const [file, data] of originals) fs.writeFileSync(file, data);
    fs.rmSync(renamedPath, { force: true });
  };
}

test("accepting an update in one tab leaves the other tab usable and on its old chunks", async ({
  page: tabA,
  context,
}) => {
  await tabA.goto("/");
  await tabA.evaluate(() => navigator.serviceWorker.ready);
  await tabA.reload();
  await expect
    .poll(() => tabA.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  const tabB = await context.newPage();
  await tabB.goto("/");
  await expect(
    tabB.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
  // Prove tab B is never reloaded behind the user's back.
  await tabB.evaluate(() => {
    (window as unknown as { __tabB: number }).__tabB = 1;
  });

  const restore = stageRelease();
  try {
    await tabA.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    const toast = (page: typeof tabA) =>
      page.locator("[data-horde='toast']", { hasText: "Update available" });
    await expect(toast(tabA)).toBeVisible();
    await expect(toast(tabB)).toBeVisible();

    // Tab A accepts: it reloads onto the NEW release (new index.html, even
    // though the previous release's shell cache is still around).
    const reloaded = tabA.waitForEvent("load");
    await toast(tabA).getByRole("button", { name: "Reload" }).click();
    await reloaded;
    await expect(tabA.locator('meta[name="e2e-release"]')).toHaveAttribute(
      "content",
      "next"
    );

    // Tab B: toast clears, no forced reload, and the OLD lazy chunk (deleted
    // from the server) still loads from the kept previous cache.
    await expect(toast(tabB)).toHaveCount(0);
    expect(
      await tabB.evaluate(
        () => (window as unknown as { __tabB?: number }).__tabB
      )
    ).toBe(1);
    await openNav(tabB, "History");
    await expect(
      tabB.getByRole("heading", { name: "History", level: 1 })
    ).toBeVisible();
  } finally {
    restore();
  }
});
