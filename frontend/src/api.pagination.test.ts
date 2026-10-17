import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import type { Video } from "./types";

function video(id: number): Video {
  return { id, title: `V${id}` } as Video;
}

function serve(pages: { items: Video[]; next_cursor: string | null }[]) {
  const fetchMock = vi.fn();
  for (const page of pages) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("listVideos", () => {
  it("follows next_cursor to the last page and keeps the query", async () => {
    const fetchMock = serve([
      { items: [video(1), video(2)], next_cursor: "c1" },
      { items: [video(3)], next_cursor: null },
    ]);
    const all = await api.listVideos({ channel: "Alpha", sort: "title" });
    expect(all.map((v) => v.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new URL(fetchMock.mock.calls[0][0], "http://x");
    expect(first.searchParams.get("channel")).toBe("Alpha");
    expect(first.searchParams.get("limit")).toBe("500");
    expect(first.searchParams.has("cursor")).toBe(false);
    const second = new URL(fetchMock.mock.calls[1][0], "http://x");
    expect(second.searchParams.get("cursor")).toBe("c1");
    expect(second.searchParams.get("sort")).toBe("title");
  });

  it("reports progress after every page but the last", async () => {
    serve([
      { items: [video(1)], next_cursor: "c1" },
      { items: [video(2)], next_cursor: "c2" },
      { items: [video(3)], next_cursor: null },
    ]);
    const seen: number[][] = [];
    const all = await api.listVideos({}, (soFar) =>
      seen.push(soFar.map((v) => v.id))
    );
    expect(seen).toEqual([[1], [1, 2]]);
    expect(all.map((v) => v.id)).toEqual([1, 2, 3]);
  });

  it("makes one request for a small library", async () => {
    const fetchMock = serve([{ items: [video(1)], next_cursor: null }]);
    expect((await api.listVideos()).length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
