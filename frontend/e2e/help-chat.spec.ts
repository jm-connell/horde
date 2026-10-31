import { expectNoSeriousViolations } from "./axe";
import { expect, test, videoCard } from "./fixtures";

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
  const bodies: { message: string; thread_id: number | null; page: string }[] =
    [];
  await page.route(/\/api\/ask\/chat$/, (route) => {
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
        { type: "thread", id: 7, title: "How do I set up AI?" },
        { type: "scope", channels: [] },
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
  // The box keeps focus, so the next question needs no click.
  await expect(input).toBeFocused();
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
  // The server keeps the conversation: the follow-up names its thread.
  expect(bodies[0].thread_id).toBeNull();
  expect(bodies[1].thread_id).toBe(7);

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
  await panel.getByRole("button", { name: "New chat" }).click();
  await expect(panel.getByText("Yes, local models work too.")).toBeHidden();
  // The sample questions change each time; "What can you do?" is always first.
  await expect(
    panel.getByRole("button", { name: "What can you do?" })
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
  await expect(input).toBeFocused();
});

/** The applied custom stylesheet (a style tag has no rendered text). */
const savedCss = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () => document.getElementById("horde-custom-css")?.textContent ?? ""
  );

/** Answer every question with `answer` and record what was asked. */
async function stubAnswer(
  page: import("@playwright/test").Page,
  answer: string | ((n: number) => string)
) {
  const bodies: { message: string; data_consent?: string }[] = [];
  await page.route(/\/api\/ask\/chat$/, (route) => {
    const body = route.request().postDataJSON() as (typeof bodies)[number];
    bodies.push(body);
    const text = typeof answer === "string" ? answer : answer(bodies.length);
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        {
          type: "user",
          message: { id: null, role: "user", content: body.message },
        },
        { type: "token", text },
        {
          type: "done",
          message: { id: null, role: "assistant", content: text },
        },
      ]),
    });
  });
  return bodies;
}

async function ask(page: import("@playwright/test").Page, question: string) {
  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  const input = panel.getByRole("textbox", { name: "Your question" });
  await input.fill(question);
  await input.press("Enter");
  return panel;
}

test("a setting link opens its tab and rings it, and Apply changes it", async ({
  page,
}) => {
  await stubAnswer(
    page,
    "It is under [[setting:background-effect]]. Or I can do it: [[set:background-effect=rain]]"
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = await ask(page, "rain background please");

  // The action token became a card, not text.
  await expect(panel.getByText("[[set:")).toHaveCount(0);
  await expect(panel.getByText("Change")).toContainText("Rain");
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(panel.getByRole("status")).toContainText(
    "Background animation is now Rain"
  );
  const saved = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("horde.settings") || "{}")
          .backgroundEffect as string
    );
  expect(await saved()).toBe("rain");
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("is back how it was")).toBeVisible();
  expect(await saved()).toBe("none");

  // The link stays in the app, opens the tab and rings the section.
  await panel
    .getByRole("link", { name: "Background animation" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/settings\?tab=appearance$/);
  const section = page.locator('[data-setting="background"]');
  await expect(section).toHaveClass(/setting-flash/);
  await expect(section).toBeInViewport();
  await expect(section).toBeFocused();
  await expect(panel).toBeVisible();
});

test("an unknown ?find= searches Settings for the words", async ({ page }) => {
  await page.goto("/settings?tab=playback&find=sponsor");
  await expect(
    page.getByRole("searchbox", { name: "Search settings" })
  ).toHaveValue("sponsor", { timeout: 10_000 });
  await expect(page).toHaveURL(/\/settings\?tab=playback$/);
});

test("What can you do? is answered without asking the model", async ({
  page,
}) => {
  const bodies = await stubAnswer(page, "unused");
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  await panel.getByRole("button", { name: "What can you do?" }).click();
  await expect(panel.getByText("Here's what I can do:")).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Background animation" })
  ).toBeVisible();
  expect(bodies).toEqual([]);
});

