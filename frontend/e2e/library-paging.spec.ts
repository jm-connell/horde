import type { APIRequestContext, Page } from "@playwright/test";
import {
  CSRF_HEADERS,
  expect,
  feedCard,
  openSearchBox,
  test,
  videoCard,
} from "./fixtures";

// More than the client's 500-video request size, so the real server has to hand
// the library over in more than one page.
const BULK = 620;

test.beforeEach(async ({ page, request }) => {
  void page;
  const resp = await request.post(`/api/e2e/bulk-videos?count=${BULK}`, {
    headers: CSRF_HEADERS,
  });
  expect(resp.ok()).toBeTruthy();
});

function bulkCards(page: Page) {
  return page.locator("[data-horde='video-card']", {
    hasText: /Bulk video \d{4}/,
  });
}

async function bulkNumbers(page: Page): Promise<number[]> {
  const texts = await bulkCards(page).allTextContents();
  return texts.map((t) => Number(/Bulk video (\d{4})/.exec(t)![1]));
}

test("a library larger than one page shows every video exactly once", async ({
  page,
}) => {
  await page.goto("/");
  await expect(bulkCards(page)).toHaveCount(BULK);
  const numbers = await bulkNumbers(page);
  expect(new Set(numbers).size).toBe(BULK);
  expect(Math.min(...numbers)).toBe(0);
  expect(Math.max(...numbers)).toBe(BULK - 1);
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
});

/** The bulk videos in the order the server pages them for this sort. */
async function serverOrder(
  request: APIRequestContext,
  sort: string,
  order: string
): Promise<number[]> {
  const numbers: number[] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ sort, order, limit: "200" });
    if (cursor) qs.set("cursor", cursor);
    const page = await (await request.get(`/api/videos?${qs}`)).json();
    for (const v of page.items) {
      const m = /^Bulk video (\d{4})$/.exec(v.title);
      if (m) numbers.push(Number(m[1]));
    }
    cursor = page.next_cursor;
  } while (cursor);
  return numbers;
}

for (const [label, sort] of [
  ["Duration", "duration"],
  ["Title", "title"],
] as const) {
  test(`sorting by ${label} lists every video once, in the server's order`, async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await expect(bulkCards(page)).toHaveCount(BULK);

    // Duration has ten-way ties in the bulk data, so the page boundary falls
    // inside a run of equal keys.
    const sorted = page.waitForRequest((r) => {
      const url = new URL(r.url());
      return (
        url.pathname === "/api/videos" &&
        url.searchParams.get("sort") === sort &&
        !url.searchParams.has("cursor")
      );
    });
    await page.getByRole("button", { name: "Sort library" }).click();
    await page.getByRole("option", { name: label }).click();
    const order = new URL((await sorted).url()).searchParams.get("order")!;
    const expected = await serverOrder(request, sort, order);
    expect(expected).toHaveLength(BULK);

    // The grid fills page by page, so poll until the whole sorted list is in.
    await expect(async () => {
      expect(await bulkNumbers(page)).toEqual(expected);
    }).toPass();
  });
}

test("a channel filter drops the other channels and a search narrows to its match", async ({
  page,
}) => {
  await page.goto(`/?channel=${encodeURIComponent("Bulkland")}`);
  await expect(
    page.getByRole("heading", { name: "Bulkland", level: 1 })
  ).toBeVisible();
  await expect(feedCard(page, "Bulk video 0000")).toBeVisible();
  await expect(feedCard(page, "Kiln fire")).toHaveCount(0);

  await page.goto("/");
  await expect(videoCard(page, "Kiln fire")).toBeVisible();
  await (await openSearchBox(page)).fill("Bulk video 0123");
  await expect(videoCard(page, "Bulk video 0123").first()).toBeVisible();
  await expect(videoCard(page, "Bulk video 0124")).toHaveCount(0);
});
