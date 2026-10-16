import { expect, openNav, test, videoCard, type Page } from "./fixtures";

// Player behaviour: keyboard, scrubbing, volume, speed, chapters, SponsorBlock,
// fullscreen and the mini player. Desktop only: the phone layout drops the
// volume slider and the theater/fit buttons.
//
// The seeded clip is 20 s long, so the library video is re-described on the
// way in: three chapters, one subtitle track, and a YouTube source URL so the
// SponsorBlock lookup runs (against a stubbed response).

const YT_ID = "abcdefghijk";
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:19.000\nHello from the test\n";

interface PlayerOptions {
  sponsor?: { startSec: number; endSec: number; category: string }[];
  skipMode?: "auto" | "prompt";
}

async function openPlayer(page: Page, opts: PlayerOptions = {}) {
  await page.route(/\/api\/videos\/\d+$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    body.chapters = [
      { start_sec: 0, title: "Intro" },
      { start_sec: 8, title: "Middle" },
      { start_sec: 14, title: "Finale" },
    ];
    body.subtitles = [{ lang: "en", auto: false }];
    if (opts.sponsor) {
      body.source_url = `https://www.youtube.com/watch?v=${YT_ID}`;
    }
    return route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/videos\/\d+\/subtitles\/en/, (route) =>
    route.fulfill({ contentType: "text/vtt", body: VTT })
  );
  await page.route(/sponsor\.ajay\.app\/api\/skipSegments/, (route) =>
    route.fulfill({
      json: (opts.sponsor ?? []).map((s) => ({
        segment: [s.startSec, s.endSec],
        category: s.category,
      })),
    })
  );
  if (opts.skipMode) {
    await page.addInitScript((mode) => {
      if (sessionStorage.getItem("horde-e2e-skip-mode")) return;
      sessionStorage.setItem("horde-e2e-skip-mode", "1");
      localStorage.setItem(
        "horde.settings",
        JSON.stringify({ sponsorBlockSkipMode: mode })
      );
    }, opts.skipMode);
  }
  await page.goto("/");
  await videoCard(page, "Aurora Drift").first().click();
  await expect(page).toHaveURL(/\/watch\//);
  await expect
    .poll(() => videoState(page).then((s) => s.duration))
    .toBeGreaterThan(5);
  await pauseAt(page, 0);
}

interface VideoState {
  paused: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  rate: number;
}

function videoState(page: Page): Promise<VideoState> {
  return page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement) => ({
      paused: v.paused,
      currentTime: v.currentTime,
      duration: v.duration,
      volume: v.volume,
      muted: v.muted,
      rate: v.playbackRate,
    }));
}

/** Pause and park the playhead (autoplay may have started the clip). */
async function pauseAt(page: Page, sec: number) {
  await page
    .locator("video")
    .first()
    .evaluate((v: HTMLVideoElement, t) => {
      v.pause();
      v.currentTime = t;
    }, sec);
  await expect
    .poll(() => videoState(page).then((s) => Math.abs(s.currentTime - sec)))
    .toBeLessThan(0.3);
}

