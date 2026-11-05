import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";

type Job = { id: number; status: string; title: string | null };

/** Serve the queue event stream with `frames` on every (re)connect. */
async function streamEvents(page: Page, frames: () => object[]) {
  await page.route("**/api/downloads/events", (route: Route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body:
        "retry: 300\n\n" +
        frames()
          .map((f) => `data: ${JSON.stringify(f)}\n\n`)
          .join(""),
    })
  );
}

async function seededJobs(page: Page): Promise<Job[]> {
  const res = await page.request.get("/api/downloads");
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Job[];
}

test("a failure that happened before the page opened is not toasted again", async ({
  page,
}) => {
  const failed = (await seededJobs(page)).find((j) => j.status === "error");
  expect(failed).toBeTruthy();
  // The server replays a finished job's last state for a while after it ends.
  await streamEvents(page, () => [
    {
      job_id: failed!.id,
      status: "error",
      error_kind: "unknown",
      error: "Replayed failure text",
    },
  ]);

  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  // Several reconnects (retry: 300 ms) replay it; none may toast. A toast
  // dismisses itself, so watch for it appearing at all instead of counting.
  const appeared = await page
    .getByText("Replayed failure text")
    .waitFor({ timeout: 3_000 })
    .then(
      () => true,
      () => false
    );
  expect(appeared).toBe(false);
});

test("a download that fails while the page is open is toasted once", async ({
  page,
}) => {
  const queued = (await seededJobs(page)).find((j) => j.status === "queued");
  expect(queued).toBeTruthy();
  let sent = 0;
  await streamEvents(page, () => {
    sent += 1;
    // First connection: the job is running. Later ones: it failed (replayed).
    return sent === 1
      ? [{ job_id: queued!.id, status: "downloading", progress: 10 }]
      : [
          {
            job_id: queued!.id,
            status: "error",
            error_kind: "unknown",
            error: "Live failure text",
          },
        ];
  });

  await page.goto("/history");
  await expect(page.getByText("Live failure text")).toHaveCount(1, {
    timeout: 10_000,
  });
});
