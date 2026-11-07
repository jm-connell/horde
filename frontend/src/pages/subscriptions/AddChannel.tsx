import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { ApiError } from "../../api/client";
import { describeError } from "../../apiErrors";
import Collapse from "../../components/Collapse";
import { button } from "../../components/buttons";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useSubscribe } from "../../queries/follows";
import { queryKeys } from "../../queries/keys";
import { formatCompactCount } from "../../utils";
import { normalizeChannelUrl } from "../../utils/followUrl";
import { Toggle } from "../settings/ui";

/** A channel the box has found: from a search result or a looked-up link. */
interface Candidate {
  channelUrl: string;
  name: string;
  avatar: string | null;
  subscribers: number | null;
}

/** A link or an @handle is looked up; anything else is searched for. */
const LINK_RE = /^(https?:\/\/|www\.|m\.youtube\.|youtube\.com\/|@)/i;
const DEBOUNCE_MS = 350;

/** YouTube's search hands back protocol-relative picture URLs. */
function httpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("//") ? `https:${url}` : url;
}

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return debounced;
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 text-muted motion-safe:animate-spin"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Avatar({
  src,
  name,
  size,
}: {
  src: string | null;
  name: string;
  size: string;
}) {
  return src ? (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className={`${size} shrink-0 rounded-full object-cover`}
    />
  ) : (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-full bg-ink-800 text-sm text-gray-300`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * Add a channel: type a name to search YouTube's channels, or paste a link or
 * @handle to look it up. Once one is found the box opens to show it and the
 * options (automatic downloads, Ask indexing), and Subscribe becomes active.
 */
export default function AddChannel({
  subscribed,
  onTextChange,
}: {
  subscribed: Set<string>;
  /** The box's text as typed, so the page can show matching subscriptions. */
  onTextChange: (text: string) => void;
}) {
  const { can } = useAuth();
  const { showError, showToast } = useToast();
  const queryClient = useQueryClient();
  const { subscribe, mayIndex } = useSubscribe();
  const inputId = useId();
  const resultsId = useId();
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [autodownload, setAutodownload] = useState(false);
  const [indexAsk, setIndexAsk] = useState(true);
  const [busy, setBusy] = useState(false);

  const text = value.trim();
  useEffect(() => onTextChange(text), [text, onTextChange]);
  const debounced = useDebounced(text);
  const isLink = LINK_RE.test(debounced);
  const ready = debounced.length >= 2 && !picked;

  const preview = useQuery({
    queryKey: queryKeys.channels.preview(debounced),
    queryFn: ({ signal }) => api.previewChannel(debounced, { signal }),
    enabled: ready && isLink,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const search = useQuery({
    queryKey: queryKeys.channels.youtubeSearch(debounced),
    queryFn: ({ signal }) => api.searchChannels(debounced, 6, { signal }),
    enabled: ready && !isLink,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const found: Candidate | null =
    picked ??
    (ready && isLink && preview.data
      ? {
          channelUrl: preview.data.channel_url,
          name: preview.data.channel_name ?? preview.data.channel_url,
          avatar: preview.data.avatar_url ?? null,
          subscribers: null,
        }
      : null);
  const results = ready && !isLink ? (search.data?.results ?? []) : [];
  const loading =
    !found &&
    text.length >= 2 &&
    (text !== debounced || preview.isFetching || search.isFetching);
  // The open box keeps showing the last channel while it folds shut.
  const [shown, setShown] = useState<Candidate | null>(null);
  if (found && found.channelUrl !== shown?.channelUrl) setShown(found);
  const already =
    !!found && subscribed.has(normalizeChannelUrl(found.channelUrl) ?? "");

  let note: string | null = null;
  if (!loading && ready && isLink && preview.isError)
    note =
      preview.error instanceof ApiError &&
      preview.error.code === "channel_not_found"
        ? "No YouTube channel found there."
        : describeError(preview.error, "Could not look that channel up");
  else if (!loading && ready && !isLink && search.isError)
    note = describeError(search.error, "Could not search YouTube");
  else if (!loading && ready && !isLink && search.isSuccess && !results.length)
    note = "No channels found. Try another name, or paste its link.";

  const pick = (hit: (typeof results)[number]) => {
    setPicked({
      channelUrl: hit.url,
      name: hit.name,
      avatar: httpsUrl(hit.thumbnail_url),
      subscribers: hit.subscriber_count ?? null,
    });
    setValue(hit.name);
  };

  const add = async () => {
    if (!found || already) {
      if (results[0]) pick(results[0]);
      return;
    }
    setBusy(true);
    try {
      const followed = await subscribe(found.channelUrl, found.name, {
        indexAsk,
      });
      const name = followed.channel_name ?? found.name;
      if (autodownload) {
        await api.updateChannelAutodownload({
          url: followed.channel_url,
          channel: followed.channel_name ?? found.name,
          enabled: true,
          previous_mode: "none",
          quality_preset: "1080p",
          include_completed_streams: false,
        });
      }
      showToast(
        autodownload
          ? `Subscribed to ${name}; new uploads will download by themselves`
          : `Subscribed to ${name}`
      );
      setValue("");
      setPicked(null);
    } catch (err) {
      showError(`Could not subscribe: ${describeError(err)}`);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.follows.subscriptions,
      });
    }
  };

  return (
    <form
      className="ui-panel mb-6 rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Find a YouTube channel: name, link or @handle
      </label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id={inputId}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setPicked(null);
            }}
            placeholder="Add a channel: search, link or @handle"
            autoComplete="off"
            aria-controls={results.length ? resultsId : undefined}
            aria-busy={loading || undefined}
            className="w-full rounded-lg border border-ink-700 bg-ink-950 py-2 pl-3 pr-9 text-sm text-gray-100 outline-hidden focus:border-accent"
          />
          {loading && (
            <span
              className="absolute inset-y-0 right-3 flex items-center"
              role="status"
              aria-label="Looking for the channel"
            >
              <Spinner />
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={busy || !found || already}
          className={`${button("primary")} shrink-0`}
        >
          {busy ? "Subscribing…" : "Subscribe"}
        </button>
      </div>

      {results.length > 0 && (
        <ul
          id={resultsId}
          aria-label="Channels found"
          className="mt-2 space-y-0.5"
        >
          {results.map((hit) => {
            const known = subscribed.has(normalizeChannelUrl(hit.url) ?? "");
            return (
              <li key={hit.url}>
                <button
                  type="button"
                  onClick={() => pick(hit)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-ink-800 focus-visible:bg-ink-800"
                >
                  <Avatar
                    src={httpsUrl(hit.thumbnail_url)}
                    name={hit.name}
                    size="h-8 w-8"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                    {hit.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {known
                      ? "Subscribed"
                      : hit.subscriber_count != null
                        ? `${formatCompactCount(hit.subscriber_count)} subs`
                        : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {note && <p className="mt-2 text-sm text-muted">{note}</p>}

      <Collapse open={!!found}>
        {shown && (
          <div className="mt-3 space-y-3 border-t border-ink-700 pt-3">
            <div
              className="flex items-center gap-3"
              role="group"
              aria-label={`Found: ${shown.name}`}
            >
              <Avatar src={shown.avatar} name={shown.name} size="h-10 w-10" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-100">
                  {shown.name}
                </p>
                <p className="truncate text-xs text-muted">
                  {already
                    ? "You already subscribe to this channel"
                    : shown.subscribers != null
                      ? `${formatCompactCount(shown.subscribers)} subscribers`
                      : shown.channelUrl.replace(/^https:\/\//, "")}
                </p>
              </div>
            </div>
            {!already && (can("download") || mayIndex) && (
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-200">
                {can("download") && (
                  <label className="flex items-center gap-2.5">
                    <Toggle
                      checked={autodownload}
                      onChange={() => setAutodownload((v) => !v)}
                    />
                    Download new uploads (1080p)
                  </label>
                )}
                {mayIndex && (
                  <label className="flex items-center gap-2.5">
                    <Toggle
                      checked={indexAsk}
                      onChange={() => setIndexAsk((v) => !v)}
                    />
                    <span>
                      Index for Ask and search{" "}
                      <span className="text-muted">
                        (asks first above 500 videos)
                      </span>
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </Collapse>
    </form>
  );
}
