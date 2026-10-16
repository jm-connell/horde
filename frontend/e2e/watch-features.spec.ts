import { CSRF_HEADERS, expect, test, videoCard } from "./fixtures";
import type { Page } from "@playwright/test";

/** The seeded id of the library video called `title`. */
async function videoId(page: Page, title: string): Promise<number> {
  const list = await page.request.get("/api/videos?limit=500");
  const item = (await list.json()).items.find(
    (v: { title: string }) => v.title === title
  );
  return item.id;
}

/** Make the server report `patch` on top of the real detail of video `id`. */
async function patchVideoDetail(
  page: Page,
  id: number,
  patch: Record<string, unknown>
) {
  await page.route(new RegExp(`/api/videos/${id}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    return route.fulfill({
      response,
      json: { ...(await response.json()), ...patch },
    });
  });
}

/** A connected AI backend with summaries and chat switched on. */
async function enableAi(page: Page) {
  await page.route(/\/api\/ai\/status$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), enabled: true, reachable: true },
    });
  });
  const saved = await page.request.patch("/api/settings", {
    headers: CSRF_HEADERS,
    data: { ai: { ai_summaries: true, ai_chat: true } },
  });
  expect(saved.ok()).toBe(true);
}

test("AI summary is generated from the watch page and chat answers a question", async ({
  page,
}) => {
  const id = await videoId(page, "Aurora Drift");
  await enableAi(page);
  await patchVideoDetail(page, id, {
    subtitles: [{ lang: "en", auto: false }],
  });
  const summary = "The ridge glows green all night.";
  const detail = await (await page.request.get(`/api/videos/${id}`)).json();
  await page.route(new RegExp(`/api/videos/${id}/ai/summarize`), (route) =>
    route.fulfill({
      json: {
        ...detail,
        subtitles: [{ lang: "en", auto: false }],
        ai_summary: summary,
      },
    })
  );
  await page.route(new RegExp(`/api/videos/${id}/ai/chat$`), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const events = [
      { type: "token", text: "It is " },
      { type: "token", text: "about auroras." },
      {
        type: "done",
        message: {
          id: "m1",
          role: "assistant",
          content: "It is about auroras.",
        },
      },
    ];
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });

  await page.goto(`/watch/${id}`);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift", level: 1 })
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate summary" }).click();
  await expect(page.getByText(summary)).toBeVisible();

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByPlaceholder("Ask this video…").fill("What is it about?");
  await page.getByPlaceholder("Ask this video…").press("Enter");
  await expect(page.getByText("It is about auroras.")).toBeVisible();
});

test("related videos list under the player and open their watch page", async ({
  page,
}) => {
  const id = await videoId(page, "Aurora Drift");
  const other = await videoId(page, "Harbor Lights");
  const related = await (await page.request.get(`/api/videos/${other}`)).json();
  await page.route(new RegExp(`/api/videos/${id}/related`), (route) =>
    route.fulfill({ json: [related] })
  );
  await page.goto(`/watch/${id}`);
  await expect(
    page.getByRole("heading", { name: "More like this" })
  ).toBeVisible();
  await page
    .getByRole("link", { name: /Harbor Lights/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/watch/${other}$`));
  await expect(
    page.getByRole("heading", { name: "Harbor Lights", level: 1 })
  ).toBeVisible();
});

test("deleting a video from the watch page removes it from the library", async ({
  page,
}) => {
  const id = await videoId(page, "Kiln fire");
  await page.goto(`/watch/${id}`);
  await page.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(videoCard(page, "Aurora Drift").first()).toBeVisible();
  await expect(videoCard(page, "Kiln fire")).toHaveCount(0);
  expect((await page.request.get(`/api/videos/${id}`)).status()).toBe(404);
});

test("changing resolution sends the chosen quality and reports the job", async ({
  page,
}) => {
  const id = await videoId(page, "Kiln fire");
  await patchVideoDetail(page, id, {
    source_url: "https://example.test/watch?v=kiln",
  });
  const detail = await (await page.request.get(`/api/videos/${id}`)).json();
  let body: { quality_preset?: string } | null = null;
  await page.route(new RegExp(`/api/videos/${id}/redownload$`), (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: detail });
  });
  await page.goto(`/watch/${id}`);
  await page.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Change resolution" }).click();
  const dialog = page.getByRole("dialog", { name: "Change resolution" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Quality" }).click();
  await page.getByRole("option", { name: "720p" }).click();
  await dialog.getByRole("button", { name: "Replace file" }).click();
  await expect(page.getByText(/Download started/)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(body).toMatchObject({ quality_preset: "720p" });
});

test("the mini player stays hidden while the next video loads and on a missing video", async ({
  page,
}) => {
  const a = await videoId(page, "Aurora Drift");
  const b = await videoId(page, "Harbor Lights");
  const related = await (await page.request.get(`/api/videos/${b}`)).json();
  await page.route(new RegExp(`/api/videos/${a}/related`), (route) =>
    route.fulfill({ json: [related] })
  );
  await page.goto(`/watch/${a}`);
  await expect(
    page.getByRole("heading", { name: "Aurora Drift", level: 1 })
  ).toBeVisible();

  const mini = page.getByLabel("Drag to resize mini player");
  await page.route(new RegExp(`/api/videos/${b}$`), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fallback();
  });
  await page
    .getByRole("link", { name: /Harbor Lights/ })
    .first()
    .click();
  await expect(page.getByText("Loading…")).toBeVisible();
  await expect(mini).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Harbor Lights", level: 1 })
  ).toBeVisible();

  // A video that does not exist shows the error page, still without the mini player.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/watch/987654");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Video not found")).toBeVisible();
  await expect(mini).toHaveCount(0);
});
