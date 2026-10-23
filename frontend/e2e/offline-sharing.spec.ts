import type { Page } from "@playwright/test";
import { ACCOUNTS } from "./accounts";
import { expect, signInWithForm, test } from "./fixtures";

const TITLE = "Harbor Lights";
const ADMIN = ACCOUNTS.admin;
const MEMBER = ACCOUNTS.member;

/** The account actions: a dropdown on wide screens (these specs run on desktop). */
async function signOut(page: Page) {
  await page.locator('[data-horde="account-menu"]').click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function signInAs(
  page: Page,
  account: { username: string; password: string }
) {
  await signInWithForm(page, account.username, account.password);
  await expect(page.locator('[data-horde="account-menu"]')).toContainText(
    account.username
  );
}

/** The seeded video's id, from the API. */
async function videoId(page: Page): Promise<number> {
  const list = await page.request.get("/api/videos?limit=100");
  const items: { id: number; title: string }[] = (await list.json()).items;
  const id = items.find((v) => v.title === TITLE)?.id;
  expect(id, `video "${TITLE}" not in /api/videos`).toBeTruthy();
  return id as number;
}

/** What this browser has saved for offline viewing, read from its IndexedDB. */
async function savedVideos(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ videoId: number; status: string; owner?: number }[]>(
        (resolve, reject) => {
          const open = indexedDB.open("horde-offline");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const all = open.result
              .transaction("items")
              .objectStore("items")
              .getAll();
            all.onerror = () => reject(all.error);
            all.onsuccess = () => resolve(all.result);
          };
        }
      )
  );
}

/** Save the video for offline viewing from the watch page's ••• menu. */
async function saveForOffline(page: Page, id: number) {
  await page.goto(`/watch/${id}`);
  await page.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Download for offline" }).click();
  await expect
    .poll(async () => (await savedVideos(page)).map((v) => v.status), {
      timeout: 45_000,
    })
    .toEqual(["complete"]);
}

async function setSharing(page: Page, share: boolean, password?: string) {
  await page.goto("/account");
  const box = page.getByLabel("Share my downloads with other accounts");
  await expect(box).toBeVisible();
  if (share) {
    await box.click();
  } else {
    await box.uncheck();
    await page.getByLabel("Your password").fill(password ?? "");
    await page
      .getByRole("button", { name: "Keep my downloads private" })
      .click();
  }
  await expect(box).toBeChecked({ checked: share });
  await expect(
    page.getByText(/Your downloads are private|Other accounts can see/)
  ).toBeVisible();
}