/** The control bar fades out while playing; moving over the video brings it back. */
async function revealControls(page: Page) {
  const box = await page.locator("video").first().boundingBox();
  if (!box) throw new Error("video not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 3);
}

function seekBar(page: Page) {
  // The range input sits inside the pointer-handling scrub area.
  return page.getByRole("slider", { name: "Seek" }).locator("..");
}

async function scrubBox(page: Page) {
  const box = await seekBar(page).boundingBox();
  if (!box) throw new Error("scrub bar not laid out");
  return box;
}

test.describe("player keyboard shortcuts", () => {
  test.beforeEach(async ({ page }) => {
    await openPlayer(page);
  });

  test("k and Space toggle playback", async ({ page }) => {
    await page.keyboard.press("k");
    await expect.poll(() => videoState(page).then((s) => s.paused)).toBe(false);
    await page.keyboard.press("k");
    await expect.poll(() => videoState(page).then((s) => s.paused)).toBe(true);
    await page.keyboard.press(" ");
    await expect.poll(() => videoState(page).then((s) => s.paused)).toBe(false);
  });

  test("arrow keys seek 5 s and change the volume by 5%", async ({ page }) => {
    await pauseAt(page, 8);
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeCloseTo(13, 0);
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeCloseTo(8, 0);

    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => videoState(page).then((s) => s.volume))
      .toBeCloseTo(0.95, 2);
    await page.keyboard.press("ArrowUp");
    await expect
      .poll(() => videoState(page).then((s) => s.volume))
      .toBeCloseTo(1, 2);
    await revealControls(page);
    await expect(page.getByRole("slider", { name: "Volume" })).toHaveAttribute(
      "aria-valuetext",
      "100%"
    );
  });

  test("< and > step the playback speed", async ({ page }) => {
    await page.keyboard.press(">");
    await expect(page.getByTitle("Playback speed")).toHaveText("1.25x");
    await expect.poll(() => videoState(page).then((s) => s.rate)).toBe(1.25);
    await page.keyboard.press(".");
    await expect(page.getByTitle("Playback speed")).toHaveText("1.5x");
    await page.keyboard.press("<");
    await page.keyboard.press(",");
    await page.keyboard.press(",");
    await expect(page.getByTitle("Playback speed")).toHaveText("0.75x");
    await expect.poll(() => videoState(page).then((s) => s.rate)).toBe(0.75);
  });

  test("t toggles theater, f toggles fit window and Escape leaves it", async ({
    page,
  }) => {
    await revealControls(page);
    const theater = page.getByRole("button", { name: "Theater", exact: true });
    const fit = page.getByRole("button", { name: "Fit window" });
    await page.keyboard.press("t");
    // `hover:text-accent` is on every button; the active one has it bare.
    const active = /(^|\s)text-accent(\s|$)/;
    await expect(theater).toHaveClass(active);
    await page.keyboard.press("t");
    await expect(theater).not.toHaveClass(active);

    await page.keyboard.press("f");
    await expect(fit).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(fit).toHaveAttribute("aria-pressed", "false");
  });

  test("n jumps to the next chapter and c cycles the captions", async ({
    page,
  }) => {
    await pauseAt(page, 1);
    await page.keyboard.press("n");
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeCloseTo(8, 0);
    await page.keyboard.press("n");
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeCloseTo(14, 0);

    await revealControls(page);
    const cc = page.getByRole("button", { name: "CC (subtitles)" });
    await expect(cc).toHaveAttribute("aria-pressed", "false");
    const subtitleFetch = page.waitForRequest(/\/subtitles\/en/);
    await page.keyboard.press("c");
    await expect(cc).toHaveAttribute("aria-pressed", "true");
    await subtitleFetch;
    await page.keyboard.press("c");
    await expect(cc).toHaveAttribute("aria-pressed", "false");
  });

  test("shortcuts are ignored while typing in a field", async ({ page }) => {
    await pauseAt(page, 4);
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "e2e-typing";
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.type("kn>");
    const s = await videoState(page);
    expect(s.paused).toBe(true);
    expect(s.rate).toBe(1);
    expect(s.currentTime).toBeCloseTo(4, 0);
  });
});

