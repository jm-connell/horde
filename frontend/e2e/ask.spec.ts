import { expectNoSeriousViolations } from "./axe";
import { expect, hasDesktopPlayerChrome, test, videoCard } from "./fixtures";

// These specs are about the AI chat: the e2e server has no provider, so say
// there is one (a spec can still answer /api/ai/help/info differently).
test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/ai\/help\/info$/, (route) =>
    route.fulfill({
      json: {
        model: null,
        tier: "medium",
        provider_label: "a test provider",
        local: true,
        available: true,
      },
    })
  );
});

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
  // Mixed results: the downloaded video whose captions say it, with the
  // moment under its card. It opens the library copy at the line that says
  // it (0:42, 2 s early), not at the start of its passage.
  const mixed = page.getByRole("region", { name: /^Results/ });
  await expect(videoCard(mixed, "Cedar Notes")).toBeVisible();
  const moment = mixed.getByRole("link", { name: "0:40" });
  await expect(moment).toHaveAttribute("href", /^\/watch\/\d+\?t=40$/);
  await expect(mixed.locator("mark").first()).toHaveText(/timing|belt/);
  await expectNoSeriousViolations(page, "mixed search results");

  // Sections: what was said has its own group and jump link.
  await page
    .getByRole("group", { name: "Results layout" })
    .getByRole("button", { name: "Sections" })
    .click();
  const results = page.locator("section").filter({
    has: page.getByRole("button", { name: /Said in videos/ }),
  });
  await expect(
    results.getByRole("link", { name: "Cedar Notes" })
  ).toBeVisible();
  const sectionMoment = results.getByRole("link", { name: "0:40" });
  await expect(sectionMoment).toHaveAttribute("href", /^\/watch\/\d+\?t=40$/);
  await expect(
    page
      .getByRole("navigation", { name: "Search results" })
      .getByRole("link", { name: /Said in videos/ })
  ).toBeVisible();
  await expectNoSeriousViolations(page, "transcript search results");

  await sectionMoment.click();
  await expect(page).toHaveURL(/\/watch\/\d+\?t=40$/);
});

test("the channels Ask answers from are managed in Settings, not their own page", async ({
  page,
}) => {
  await page.goto("/settings?tab=library&find=ask-channels");
  const section = page.locator('[data-setting="ask-channels"]');
  await expect(
    section.getByRole("heading", { name: "Channels Ask can answer from" })
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
  const bodies: {
    message: string;
    channel_ids: number[];
    horde_only: boolean;
  }[] = [];
  await page.route(/\/api\/ask\/chat$/, (route) => {
    const body = route.request().postDataJSON() as (typeof bodies)[number];
    bodies.push(body);
    if (body.horde_only)
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          { type: "thread", id: 3, title: "belt?" },
          { type: "scope", channels: [] },
          { type: "token", text: "Turn it off in Settings." },
          {
            type: "done",
            message: {
              id: 5,
              role: "assistant",
              content: "Turn it off in Settings.",
            },
          },
        ]),
      });
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
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const chatPanel = page.getByRole("dialog", { name: "Ask", exact: true });
  const input = chatPanel.getByRole("textbox", { name: "Your question" });
  // With an Ask channel on, the hint says a channel can be named or picked.
  await expect(input).toHaveAttribute("placeholder", /name a channel/);
  await expect(
    chatPanel.getByText(/name it or pick it beside Ask at the top\./)
  ).toBeVisible();
  const source = (name: string) =>
    chatPanel.getByRole("button", {
      name: `Answering from ${name}`,
      exact: true,
    });
  // Nothing picked: Horde, or the channel a question names.
  await expect(source("Automatic")).toBeVisible();
  await input.fill("What does Northwind say about the timing belt?");
  await input.press("Enter");

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
  // The source shows the channel, and so does the answer's byline.
  await expect(source("Northwind")).toBeVisible();
  const byline = chatPanel.locator('[data-horde="ask-byline"]').last();
  await expect(byline).toHaveText("Northwind");
  await expectNoSeriousViolations(page, "ask chat", '[data-horde="help-chat"]');

  // A follow-up stays on the channel without naming it again.
  await input.fill("And how often?");
  await input.press("Enter");
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].channel_ids).toEqual([1]);
  expect(bodies[1].horde_only).toBe(false);

  // Picking Horde answers from Horde, even when a channel is named.
  await source("Northwind").click();
  const menu = page.getByRole("menu", { name: "Answer from" });
  await expect(
    menu.getByRole("menuitemradio", { name: "Northwind", exact: true })
  ).toHaveAttribute("aria-checked", "true");
  await expectNoSeriousViolations(
    page,
    "ask source menu",
    '[data-horde="ask-source"]'
  );
  await menu.getByRole("menuitemradio", { name: /^Horde/ }).click();
  await expect(source("Horde")).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill("How do I stop indexing Northwind?");
  await input.press("Enter");
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2].channel_ids).toEqual([]);
  expect(bodies[2].horde_only).toBe(true);
  await expect(byline).toHaveText("Horde");

  // The pick outlasts closing the panel, and New chat starts on it.
  await input.press("Escape");
  await expect(chatPanel).toHaveCount(0);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(source("Horde")).toBeVisible();
  await chatPanel.getByRole("button", { name: "New chat" }).click();
  await expect(source("Horde")).toBeVisible();
  // Automatic goes back to choosing per question.
  await source("Horde").click();
  await menu.getByRole("menuitemradio", { name: /^Automatic/ }).click();
  await expect(source("Automatic")).toBeVisible();
});

