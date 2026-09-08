import { describe, expect, it } from "vitest";
import {
  filterLibraryVideos,
  findLibraryVideoForUrl,
  looksLikeDownloadUrl,
  playlistAddAlreadyInPlaylist,
  playlistAddSuggestions,
  type PlaylistAddLibraryHit,
} from "./playlistAddSearch";

function hit(
  partial: Partial<PlaylistAddLibraryHit> & Pick<PlaylistAddLibraryHit, "id" | "title">
): PlaylistAddLibraryHit {
  return {
    channel: "Alpha",
    published_at: "2024-01-15T00:00:00Z",
    source_url: null,
    file_path: `Alpha/${partial.title} [aaaaaaaaaa${partial.id}].mp4`,
    status: "ready",
    ...partial,
  };
}

describe("looksLikeDownloadUrl", () => {
  it("accepts http(s) links and YouTube hosts", () => {
    expect(looksLikeDownloadUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(
      looksLikeDownloadUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ).toBe(true);
    expect(looksLikeDownloadUrl("youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(looksLikeDownloadUrl("youtu.be/dQw4w9WgXcQ")).toBe(true);
  });

  it("rejects title searches and bare hosts", () => {
    expect(looksLikeDownloadUrl("hyprland install")).toBe(false);
    expect(looksLikeDownloadUrl("youtube.com")).toBe(false);
    expect(looksLikeDownloadUrl("")).toBe(false);
  });
});

describe("playlist add suggestions", () => {
  const library = [
    hit({
      id: 1,
      title: "Hyprland rice",
      channel: "Linux Channel",
      source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      file_path: "Linux Channel/Hyprland rice [dQw4w9WgXcQ].mp4",
    }),
    hit({
      id: 2,
      title: "Garden tour",
      channel: "Plants",
      published_at: "2023-06-01T00:00:00Z",
    }),
    hit({
      id: 3,
      title: "Hyprland keybinds",
      channel: "Linux Channel",
    }),
    hit({
      id: 4,
      title: "Still downloading",
      status: "downloading",
    }),
  ];

  it("filters library by title and channel, skipping members and non-ready", () => {
    const hits = filterLibraryVideos(library, "hyprland linux", new Set([3]));
    expect(hits.map((v) => v.id)).toEqual([1]);
  });

  it("matches channel names, including compact spellings", () => {
    const plants = filterLibraryVideos(library, "plants", new Set());
    expect(plants.map((v) => v.id)).toEqual([2]);

    const compact = [
      ...library,
      hit({
        id: 5,
        title: "PC build log",
        channel: "JayzTwoCents",
      }),
    ];
    expect(
      filterLibraryVideos(compact, "jayz two cents", new Set()).map((v) => v.id)
    ).toEqual([5]);
  });

  it("matches a pasted watch URL to a downloaded video", () => {
    const found = findLibraryVideoForUrl(
      library,
      "https://youtu.be/dQw4w9WgXcQ"
    );
    expect(found?.id).toBe(1);
  });

  it("suggests download when the URL is not in the library", () => {
    const suggestions = playlistAddSuggestions(
      "https://www.youtube.com/watch?v=xxxxxxxxxxx",
      library,
      new Set()
    );
    expect(suggestions).toEqual([
      {
        kind: "download",
        url: "https://www.youtube.com/watch?v=xxxxxxxxxxx",
      },
    ]);
  });

  it("hides a URL that is already in the playlist", () => {
    expect(
      playlistAddAlreadyInPlaylist(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        library,
        new Set([1])
      )
    ).toBe(true);
    expect(
      playlistAddSuggestions(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        library,
        new Set([1])
      )
    ).toEqual([]);
  });
});