test.describe("player controls", () => {
  test.beforeEach(async ({ page }) => {
    await openPlayer(page);
    await revealControls(page);
  });

  test("the seek bar previews, clicks, drags and takes arrow keys", async ({
    page,
  }) => {
    const box = await scrubBox(page);
    const y = box.y + box.height / 2;

    await page.mouse.move(box.x + box.width * 0.5, y);
    await expect(page.getByText("0:10", { exact: true })).toBeVisible();
    await page.mouse.click(box.x + box.width * 0.5, y);
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeGreaterThan(8);

    await page.mouse.move(box.x + box.width * 0.25, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, y, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeGreaterThan(13);

    const before = (await videoState(page)).currentTime;
    await page.getByRole("slider", { name: "Seek" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeLessThan(before - 3);
  });

  test("chapter markers seek, label the hover preview and show the chapter", async ({
    page,
  }) => {
    const marker = page.getByRole("button", { name: "Chapter Middle at 0:08" });
    await marker.hover();
    await expect(
      page.getByText("Middle", { exact: true }).first()
    ).toBeVisible();
    await marker.dispatchEvent("pointerdown", { button: 0 });
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeCloseTo(8, 0);
    await expect(page.getByText("· Middle")).toBeVisible();
  });

  test("the volume slider and mute button stay in sync", async ({ page }) => {
    const slider = page.getByRole("slider", { name: "Volume" });
    await slider.fill("0.4");
    await expect.poll(() => videoState(page).then((s) => s.volume)).toBe(0.4);
    await expect(slider).toHaveAttribute("aria-valuetext", "40%");

    await page.getByRole("button", { name: "Mute", exact: true }).click();
    await expect.poll(() => videoState(page).then((s) => s.muted)).toBe(true);
    await expect(slider).toHaveAttribute("aria-valuetext", "0%");
    await page.getByRole("button", { name: "Unmute", exact: true }).click();
    await expect.poll(() => videoState(page).then((s) => s.muted)).toBe(false);

    await slider.fill("0");
    await expect(
      page.getByRole("button", { name: "Unmute", exact: true })
    ).toBeVisible();
    await expect.poll(() => videoState(page).then((s) => s.muted)).toBe(true);
  });

  test("the speed menu applies a rate and closes on Escape", async ({
    page,
  }) => {
    await page.getByTitle("Playback speed").click();
    await page.getByRole("button", { name: "2x", exact: true }).click();
    await expect.poll(() => videoState(page).then((s) => s.rate)).toBe(2);
    await page.getByRole("slider", { name: "Playback speed" }).fill("0.5");
    await expect.poll(() => videoState(page).then((s) => s.rate)).toBe(0.5);
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("Playback speed")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await expect(page.getByTitle("Playback speed")).toBeFocused();
  });

  test("the fullscreen button enters and leaves fullscreen", async ({
    page,
  }) => {
    const button = page.getByRole("button", {
      name: "Fullscreen",
      exact: true,
    });
    await button.click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null))
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.body.classList.contains("player-fullscreen")
        )
      )
      .toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null))
      .toBe(false);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.body.classList.contains("player-fullscreen")
        )
      )
      .toBe(false);
  });

  test("the PiP button asks the browser for picture in picture", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const v = document.querySelector("video") as HTMLVideoElement;
      (window as unknown as { __pip: number }).__pip = 0;
      v.requestPictureInPicture = async () => {
        (window as unknown as { __pip: number }).__pip += 1;
        return {} as PictureInPictureWindow;
      };
    });
    await page
      .getByRole("button", { name: "PiP (picture in picture)" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __pip: number }).__pip)
      )
      .toBe(1);
  });

  test("Play and Pause buttons follow the video", async ({ page }) => {
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => videoState(page).then((s) => s.paused)).toBe(false);
    await revealControls(page);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => videoState(page).then((s) => s.paused)).toBe(true);
  });
});

test.describe("SponsorBlock skipping", () => {
  const sponsor = [{ startSec: 5, endSec: 9, category: "sponsor" }];

  test("auto mode skips the segment and offers to go back", async ({
    page,
  }) => {
    await openPlayer(page, { sponsor });
    await pauseAt(page, 3.5);
    await page.evaluate(() => {
      const w = window as unknown as { __times: number[] };
      w.__times = [];
      document
        .querySelector("video")!
        .addEventListener("timeupdate", (e) =>
          w.__times.push((e.target as HTMLVideoElement).currentTime)
        );
    });
    await page
      .locator("video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.play());
    const notice = page.getByRole("status").filter({ hasText: /Skipped/ });
    await expect(notice).toBeVisible({ timeout: 10_000 });
    // The notice lasts 4 s, so the jump must already have happened. Playback
    // never sampled the skipped stretch.
    expect((await videoState(page)).currentTime).toBeGreaterThan(8.9);
    const seen = await page.evaluate(
      () => (window as unknown as { __times: number[] }).__times
    );
    expect(seen.filter((t) => t > 5.5 && t < 8.5)).toEqual([]);
    await notice.getByRole("button", { name: "Go back" }).click();
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime))
      .toBeLessThan(5.5);
    // The undone segment is not skipped a second time.
    await page.waitForTimeout(2500);
    expect((await videoState(page)).currentTime).toBeGreaterThan(6);
  });

  test("prompt mode asks first and Skip jumps past the segment", async ({
    page,
  }) => {
    await openPlayer(page, { sponsor, skipMode: "prompt" });
    await pauseAt(page, 4);
    await page
      .locator("video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.play());
    const prompt = page.getByRole("status").filter({
      has: page.getByRole("button", { name: "Skip", exact: true }),
    });
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    // Freeze inside the segment so only Skip can move the playhead past it.
    await pauseAt(page, 6);
    await prompt.getByRole("button", { name: "Skip", exact: true }).click();
    await expect
      .poll(() => videoState(page).then((s) => s.currentTime), {
        timeout: 2000,
      })
      .toBeGreaterThan(8.9);
    await expect(page.getByRole("button", { name: "Go back" })).toBeVisible();
  });
});