test("saved conversations are listed in the chat panel", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Ask", exact: true });
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
  const panel = page.getByRole("dialog", { name: "Ask", exact: true });
  await expect(panel).toBeVisible();
  const source = (name: string) =>
    panel.getByRole("button", { name: `Answering from ${name}`, exact: true });
  await expect(source("Northwind")).toBeVisible();
  const input = panel.getByRole("textbox", { name: "Your question" });
  await expect(input).toHaveAttribute("placeholder", "Ask Northwind…");
  // The download box floats over the panel's corner on this page.
  await page.getByRole("button", { name: "Hide download panel" }).click();
  // Picking Horde stops answering from the channel, even on its page.
  await source("Northwind").click();
  const menu = page.getByRole("menu", { name: "Answer from" });
  await menu.getByRole("menuitemradio", { name: /^Horde/ }).click();
  await expect(source("Horde")).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "Ask how to use Horde…");
  // Picking the channel goes back to it.
  await source("Horde").click();
  await menu
    .getByRole("menuitemradio", { name: "Northwind", exact: true })
    .click();
  await expect(source("Northwind")).toBeVisible();
  // Automatic, on its page: its videos' questions go to it, the rest to Horde.
  await source("Northwind").click();
  await menu.getByRole("menuitemradio", { name: /^Automatic/ }).click();
  await expect(source("Northwind or Horde")).toBeVisible();
});

test("on a video of an Ask channel, the chat answers from that channel", async ({
  page,
}) => {
  const bodies: {
    page_channel_id: number | null;
    page_video_id: string | null;
    horde_only: boolean;
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
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Ask", exact: true });
  // Nothing picked: each question goes to the channel or Horde. The source
  // sits beside the title ("Ask Northwind or Horde"), and Automatic says how.
  const source = panel
    .locator("header")
    .getByRole("button", { name: "Answering from Northwind or Horde" });
  await expect(source).toBeVisible();
  await source.click();
  await expect(
    page
      .getByRole("menu", { name: "Answer from" })
      .getByRole("menuitemradio", { name: /^Automatic/ })
  ).toHaveText(/Northwind for its videos, Horde for the rest/);
  await page.keyboard.press("Escape");
  await expect(source).toBeFocused();
  const input = panel.getByRole("textbox", { name: "Your question" });
  await expect(input).toHaveAttribute("placeholder", "Ask Northwind or Horde…");
  await input.fill("when should the belt be changed?");
  await input.press("Enter");
  await expect(panel.getByText("Change it early.")).toBeVisible();
  // The server is told the page's channel and the video being watched.
  expect(bodies[0].page_channel_id).toBe(1);
  expect(bodies[0].page_video_id).toBe("e2ecedar001");
  expect(bodies[0].horde_only).toBe(false);
});
