import {
  CSRF_HEADERS,
  contextAs,
  expect,
  openSearchBox,
  test,
} from "./fixtures";
import type { Page, Request } from "@playwright/test";

const STREAM_URL = "https://video.example.test/watch?v=abc123";
const WATCH = `/watch?url=${encodeURIComponent(STREAM_URL)}&channel=Test%20Channel`;
const SUMMARY = "A walk along the ridge at dusk.";

const META = {
  id: "abc123",
  title: "Ridge at dusk",
  channel: "Test Channel",
  channel_url: null,
  description: "A quiet evening hike with no timestamps in the description.",
  duration: 600,
  thumbnail_url: null,
  source_url: STREAM_URL,
  library_video_id: null,
  subtitles: [{ lang: "en", auto: false }],
  available_presets: [],
  view_count: 1200,
};

type StreamAiState = {
  youtube_id: string;
  supported: boolean;
  summary: string | null;
  summary_model: string | null;
  summary_cost: number | null;
  chapters: { start_sec: number; title: string }[];
  has_captions: boolean | null;
  expires_at: string | null;
};

/** The request is a CSRF-protected JSON POST with exactly this body. */
function expectMutation(request: Request, body: Record<string, unknown>) {
  expect(request.headers()["x-horde-request"]).toBeTruthy();
  expect(request.postDataJSON()).toEqual(body);
}

/** A connected AI backend with summaries, chat and chapters switched on. */
async function enableAi(page: Page, admin: Page = page) {
  await page.route(/\/api\/ai\/status$/, async (route) => {
    let response;
    let status: Record<string, unknown>;
    try {
      response = await route.fetch();
      status = await response.json();
    } catch {
      // The page closed (test over) while a status poll was in flight.
      return;
    }
    await route.fulfill({
      response,
      json: { ...status, enabled: true, reachable: true },
    });
  });
  const saved = await admin.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ai: { ai_summaries: true, ai_chat: true, ai_chapters: true } },
  });
  expect(saved.ok()).toBe(true);
}