test.describe("mini player", () => {
  async function toMiniPlayer(page: Page) {
    await openPlayer(page);
    await page
      .locator("video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.play());
    await openNav(page, "Home");
    await expect(page).not.toHaveURL(/\/watch\//);
    const mini = page.locator(".player-mini");
    await expect(mini).toBeVisible();
    return mini;
  }

  test("keeps playing, expands back to the watch page and closes", async ({
    page,
  }) => {
    const mini = await toMiniPlayer(page);
    await expect(mini).toContainText("Aurora Drift");
    await expect.poll(() => videoState(page).then((s) => s.paused)).toBe(false);

    await mini.hover();
    await mini.getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => videoState(page).then((s) => s.paused)).toBe(true);

    await mini.hover();
    await mini.getByRole("button", { name: "Expand" }).click();
    await expect(page).toHaveURL(/\/watch\//);
    await expect(page.locator(".player-mini")).toHaveCount(0);

    await openNav(page, "Home");
    await page.locator(".player-mini").hover();
    await page
      .locator(".player-mini")
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.locator("video")).toHaveCount(0);
  });

  test("closing the mini player mid-drag leaves no window listeners behind", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const live = new Set<unknown>();
      const w = window as unknown as { __live: Set<unknown> };
      w.__live = live;
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      window.addEventListener = ((type: string, fn: unknown, o?: unknown) => {
        if (type === "pointermove") live.add(fn);
        return add(type, fn as EventListener, o as boolean);
      }) as typeof window.addEventListener;
      window.removeEventListener = ((
        type: string,
        fn: unknown,
        o?: unknown
      ) => {
        if (type === "pointermove") live.delete(fn);
        return remove(type, fn as EventListener, o as boolean);
      }) as typeof window.removeEventListener;
    });
    const mini = await toMiniPlayer(page);
    const live = () =>
      page.evaluate(
        () => (window as unknown as { __live: Set<unknown> }).__live.size
      );
    const before = await live();
    // Press on the picture (starts a drag) and close without releasing.
    await mini.locator("video").dispatchEvent("pointerdown", {
      button: 0,
      pointerId: 7,
      pointerType: "mouse",
      bubbles: true,
    });
    expect(await live()).toBe(before + 1);
    await mini.hover();
    await mini.getByRole("button", { name: "Close" }).dispatchEvent("click");
    await expect(page.locator("video")).toHaveCount(0);
    expect(await live()).toBe(before);
  });

  test("can be dragged and resized", async ({ page }) => {
    const mini = await toMiniPlayer(page);
    const start = await mini.boundingBox();
    if (!start) throw new Error("mini player not laid out");

    // Drag by the picture.
    const grabX = start.x + start.width / 2;
    const grabY = start.y + start.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX - 120, grabY - 80, { steps: 8 });
    await page.mouse.up();
    const moved = await mini.boundingBox();
    if (!moved) throw new Error("mini player vanished");
    expect(
      Math.abs(moved.x - start.x) + Math.abs(moved.y - start.y)
    ).toBeGreaterThan(40);
    expect(moved.width).toBeCloseTo(start.width, 0);
    // A drag must not toggle playback.
    expect((await videoState(page)).paused).toBe(false);

    // Resize from the top-left handle.
    await page.mouse.move(moved.x + 4, moved.y + 4);
    await page.mouse.down();
    await page.mouse.move(moved.x - 76, moved.y - 76, { steps: 8 });
    await page.mouse.up();
    const resized = await mini.boundingBox();
    if (!resized) throw new Error("mini player vanished");
    expect(resized.width).toBeGreaterThan(moved.width + 40);
  });
});

