import { contextAs, CSRF_HEADERS, expect, test } from "./fixtures";

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
  // Synthetic HTML5 drag events: a real mouse drag depends on frame timing, and
  // under load the drop was sometimes released before dragover had run.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await handles.nth(1).dispatchEvent("dragstart", { dataTransfer: transfer });
  await rows.first().dispatchEvent("dragover", {
    dataTransfer: transfer,
  });
  await rows.first().dispatchEvent("drop", {
    dataTransfer: transfer,
  });
  await handles.nth(1).dispatchEvent("dragend", { dataTransfer: transfer });
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
  await page
    .locator("[id^='playlist-row-']")
    .filter({ has: page.getByRole("heading", { name: "Evening set" }) })
    .getByRole("button", { name: "Edit playlist" })
    .click();
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

test("a private playlist is seen and edited only by its owner", async ({
  page,
  browser,
  baseURL,
}) => {
  // The administrator makes one private playlist; the shared seed stays App-wide.
  await page.goto("/playlists");
  // The radio itself is visually hidden; the segmented control is its label.
  await page
    .locator("label")
    .filter({ hasText: /^Private$/ })
    .click();
  await expect(page.getByRole("radio", { name: "Private" })).toBeChecked();
  await page.getByPlaceholder("Playlist name").fill("Secret mix");
  await page.getByRole("button", { name: "Create" }).click();
  const secret = page.getByRole("heading", { name: "Secret mix", level: 3 });
  await expect(secret).toBeVisible();
  const secretRow = page
    .locator("[id^='playlist-row-']")
    .filter({ has: secret });
  await expect(secretRow.getByText("Private", { exact: true })).toBeVisible();
  const secretId = Number(
    (await secretRow.getAttribute("id"))!.replace("playlist-row-", "")
  );
  // Another account sees the shared playlist, "by admin", and nothing of the private one.
  const memberCtx = await contextAs(browser, baseURL, "member");
  const member = await memberCtx.newPage();
  await member.goto("/playlists");
  const evening = member
    .locator("[id^='playlist-row-']")
    .filter({ has: member.getByRole("heading", { name: "Evening set" }) });
  await expect(evening).toContainText("by admin");
  await expect(member.getByText("Secret mix")).toHaveCount(0);
  const hidden = await memberCtx.request.get(`/api/playlists/${secretId}`);
  expect(hidden.status()).toBe(404);
  const refused = await memberCtx.request.post(
    `/api/playlists/${secretId}/items`,
    { headers: CSRF_HEADERS, data: { video_id: 1 } }
  );
  expect(refused.status()).toBe(404);
  await memberCtx.close();

  // A viewer (no Manage playlists) may make a private playlist only, and can
  // look at, but not change, the shared one.
  const viewerCtx = await contextAs(browser, baseURL, "viewer");
  const viewer = await viewerCtx.newPage();
  await viewer.goto("/playlists");
  await expect(viewer.getByRole("radio", { name: "App-wide" })).toBeDisabled();
  await viewer.getByPlaceholder("Playlist name").fill("Viewer's own");
  await viewer.getByRole("button", { name: "Create" }).click();
  await expect(
    viewer.getByRole("heading", { name: "Viewer's own", level: 3 })
  ).toBeVisible();
  // Your own and the shared playlists are listed apart.
  await expect(
    viewer.getByRole("heading", { name: "Your playlists", level: 2 })
  ).toBeVisible();
  await expect(
    viewer.getByRole("heading", { name: "Shared with everyone", level: 2 })
  ).toBeVisible();
  const sharedRow = viewer
    .locator("[id^='playlist-row-']")
    .filter({ has: viewer.getByRole("heading", { name: "Evening set" }) });
  await sharedRow.getByRole("button", { name: "Expand playlist" }).click();
  await expect(
    viewer.getByRole("link", { name: /Aurora Drift/ })
  ).toBeVisible();
  await expect(sharedRow.getByRole("button", { name: "Delete" })).toHaveCount(
    0
  );
  await expect(sharedRow.getByTitle("Remove from playlist")).toHaveCount(0);
  await expect(
    sharedRow.getByRole("button", { name: "Edit playlist" })
  ).toHaveCount(0);
  await viewerCtx.close();

  // The administrator never sees the viewer's private playlist.
  await page.reload();
  await expect(page.getByText("Viewer's own")).toHaveCount(0);
});

test("a playlist mixes downloaded and streamed videos and can leave the server", async ({
  page,
}) => {
  await page.goto("/playlists");
  await page.getByRole("heading", { name: "Watch later", level: 3 }).click();
  const panelId = await page
    .getByRole("button", { name: "Collapse playlist" })
    .getAttribute("aria-controls");
  const panel = page.locator(`#${panelId}`);
  const header = page.locator(`#${panelId!.replace("panel", "row")}`);
  const entries = panel.locator("[data-horde='playlist-entry']");

  await expect(entries).toHaveCount(2);
  await expect(header.getByText("2 videos · 1 downloaded")).toBeVisible();
  const streamed = entries.filter({ hasText: "Ridge walk" });
  await expect(streamed.getByText("Not downloaded")).toBeVisible();
  // A streamed entry opens as a stream.
  await expect(streamed.getByRole("link")).toHaveAttribute(
    "href",
    /\/watch\?url=.*e2estream01/
  );
  await expect(
    panel.getByRole("button", { name: "Download all (1)" })
  ).toBeVisible();

  // Removing it from the server keeps it in the playlist, as a stream.
  await panel.getByRole("button", { name: "Remove from server" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Remove these videos from the server?",
  });
  await expect(dialog).toContainText("1 video");
  await dialog.getByRole("button", { name: "Remove from server" }).click();
  await expect(header.getByText("2 videos · 0 downloaded")).toBeVisible();
  await expect(
    entries.filter({ hasText: "Cedar Notes" }).getByText("Not downloaded")
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Download all (2)" })
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Remove from server" })
  ).toHaveCount(0);
});
