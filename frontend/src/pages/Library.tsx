import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import VideoCard from "../components/VideoCard";
import type { ChannelStat, Video } from "../types";

const SORT_OPTIONS = [
  { value: "added_at", label: "Recently added" },
  { value: "published_at", label: "Publish date" },
  { value: "title", label: "Title" },
  { value: "duration", label: "Duration" },
];

export default function Library() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [activeChannel, setActiveChannel] = useState<string | null>(
    searchParams.get("channel")
  );
  const [activeTag, setActiveTag] = useState<string | null>(
    searchParams.get("tag")
  );
  const [sort, setSort] = useState("added_at");
  const [order, setOrder] = useState("desc");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const reloadChannels = () =>
    api.listChannels().then(setChannels).catch(() => undefined);

  const submitRename = async (oldName: string) => {
    const next = renameValue.trim();
    setRenaming(null);
    if (!next || next === oldName) return;
    await api.renameChannel(oldName, next).catch(() => undefined);
    if (activeChannel === oldName) setActiveChannel(next);
    reloadChannels();
  };

  useEffect(() => {
    setActiveTag(searchParams.get("tag"));
    setActiveChannel(searchParams.get("channel"));
  }, [searchParams]);

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    api.listChannels().then(setChannels).catch(() => undefined);
    api.listTags().then(setTags).catch(() => undefined);
  }, [videos.length]);

  useEffect(() => {
    setLoading(true);
    api
      .listVideos({
        q: debouncedSearch || undefined,
        channel: activeChannel || undefined,
        tag: activeTag || undefined,
        sort,
        order,
      })
      .then(setVideos)
      .catch(() => setVideos([]))
      .finally(() => setLoading(false));
  }, [debouncedSearch, activeChannel, activeTag, sort, order]);

  const headline = useMemo(() => {
    if (activeChannel) return activeChannel;
    if (activeTag) return `#${activeTag}`;
    return "Library";
  }, [activeChannel, activeTag]);

  return (
    <div className="flex gap-6">
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-20 space-y-6">
          <div>
            <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Channels
            </h2>
            <ul className="space-y-0.5">
              <li>
                <button
                  onClick={() => setActiveChannel(null)}
                  className={`w-full rounded-lg px-3 py-1.5 text-left text-sm ${
                    !activeChannel
                      ? "bg-accent/15 text-accent"
                      : "text-gray-300 hover:bg-ink-800"
                  }`}
                >
                  All channels
                </button>
              </li>
              {channels.map((c) =>
                renaming === c.channel ? (
                  <li key={c.channel} className="px-1">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => submitRename(c.channel)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRename(c.channel);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="w-full rounded-lg border border-accent bg-ink-950 px-2 py-1 text-sm text-gray-100 outline-none"
                    />
                  </li>
                ) : (
                  <li key={c.channel} className="group flex items-center">
                    <button
                      onClick={() => setActiveChannel(c.channel)}
                      className={`flex min-w-0 flex-1 items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm ${
                        activeChannel === c.channel
                          ? "bg-accent/15 text-accent"
                          : "text-gray-300 hover:bg-ink-800"
                      }`}
                    >
                      <span className="truncate">{c.channel}</span>
                      <span className="ml-2 text-xs text-gray-500">{c.count}</span>
                    </button>
                    <button
                      onClick={() => {
                        setRenameValue(c.channel);
                        setRenaming(c.channel);
                      }}
                      title="Rename channel"
                      className="ml-1 shrink-0 px-1 text-xs text-gray-600 opacity-0 hover:text-accent group-hover:opacity-100"
                    >
                      ✎
                    </button>
                  </li>
                )
              )}
            </ul>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <h1 className="text-2xl font-bold text-gray-100">{headline}</h1>
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:justify-end">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search videos..."
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent sm:w-64"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setOrder(order === "desc" ? "asc" : "desc")}
              className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 hover:border-accent"
              title="Toggle sort direction"
            >
              {order === "desc" ? "↓" : "↑"}
            </button>
          </div>
        </div>

        {tags.length > 0 && (
          <div className="mb-5 flex flex-wrap gap-2">
            {activeTag && (
              <button
                onClick={() => setActiveTag(null)}
                className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-ink-950"
              >
                #{activeTag} ✕
              </button>
            )}
            {tags
              .filter((t) => t !== activeTag)
              .map((tag) => (
                <button
                  key={tag}
                  onClick={() => setActiveTag(tag)}
                  className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
                >
                  #{tag}
                </button>
              ))}
          </div>
        )}

        {loading ? (
          <p className="py-20 text-center text-gray-500">Loading...</p>
        ) : videos.length === 0 ? (
          <div className="py-20 text-center text-gray-500">
            <p className="text-lg">No videos yet.</p>
            <p className="mt-1 text-sm">
              Paste a link on the Download page or drop files into your media
              folder.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {videos.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
