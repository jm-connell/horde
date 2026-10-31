import { expectNoSeriousViolations } from "./axe";
import { expect, hasDesktopPlayerChrome, test, videoCard } from "./fixtures";

const sse = (events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test("the search bar finds the moment an Ask channel said something", async ({
  page,
}) => {
  test.skip(
    !hasDesktopPlayerChrome(page),
    "phones open search from the nav button"
  );
  await page.goto("/");
  await page
    .getByRole("searchbox", { name: "Search library" })
    .fill("timing belt");
  const results = page.locator("section").filter({
    has: page.getByRole("button", { name: /Said in videos/ }),
  });
  await expect(
    results.getByRole("link", { name: "Cedar Notes" })
  ).toBeVisible();
  // The hit opens the library copy at the line that says it (0:42, 2 s early),
  // not at the start of its passage.
  const moment = results.getByRole("link", { name: "0:40" });
  await expect(moment).toHaveAttribute("href", /^\/watch\/\d+\?t=40$/);
  await expect(results.locator("mark").first()).toHaveText(/timing|belt/);
  await expect(
    page
      .getByRole("navigation", { name: "Search results" })
      .getByRole("link", { name: /Said in videos/ })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "transcript search results");

  await moment.click();
  await expect(page).toHaveURL(/\/watch\/\d+\?t=40$/);
});

test("Ask channels are managed in Settings, not their own page", async ({
  page,
}) => {
  await page.goto("/settings?tab=library&find=ask-channels");
  const section = page.locator('[data-setting="ask-channels"]');
  await expect(
    section.getByRole("heading", { name: "Ask channels" })
  ).toBeVisible();
  await expect(section.getByRole("link", { name: "Northwind" })).toBeVisible();
  await expect(section.getByText("1 of 1 videos indexed")).toBeVisible();
  await expect(
    section.getByRole("button", { name: "Add channel" })
  ).toBeVisible();
  await expectNoSeriousViolations(
    page,
    "ask channels settings",
    '[data-setting="ask-channels"]'
  );
  await expect(
    page.getByRole("link", { name: "Ask", exact: true })
  ).toHaveCount(0);
});

test("a channel answer links every point to its moment", async ({ page }) => {
  const bodies: { message: string; channel_ids: number[] }[] = [];
  await page.route(/\/api\/ask\/chat$/, (route) => {
    bodies.push(route.request().postDataJSON() as (typeof bodies)[number]);
    const answer = "Northwind says to change the timing belt early[1].";
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "thread", id: 3, title: "belt?" },
        { type: "scope", channels: [{ id: 1, name: "Northwind" }] },
        { type: "status", text: "Searching Northwind" },
        { type: "user", message: { id: 1, role: "user", content: "belt?" } },
        // While streaming, the model's own excerpt numbers stay hidden.
        {
          type: "token",
          text: "Northwind says to change the timing belt early [4].",
        },
        {
          type: "references",
          channels: [{ id: 1, name: "Northwind" }],
          references: [
            {
              n: 1,
              channel: "Northwind",
              title: "Cedar Notes",
              yt_id: "e2ecedar001",
              published_at: "2023-04-01T00:00:00Z",
              start_sec: 40,
              library_video_id: null,
              line: "change the timing belt before it snaps",
              is_description: false,
            },
          ],
        },
        {
          type: "done",
          message: { id: 2, role: "assistant", content: answer },
        },
      ]),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  // The panel's title follows what it answers from, so find it by its id.
  const panel = page.locator('[data-horde="help-chat"]');
  const input = panel.getByRole("textbox", { name: "Your question" });
  // With an Ask channel on, the hint says a channel can be named.
  await expect(input).toHaveAttribute("placeholder", /name a channel/);
  // And which channels can be named.
  await expect(
    panel.getByText(/Name a channel to ask what it said .*: Northwind\./)
  ).toBeVisible();
  await input.fill("What does Northwind say about the timing belt?");
  await input.press("Enter");

  const chatPanel = page.getByRole("dialog", { name: "Ask Northwind" });
  const cite = chatPanel.getByRole("link", {
    name: /Reference 1: Cedar Notes at 0:40/,
  });
  await expect(cite).toHaveAttribute(
    "href",
    "/watch?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3De2ecedar001&t=40"
  );
  await expect(chatPanel.getByText("[4]")).toHaveCount(0);
  const list = chatPanel.locator("ol");
  await expect(
    list.getByRole("link", { name: /Northwind · “Cedar Notes” \(2023\)/ })
  ).toBeVisible();
  await expect(
    list.getByText("“change the timing belt before it snaps”")
  ).toBeVisible();
  await expect(chatPanel.getByText("Answering from")).toBeVisible();
  await expectNoSeriousViolations(page, "ask chat", '[data-horde="help-chat"]');

  // A follow-up stays on the channel without naming it again.
  await input.fill("And how often?");
  await input.press("Enter");
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].channel_ids).toEqual([1]);

  // Clearing the chip goes back to Ask about Horde.
  await chatPanel
    .getByRole("button", { name: "Stop answering from these channels" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Ask about Horde" })
  ).toBeVisible();
});

