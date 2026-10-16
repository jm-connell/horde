import type { Page } from "@playwright/test";
import { ACCOUNTS } from "./accounts";
import {
  anonymousContext,
  contextAs,
  CSRF_HEADERS,
  expect,
  signInWithForm,
  test,
  videoCard,
} from "./fixtures";

test("one account's watching and dismissals never touch another account's", async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  const { items } = await (await request.get("/api/videos")).json();
  const kiln = items.find((v: { title: string }) => v.title === "Kiln fire");

  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/history");
  await expect(member.getByText("No watch history yet.")).toBeVisible();

  // The member watches part of one video.
  const saved = await ctx.request.patch(`/api/videos/${kiln.id}/progress`, {
    headers: CSRF_HEADERS,
    data: { position_sec: 60 },
  });
  expect(saved.ok()).toBeTruthy();
  await member.reload();
  await expect(videoCard(member, "Kiln fire")).toBeVisible();
  await expect(videoCard(member, "Aurora Drift")).toHaveCount(0);

  await member.goto("/");
  const row = member.locator("section").filter({
    has: member.getByRole("heading", { name: "Continue watching" }),
  });
  await expect(videoCard(row, "Kiln fire")).toBeVisible();

  // The admin's history is theirs alone.
  await page.goto("/history");
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await expect(videoCard(page, "Harbor Lights")).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toHaveCount(0);

  // The member clears Kiln fire from the shelf; the admin's shelf is unchanged.
  await row
    .getByRole("button", { name: "Remove from continue watching" })
    .click();
  await expect(
    member.getByRole("heading", { name: "Continue watching" })
  ).toHaveCount(0);
  // Dismissing only hides the shelf entry; the member's history keeps the video.
  await member.goto("/history");
  await expect(videoCard(member, "Kiln fire")).toBeVisible();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Continue watching" })
  ).toBeVisible();
  await page.goto("/history");
  await expect(videoCard(page, "Aurora Drift")).toBeVisible();
  await ctx.close();
});