/** Mock the stream endpoints; returns the mutable server-side AI state. */
async function mockStream(page: Page, related: unknown[] = []) {
  const state: StreamAiState = {
    youtube_id: "abc123",
    supported: true,
    summary: null,
    summary_model: null,
    summary_cost: null,
    chapters: [],
    has_captions: null,
    expires_at: null,
  };
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({ json: META })
  );
  // No yt-dlp in e2e: playback just fails to load.
  await page.route(/\/api\/preview\/(manifest|stream|subtitles)\?/, (route) =>
    route.fulfill({ status: 404, json: { detail: "no media", code: "x" } })
  );
  await page.route(/\/api\/preview\/ai\?/, (route) =>
    route.fulfill({ json: state })
  );
  await page.route(/\/api\/preview\/ai\/summarize$/, (route) => {
    expectMutation(route.request(), { url: STREAM_URL, force: false });
    state.summary = SUMMARY;
    state.has_captions = true;
    state.expires_at = "2026-11-16T12:00:00Z";
    return route.fulfill({ json: state });
  });
  await page.route(/\/api\/preview\/ai\/chapters$/, (route) => {
    expectMutation(route.request(), { url: STREAM_URL, force: false });
    state.chapters = [
      { start_sec: 0, title: "Trailhead" },
      { start_sec: 120, title: "Summit push" },
    ];
    state.has_captions = true;
    return route.fulfill({ json: state });
  });
  // Questions go to Ask, with the stream as the video; Ask answers with AI.
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
  await page.route(/\/api\/ask\/chat$/, (route) => {
    expect(route.request().headers()["x-horde-request"]).toBe("1");
    const body = route.request().postDataJSON() as {
      message: string;
      video: { library_id: number | null; url: string | null } | null;
    };
    expect(body.message).toBe("What is it about?");
    expect(body.video).toEqual({ library_id: null, url: STREAM_URL });
    const events = [
      { type: "thread", id: 6, title: "What is it about?" },
      {
        type: "scope",
        channels: [],
        video: {
          library_id: null,
          youtube_id: null,
          url: STREAM_URL,
          title: "Ridge at dusk",
        },
      },
      { type: "token", text: "Mostly " },
      { type: "token", text: "about a hike." },
      {
        type: "done",
        message: {
          id: 2,
          role: "assistant",
          content: "Mostly about a hike.",
        },
      },
    ];
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
  await page.route(/\/api\/preview\/related\?/, (route) =>
    route.fulfill({ json: { items: related, next_cursor: null } })
  );
  return state;
}

test("a streamed video gets an AI summary with a retention note, and Chat opens Ask", async ({
  page,
}) => {
  await enableAi(page);
  await mockStream(page);
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();

  await page.getByRole("button", { name: "Generate summary" }).click();
  await expect(page.getByText(SUMMARY)).toBeVisible();
  await expect(page.getByText(/Saved until Nov 16, 2026/)).toBeVisible();
  await expect(page.getByText(/downloading the video keeps it/)).toBeVisible();

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Ask", exact: true });
  await expect(
    panel.getByRole("button", {
      name: "Answering from Ridge at dusk",
      exact: true,
    })
  ).toBeVisible();
  const input = panel.getByRole("textbox", { name: "Your question" });
  await input.fill("What is it about?");
  await input.press("Enter");
  await expect(panel.getByText("Mostly about a hike.")).toBeVisible();
});

test("AI chapters generated for a stream replace the empty chapter list", async ({
  page,
}) => {
  await enableAi(page);
  await mockStream(page);
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();

  await expect(page.getByRole("button", { name: /Trailhead/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Generate chapters" }).click();
  await expect(page.getByRole("button", { name: /Trailhead/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Summit push/ })).toBeVisible();
  // The player's control bar shows the current chapter too.
  await expect(page.getByText("· Trailhead")).toBeVisible();
  const note = page.getByText(/AI generated chapters/);
  await expect(note).toBeVisible();
  // The note labels the chapters: right over their list whether the list
  // sits beside the description (wide) or under it (phone).
  const noteBox = await note.boundingBox();
  const listBox = await page
    .getByRole("button", { name: /Trailhead/ })
    .boundingBox();
  expect(noteBox && listBox).toBeTruthy();
  const gap = listBox!.y - (noteBox!.y + noteBox!.height);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThan(40);
});

test("on a phone the control bar and stream details each stay on one line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 932 });
  const state = await mockStream(page);
  state.chapters = [{ start_sec: 0, title: "Upgrading from the old machine" }];
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();

  const centerY = async (loc: ReturnType<Page["locator"]>) => {
    const box = await loc.boundingBox();
    expect(box).not.toBeNull();
    return box!.y + box!.height / 2;
  };
  // Play and the right-hand buttons share one row.
  const play = page.getByRole("button", { name: /^(Play|Pause)$/ });
  const speed = page.getByTitle("Playback speed");
  await expect(play).toBeVisible();
  expect(Math.abs((await centerY(play)) - (await centerY(speed)))).toBeLessThan(
    6
  );
  // The download button sits at the right of the channel / duration line.
  const channel = page.getByRole("link", { name: "Test Channel" });
  const download = page.getByRole("button", { name: /^Download / });
  expect(
    Math.abs((await centerY(channel)) - (await centerY(download)))
  ).toBeLessThan(6);
  const original = page.getByRole("link", { name: /^Source$/ });
  expect(
    Math.abs((await centerY(channel)) - (await centerY(original)))
  ).toBeLessThan(6);
});

test("a streamed video links to its original page", async ({ page }) => {
  await mockStream(page);
  await page.goto(WATCH);
  const original = page.getByRole("link", { name: /^Source$/ });
  await expect(original).toHaveAttribute("href", STREAM_URL);
  await expect(original).toHaveAttribute("target", "_blank");
});

test("stream details leave length and resolution to the player", async ({
  page,
}) => {
  await mockStream(page);
  await page.goto(WATCH);
  const details = page
    .getByRole("link", { name: "Test Channel" })
    .locator("xpath=..");
  await expect(details).toContainText("1.2K views");
  await expect(details).not.toContainText("10:00");
  await expect(details).not.toContainText(/\d{3,4}p/);
});

test("the channel link on a stream reached from a search opens the channel", async ({
  page,
}) => {
  await mockStream(page);
  await page.goto(WATCH);
  const channelLink = page.getByRole("link", { name: "Test Channel" });
  await expect(channelLink).toBeVisible();
  // Searching goes to the results; Back returns to the stream with the query
  // still set, as after opening a result.
  await (await openSearchBox(page)).fill("ridge");
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();

  await channelLink.click();
  await expect(page).toHaveURL(/\?channel=Test%20Channel/);
  await expect(page.getByPlaceholder("Search this channel")).toBeVisible();
  for (const box of await page
    .getByPlaceholder("Search", { exact: true })
    .all()) {
    await expect(box).toHaveValue("");
  }
});

test("when a stream ends, the next part of its series comes up next", async ({
  page,
}) => {
  await mockStream(page);
  const NEXT_URL = "https://www.youtube.com/watch?v=part0000003";
  const asked: string[] = [];
  await page.route(/\/api\/preview\/next-part\?/, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("url") ?? "");
    return route.fulfill({
      json: {
        entry: {
          id: "part0000003",
          url: NEXT_URL,
          title: "Ridge at dusk #3",
          channel: "Test Channel",
          in_library: false,
        },
        reason: "ridge at dusk 3 follows 2",
      },
    });
  });
  await page.goto(WATCH);
  const video = page.locator("video").first();
  await expect(video).toBeAttached();
  await video.evaluate((el) => el.dispatchEvent(new Event("ended")));

  await expect(page.getByText(/^Playing next/)).toBeVisible();
  await expect(page.getByText("Ridge at dusk #3")).toBeVisible();
  await expect(page.getByText("Next part · not downloaded")).toBeVisible();
  expect(asked).toEqual([STREAM_URL]);
});

test("a stream's AI is hidden when the server does not support it", async ({
  page,
}) => {
  await enableAi(page);
  const state = await mockStream(page);
  state.supported = false;
  // Absence only means something once the page knows AI is on and has read the
  // stream's AI state.
  const aiRead = page.waitForResponse(/\/api\/preview\/ai\?/);
  const statusRead = page.waitForResponse(/\/api\/ai\/status$/);
  await page.goto(WATCH);
  await Promise.all([aiRead, statusRead]);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate summary" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Generate chapters" })
  ).toHaveCount(0);
});