test("Use my data is a setting, not a switch in the chat", async ({ page }) => {
  const bodies = await stubAnswer(page, "You have 3 videos.");
  await page.route(/\/api\/ai\/help\/info$/, (route) =>
    route.fulfill({
      json: {
        model: null,
        tier: "medium",
        provider_label: "OpenRouter, a cloud AI service",
        local: false,
        available: true,
      },
    })
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = page.getByRole("dialog", { name: "Ask about Horde" });
  await expect(panel.getByText("Use my data")).toHaveCount(0);
  await ask(page, "how many videos are in my library?");
  await expect(panel.getByText("You have 3 videos.")).toBeVisible();
  expect(bodies[0].data_consent).toBe("off");

  // The capabilities answer links the setting; it opens on the Library tab.
  await panel.getByRole("button", { name: "New chat" }).click();
  await panel.getByRole("button", { name: "What can you do?" }).click();
  await panel.getByRole("link", { name: "Use my data" }).click();
  await expect(page).toHaveURL(/\/settings\?tab=library$/);
  const choices = page.getByRole("group", { name: "Use my data" });
  await expect(choices.getByRole("button", { name: "Off" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  // The e2e server's AI is not on the local network: local-only sends nothing.
  await choices.getByRole("button", { name: "AI on my network only" }).click();
  await expect(
    page.getByText("nothing is sent until you choose")
  ).toBeVisible();
  await choices
    .getByRole("button", { name: "Any AI, including cloud" })
    .click();
  await expect(
    page.getByText("what a question needs is sent there")
  ).toBeVisible();

  await ask(page, "and now?");
  await expect(panel.getByText("You have 3 videos.")).toBeVisible();
  expect(bodies[1].data_consent).toBe("cloud");
});

test("CSS from the chat previews, reverts by itself or is kept", async ({
  page,
}) => {
  const css = '[data-horde="nav"] { outline: 3px solid rgb(255, 0, 0); }';
  const other = ".ui-card { border-radius: 2rem; }";
  await stubAnswer(
    page,
    "Here you go:\n\n```css\n" +
      css +
      "\n```\n\nOr:\n\n```css\n" +
      other +
      "\n```"
  );
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = await ask(page, "red outline on the top bar with css");
  const preview = page.locator('style[data-horde="custom-css-preview"]');
  const bar = page.getByRole("alertdialog", { name: "CSS preview" });

  const [first, second] = [
    panel.locator('[data-help-action="css"]').nth(0),
    panel.locator('[data-help-action="css"]').nth(1),
  ];
  // Only one preview at a time: starting the second ends the first.
  await second.getByRole("button", { name: "Preview" }).click();
  await expect(preview).toHaveCount(1);
  await first.getByRole("button", { name: "Preview" }).click();
  await expect(preview).toHaveCount(1);
  await expect(bar).toHaveCount(1);
  await expect(second.getByText("Reverted. Nothing was saved.")).toBeVisible();
  await expect(bar).toContainText("reverts in 20s");
  // Left alone, it undoes itself.
  await page.clock.runFor(21_000);
  await expect(preview).toHaveCount(0);
  await expect(bar).toBeHidden();
  await expect(first.getByText("Reverted. Nothing was saved.")).toBeVisible();

  // Escape reverts at once (and does not close the chat). A new preview gets
  // the whole 20 seconds again.
  await first.getByRole("button", { name: "Preview again" }).click();
  await page.clock.runFor(1_000);
  await expect(preview).toHaveCount(1);
  await expect(bar).toContainText("reverts in 19s");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(panel).toBeVisible();

  await first.getByRole("button", { name: "Preview again" }).click();
  await bar.getByRole("button", { name: "Keep" }).click();
  await expect(panel.getByText("Added to your custom CSS")).toBeVisible();
  await expect.poll(() => savedCss(page)).toContain("outline: 3px");
  const stored = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("horde.settings") || "{}") as {
        customCss: string;
        customCssEnabled: boolean;
      }
  );
  expect(stored.customCssEnabled).toBe(true);
  expect(stored.customCss).toContain(css);

  // ?nocss loads the app without it, says so, and can turn it back on.
  await page.goto("/history?nocss=1");
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.locator("#horde-custom-css")).toHaveCount(0);
  const notice = page.locator('[data-horde="custom-css-off"]');
  await expect(notice).toContainText("Custom CSS is off in this tab");
  await page.getByRole("link", { name: "History" }).first().click();
  await expect(page.locator("#horde-custom-css")).toHaveCount(0);
  await notice.getByRole("button", { name: "Turn it back on" }).click();
  await expect.poll(() => savedCss(page)).toContain("outline: 3px");
  await expect(notice).toBeHidden();
});

test("the chat offers downloads and playlists, and does them on confirm", async ({
  page,
  request,
}) => {
  const { items } = (await (await request.get("/api/videos")).json()) as {
    items: { id: number; title: string }[];
  };
  const [a, b] = items;
  await stubAnswer(
    page,
    `Found [[video:${a.id}|${a.title}]].\n\n[[playlist-new:Chat mix|${a.id},${b.id},999999]]\n\n[[download:https://www.youtube.com/watch?v=dQw4w9WgXcQ]]`
  );
  const posted: string[] = [];
  await page.route("**/api/downloads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posted.push((route.request().postDataJSON() as { url: string }).url);
    const jobs = (await (
      await route.fetch({ method: "GET" })
    ).json()) as object[];
    return route.fulfill({ json: jobs[0] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = await ask(page, "make me a playlist and grab that link");

  // The link in the reply; the playlist card lists the same video once the
  // titles load.
  await expect(
    panel.locator('a[data-help-link="video"]', { hasText: a.title })
  ).toHaveAttribute("href", `/watch/${a.id}`);
  await panel.getByRole("button", { name: "Make playlist" }).click();
  await expect(panel.getByText("Made “Chat mix” with 2 videos.")).toBeVisible();
  const playlists = (await (await request.get("/api/playlists")).json()) as {
    name: string;
  }[];
  expect(playlists.map((p) => p.name)).toContain("Chat mix");

  await panel.getByRole("button", { name: "Download" }).click();
  await expect(panel.getByText("Added to the queue.")).toBeVisible();
  expect(posted).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
});

test("a link that leaves Horde names the site it goes to", async ({ page }) => {
  await stubAnswer(
    page,
    "[Open Settings](https://evil.example/steal) or [the wiki](/wiki/) or [History](/history)"
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = await ask(page, "where are my settings?");
  const away = panel.getByRole("link", { name: "Open Settings" });
  await expect(away).toHaveAttribute("href", "https://evil.example/steal");
  await expect(away.locator("xpath=..")).toContainText(
    "Open Settings (evil.example)"
  );
  // Links that stay on this server read as before.
  await expect(panel.getByText("(localhost")).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "History" })).toHaveAttribute(
    "href",
    "/history"
  );
});

test("the chat docks at the side and the page makes room for it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const main = page.locator('[data-horde="main"]');
  const fullWidth = (await main.boundingBox())!.width;
  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = page.locator('[data-horde="help-chat"]');
  await panel
    .getByRole("button", { name: "Dock the chat at the side" })
    .click();
  await expect(panel).toHaveAttribute("data-docked", "true");

  // A full-height column on the right, below the full-width nav.
  const nav = (await page.locator('[data-horde="nav"]').boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(nav.width).toBeGreaterThan(1400);
  expect(box.x + box.width).toBeCloseTo(1440, 0);
  expect(box.y).toBeCloseTo(nav.y + nav.height, 0);
  expect(box.y + box.height).toBeCloseTo(900, 0);
  // The page sits beside it instead of under it.
  const beside = (await main.boundingBox())!;
  expect(beside.x + beside.width).toBeLessThanOrEqual(box.x + 1);
  expect(beside.width).toBeLessThan(fullWidth);

  // Dragging its left edge makes it wider and the page narrower.
  const handle = panel.getByRole("separator", { name: "Resize the chat" });
  const edge = (await handle.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x - 200, edge.y + 200, { steps: 8 });
  await page.mouse.up();
  const wider = (await panel.boundingBox())!;
  expect(wider.width).toBeGreaterThan(box.width + 150);
  expect((await main.boundingBox())!.width).toBeLessThan(beside.width - 150);
  // Arrow keys nudge it (right is narrower).
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeCloseTo(wider.width - 16, 0);

  // It stays docked, at its width, on the next page; floating again gives the
  // room back.
  await page.getByRole("link", { name: "History" }).first().click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(panel).toHaveAttribute("data-docked", "true");
  await expectNoSeriousViolations(
    page,
    "docked chat",
    '[data-horde="help-chat"]'
  );
  expect((await panel.boundingBox())!.width).toBeCloseTo(wider.width - 16, 0);
  await panel.getByRole("button", { name: "Float the chat" }).click();
  await expect(panel).not.toHaveAttribute("data-docked", "true");
  await expect
    .poll(async () => (await main.boundingBox())!.width)
    .toBeCloseTo(fullWidth, 0);
});

test("watching with the chat docked shows the player as theater", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page).toHaveURL(/\/watch\//);
  const theater = page.getByRole("button", { name: "Theater", exact: true });
  // `hover:text-accent` is on every button; the active one has it bare.
  const active = /(^|\s)text-accent(\s|$)/;
  const reveal = async () => {
    const box = (await page.locator("video").first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2);
  };
  await reveal();
  await expect(theater).not.toHaveClass(active);

  await page.getByRole("button", { name: "Ask about Horde" }).click();
  const panel = page.locator('[data-horde="help-chat"]');
  await panel
    .getByRole("button", { name: "Dock the chat at the side" })
    .click();
  await reveal();
  await expect(theater).toHaveClass(active);
  // Full bleed stops at the chat, so the player's own controls stay clickable.
  await expect
    .poll(async () => {
      const video = (await page.locator("video").first().boundingBox())!;
      const chat = (await panel.boundingBox())!;
      return video.x + video.width - chat.x;
    })
    .toBeLessThanOrEqual(1);

  // Floating it again brings back the saved standard layout.
  await panel.getByRole("button", { name: "Float the chat" }).click();
  await reveal();
  await expect(theater).not.toHaveClass(active);

  // Docked again, leaving theater from the player floats the chat.
  await panel
    .getByRole("button", { name: "Dock the chat at the side" })
    .click();
  await reveal();
  await expect(theater).toHaveClass(active);
  await reveal();
  await theater.click();
  await expect(panel).not.toHaveAttribute("data-docked", "true");
  await reveal();
  await expect(theater).not.toHaveClass(active);
});