test("appearance choices belong to the account that made them", async ({
  page,
  browser,
  baseURL,
}) => {
  const waitForSave = () =>
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/settings") &&
        r.request().method() === "PATCH" &&
        r.ok()
    );

  await page.goto("/settings?tab=appearance");
  const saved = waitForSave();
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("option", { name: "OLED (true black)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
  await saved;

  // The member starts from the defaults and picks a different theme.
  const memberCtx = await contextAs(browser, baseURL, "member");
  const member = await memberCtx.newPage();
  await member.goto("/settings?tab=appearance");
  await expect(
    member.getByRole("heading", { name: "Settings", level: 1 })
  ).toBeVisible();
  await expect(member.locator("html")).not.toHaveAttribute(
    "data-theme",
    "oled"
  );
  const memberSaved = member.waitForResponse(
    (r) =>
      r.url().includes("/api/settings") &&
      r.request().method() === "PATCH" &&
      r.ok()
  );
  await member.getByRole("button", { name: "Theme" }).click();
  await member.getByRole("option", { name: "Nord" }).click();
  await expect(member.locator("html")).toHaveAttribute("data-theme", "nord");
  await memberSaved;

  // A fresh browser for each account (no shared local storage) gets its own
  // theme back from the server.
  const adminAgain = await contextAs(browser, baseURL, "admin");
  const adminPage = await adminAgain.newPage();
  await adminPage.goto("/");
  await expect(adminPage.locator("html")).toHaveAttribute("data-theme", "oled");
  const memberAgain = await contextAs(browser, baseURL, "member");
  const memberPage = await memberAgain.newPage();
  await memberPage.goto("/");
  await expect(memberPage.locator("html")).toHaveAttribute(
    "data-theme",
    "nord"
  );
  await Promise.all([memberCtx, adminAgain, memberAgain].map((c) => c.close()));
});

/** Progress saves queued in this browser while the server was unreachable. */
function pendingProgress(
  page: Page
): Promise<{ videoId: number; positionSec: number; owner?: number }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("horde-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("pendingProgress")) {
            db.close();
            return resolve([]);
          }
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

async function signOut(page: Page, username: string) {
  await page.getByRole("button", { name: new RegExp(`^${username}$`) }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Watch to 8 s on this device while progress saves can't reach the server. */
async function watchUnreachable(page: Page, videoId: number) {
  await page.goto(`/watch/${videoId}`);
  const video = page.locator("video").first();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.duration))
    .toBeGreaterThan(8);
  // Saves are throttled to one per 5 s: keep parking the playhead until the
  // queued position is this one.
  await expect
    .poll(
      async () => {
        await video.evaluate((v: HTMLVideoElement) => {
          v.pause();
          v.currentTime = 8;
        });
        const queued = await pendingProgress(page);
        return queued.find((p) => p.videoId === videoId)?.positionSec;
      },
      { timeout: 20_000 }
    )
    .toBe(8);
  // Leave the player, so nothing but the queue carries this position.
  await page.goto("/");
}

test("progress saved offline on a shared device is only synced to the account that watched", async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  // `page` resets the seeded data; the shared device is a cookie-less context.
  void page;
  const { items } = await (await request.get("/api/videos")).json();
  const idOf = (title: string) =>
    items.find((v: { title: string }) => v.title === title).id as number;
  const kiln = idOf("Kiln fire");
  const cedar = idOf("Cedar Notes");
  const ctx = await anonymousContext(browser, baseURL);
  /** Where the account signed in on the shared device is in `videoId`. */
  const position = async (videoId: number) =>
    (await (await ctx.request.get(`/api/videos/${videoId}`)).json())
      .last_position_sec as number;
  const whoAmI = async () =>
    (await (await ctx.request.get("/api/auth/state")).json()).user.id as number;

  const device = await ctx.newPage();
  await ctx.route("**/api/videos/*/progress", (route) =>
    route.abort("internetdisconnected")
  );

  // A save queued by an older release did not record whose it was: it is
  // dropped when the app upgrades this browser's offline database.
  await device.goto("/api/ping");
  await device.evaluate(
    (videoId) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("horde-offline", 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore("items", { keyPath: "videoId" });
          open.result.createObjectStore("pendingProgress", {
            keyPath: "videoId",
          });
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("pendingProgress", "readwrite");
          tx.objectStore("pendingProgress").put({
            videoId,
            positionSec: 30,
            at: Date.now(),
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

  // The member and then the admin each watch something while the server
  // can't be reached: both saves wait in this browser's queue.
  await device.goto("/");
  await signInWithForm(device, "member", ACCOUNTS.member.password);
  await expect(videoCard(device, "Kiln fire").first()).toBeVisible();
  const member = await whoAmI();
  await watchUnreachable(device, kiln);
  await signOut(device, "member");
  await signInWithForm(device, "admin", ACCOUNTS.admin.password);
  await expect(videoCard(device, "Aurora Drift").first()).toBeVisible();
  const admin = await whoAmI();
  await watchUnreachable(device, cedar);
  const queued = await pendingProgress(device);
  expect(queued).toHaveLength(2);
  expect(queued).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ videoId: kiln, positionSec: 8, owner: member }),
      expect.objectContaining({ videoId: cedar, positionSec: 8, owner: admin }),
    ])
  );

  // A save for a video deleted since (id 0 sorts first) must not hold the
  // admin's other saves back.
  await device.evaluate(
    (owner) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("horde-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("pendingProgress", "readwrite");
          tx.objectStore("pendingProgress").put({
            owner,
            videoId: 0,
            positionSec: 8,
            at: Date.now(),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    admin
  );

  // Back online with the admin signed in: only the admin's save is sent.
  await ctx.unroute("**/api/videos/*/progress");
  await device.reload();
  await expect.poll(() => position(cedar)).toBe(8);
  await expect
    .poll(() => pendingProgress(device))
    .toEqual([expect.objectContaining({ videoId: kiln, owner: member })]);
  expect(await position(kiln)).toBe(0);

  // The member comes back: their position reaches their own history.
  await signOut(device, "admin");
  // Signing in is enough; no reload or change of connection needed.
  await signInWithForm(device, "member", ACCOUNTS.member.password);
  await expect.poll(() => position(kiln)).toBe(8);
  await expect.poll(() => pendingProgress(device)).toEqual([]);
  expect(await position(cedar)).toBe(0);
  await ctx.close();
});
