import { expectNoSeriousViolations } from "./axe";
import { expect, test } from "./fixtures";

const sse = (events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test("Ask about Horde answers from the Settings footer and keeps the thread", async ({
  page,
}) => {
  const bodies: { message: string; history: unknown[] }[] = [];
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

  await page.goto("/settings");
  const ask = page.getByRole("textbox", { name: "Ask about Horde" });
  await ask.fill("How do I set up AI?");
  await ask.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Ask about Horde" });
  await expect(dialog.getByText("How do I set up AI?")).toBeVisible();
  await expect(dialog.getByText("Settings → AI")).toBeVisible();
  await expect(dialog.locator("pre")).toHaveText(
    "OLLAMA_URL=http://ollama:11434"
  );
  await dialog.getByText("Sources (1)").click();
  await expect(dialog.getByRole("link", { name: "AI setup" })).toHaveAttribute(
    "href",
    "/wiki/ops/ai-setup/"
  );
  await expectNoSeriousViolations(page, "help chat", '[role="dialog"]');

  // A follow-up carries the conversation so far.
  const input = dialog.getByRole("textbox", { name: "Your question" });
  await input.fill("Can I use a local model?");
  await input.press("Enter");
  await expect(dialog.getByText("Yes, local models work too.")).toBeVisible();
  expect(bodies[1].history).toEqual([
    { role: "user", content: "How do I set up AI?" },
    {
      role: "assistant",
      content: expect.stringContaining("Settings → AI") as unknown as string,
    },
  ]);

  // Escape closes; the thread is still there for this tab after a reload.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.getByRole("textbox", { name: "Ask about Horde" }).fill("Thanks");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(dialog.getByText("Yes, local models work too.")).toBeVisible();
  await dialog.getByRole("button", { name: "Clear" }).click();
  await expect(dialog.getByText("Yes, local models work too.")).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "How do I set up AI features?" })
  ).toBeVisible();
});

test("Ask about Horde shows the server's reason when no AI is set up", async ({
  page,
}) => {
  await page.goto("/settings");
  const ask = page.getByRole("textbox", { name: "Ask about Horde" });
  await ask.fill("What is Horde?");
  await ask.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Ask about Horde" });
  await expect(dialog.getByText("What is Horde?")).toBeVisible();
  // The e2e server has no AI provider; the real route answers with an error event.
  await expect(dialog.getByRole("alert")).toHaveText(/\S/);
  await expect(dialog.getByText("Looking it up")).toBeHidden();
});
