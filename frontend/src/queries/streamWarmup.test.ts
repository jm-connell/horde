import {
  CancelledError,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { StreamPreviewMeta } from "../types";
import { queryKeys } from "./keys";
import {
  StreamWarmer,
  WARM_DWELL_MS,
  WARM_REPEAT_MS,
  streamWarmer,
  type WarmDeps,
} from "./streamWarmup";

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
    fetchMeta: vi.fn<WarmDeps["fetchMeta"]>(
      (url) =>
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
    /** Each details request as [url, sent as a background lookup]. */
    metaKinds: () => deps.fetchMeta.mock.calls,
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
  vi.restoreAllMocks();
});

describe("StreamWarmer", () => {
  it("rest warms once the pointer has rested long enough", async () => {
    const h = harness();
    h.warmer.rest("A");
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS - 1);
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

  it("another card leaving keeps the dwell", async () => {
    // A card that unmounts (an infinite list, a refreshed feed) must not
    // cancel the card the pointer is resting on.
    const h = harness();
    const resting = {};
    h.warmer.rest("A", resting);
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS / 2);
    h.warmer.leave({});
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS / 2);
    expect(h.metaCalls()).toEqual(["A"]);
  });

  it("a second rest replaces the first", async () => {
    const h = harness();
    h.warmer.rest("A");
    await vi.advanceTimersByTimeAsync(60);
    h.warmer.rest("B");
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS);
    expect(h.metaCalls()).toEqual(["B"]);
  });

  it("a card the pointer only crosses is not warmed", async () => {
    // Its lookup would hold the server's one-at-a-time YouTube gate while
    // the card actually clicked waits behind it.
    const h = harness();
    h.warmer.rest("A");
    await vi.advanceTimersByTimeAsync(250);
    h.warmer.leave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.metaCalls()).toEqual([]);
  });

  it("a rest asks for a background lookup, a press for a full-priority one", async () => {
    const h = harness();
    h.warmer.rest("A");
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS);
    await h.answer("A");
    await h.warmer.idle();
    h.warmer.warm("B");
    expect(h.metaKinds()).toEqual([
      ["A", true],
      ["B", false],
    ]);
  });

  it("a press on the card waiting its turn raises it to full priority", async () => {
    const h = harness();
    h.warmer.warm("A");
    h.warmer.rest("B");
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS);
    h.warmer.warm("B");
    h.warmer.rest("B");
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS);
    await h.answer("A");
    expect(h.metaKinds()).toEqual([
      ["A", false],
      ["B", false],
    ]);
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

describe("a rest's details and the watch page's query", () => {
  const URL = "https://www.youtube.com/watch?v=restwarm001";
  const key = queryKeys.preview.meta(URL);
  const details = (title: string) =>
    ({
      title,
      is_live: false,
      library_video_id: null,
    }) as StreamPreviewMeta;

  /** A rest on URL whose background lookup stays open until answered. */
  async function restOn(client: QueryClient) {
    let answer: (m: StreamPreviewMeta) => void = () => {};
    const lookup = vi
      .spyOn(api, "getPreviewMeta")
      .mockImplementation(
        () => new Promise<StreamPreviewMeta>((resolve) => (answer = resolve))
      );
    vi.spyOn(api, "warmPreviewManifest").mockResolvedValue();
    const warmer = streamWarmer(client);
    warmer.rest(URL);
    await vi.advanceTimersByTimeAsync(WARM_DWELL_MS);
    expect(lookup).toHaveBeenCalledWith(URL, { background: true });
    return async (m: StreamPreviewMeta) => {
      answer(m);
      await warmer.idle();
    };
  }

  it("fills the query the watch page reads", async () => {
    const client = new QueryClient();
    const answer = await restOn(client);
    await answer(details("warmed"));
    expect(client.getQueryData(key)).toEqual(details("warmed"));
  });

  it("leaves alone details the page loaded and left meanwhile", async () => {
    // Coming back must ask again (a newer resume point), not reuse the late
    // answer as fresh.
    const client = new QueryClient();
    const answer = await restOn(client);
    client.setQueryData(key, details("page"));
    await client.invalidateQueries({ queryKey: key, refetchType: "none" });
    await answer(details("warmed"));
    expect(client.getQueryData(key)).toEqual(details("page"));
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("does not swap the details an open page is showing", async () => {
    // New details hand the player the stream again.
    const client = new QueryClient();
    client.setQueryData(key, details("page"));
    const page = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => details("page"),
      enabled: false,
    });
    const stop = page.subscribe(() => {});
    vi.setSystemTime(Date.now() + WARM_REPEAT_MS + 1);
    const answer = await restOn(client);
    await answer(details("warmed"));
    expect(client.getQueryData(key)).toEqual(details("page"));
    stop();
  });
});
