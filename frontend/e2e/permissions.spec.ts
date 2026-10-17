import type { APIRequestContext } from "@playwright/test";
import { contextAs, CSRF_HEADERS, expect, test, videoCard } from "./fixtures";

interface Account {
  id: number;
  username: string;
}

async function memberId(admin: APIRequestContext): Promise<number> {
  const users: Account[] = await (await admin.get("/api/users")).json();
  return users.find((u) => u.username === "member")!.id;
}

async function setMemberPermissions(
  admin: APIRequestContext,
  permissions: string[]
): Promise<void> {
  const resp = await admin.patch(`/api/users/${await memberId(admin)}`, {
    headers: CSRF_HEADERS,
    data: { is_admin: false, permissions },
  });
  expect(resp.ok()).toBeTruthy();
}

test("the admin turns permissions off and the member's screens follow after a reload", async ({
  page,
  browser,
  baseURL,
}) => {
  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/playlists");
  await expect(member.getByPlaceholder("Playlist name")).toBeVisible();
  await expect(member.getByRole("link", { name: /^Download\b/ })).toBeVisible();

  // The admin edits the member's account type in the Users settings.
  await page.goto("/settings?tab=users");
  await page.getByRole("button", { name: "Edit member", exact: true }).click();
  for (const label of [
    "Manage playlists",
    "Edit details",
    "Download and import",
  ]) {
    const box = page
      .getByRole("region", { name: "Users" })
      .getByRole("checkbox", { name: new RegExp(`^${label}`) });
    await expect(box).toBeChecked();
    await box.uncheck();
  }
  await page.getByRole("button", { name: "Save account type" }).click();
  await expect(page.getByText("Saved member")).toBeVisible();

  // Nothing changes under the member's feet until the page loads again.
  await member.reload();
  await expect(
    member.getByRole("heading", { name: "Playlists", level: 1 })
  ).toBeVisible();
  await expect(member.getByPlaceholder("Playlist name")).toHaveCount(0);
  await expect(member.getByRole("link", { name: /^Download\b/ })).toHaveCount(
    0
  );

  await member.getByRole("heading", { name: "Evening set", level: 3 }).click();
  await expect(
    member.getByRole("link", { name: /Aurora Drift/ })
  ).toBeVisible();
  await expect(member.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await member.goto("/");
  await videoCard(member, "Kiln fire").click();
  await member.getByTitle("More actions").click();
  await expect(
    member.getByRole("menuitemcheckbox", { name: /Autoplay related/ })
  ).toBeVisible();
  await expect(member.getByRole("menuitem", { name: "Add note" })).toHaveCount(
    0
  );
  await expect(
    member.getByRole("menuitem", { name: "Edit details" })
  ).toHaveCount(0);

  // The server enforces the same rules, with a sentence a person can act on.
  const refused = await ctx.request.post("/api/playlists", {
    headers: CSRF_HEADERS,
    data: { name: "Sneaky" },
  });
  expect(refused.status()).toBe(403);
  const body = await refused.json();
  expect(body.code).toBe("permission_denied");
  expect(body.detail).toContain("Manage playlists");
  await ctx.close();
});

test("a member whose permission was revoked mid-session sees the server's reason", async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  void page;
  const ctx = await contextAs(browser, baseURL, "member");
  const member = await ctx.newPage();
  await member.goto("/playlists");
  await member.getByRole("heading", { name: "Evening set", level: 3 }).click();
  await expect(
    member.getByRole("link", { name: /Harbor Lights/ })
  ).toBeVisible();

  await setMemberPermissions(request, ["download", "edit_metadata"]);

  // The open page still offers the action; the refusal arrives as a toast.
  await member.getByTitle("Remove from playlist").first().click();
  await expect(
    member.getByText(
      /Could not remove video: Your account is not allowed to do this \(Manage playlists\)/
    )
  ).toBeVisible();
  // Nothing was removed.
  await member.reload();
  await member.getByRole("heading", { name: "Evening set", level: 3 }).click();
  await expect(
    member.getByRole("link", { name: /Aurora Drift/ })
  ).toBeVisible();
  await expect(
    member.getByRole("link", { name: /Harbor Lights/ })
  ).toBeVisible();
  await ctx.close();
});
