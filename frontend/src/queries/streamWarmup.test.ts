import { CancelledError } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamWarmer, WARM_REPEAT_MS, type WarmDeps } from "./streamWarmup";

type Meta = Awaited<ReturnType<WarmDeps["fetchMeta"]>>;

const PLAIN: Meta = { is_live: false, library_video_id: null };

/** Deps whose details requests stay open until the test settles them. */
function harness(details: (url: string) => Meta = () => PLAIN) {
  let clock = 1_000_000;
  const open = new Map<
    string,
    { resolve: (m: Meta) => void; reject: (e: Error) => void }
  >();
  const deps = {
    fetchMeta: vi.fn(
      (url: string) =>
        new Promise<Meta>((resolve, reject) => {
          open.set(url, { resolve, reject });
        })
    ),
    fetchManifest: vi.fn(async (url: string) => void url),
    now: () => clock,
  };
  const warmer = new StreamWarmer(deps);
  return {
    deps,
    warmer,
    metaCalls: () => deps.fetchMeta.mock.calls.map(([url]) => url),
    /** Answer the open details request for ``url``. */
    async answer(url: string) {
      open.get(url)?.resolve(details(url));
      open.delete(url);
      await vi.advanceTimersByTimeAsync(0);
    },
    async fail(url: string, error: Error = new Error("502")) {
      open.get(url)?.reject(error);
      open.delete(url);
      await vi.advanceTimersByTimeAsync(0);
    },
    tick(ms: number) {
      clock += ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamWarmer", () => {
  it("rest warms after 120 ms", async () => {
    const h = harness();
    h.warmer.rest("A");
    await vi.advanceTimersByTimeAsync(119);
    expect(h.metaCalls()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.metaCalls()).toEqual(["A"]);
  });

  it("leaving before the dwell ends cancels it", async () => {
    const h = harness();
    h.warmer.rest("A");
    await vi.advanceTimersByTimeAsync(100);
    h.warmer.leave();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.metaCalls()).toEqual([]);
  });

  it("a second rest replaces the first", async () => {
    const h = harness();
    h.warmer.rest("A");
    await vi.advanceTimersByTimeAsync(60);
    h.warmer.rest("B");
    await vi.advanceTimersByTimeAsync(120);
    expect(h.metaCalls()).toEqual(["B"]);
  });

  it("warm starts at once", () => {
    const h = harness();
    h.warmer.warm("A");
    expect(h.metaCalls()).toEqual(["A"]);
  });

  it("the manifest follows the details unless live or downloaded", async () => {
    const h = harness((url) =>
      url === "live"
        ? { is_live: true, library_video_id: null }
        : url === "saved"
          ? { is_live: false, library_video_id: 7 }
          : PLAIN
    );
    for (const url of ["plain", "live", "saved"]) {
      h.warmer.warm(url);
      await h.answer(url);
    }
    await h.warmer.idle();
    expect(h.deps.fetchManifest.mock.calls).toEqual([["plain"]]);
  });

  it("one at a time and the newest pending wins", async () => {
    const h = harness();
    h.warmer.warm("A");
    h.warmer.warm("B");
    h.warmer.warm("C");
    expect(h.metaCalls()).toEqual(["A"]);
    await h.answer("A");
    await h.answer("C");
    await h.warmer.idle();
    expect(h.metaCalls()).toEqual(["A", "C"]);
  });

  it("a url warmed within 3 minutes is skipped", async () => {
    const h = harness();
    h.warmer.warm("A");
    await h.answer("A");
    await h.warmer.idle();
    h.warmer.warm("A");
    expect(h.metaCalls()).toEqual(["A"]);
    h.tick(WARM_REPEAT_MS + 1);
    h.warmer.warm("A");
    expect(h.metaCalls()).toEqual(["A", "A"]);
  });

  it("a failed warm-up also waits 3 minutes", async () => {
    // A video that cannot play (premiere, private, removed) would otherwise
    // cost a YouTube lookup on every hover.
    const h = harness();
    h.warmer.warm("A");
    await h.fail("A");
    await h.warmer.idle();
    h.warmer.warm("A");
    expect(h.metaCalls()).toEqual(["A"]);
    h.tick(WARM_REPEAT_MS + 1);
    h.warmer.warm("A");
    expect(h.metaCalls()).toEqual(["A", "A"]);
  });

  it("a cancelled warm-up can be retried at once", async () => {
    const h = harness();
    h.warmer.warm("A");
    await h.fail("A", new CancelledError());
    await h.warmer.idle();
    h.warmer.warm("A");
    expect(h.metaCalls()).toEqual(["A", "A"]);
  });

  it("warming the url already running or pending does nothing", async () => {
    const h = harness();
    h.warmer.warm("A");
    h.warmer.warm("A");
    h.warmer.warm("B");
    h.warmer.warm("B");
    await h.answer("A");
    await h.answer("B");
    await h.warmer.idle();
    expect(h.metaCalls()).toEqual(["A", "B"]);
  });
});
