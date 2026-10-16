import { expect, test } from "./fixtures";

test("a playlist is built, reordered, trimmed and deleted", async ({
  page,
}) => {
  await page.goto("/playlists");
  await page.getByPlaceholder("Playlist name").fill("Weekend mix");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend mix", level: 3 })
  ).toBeVisible();

  // Everything below happens inside the open playlist's panel.
  const panelId = await page
    .getByRole("button", { name: "Collapse playlist" })
    .getAttribute("aria-controls");
  const panel = page.locator(`#${panelId}`);
  const header = page.locator(`#${panelId!.replace("panel", "row")}`);
  await expect(panel.getByText("No videos yet.")).toBeVisible();

  // Add two library videos from the playlist's own search box.
  for (const title of ["Kiln fire", "Cedar Notes"]) {
    // The search box stays open after an add, ready for the next video.
    const opener = panel.getByRole("button", {
      name: "Add Video",
      exact: true,
    });
    if ((await opener.getAttribute("aria-expanded")) === "false") {
      await opener.click();
    }
    await panel
      .getByRole("combobox", {
        name: "Search library or paste a download link",
      })
      .fill(title);
    await panel.getByRole("option", { name: new RegExp(title) }).click();
    await expect(
      panel.getByRole("link", { name: new RegExp(title) })
    ).toBeVisible();
  }
  const rows = panel.getByRole("link", { name: /Kiln fire|Cedar Notes/ });
  await expect(rows).toHaveText([/Kiln fire/, /Cedar Notes/]);
  await expect(header.getByText("2 videos")).toBeVisible();

  // Drag the second video above the first; the order survives a reload.
  const handles = panel.getByRole("button", { name: "Drag to reorder videos" });
  await handles.nth(1).dragTo(rows.first());
  await expect(rows).toHaveText([/Cedar Notes/, /Kiln fire/]);
  // The reload keeps this playlist open (?open=<id>).
  await page.reload();
  await expect(rows).toHaveText([/Cedar Notes/, /Kiln fire/]);

  // Remove one.
  await panel.getByTitle("Remove from playlist").first().click();
  await expect(rows).toHaveText([/Kiln fire/]);
  await expect(header.getByText("1 video", { exact: true })).toBeVisible();

  // Deleting asks first; cancelling keeps the playlist.
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this playlist?" });
  await expect(dialog).toContainText("Videos stay in your library.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Weekend mix", level: 3 })
  ).toBeVisible();

  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend mix", level: 3 })
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Evening set", level: 3 })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekend mix", level: 3 })
  ).toHaveCount(0);

  // The videos themselves are untouched.
  await page.goto("/");
  await expect(
    page.locator("[data-horde='video-card']", { hasText: "Kiln fire" })
  ).toBeVisible();
});

test("playlists can be renamed from the row", async ({ page }) => {
  await page.goto("/playlists");
  await page.getByRole("button", { name: "Edit playlist" }).click();
  const name = page.getByLabel("Playlist name");
  await name.fill("Night set");
  await name.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Night set", level: 3 })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Night set", level: 3 })
  ).toBeVisible();
});