test.describe("player behaviour across state changes", () => {
  function controlBar(page: Page) {
    return page
      .getByRole("slider", { name: "Seek" })
      .locator("xpath=ancestor::div[contains(@class,'bg-gradient-to-t')][1]");
  }
  const play = (page: Page) =>
    page
      .locator("video")
      .first()
      .evaluate((v: HTMLVideoElement) => v.play());

  test("controls auto-hide while playing and stay up with a menu open", async ({
    page,
  }) => {
    await openPlayer(page);
    await revealControls(page);
    await play(page);
    await expect(controlBar(page)).toHaveClass(/opacity-0/, {
      timeout: 8000,
    });
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.playerPlaying))
      .toBe("true");
    await revealControls(page);
    await expect(controlBar(page)).toHaveClass(/opacity-100/);
    await page.getByTitle("Playback speed").click();
    await page.waitForTimeout(3800);
    await expect(controlBar(page)).toHaveClass(/opacity-100/);
    await page.keyboard.press("Escape");
    await expect(controlBar(page)).toHaveClass(/opacity-0/, {
      timeout: 8000,
    });
    await page.keyboard.press("t");
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.playerCovering))
      .toBe("true");
  });

  test("holding the picture plays at the hold speed and restores the rate", async ({
    page,
  }) => {
    await openPlayer(page);
    await play(page);
    const box = (await page.locator("video").first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await expect
      .poll(() => videoState(page).then((s) => s.rate), { timeout: 3000 })
      .not.toBe(1);
    expect((await videoState(page)).rate).toBeGreaterThan(1);
    await page.mouse.up();
    await expect.poll(() => videoState(page).then((s) => s.rate)).toBe(1);
    await page.waitForTimeout(400);
    // The click that ends a hold must not pause.
    expect((await videoState(page)).paused).toBe(false);
  });

  test("picture in picture switches captions to native cues and back", async ({
    page,
  }) => {
    await openPlayer(page);
    await revealControls(page);
    await play(page);
    const modes = () =>
      page
        .locator("video")
        .first()
        .evaluate((v: HTMLVideoElement) =>
          Array.from(v.textTracks).map((t) => t.mode)
        );
    await page.keyboard.press("c");
    await expect.poll(modes).toEqual(["hidden"]);
    const fire = (type: string) =>
      page
        .locator("video")
        .first()
        .evaluate((v, t) => v.dispatchEvent(new Event(t)), type);
    await fire("enterpictureinpicture");
    await expect.poll(modes).toEqual(["showing"]);
    await fire("leavepictureinpicture");
    await expect.poll(modes).toEqual(["hidden"]);
  });

  test("volume survives and a pending skip prompt is dropped on a source change", async ({
    page,
  }) => {
    await openPlayer(page, {
      sponsor: [{ startSec: 5, endSec: 9, category: "sponsor" }],
      skipMode: "prompt",
    });
    await revealControls(page);
    await page.getByRole("slider", { name: "Volume" }).fill("0.4");
    await expect.poll(() => videoState(page).then((s) => s.volume)).toBe(0.4);
    await pauseAt(page, 4);
    await play(page);
    const prompt = page.getByRole("status").filter({
      has: page.getByRole("button", { name: "Skip", exact: true }),
    });
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    await openNav(page, "Home");
    await expect(page.locator(".player-mini")).toBeVisible();
    await videoCard(page, "Kiln fire").click();
    await expect(page).toHaveURL(/\/watch\//);
    await expect
      .poll(() => videoState(page).then((s) => s.duration))
      .toBeGreaterThan(5);
    expect((await videoState(page)).volume).toBe(0.4);
    await expect(prompt).toHaveCount(0);
  });
});