test.describe("sharing offline downloads between accounts", () => {
  // These tests sign accounts out, which ends the session; the seeded
  // browser state's session must survive for the other specs, so every test
  // signs in through the form for a session of its own.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await signInAs(page, ADMIN);
  });

  test("a private download is hidden from the next account and unlocks offline", async ({
    page,
    context,
  }) => {
    test.setTimeout(150_000);
    const id = await videoId(page);
    const offlinePage = page.locator("[data-horde='offline-page']");
    const notice = page.locator("[data-horde='private-downloads-notice']");

    await test.step("admin keeps downloads private and saves a video", async () => {
      await page.goto("/");
      await page.evaluate(() => navigator.serviceWorker.ready);
      await setSharing(page, false, ADMIN.password);
      await saveForOffline(page, id);
      // Stamped with the account that saved it.
      expect((await savedVideos(page))[0].owner).toBeGreaterThan(0);
    });

    await test.step("the next account sees a notice, not the video", async () => {
      await page.goto("/account");
      await signOut(page);
      await signInAs(page, MEMBER);
      await page.goto("/offline");
      await expect(offlinePage).toBeVisible();
      await expect(offlinePage.getByText(TITLE)).toHaveCount(0);
      await expect(notice).toContainText(
        "1 video saved by admin on this device is private. Switch to admin to watch it."
      );
      await expect(
        notice.getByRole("button", { name: "Switch account" })
      ).toBeVisible();
    });

    await test.step("the video is not offered as already saved to the next account", async () => {
      await page.goto(`/watch/${id}`);
      await page.getByTitle("More actions").click();
      await expect(
        page.getByRole("menuitem", { name: "Download for offline" })
      ).toBeVisible();
    });

    await test.step("offline, the owner's password unlocks it", async () => {
      await page.goto("/offline");
      await expect(notice).toBeVisible();
      await context.setOffline(true);
      await page.reload();
      await expect(
        page.locator("[data-horde='connection-tag']")
      ).toHaveAttribute("data-status", "offline", { timeout: 25_000 });
      await expect(notice).toContainText("Unlock admin to watch it.");
      await expect(
        notice.getByRole("button", { name: "Switch account" })
      ).toHaveCount(0);

      await notice.getByRole("button", { name: "Unlock" }).click();
      await page.getByLabel("Password for admin").fill("not-the-password");
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(
        page.getByText("That password doesn’t match.")
      ).toBeVisible();

      await page.getByLabel("Password for admin").fill(ADMIN.password);
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(offlinePage.getByText(TITLE)).toBeVisible();
      await expect(notice).toHaveCount(0);
      await expect(page.locator('[data-horde="account-menu"]')).toContainText(
        "admin (offline)"
      );
    });

    await test.step("back online, the server's session wins again", async () => {
      await context.setOffline(false);
      const tag = page.locator("[data-horde='connection-tag']");
      await tag.click({ timeout: 3_000 }).catch(() => {});
      await expect(tag).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator('[data-horde="account-menu"]')).toContainText(
        "member"
      );
      await expect(
        page.locator('[data-horde="account-menu"]')
      ).not.toContainText("offline");
      await expect(notice).toBeVisible();
    });

    await test.step("online, Switch account signs out with the name filled in", async () => {
      await notice.getByRole("button", { name: "Switch account" }).click();
      await expect(page).toHaveURL(/\/login\?username=admin$/);
      await expect(page.getByLabel("Username")).toHaveValue("admin");
    });
  });

  test("sharing again shows the video to the next account as saved by its owner", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const id = await videoId(page);

    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await saveForOffline(page, id);

    // Shared by default: the next account sees it straight away.
    await signOut(page);
    await signInAs(page, MEMBER);
    await page.goto("/offline");
    const offlinePage = page.locator("[data-horde='offline-page']");
    await expect(offlinePage.getByText(TITLE)).toBeVisible();
    await expect(offlinePage.getByText("Saved by admin")).toBeVisible();
    await expect(
      page.locator("[data-horde='private-downloads-notice']")
    ).toHaveCount(0);

    // Private, then shared again: the device follows the owner's last choice.
    await signOut(page);
    await signInAs(page, ADMIN);
    await setSharing(page, false, ADMIN.password);
    await signOut(page);
    await signInAs(page, MEMBER);
    await page.goto("/offline");
    await expect(offlinePage.getByText(TITLE)).toHaveCount(0);
    await signOut(page);
    await signInAs(page, ADMIN);
    await setSharing(page, true);
    await signOut(page);
    await signInAs(page, MEMBER);
    await page.goto("/offline");
    await expect(offlinePage.getByText(TITLE)).toBeVisible();
    await expect(offlinePage.getByText("Saved by admin")).toBeVisible();

    // Anyone who can see a shared download can remove it.
    await page
      .getByRole("button", { name: `Remove ${TITLE} from this device` })
      .click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(offlinePage.getByText(TITLE)).toHaveCount(0);
  });

  test("turning sharing off asks for the right password", async ({ page }) => {
    await page.goto("/account");
    const box = page.getByLabel("Share my downloads with other accounts");
    await box.uncheck();
    await page.getByLabel("Your password").fill("wrong-password");
    await page
      .getByRole("button", { name: "Keep my downloads private" })
      .click();
    await expect(page.getByText("Current password is incorrect")).toBeVisible();
    const me = await page.request.get("/api/auth/state");
    expect((await me.json()).user.share_downloads).toBe(true);
  });

  test("an administrator sets sharing when adding and editing a user", async ({
    page,
  }) => {
    await page.goto("/account");
    await page.getByRole("button", { name: "Add a user" }).click();
    await page.getByLabel("Username").fill("kid");
    await page.getByLabel("Password", { exact: true }).fill("kid-password-1");
    const box = page.getByLabel("Share this account’s downloads");
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByRole("button", { name: "Add user" }).click();
    await expect(page.getByText("Created kid")).toBeVisible();

    const row = page.locator("[data-horde='user-row']", { hasText: "kid" });
    await row.getByRole("button", { name: "Edit kid" }).click();
    const edit = row.getByLabel("Share this account’s downloads");
    await expect(edit).not.toBeChecked();
    await edit.click();
    await expect(page.getByText("kid’s downloads are shared")).toBeVisible();
    const users = await page.request.get("/api/users");
    const kid = (await users.json()).find(
      (u: { username: string }) => u.username === "kid"
    );
    expect(kid.share_downloads).toBe(true);
  });
});
