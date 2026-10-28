import { CSRF_HEADERS, contextAs, expect, test } from "./fixtures";
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
  await page.route(/\/api\/preview\/ai\/chat/, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { messages: [] } });
    }
    expectMutation(route.request(), {
      url: STREAM_URL,
      message: "What is it about?",
    });
    const events = [
      { type: "token", text: "Mostly " },
      { type: "token", text: "about a hike." },
      {
        type: "done",
        message: {
          id: "m1",
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

test("a streamed video gets an AI summary with a retention note, and chat", async ({
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
  await page.getByPlaceholder("Ask this video…").fill("What is it about?");
  await page.getByPlaceholder("Ask this video…").press("Enter");
  await expect(page.getByText("Mostly about a hike.")).toBeVisible();
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
  await expect(page.getByText(/AI generated chapters/)).toBeVisible();
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
  await expect(page.getByPlaceholder("Ask this video…")).toBeVisible();
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
