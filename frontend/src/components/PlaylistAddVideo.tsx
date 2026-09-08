import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { clipboardEventToText, clipboardTextToUrl } from "../clipboard";
import { useDownloads } from "../context/DownloadContext";
import type { PlaylistDetail, Video } from "../types";
import { formatPublishedAt, joinDotList } from "../utils";
import Collapse from "./Collapse";
import {
  findLibraryVideoForUrl,
  looksLikeDownloadUrl,
  playlistAddAlreadyInPlaylist,
  playlistAddSuggestions,
  type PlaylistAddSuggestion,
} from "./playlistAddSearch";

type LinkPreview = {
  url: string;
  title: string | null;
  channel: string | null;
  published_at: string | null;
  published_label: string | null;
};

export default function PlaylistAddVideo({
  playlistId,
  memberIds,
  active,
  onAdded,
}: {
  playlistId: number;
  memberIds: Set<number>;
  active: boolean;
  onAdded: (next: PlaylistDetail) => void;
}) {
  const { refreshJobs, onJobCompleted } = useDownloads();
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingDownloads = useRef(0);
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<Video[] | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [linkPreview, setLinkPreview] = useState<LinkPreview | null>(null);
  const [linkPreviewing, setLinkPreviewing] = useState(false);

  useEffect(() => {
    if (!active) {
      setOpen(false);
      setQuery("");
      setError(null);
      setStatus(null);
      setHighlight(0);
      setLinkPreview(null);
      setLinkPreviewing(false);
    }
  }, [active]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .listVideos()
      .then((videos) => {
        if (!cancelled) setLibrary(videos);
      })
      .catch(() => {
        if (!cancelled) setLibrary([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 160);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    return onJobCompleted((videoId) => {
      if (pendingDownloads.current <= 0) return;
      pendingDownloads.current -= 1;
      if (!videoId) return;
      api
        .getPlaylist(playlistId)
        .then((next) => onAddedRef.current(next))
        .catch(() => undefined);
    });
  }, [onJobCompleted, playlistId]);

  const libraryUrlHit = useMemo(() => {
    if (library == null || !looksLikeDownloadUrl(query)) return null;
    return findLibraryVideoForUrl(library, query);
  }, [library, query]);

  useEffect(() => {
    if (!open || !looksLikeDownloadUrl(query) || libraryUrlHit) {
      setLinkPreview(null);
      setLinkPreviewing(false);
      return;
    }
    const url = clipboardTextToUrl(query) || query.trim();
    let cancelled = false;
    setLinkPreviewing(true);
    setLinkPreview(null);
    api
      .previewDownload(url)
      .then((preview) => {
        if (cancelled) return;
        setLinkPreview({
          url,
          title: preview.title,
          channel: preview.channel,
          published_at: preview.published_at ?? null,
          published_label: preview.published_label ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setLinkPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLinkPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, query, libraryUrlHit]);

  const suggestions = useMemo((): PlaylistAddSuggestion[] => {
    const raw = query.trim();
    if (!raw) return [];
    if (looksLikeDownloadUrl(raw)) {
      if (library != null) {
        return playlistAddSuggestions(raw, library, memberIds);
      }
      return [{ kind: "download", url: clipboardTextToUrl(raw) || raw }];
    }
    if (library == null) return [];
    return playlistAddSuggestions(raw, library, memberIds);
  }, [query, library, memberIds]);
  const alreadyInPlaylist = useMemo(
    () =>
      library != null &&
      playlistAddAlreadyInPlaylist(query, library, memberIds),
    [query, library, memberIds]
  );

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const highlightIndex =
    suggestions.length === 0
      ? 0
      : Math.min(highlight, suggestions.length - 1);

  const close = () => {
    setOpen(false);
    setQuery("");
    setError(null);
    setHighlight(0);
    setLinkPreview(null);
    setLinkPreviewing(false);
  };

  const addVideo = async (videoId: number) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.addToPlaylist(playlistId, videoId);
      onAdded(next);
      setQuery("");
      setStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add video");
    } finally {
      setBusy(false);
    }
  };

  const queueUrl = async (url: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.addUrlToPlaylist(playlistId, url);
      const addedExisting = next.videos.some((video) => !memberIds.has(video.id));
      onAdded(next);
      setQuery("");
      setLinkPreview(null);
      if (addedExisting) {
        setStatus(null);
        return;
      }
      pendingDownloads.current += 1;
      refreshJobs();
      setStatus("Download started — the video will appear here when it finishes.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue download");
    } finally {
      setBusy(false);
    }
  };

  const choose = async (item: PlaylistAddSuggestion) => {
    if (busy) return;
    if (item.kind === "video") await addVideo(item.video.id);
    else await queueUrl(item.url);
  };

  const submitQuery = async () => {
    const item = suggestions[highlightIndex] ?? suggestions[0];
    if (item) {
      await choose(item);
      return;
    }
    const raw = query.trim();
    if (alreadyInPlaylist) return;
    if (looksLikeDownloadUrl(raw)) {
      await queueUrl(clipboardTextToUrl(raw) || raw);
    }
  };

  const showResults = open && query.trim().length > 0;
  const loadingLibrary =
    open &&
    library === null &&
    query.trim().length > 0 &&
    !looksLikeDownloadUrl(query);

  const renderDownloadRow = (
    item: Extract<PlaylistAddSuggestion, { kind: "download" }>,
    index: number,
    activeRow: boolean
  ) => {
    const title =
      linkPreview?.title?.trim() ||
      (linkPreviewing ? "Looking up…" : "Download and add");
    const meta = joinDotList([
      linkPreview?.channel,
      formatPublishedAt(
        linkPreview?.published_at,
        linkPreview?.published_label
      ),
    ]);
    return (
      <li
        key="download"
        id={`${listId}-${index}`}
        role="option"
        aria-selected={activeRow}
      >
        <button
          type="button"
          disabled={busy}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => void choose(item)}
          className={`block w-full px-3 py-2 text-left ${
            activeRow ? "bg-ink-800" : "hover:bg-ink-800"
          }`}
        >
          <p className="truncate text-sm font-medium text-gray-100">{title}</p>
          <p className="truncate text-xs text-gray-500">
            {meta || item.url}
          </p>
        </button>
      </li>
    );
  };

  return (
    <div className={`flex-1 ${open ? "min-w-0" : "min-w-max"}`}>
      <div
        className="grid w-full transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{
          gridTemplateColumns: open
            ? "max-content minmax(0, 1fr)"
            : "max-content minmax(0, 0fr)",
        }}
      >
        <span
          aria-hidden
          className="invisible col-start-1 row-start-1 whitespace-nowrap px-3 py-1.5 text-sm"
        >
          Add Video
        </span>
        <div className="col-span-2 col-start-1 row-start-1 w-0 min-w-full">
          <div className="overflow-x-clip">
            <div
              className={`relative flex items-center overflow-hidden rounded-lg border transition-[border-color,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
                open
                  ? "border-ink-700 bg-ink-950 focus-within:border-accent"
                  : "border-ink-600 hover:border-accent"
              }`}
            >
              <span
                aria-hidden
                className="invisible whitespace-nowrap px-3 py-1.5 text-sm"
              >
                Add Video
              </span>
              <button
                type="button"
                tabIndex={open ? -1 : 0}
                aria-expanded={open}
                aria-label="Add Video"
                onClick={() => setOpen(true)}
                className={`absolute inset-0 z-[1] flex items-center whitespace-nowrap px-3 text-sm text-gray-300 transition-opacity duration-200 ease-out hover:text-accent motion-reduce:transition-none ${
                  open ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                Add Video
              </button>
              <input
                ref={inputRef}
                value={query}
                disabled={busy}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                tabIndex={open ? 0 : -1}
                role="combobox"
                aria-expanded={showResults}
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={
                  suggestions[highlightIndex]
                    ? `${listId}-${highlightIndex}`
                    : undefined
                }
                aria-label="Search library or paste a download link"
                placeholder={
                  open ? "Search library or paste a download link" : undefined
                }
                onChange={(event) => {
                  setQuery(event.target.value);
                  setError(null);
                  setStatus(null);
                }}
                onPaste={(event) => {
                  const text = clipboardEventToText(event.clipboardData);
                  const url = clipboardTextToUrl(text);
                  if (!looksLikeDownloadUrl(url)) return;
                  event.preventDefault();
                  setQuery(url);
                  setError(null);
                  setStatus(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    if (suggestions.length === 0) return;
                    event.preventDefault();
                    setHighlight((index) =>
                      Math.min(index + 1, suggestions.length - 1)
                    );
                  } else if (event.key === "ArrowUp") {
                    if (suggestions.length === 0) return;
                    event.preventDefault();
                    setHighlight((index) => Math.max(index - 1, 0));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    void submitQuery();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    if (query) {
                      setQuery("");
                      setError(null);
                    } else {
                      close();
                    }
                  }
                }}
                className={`absolute inset-0 z-0 min-w-0 bg-transparent py-1.5 pl-3 text-sm text-gray-100 outline-none transition-opacity duration-200 ease-out motion-reduce:transition-none ${
                  open
                    ? busy
                      ? "pr-8 opacity-50"
                      : "pr-8 opacity-100"
                    : "pointer-events-none pr-3 opacity-0"
                }`}
              />
              <button
                type="button"
                tabIndex={open ? 0 : -1}
                onClick={close}
                title="Close"
                aria-label="Close add video"
                className={`absolute right-0.5 top-1/2 z-[1] flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-sm text-gray-500 transition-opacity duration-200 ease-out hover:bg-ink-800 hover:text-accent motion-reduce:transition-none ${
                  open ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
              >
                ✕
              </button>
            </div>
          </div>
          <Collapse open={showResults}>
            <ul
              id={listId}
              role="listbox"
              className="mt-1 max-h-64 w-full overflow-y-auto rounded-lg bg-ink-950 ring-1 ring-ink-800 horde-scrollbar"
            >
              {loadingLibrary ? (
                <li className="px-3 py-2 text-sm text-gray-500">Searching…</li>
              ) : alreadyInPlaylist ? (
                <li className="px-3 py-2 text-sm text-gray-500">
                  Already in this playlist
                </li>
              ) : suggestions.length === 0 ? (
                <li className="px-3 py-2 text-sm text-gray-500">
                  {looksLikeDownloadUrl(query) && linkPreviewing
                    ? "Looking up…"
                    : "No matching videos"}
                </li>
              ) : (
                suggestions.map((item, index) => {
                  const activeRow = index === highlightIndex;
                  if (item.kind === "download") {
                    return renderDownloadRow(item, index, activeRow);
                  }
                  const meta = joinDotList([
                    item.video.channel,
                    formatPublishedAt(item.video.published_at),
                  ]);
                  return (
                    <li
                      key={item.video.id}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={activeRow}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onMouseEnter={() => setHighlight(index)}
                        onClick={() => void choose(item)}
                        className={`block w-full px-3 py-2 text-left ${
                          activeRow ? "bg-ink-800" : "hover:bg-ink-800"
                        }`}
                      >
                        <p className="truncate text-sm font-medium text-gray-100">
                          {item.video.title}
                        </p>
                        {meta ? (
                          <p className="truncate text-xs text-gray-500">{meta}</p>
                        ) : null}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </Collapse>
          {error && <p className="mt-1 text-sm text-red-400">{error}</p>}
          {status && !error && (
            <p className="mt-1 text-sm text-accent">{status}</p>
          )}
        </div>
      </div>
    </div>
  );
}