test("related videos of a stream mark downloaded ones and link to the right page", async ({
  page,
}) => {
  const list = await page.request.get("/api/videos?limit=500");
  const library = (await list.json()).items.find(
    (v: { title: string }) => v.title === "Harbor Lights"
  );
  const related = [
    {
      id: "lib1",
      url: "https://video.example.test/watch?v=lib1",
      title: "Harbor Lights",
      duration: 90,
      thumbnail_url: null,
      channel: "Test Channel",
      in_library: true,
      video_id: library.id,
    },
    {
      id: "rem1",
      url: "https://video.example.test/watch?v=rem1",
      title: "Not yet downloaded clip",
      duration: 75,
      thumbnail_url: "https://i.ytimg.com/vi/rem1/mqdefault.jpg",
      channel: "Other Channel",
      in_library: false,
      video_id: null,
    },
  ];
  await mockStream(page, related);
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "More like this" })
  ).toBeVisible();

  const downloaded = page.getByRole("link", { name: /Harbor Lights/ }).first();
  await expect(downloaded).toHaveAttribute("href", `/watch/${library.id}`);
  // The item for a video already in the library says so.
  await expect(page.getByText("Downloaded", { exact: true })).toBeVisible();

  const remote = page.getByRole("link", { name: /Not yet downloaded clip/ });
  const href = (await remote.getAttribute("href")) ?? "";
  const target = new URL(href, "http://x.test");
  expect(target.pathname).toBe("/watch");
  expect(target.searchParams.get("url")).toBe(
    "https://video.example.test/watch?v=rem1"
  );
  expect(target.searchParams.get("channel")).toBe("Other Channel");
  await expect(remote.getByText("Downloaded", { exact: true })).toHaveCount(0);

  await downloaded.click();
  await expect(page).toHaveURL(new RegExp(`/watch/${library.id}$`));
});

