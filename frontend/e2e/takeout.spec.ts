import type { Page } from "@playwright/test";
import { expect, openNav, test } from "./fixtures";

const DAY = 24 * 60 * 60 * 1000;

function view(id: string, daysAgo: number, title: string, channel: string) {
  return {
    header: "YouTube",
    title: `Watched ${title}`,
    titleUrl: `https://www.youtube.com/watch?v=${id}`,
    subtitles: [
      {
        name: channel,
        url: `https://www.youtube.com/channel/UC${channel.replace(/\W/g, "")}`,
      },
    ],
    time: new Date(Date.now() - daysAgo * DAY).toISOString(),
    products: ["YouTube"],
  };
}

const HISTORY = [
  view("takeout0001", 1, "Raku firing at night", "Kiln Club"),
  view("takeout0001", 3, "Raku firing at night", "Kiln Club"),
  view("takeout0001", 9, "Raku firing at night", "Kiln Club"),
  view("takeout0002", 2, "Throwing a big bowl", "Wheel Days"),
];

const SUBSCRIPTIONS = [
  "Channel Id,Channel Url,Channel Title",
  "UCKilnClub,http://www.youtube.com/channel/UCKilnClub,Kiln Club",
  "UCWheelDays,http://www.youtube.com/channel/UCWheelDays,Wheel Days",
  "UCGlazeLab,http://www.youtube.com/channel/UCGlazeLab,Glaze Lab",
].join("\n");

const PLAYLISTS = [
  "Playlist ID,Add new videos to top,Playlist Title (Original),Playlist Title (Original Language),Playlist Create Timestamp,Playlist Update Timestamp,Playlist Video Order,Playlist Visibility",
  "PLe2epottery,False,Pottery to try,,,,Manual,Private",
].join("\n");

const PLAYLIST_VIDEOS = [
  "Video ID,Playlist Video Creation Timestamp",
  "takeout0001,2024-01-01T00:00:00+00:00",
  "takeout0003,2024-01-01T00:00:00+00:00",
].join("\n");

/** The loose files of an unzipped export (the import takes those as well as the .zip). */
function exportFiles() {
  return [
    {
      name: "watch-history.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(HISTORY)),
    },
    {
      name: "subscriptions.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(SUBSCRIPTIONS),
    },
    {
      name: "playlists.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(PLAYLISTS),
    },
    {
      name: "Pottery to try-videos.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(PLAYLIST_VIDEOS),
    },
  ];
}

async function openImport(page: Page) {
  await page.goto("/settings?tab=library");
  await page
    .getByRole("button", { name: "Import from Google Takeout" })
    .click();
  return page.getByRole("dialog", { name: "Import from Google Takeout" });
}

test("imports a Takeout export and lets the user pick what to keep", async ({
  page,
}) => {
  const dialog = await openImport(page);
  await dialog.getByLabel("Choose export").setInputFiles(exportFiles());
  await dialog.getByRole("button", { name: "Import", exact: true }).click();

  await expect(dialog.getByText("4 new views")).toBeVisible();
  const subs = dialog.getByRole("region", { name: /Subscriptions/ });
  await expect(subs.getByRole("checkbox")).toHaveCount(3);
  await subs
    .getByRole("button", { name: "Deselect all subscriptions" })
    .click();
  await expect(subs.getByText("0 of 3 selected")).toBeVisible();
  await subs.getByRole("checkbox", { name: /Glaze Lab/ }).check();
  await subs
    .getByRole("button", { name: "Select all subscriptions", exact: true })
    .click();
  await expect(subs.getByText("3 of 3 selected")).toBeVisible();
  await subs.getByRole("checkbox", { name: /Wheel Days/ }).uncheck();

  const lists = dialog.getByRole("region", { name: /Playlists/ });
  await expect(
    lists.getByRole("checkbox", { name: /Pottery to try/ })
  ).toBeChecked();

  await dialog.getByRole("button", { name: /Import selected \(3\)/ }).click();
  await expect(
    dialog.getByText(/followed 2 channels, created 1 playlist/)
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();

  const follows = (await (await page.request.get("/api/follows")).json())
    .items as { channel_name: string }[];
  expect(follows.map((f) => f.channel_name).sort()).toEqual(
    expect.arrayContaining(["Glaze Lab", "Kiln Club"])
  );
  expect(follows.map((f) => f.channel_name)).not.toContain("Wheel Days");
  await expect(page.getByText(/4 views of 2 videos/)).toBeVisible();

  // Re-importing the same export adds nothing twice.
  const again = await openImport(page);
  await again.getByLabel("Choose export").setInputFiles(exportFiles());
  await again.getByRole("button", { name: "Import", exact: true }).click();
  await expect(again.getByText("0 new views")).toBeVisible();
  await expect(again.getByText("(4 already here)")).toBeVisible();
  await expect(
    again
      .getByRole("region", { name: /Playlists/ })
      .getByText("Imported before · up to date")
  ).toBeVisible();
  await expect(
    again
      .getByRole("region", { name: /Subscriptions/ })
      .getByRole("checkbox", { name: /Kiln Club/ })
  ).toBeDisabled();
});

test("suggests downloads watched often and adds YouTube views to stats on request", async ({
  page,
}) => {
  const dialog = await openImport(page);
  await dialog.getByLabel("Choose export").setInputFiles(exportFiles());
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByText("4 new views")).toBeVisible();
  await dialog.getByRole("switch").click();
  await dialog.getByRole("button", { name: "Close" }).first().click();

  await openNav(page, "Download");
  const toggle = page.getByRole("button", { name: /Watched often on YouTube/ });
  await expect(toggle).toContainText("1");
  await toggle.click();
  const row = page.getByRole("listitem").filter({
    hasText: "Raku firing at night",
  });
  await expect(row).toContainText("watched 3 times");
  await expect(row.getByRole("button", { name: "Download" })).toBeVisible();

  await openNav(page, "History");
  await page.getByRole("button", { name: /More stats/ }).click();
  await expect(page.getByText(/4 YouTube views/)).toBeVisible();
});