test("saved conversations are listed in the chat panel", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  await panel.getByRole("button", { name: "History" }).click();
  await expect(panel.getByText("Your conversations")).toBeVisible();
  await expect(panel.getByText("None yet.")).toBeVisible();
});

test("Ask <channel> on a channel page opens a chat about it", async ({
  page,
}) => {
  // The suite is offline: give the library channel its YouTube URL here.
  await page.route(/\/api\/channels(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as { channel: string }[];
    await route.fulfill({
      response,
      json: rows.map((row) =>
        row.channel === "Northwind"
          ? { ...row, channel_url: "https://www.youtube.com/@northwind" }
          : row
      ),
    });
  });
  await page.route(/\/api\/channels\/feed\?/, (route) =>
    route.fulfill({
      json: { channel: "Northwind", entries: [], has_more: false },
    })
  );
  await page.route(/\/api\/live\/channel\?/, (route) =>
    route.fulfill({ json: { live: null } })
  );
  await page.goto("/?channel=Northwind");
  // The panel is closed: the request must survive its mounting.
  await page.getByRole("button", { name: "Ask Northwind" }).click();
  const panel = page.getByRole("dialog", { name: "Ask Northwind" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Answering from")).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "Your question" })
  ).toHaveAttribute("placeholder", "Ask Northwind…");
  // The download box floats over the panel's corner on this page.
  await page.getByRole("button", { name: "Hide download panel" }).click();
  // Removing the chip goes back to Ask about Horde.
  await panel
    .getByRole("button", { name: "Stop answering from these channels" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Ask about Horde" })
  ).toBeVisible();
});

test("on a video of an Ask channel, the chat answers from that channel", async ({
  page,
}) => {
  const bodies: {
    page_channel_id: number | null;
    page_video_id: string | null;
  }[] = [];
  await page.route(/\/api\/ask\/chat$/, (route) => {
    bodies.push(route.request().postDataJSON() as (typeof bodies)[number]);
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "thread", id: 9, title: "x" },
        { type: "scope", channels: [{ id: 1, name: "Northwind" }] },
        { type: "token", text: "Change it early." },
        {
          type: "references",
          channels: [{ id: 1, name: "Northwind" }],
          references: [],
        },
        {
          type: "done",
          message: { id: 2, role: "assistant", content: "Change it early." },
        },
      ]),
    });
  });
  await page.goto("/");
  await videoCard(page, "Cedar Notes").first().click();
  await expect(page).toHaveURL(/\/watch\//);
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = page.locator('[data-horde="help-chat"]');
  await expect(panel.locator('[data-horde="ask-page-channel"]')).toContainText(
    "On this page: Northwind"
  );
  const input = panel.getByRole("textbox", { name: "Your question" });
  await expect(input).toHaveAttribute(
    "placeholder",
    "Ask Northwind, or about Horde…"
  );
  await input.fill("when should the belt be changed?");
  await input.press("Enter");
  await expect(panel.getByText("Change it early.")).toBeVisible();
  // The server is told the page's channel and the video being watched.
  expect(bodies[0].page_channel_id).toBe(1);
  expect(bodies[0].page_video_id).toBe("e2ecedar001");
});
