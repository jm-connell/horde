import { expectNoSeriousViolations } from "./axe";
import { expect, test } from "./fixtures";

const sse = (events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test("the footer links to the docs and the GitHub issue tracker", async ({
  page,
}) => {
  await page.goto("/");
  const footer = page.locator('[data-horde="footer"]');
  await expect(footer.getByRole("link", { name: "Docs" })).toHaveAttribute(
    "href",
    "/wiki/"
  );
  await expect(
    footer.getByRole("link", { name: "Report a bug or idea" })
  ).toHaveAttribute("href", /github\.com\/jm-connell\/horde\/issues/);
  await expect(
    footer.getByRole("link", { name: "Source on GitHub" })
  ).toHaveAttribute("href", "https://github.com/jm-connell/horde");
});

test("Ask about Horde opens in the corner, follows the user and moves", async ({
  page,
}) => {
  const bodies: { message: string; history: unknown[]; page: string }[] = [];
  await page.route(/\/api\/ai\/help\/chat$/, (route) => {
    const body = route.request().postDataJSON() as (typeof bodies)[number];
    bodies.push(body);
    const answer =
      bodies.length === 1
        ? "Open **Settings → AI** and add a provider:\n\n```\nOLLAMA_URL=http://ollama:11434\n```"
        : "Yes, local models work too.";
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        {
          type: "user",
          message: { id: null, role: "user", content: body.message },
        },
        {
          type: "sources",
          sources: [
            {
              path: "docs/ops/ai-setup.md",
              title: "AI setup",
              url: "/wiki/ops/ai-setup/",
            },
          ],
        },
        { type: "token", text: answer },
        {
          type: "done",
          message: { id: null, role: "assistant", content: answer },
        },
      ]),
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Playback" }).click();
  const open = page.getByRole("button", { name: "Ask about Horde" });
  await open.click();
  await expect(open).toHaveAttribute("aria-expanded", "true");

  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  const input = panel.getByRole("textbox", { name: "Your question" });
  await expect(input).toBeFocused();
  // Docked in the bottom-right corner, not over the middle of the page.
  const box = (await panel.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1280 - 40);
  expect(box.y + box.height).toBeGreaterThan(800 - 40);

  await input.fill("How do I set up AI?");
  await input.press("Enter");
  await expect(panel.getByText("Settings → AI")).toBeVisible();
  await expect(panel.locator("pre")).toHaveText(
    "OLLAMA_URL=http://ollama:11434"
  );
  // The server is told which screen the question was asked from.
  expect(bodies[0].page).toBe("Settings, Playback tab (/settings)");
  await panel.getByText("Sources (1)").click();
  await expect(panel.getByRole("link", { name: "AI setup" })).toHaveAttribute(
    "href",
    "/wiki/ops/ai-setup/"
  );
  await expectNoSeriousViolations(
    page,
    "help chat",
    '[data-horde="help-chat"]'
  );

  // It is not modal: the page behind still works, and the panel stays open
  // with its thread on the next page.
  await page.getByRole("link", { name: "History" }).first().click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(panel.getByText("Settings → AI")).toBeVisible();
  await input.fill("Can I use a local model?");
  await input.press("Enter");
  await expect(panel.getByText("Yes, local models work too.")).toBeVisible();
  expect(bodies[1].page).toBe("History (/history)");
  expect(bodies[1].history).toEqual([
    { role: "user", content: "How do I set up AI?" },
    {
      role: "assistant",
      content: expect.stringContaining("Settings → AI") as unknown as string,
    },
  ]);

  // Drag it by the header, then resize it from the top-left corner.
  const before = (await panel.boundingBox())!;
  const header = panel.locator("header");
  const hb = (await header.boundingBox())!;
  await page.mouse.move(hb.x + 60, hb.y + 15);
  await page.mouse.down();
  await page.mouse.move(hb.x - 240, hb.y - 100, { steps: 5 });
  await page.mouse.up();
  const moved = (await panel.boundingBox())!;
  expect(moved.x).toBeCloseTo(before.x - 300, 0);
  expect(moved.y).toBeCloseTo(before.y - 115, 0);
  expect(moved.width).toBeCloseTo(before.width, 0);

  await page.mouse.move(moved.x + 3, moved.y + 3);
  await page.mouse.down();
  await page.mouse.move(moved.x - 97, moved.y - 47, { steps: 5 });
  await page.mouse.up();
  const resized = (await panel.boundingBox())!;
  expect(resized.width).toBeCloseTo(moved.width + 100, 0);
  expect(resized.height).toBeCloseTo(moved.height + 50, 0);
  expect(resized.x + resized.width).toBeCloseTo(moved.x + moved.width, 0);

  // Escape closes; after a reload the footer reopens the same thread in the
  // same place.
  await input.press("Escape");
  await expect(panel).toBeHidden();
  await expect(open).toBeFocused();
  await page.reload();
  await open.click();
  await expect(panel.getByText("Yes, local models work too.")).toBeVisible();
  const reopened = (await panel.boundingBox())!;
  expect(reopened.x).toBeCloseTo(resized.x, 0);
  expect(reopened.width).toBeCloseTo(resized.width, 0);
  await panel.getByRole("button", { name: "Clear" }).click();
  await expect(panel.getByText("Yes, local models work too.")).toBeHidden();
  await expect(
    panel.getByRole("button", { name: "How do I set up AI features?" })
  ).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(open).toHaveAttribute("aria-expanded", "false");
});

test("Ask about Horde fills the bottom of a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const box = (await page
    .getByRole("dialog", { name: "Ask about Horde" })
    .boundingBox())!;
  expect(box.x).toBeCloseTo(8, 0);
  expect(box.width).toBeCloseTo(390 - 16, 0);
});

test("Ask about Horde shows the server's reason when no AI is set up", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  const input = panel.getByRole("textbox", { name: "Your question" });
  await input.fill("What is Horde?");
  await input.press("Enter");
  await expect(panel.getByText("What is Horde?")).toBeVisible();
  // The e2e server has no AI provider; the real route answers with an error event.
  await expect(panel.getByRole("alert")).toHaveText(/\S/);
  await expect(panel.getByText("Looking it up")).toBeHidden();
});
