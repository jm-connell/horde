import type { BrowserContext, Page } from "@playwright/test";
import { ACCOUNTS, type AccountName } from "./accounts";
import {
  anonymousContext,
  contextAs,
  CSRF_HEADERS,
  expect,
  signInWithForm,
  test,
  videoCard,
} from "./fixtures";

/**
 * Resume points belong to the account, not the device: a position saved on
 * one device is where every other device of the same account picks up, and
 * other accounts keep their own.
 */

type IdOf = (title: string) => number;

async function seededIds(page: Page): Promise<IdOf> {
  const { items } = await (await page.request.get("/api/videos")).json();
  return (title: string) =>
    items.find((v: { title: string }) => v.title === title).id as number;
}

/** The signed-in account's saved position for `videoId`, as the server has it. */
async function serverPosition(page: Page, videoId: number): Promise<number> {
  const res = await page.request.get(`/api/videos/${videoId}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).last_position_sec as number;
}

function player(page: Page) {
  return page.locator("video").first();
}

async function waitForMedia(page: Page) {
  await expect
    .poll(() => player(page).evaluate((v: HTMLVideoElement) => v.duration))
    .toBeGreaterThan(16);
}

/** Pause at `sec` and seek there (the player saves as it goes). */
async function parkAt(page: Page, sec: number) {
  await player(page).evaluate((v: HTMLVideoElement, at) => {
    v.pause();
    v.currentTime = at;
  }, sec);
}

/**
 * Watch `videoId` on this device up to `sec` and leave it paused there, until
 * the server has that position. Saves are throttled, so keep parking the
 * playhead until the latest save is this one.
 */
async function watchTo(page: Page, videoId: number, sec: number) {
  await waitForMedia(page);
  await expect
    .poll(
      async () => {
        await parkAt(page, sec);
        return serverPosition(page, videoId);
      },
      { timeout: 20_000 }
    )
    .toBe(sec);
}

/**
 * Where the player started: the first playhead past 1 s. A player that
 * resumed is already there; one that started from 0 is read as it passes 1 s.
 *
 * `leaving` is where a player already on the page sits paused (the
 * mini-player of the same video): it keeps that playhead until the opened
 * video arrives, so the start is the first playhead away from it. One that
 * wrongly carries on from there is read as it plays past.
 */
async function startPosition(page: Page, leaving?: number): Promise<number> {
  const video = player(page);
  const started = (t: number) =>
    t > 1 && (leaving === undefined || Math.abs(t - leaving) > 0.5);
  await expect
    .poll(
      async () =>
        started(await video.evaluate((v: HTMLVideoElement) => v.currentTime)),
      { timeout: 20_000 }
    )
    .toBe(true);
  return video.evaluate((v: HTMLVideoElement) => v.currentTime);
}

/** Record every time the playhead goes back by more than a second. */
async function trackRewinds(page: Page) {
  await player(page).evaluate((v: HTMLVideoElement) => {
    const w = window as unknown as { rewinds: number[] };
    w.rewinds = [];
    let last = v.currentTime;
    v.addEventListener("timeupdate", () => {
      if (v.currentTime < last - 1) w.rewinds.push(last);
      last = v.currentTime;
    });
  });
}

function rewinds(page: Page): Promise<number[]> {
  return page.evaluate(
    () => (window as unknown as { rewinds: number[] }).rewinds
  );
}

async function signedInDevice(
  browser: import("@playwright/test").Browser,
  baseURL: string | undefined,
  name: AccountName
): Promise<{ ctx: BrowserContext; page: Page }> {
  // Its own sign-in, so its own session: a second device, not a second tab.
  const ctx = await anonymousContext(browser, baseURL);
  const page = await ctx.newPage();
  await page.goto("/");
  await signInWithForm(page, name, ACCOUNTS[name].password);
  await expect(videoCard(page, "Kiln fire").first()).toBeVisible();
  return { ctx, page };
}

async function signOut(page: Page, username: string) {
  await page.getByRole("button", { name: new RegExp(`^${username}$`) }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

test("a position saved on one device is where the account's other devices start", async ({
  page: phone,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const idOf = await seededIds(phone);
  const kiln = idOf("Kiln fire");
  const { ctx: pcCtx, page: pc } = await signedInDevice(
    browser,
    baseURL,
    "admin"
  );

  // The PC opened the video earlier and left it paused in the mini-player.
  await videoCard(pc, "Kiln fire").first().click();
  await waitForMedia(pc);
  await parkAt(pc, 2);
  await pc.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(videoCard(pc, "Kiln fire").first()).toBeVisible();

  // The phone watches to 12 s.
  await phone.goto(`/watch/${kiln}`);
  await watchTo(phone, kiln, 12);

  // The PC opens it again, without a reload, and picks up there.
  await videoCard(pc, "Kiln fire").first().click();
  await expect(pc).toHaveURL(new RegExp(`/watch/${kiln}$`));
  const pcStart = await startPosition(pc, 2);
  expect(pcStart).toBeGreaterThanOrEqual(11.5);
  expect(pcStart).toBeLessThan(16);

  // Another account has its own place in the same video.
  const memberCtx = await contextAs(browser, baseURL, "member");
  const member = await memberCtx.newPage();
  expect(
    (
      await member.request.patch(`/api/videos/${kiln}/progress`, {
        headers: CSRF_HEADERS,
        data: { position_sec: 6 },
      })
    ).ok()
  ).toBeTruthy();
  await member.goto(`/watch/${kiln}`);
  const memberStart = await startPosition(member);
  expect(memberStart).toBeGreaterThanOrEqual(5.5);
  expect(memberStart).toBeLessThan(10);

  // And one that never watched it starts at the beginning.
  const viewerCtx = await contextAs(browser, baseURL, "viewer");
  const viewer = await viewerCtx.newPage();
  await viewer.goto(`/watch/${kiln}`);
  expect(await startPosition(viewer)).toBeLessThan(3);

  await Promise.all([pcCtx, memberCtx, viewerCtx].map((c) => c.close()));
});

test("pausing saves the position the player stopped at", async ({
  page: phone,
  browser,
  baseURL,
}) => {
  const idOf = await seededIds(phone);
  const kiln = idOf("Kiln fire");
  await phone.goto(`/watch/${kiln}`);
  await watchTo(phone, kiln, 6);
  // A save just went out; stop a few seconds later, inside the throttle window.
  await parkAt(phone, 11);
  await expect
    .poll(() => serverPosition(phone, kiln), { timeout: 10_000 })
    .toBe(11);

  const { ctx, page: pc } = await signedInDevice(browser, baseURL, "admin");
  await pc.goto(`/watch/${kiln}`);
  const start = await startPosition(pc);
  expect(start).toBeGreaterThanOrEqual(10.5);
  expect(start).toBeLessThan(15);
  await ctx.close();
});

test("refreshing the details of a playing video does not rewind it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const idOf = await seededIds(page);
  const kiln = idOf("Kiln fire");
  // Subtitles still being fetched: the page and the player re-read the video
  // every few seconds, each time with the position saved a moment ago.
  await page.route(`**/api/videos/${kiln}`, async (route) => {
    // The page cancels a re-read when a newer one starts; reading a cancelled
    // response throws "Response has been disposed". Nothing waits on that
    // request any more, so let it go.
    try {
      const response = await route.fetch();
      const json = { ...(await response.json()), subtitles_pending: true };
      await route.fulfill({ response, json });
    } catch (err) {
      if (!String(err).includes("disposed")) throw err;
    }
  });
  await page.goto(`/watch/${kiln}`);
  await waitForMedia(page);
  const video = player(page);
  await trackRewinds(page);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), {
      timeout: 30_000,
    })
    .toBeGreaterThan(14);
  expect(await rewinds(page)).toEqual([]);
});

test("a paused player picks up another device's progress when the tab comes back", async ({
  page: phone,
  browser,
  baseURL,
}) => {
  const idOf = await seededIds(phone);
  const kiln = idOf("Kiln fire");
  const { ctx, page: pc } = await signedInDevice(browser, baseURL, "admin");
  await pc.goto(`/watch/${kiln}`);
  await watchTo(pc, kiln, 6);

  // The PC sits paused in the background while the phone carries on.
  await phone.goto(`/watch/${kiln}`);
  await watchTo(phone, kiln, 14);

  await pc.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  const video = player(pc);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(14, 0);
  // Brought up to date, not started.
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await ctx.close();
});

test("expanding the mini-player carries on from the playhead", async ({
  page,
}) => {
  const idOf = await seededIds(page);
  const kiln = idOf("Kiln fire");
  await page.goto(`/watch/${kiln}`);
  await waitForMedia(page);
  const video = player(page);
  const now = () => video.evaluate((v: HTMLVideoElement) => v.currentTime);
  // Saves go out every 5 s: at 8 s the server is a few seconds behind.
  await expect.poll(now, { timeout: 20_000 }).toBeGreaterThan(8);
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await trackRewinds(page);
  const mini = page.locator(".player-mini");
  await mini.hover();
  await mini.getByRole("button", { name: "Expand" }).click();
  await expect(page).toHaveURL(new RegExp(`/watch/${kiln}$`));
  await expect(
    page.getByRole("heading", { name: "Kiln fire", level: 1 })
  ).toBeVisible();
  const at = await now();
  await expect.poll(now).toBeGreaterThan(at + 1);
  expect(await rewinds(page)).toEqual([]);
});

/** Positions queued in this browser while progress saves could not get through. */
function pendingProgress(
  page: Page
): Promise<{ videoId: number; positionSec: number; owner: number }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("horde-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db
            .transaction("pendingProgress", "readonly")
            .objectStore("pendingProgress")
            .getAll();
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      })
  );
}

test("a newer position this device could not send wins, an older one does not", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const idOf = await seededIds(page);
  const kiln = idOf("Kiln fire");
  const save = async (sec: number) =>
    expect(
      (
        await page.request.patch(`/api/videos/${kiln}/progress`, {
          headers: CSRF_HEADERS,
          data: { position_sec: sec },
        })
      ).ok()
    ).toBeTruthy();

  // Another device saved 6 s a while ago.
  await save(6);

  // This device watches to 9 s while its saves can't reach the server.
  await context.route("**/api/videos/*/progress", (route) =>
    route.abort("internetdisconnected")
  );
  await page.goto(`/watch/${kiln}`);
  await waitForMedia(page);
  await expect
    .poll(
      async () => {
        await parkAt(page, 9);
        const queued = await pendingProgress(page);
        return queued.find((p) => p.videoId === kiln)?.positionSec;
      },
      { timeout: 20_000 }
    )
    .toBe(9);
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Opened again (still online): the unsent 9 s is newer than the server's 6 s.
  await videoCard(page, "Kiln fire").first().click();
  const start = await startPosition(page);
  expect(start).toBeGreaterThanOrEqual(8.5);
  expect(start).toBeLessThan(13);
  await parkAt(page, 9);
  await page.goto("/");

  // Later another device moves on to 15 s; then this one gets through again.
  await new Promise((r) => setTimeout(r, 1100));
  await save(15);
  await context.unroute("**/api/videos/*/progress");
  await page.reload();
  await expect.poll(() => pendingProgress(page)).toEqual([]);
  // The older queued 9 s did not overwrite the newer 15 s.
  expect(await serverPosition(page, kiln)).toBe(15);
});

/** Status of this browser's offline copy of `videoId`, if it has one. */
function offlineStatus(page: Page, videoId: number): Promise<string | null> {
  return page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("horde-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db
            .transaction("items", "readonly")
            .objectStore("items")
            .get(id);
          req.onsuccess = () => {
            db.close();
            resolve(req.result?.status ?? null);
          };
          req.onerror = () => reject(req.error);
        };
      }),
    videoId
  );
}

test.describe("offline copies", () => {
  test("each account on a shared device resumes a downloaded video from its own place", async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    const idOf = await seededIds(page);
    const kiln = idOf("Kiln fire");
    const ctx = await anonymousContext(browser, baseURL);
    const device = await ctx.newPage();
    await device.goto("/");
    await device.evaluate(() => navigator.serviceWorker.ready);
    await signInWithForm(device, "admin", ACCOUNTS.admin.password);
    await expect(videoCard(device, "Kiln fire").first()).toBeVisible();

    // The admin saves the video on this device and watches to 12 s.
    await videoCard(device, "Kiln fire").first().click();
    await device.getByTitle("More actions").click();
    await device
      .getByRole("menuitem", { name: "Download for offline" })
      .click();
    await expect
      .poll(() => offlineStatus(device, kiln), { timeout: 45_000 })
      .toBe("complete");
    await watchTo(device, kiln, 12);

    // The member, on the same device, watches the saved copy to 6 s.
    await signOut(device, "admin");
    await signInWithForm(device, "member", ACCOUNTS.member.password);
    await videoCard(device, "Kiln fire").first().click();
    await watchTo(device, kiln, 6);
    await signOut(device, "member");

    // The admin signs back in, and later opens the saved copy offline.
    await signInWithForm(device, "admin", ACCOUNTS.admin.password);
    await expect(videoCard(device, "Kiln fire").first()).toBeVisible();
    await ctx.setOffline(true);
    await device.goto(`/watch/${kiln}`);
    await expect(
      device.locator("[data-horde='connection-tag']")
    ).toHaveAttribute("data-status", "offline", { timeout: 25_000 });
    const start = await startPosition(device);
    expect(start).toBeGreaterThanOrEqual(11.5);
    expect(start).toBeLessThan(16);
    await ctx.close();
  });
});

test("the position an older release kept on a saved video is not given to anyone", async ({
  page,
  browser,
  baseURL,
}) => {
  const idOf = await seededIds(page);
  const kiln = idOf("Kiln fire");
  const ctx = await anonymousContext(browser, baseURL);
  const device = await ctx.newPage();
  // A saved video as release 2 of the offline database stored it: one
  // position for the whole device, whoever played it last.
  await device.goto("/api/ping");
  await device.evaluate(
    (videoId) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("horde-offline", 2);
        open.onupgradeneeded = () => {
          open.result.createObjectStore("items", { keyPath: "videoId" });
          open.result.createObjectStore("pendingProgress", {
            keyPath: ["owner", "videoId"],
          });
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("items", "readwrite");
          tx.objectStore("items").put({
            videoId,
            video: {
              id: videoId,
              title: "Kiln fire",
              duration_sec: 300,
              last_position_sec: 50,
              last_watched_at: new Date().toISOString(),
            },
            status: "paused",
            sourceUrl: `/api/videos/${videoId}/stream`,
            contentType: "video/mp4",
            totalBytes: 0,
            chunkSize: 4 * 1024 * 1024,
            chunksDone: 0,
            extras: [],
            createdAt: Date.now(),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    kiln
  );

  await device.goto("/");
  await signInWithForm(device, "member", ACCOUNTS.member.password);
  await expect(videoCard(device, "Kiln fire").first()).toBeVisible();
  const stored = await device.evaluate(
    (videoId) =>
      new Promise<{ position: number; owned: unknown[] }>((resolve, reject) => {
        const open = indexedDB.open("horde-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(["items", "resumePositions"], "readonly");
          const item = tx.objectStore("items").get(videoId);
          const owned = tx.objectStore("resumePositions").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              position: item.result.video.last_position_sec,
              owned: owned.result,
            });
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    kiln
  );
  expect(stored).toEqual({ position: 0, owned: [] });
  await ctx.close();
});