test("a not-downloaded related video can be queued and played from the queue", async ({
  page,
}) => {
  await mockStream(page, [
    {
      id: "rem1",
      url: "https://video.example.test/watch?v=rem1",
      title: "Not yet downloaded clip",
      duration: 75,
      thumbnail_url: "https://i.ytimg.com/vi/rem1/mqdefault.jpg",
      channel: "Other Channel",
      in_library: false,
      video_id: null,
    },
  ]);
  await page.goto(WATCH);
  // The sidebar row (desktop) or the card (phone) holds the queue button.
  const item = page
    .locator("[data-horde='related-item']")
    .filter({ hasText: "Not yet downloaded clip" })
    .first();
  await item.hover();
  await item.getByTitle("Add to queue").click();
  // Adding does not open it, and the button acknowledges the click.
  await expect(page).toHaveURL(WATCH);
  await expect(item.getByTitle("Add to queue")).toHaveText("Queued");

  const queue = page.getByText(/^Up next \(1\)$/).locator("xpath=../..");
  await expect(queue.getByText("Not yet downloaded clip")).toBeVisible();
  await expect(queue.getByText(/Not downloaded/)).toBeVisible();

  await queue.getByRole("button", { name: /Not yet downloaded clip/ }).click();
  await expect(page).toHaveURL(/\/watch\?url=.*rem1/);
  await expect(page.getByText(/^Up next/)).toHaveCount(0);
});

test("related videos of a stream show as a grid on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mockStream(page, [
    {
      id: "rem1",
      url: "https://video.example.test/watch?v=rem1",
      title: "Not yet downloaded clip",
      duration: 75,
      thumbnail_url: null,
      channel: "Other Channel",
      in_library: false,
      video_id: null,
    },
  ]);
  await page.goto(WATCH);
  await expect(
    page.getByRole("link", { name: /Not yet downloaded clip/ })
  ).toBeVisible();
});

test("without captions a stream offers neither a summary nor chapters", async ({
  page,
}) => {
  await enableAi(page);
  const state = await mockStream(page);
  state.has_captions = false;
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();
  // Chat is still offered (it falls back to title and description).
  await expect(
    page.getByRole("button", { name: "Chat", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate summary" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Generate chapters" })
  ).toHaveCount(0);
});

test("a member without the AI grant sees related videos but no stream AI", async ({
  page: adminPage,
  browser,
  baseURL,
}) => {
  // Every seeded account has use_ai, so take it away in the auth state.
  const context = await contextAs(browser, baseURL, "member");
  const page = await context.newPage();
  await page.route(/\/api\/auth\/state$/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.user) {
      json.user.permissions = (json.user.permissions ?? []).filter(
        (p: string) => p !== "use_ai"
      );
    }
    await route.fulfill({ response, json });
  });
  let aiRequests = 0;
  // Settings are admin-only; the member's page just needs a reachable backend.
  await enableAi(page, adminPage);
  await mockStream(page, [
    {
      id: "rem1",
      url: "https://video.example.test/watch?v=rem1",
      title: "Not yet downloaded clip",
      duration: 75,
      thumbnail_url: null,
      channel: "Other Channel",
      in_library: false,
      video_id: null,
    },
  ]);
  page.on("request", (r) => {
    if (/\/api\/preview\/ai/.test(r.url())) aiRequests += 1;
  });
  await page.goto(WATCH);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Not yet downloaded clip/ })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate summary" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Generate chapters" })
  ).toHaveCount(0);
  expect(aiRequests).toBe(0);
  await context.close();
});

