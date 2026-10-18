import { devices } from "@playwright/test";
import { expect, test } from "./fixtures";

const TITLE = "Harbor Lights";

function trackConsole(page: import("@playwright/test").Page) {
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      logs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  return logs;
}

test("service worker registers, controls the page, and ping works", async ({
  page,
  request,
}) => {
  const logs = trackConsole(page);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {
      message: `no SW controller. console: ${logs.join(" | ")}`,
    })
    .toBe(true);

  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toMatch(/javascript/);

  const ping = await request.get("/api/ping");
  expect(ping.ok()).toBe(true);
  expect(await ping.json()).toMatchObject({ ok: true });
});

test("a new service worker waits for consent and activates from the update toast", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  const activeBefore = await page.evaluate(
    async () =>
      (await navigator.serviceWorker.getRegistration())!.active!.scriptURL
  );

  // Registering the worker under a new script URL is how the browser sees a
  // new release without needing a different build of sw.js.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?e2e-release=2", {
      scope: "/",
      updateViaCache: "none",
    });
  });

  const toast = page.locator("[data-horde='toast']", {
    hasText: "Update available",
  });
  await expect(toast).toBeVisible();
  // The new worker is installed but must not have taken over by itself.
  const state = await page.evaluate(async () => {
    const reg = (await navigator.serviceWorker.getRegistration())!;
    return {
      waiting: reg.waiting?.state,
      active: reg.active?.scriptURL,
      installing: !!reg.installing,
    };
  });
  expect(state.waiting).toBe("installed");
  expect(state.active).toBe(activeBefore);

  const reloaded = page.waitForEvent("load");
  await toast.getByRole("button", { name: "Reload" }).click();
  await reloaded;
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration())!.active?.scriptURL
      )
    )
    .toContain("e2e-release=2");
  await expect(
    page.getByRole("heading", { name: "Home", level: 1 })
  ).toBeVisible();
});

test.describe("offline downloads (mobile)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices["Pixel 7"].userAgent,
    isMobile: true,
    hasTouch: true,
  });

  test("download, play offline, offline home, reconnect, remove", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(120_000);
    const logs = trackConsole(page);

    // Find the seeded video id and its real streamed size.
    const list = await request.get("/api/videos?limit=100");
    expect(list.ok()).toBe(true);
    const body = await list.json();
    const items: { id: number; title: string }[] = body.items;
    const id = items.find((v) => v.title === TITLE)?.id;
    expect(id, `video "${TITLE}" not in /api/videos`).toBeTruthy();
    const full = await request.get(`/api/videos/${id}/stream`);
    expect(full.ok()).toBe(true);
    const size = (await full.body()).length;
    expect(size).toBeGreaterThan(100);

    await test.step("download on the watch page", async () => {
      await page.goto("/");
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.goto(`/watch/${id}`);
      await expect(
        page.getByRole("heading", { name: TITLE, level: 1 })
      ).toBeVisible();
      const btn = page.locator("[data-horde='offline-download']");
      await expect(btn).toHaveAttribute("data-status", "none");
      await btn.click();
      await expect(btn).toHaveAttribute("data-status", "complete", {
        timeout: 45_000,
      });
    });

    await test.step("offline reload still loads the shell and plays", async () => {
      await context.setOffline(true);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: TITLE, level: 1 })
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.locator("[data-horde='connection-tag']")
      ).toHaveAttribute("data-status", "offline", { timeout: 25_000 });

      const range = await page.evaluate(async (vid) => {
        const r = await fetch(`/api/videos/${vid}/stream`, {
          headers: { Range: "bytes=0-99" },
        });
        return {
          status: r.status,
          contentRange: r.headers.get("Content-Range"),
          len: (await r.arrayBuffer()).byteLength,
        };
      }, id);
      expect(range).toEqual({
        status: 206,
        contentRange: `bytes 0-99/${size}`,
        len: 100,
      });

      const ready = await page.evaluate(async () => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (!v) return { error: "no video element" };
        v.muted = true;
        if (v.readyState < 2) {
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            v.addEventListener("loadeddata", done, { once: true });
            v.addEventListener("canplay", done, { once: true });
            v.addEventListener("error", done, { once: true });
            setTimeout(done, 15_000);
            v.load();
          });
        }
        return { readyState: v.readyState, error: v.error?.message ?? null };
      });
      expect(ready, `console: ${logs.join(" | ")}`).toMatchObject({
        error: null,
      });
      expect(
        (ready as { readyState: number }).readyState
      ).toBeGreaterThanOrEqual(2);
    });

    await test.step("offline home lists downloads; server-only nav hidden", async () => {
      await page.goto("/");
      const offlinePage = page.locator("[data-horde='offline-page']");
      await expect(offlinePage).toBeVisible({ timeout: 20_000 });
      await expect(offlinePage.getByText(TITLE)).toBeVisible();
      await page.getByLabel("Toggle navigation menu").click();
      const nav = page.locator("[data-horde='nav-menu']");
      for (const label of ["Playlists", "History", "Download", "Import"]) {
        await expect(nav.getByText(label, { exact: true })).toHaveCount(0);
      }
      await expect(
        nav.getByRole("link", { name: "Settings", exact: true })
      ).toBeVisible();
    });

    await test.step("reconnect via connection tag", async () => {
      await context.setOffline(false);
      const tag = page.locator("[data-horde='connection-tag']");
      // It may already have auto-reconnected and vanished; click is best-effort.
      await tag.click({ timeout: 3_000 }).catch(() => {});
      await expect(tag).toHaveCount(0, { timeout: 30_000 });
    });

    await test.step("remove from /offline page", async () => {
      await page.goto("/offline");
      const offlinePage = page.locator("[data-horde='offline-page']");
      await expect(offlinePage.getByText(TITLE)).toBeVisible();
      await page
        .getByRole("button", { name: `Remove ${TITLE} from this device` })
        .click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(offlinePage.getByText(TITLE)).toHaveCount(0);
      await expect(offlinePage.getByText("No downloads yet")).toBeVisible();
    });
  });
});