test("a chapter request for one stream does not show as busy or failed on the next", async ({
  page,
}) => {
  const A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
  const B = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
  const metaFor = (id: string, url: string, title: string) => ({
    ...META,
    id,
    title,
    source_url: url,
    description: "no stamps",
  });
  const empty = (id: string) => ({
    youtube_id: id,
    supported: true,
    summary: null,
    summary_model: null,
    summary_cost: null,
    chapters: [],
    has_captions: null,
    expires_at: null,
  });
  const urlOf = (r: { request(): Request }) =>
    new URL(r.request().url()).searchParams.get("url");
  await enableAi(page);
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json:
        urlOf(route) === A
          ? metaFor("aaaaaaaaaaa", A, "Video A")
          : metaFor("bbbbbbbbbbb", B, "Video B"),
    })
  );
  await page.route(/\/api\/preview\/(manifest|stream|subtitles)\?/, (r) =>
    r.fulfill({ status: 404, json: { detail: "x", code: "x" } })
  );
  await page.route(/\/api\/preview\/ai\?/, (route) =>
    route.fulfill({
      json: empty(urlOf(route) === A ? "aaaaaaaaaaa" : "bbbbbbbbbbb"),
    })
  );
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/preview\/ai\/chapters$/, async (route) => {
    await gate;
    return route.fulfill({
      status: 502,
      json: { detail: "A failed", code: "x" },
    });
  });
  await page.route(/\/api\/preview\/related\?/, (route) =>
    route.fulfill({
      json: {
        items:
          urlOf(route) === A
            ? [
                {
                  id: "bbbbbbbbbbb",
                  url: B,
                  title: "Video B",
                  duration: 5,
                  thumbnail_url: null,
                  channel: "C",
                  in_library: false,
                  video_id: null,
                },
              ]
            : [],
        next_cursor: null,
      },
    })
  );

  await page.goto(`/watch?url=${encodeURIComponent(A)}`);
  await expect(
    page.getByRole("heading", { name: "Video A", level: 1 })
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate chapters" }).click();
  await expect(page.getByRole("button", { name: "Generating…" })).toBeVisible();

  await page.getByRole("link", { name: /Video B/ }).click();
  await expect(
    page.getByRole("heading", { name: "Video B", level: 1 })
  ).toBeVisible();
  // B has nothing in flight: its button is idle, not A's "Generating…".
  await expect(
    page.getByRole("button", { name: "Generate chapters" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Generating…" })).toHaveCount(
    0
  );

  // A's request now fails; B must not show A's error.
  release();
  await page.waitForTimeout(500);
  await expect(page.getByText("A failed")).toHaveCount(0);
});

test("a live broadcast offers no chapters or caption-based AI", async ({
  page,
}) => {
  await enableAi(page);
  const state = await mockStream(page);
  state.chapters = [{ start_sec: 0, title: "Saved AI chapter" }];
  // The newest route wins: this broadcast is live, with stamps in its text.
  await page.route(/\/api\/preview\/meta\?/, (route) =>
    route.fulfill({
      json: {
        ...META,
        is_live: true,
        description: "0:00 Opening\n2:00 Main event",
      },
    })
  );
  const aiRead = page.waitForResponse(/\/api\/preview\/ai\?/);
  const statusRead = page.waitForResponse(/\/api\/ai\/status$/);
  await page.goto(WATCH);
  await Promise.all([aiRead, statusRead]);
  await expect(
    page.getByRole("heading", { name: "Ridge at dusk", level: 1 })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Opening/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Saved AI chapter/ })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Generate summary" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Generate chapters" })
  ).toHaveCount(0);
});
