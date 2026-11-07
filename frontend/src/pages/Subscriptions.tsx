import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { describeError } from "../apiErrors";
import LoadingIndicator from "../components/LoadingIndicator";
import { button } from "../components/buttons";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useAskChannels } from "../queries/ask";
import {
  useChannelAvatar,
  useSubscribe,
  useSubscriptions,
} from "../queries/follows";
import { queryKeys } from "../queries/keys";
import type { AskChannel, Subscription } from "../types";
import { formatRelative } from "../utils";
import { findAskChannel } from "./ask/askLinks";
import { saveChannelUrl } from "./libraryStorage";
import ChannelSettingsSheet from "./library/channelSettings/ChannelSettingsSheet";
import {
  autodownloadChipLabel,
  retentionChipLabel,
} from "./library/channelSettings/channelSettingsText";
import { useChannelCatalog } from "./library/useChannelCatalog";

/** The channel page, with its URL remembered for channels the library lacks. */
function channelHref(sub: Subscription): string {
  return `/?${new URLSearchParams({ channel: channelName(sub) })}`;
}

function channelName(sub: Subscription): string {
  return sub.channel_name ?? sub.channel_url;
}

const chip =
  "inline-flex items-center gap-1 rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-gray-300 ring-1 ring-ink-700";

function Avatar({ sub, size }: { sub: Subscription; size: "md" | "sm" }) {
  const avatar = useChannelAvatar(sub.channel_url);
  const box = size === "md" ? "h-11 w-11 text-base" : "h-8 w-8 text-sm";
  return avatar ? (
    <img
      src={avatar}
      alt=""
      className={`${box} shrink-0 rounded-full object-cover`}
    />
  ) : (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center rounded-full bg-ink-800 text-gray-300`}
    >
      {channelName(sub).slice(0, 1).toUpperCase()}
    </span>
  );
}

const ASK_STATE: Partial<Record<AskChannel["status"], string>> = {
  ready: "Ask",
  paused: "Ask · paused",
  error: "Ask · error",
};

/** What is on for the channel, as small chips (nothing for plain subscriptions). */
function StatusChips({
  sub,
  ask,
}: {
  sub: Subscription;
  ask: AskChannel | null;
}) {
  const auto = autodownloadChipLabel(
    sub.autodownload
      ? { enabled: true, quality_preset: sub.quality_preset ?? "1080p" }
      : null
  );
  const keep = retentionChipLabel(sub.retention);
  if (!auto && !keep && !ask) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Turned on">
      {auto && <li className={chip}>{auto}</li>}
      {ask && (
        <li className={chip} title="Ask and the search bar use its captions">
          {ASK_STATE[ask.status] ?? "Ask · indexing"}
        </li>
      )}
      {keep && <li className={chip}>{keep}</li>}
    </ul>
  );
}

function SettingsButton({
  sub,
  onOpen,
}: {
  sub: Subscription;
  onOpen: (sub: Subscription) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(sub)}
      aria-label={`Settings for ${channelName(sub)}`}
      className={`${button("quiet", "sm")} shrink-0`}
    >
      Settings
    </button>
  );
}

function videoCount(sub: Subscription): string {
  if (sub.video_count === 0) return "Nothing downloaded";
  return sub.video_count === 1 ? "1 video" : `${sub.video_count} videos`;
}

function SubscriptionCard({
  sub,
  ask,
  onOpen,
}: {
  sub: Subscription;
  ask: AskChannel | null;
  onOpen: (sub: Subscription) => void;
}) {
  const name = channelName(sub);
  return (
    <li className="ui-panel flex items-center gap-3 rounded-xl bg-ink-900 p-3 ring-1 ring-ink-700">
      <Avatar sub={sub} size="md" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="min-w-0">
          <Link
            to={channelHref(sub)}
            onClick={() => saveChannelUrl(name, sub.channel_url)}
            className="block truncate text-sm font-medium text-gray-100 hover:text-accent"
          >
            {name}
          </Link>
          <p className="truncate text-xs text-muted">
            {videoCount(sub)}
            {sub.checked_at
              ? ` · checked ${formatRelative(sub.checked_at)}`
              : ""}
          </p>
        </div>
        <StatusChips sub={sub} ask={ask} />
      </div>
      <SettingsButton sub={sub} onOpen={onOpen} />
    </li>
  );
}

/** A channel that downloads or cleans up for everyone but you do not subscribe to. */
function ServerChannelRow({
  sub,
  ask,
  onOpen,
}: {
  sub: Subscription;
  ask: AskChannel | null;
  onOpen: (sub: Subscription) => void;
}) {
  const { can } = useAuth();
  const { showError } = useToast();
  const { subscribe, pending } = useSubscribe();
  const name = channelName(sub);
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-ink-800">
      <Avatar sub={sub} size="sm" />
      <Link
        to={channelHref(sub)}
        onClick={() => saveChannelUrl(name, sub.channel_url)}
        className="min-w-0 flex-1 truncate text-sm text-gray-200 hover:text-accent"
      >
        {name}
      </Link>
      <div className="hidden sm:block">
        <StatusChips sub={sub} ask={ask} />
      </div>
      <div className="flex shrink-0 gap-1">
        {can("manage_subscriptions") && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              subscribe(sub.channel_url, sub.channel_name).catch(
                (err: unknown) =>
                  showError(`Could not subscribe: ${describeError(err)}`)
              )
            }
            className={button("secondary", "sm")}
          >
            Subscribe
          </button>
        )}
        <SettingsButton sub={sub} onOpen={onOpen} />
      </div>
    </li>
  );
}

/** The channel settings sheet, opened over this page for one subscription. */
function SubscriptionSettings({
  sub,
  onClose,
}: {
  sub: Subscription;
  onClose: () => void;
}) {
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const name = channelName(sub);
  const catalog = useChannelCatalog(name, sub.channel_url);
  return (
    <ChannelSettingsSheet
      channel={name}
      channelUrl={sub.channel_url}
      section={null}
      catalog={catalog}
      onRename={async (next) => {
        try {
          await api.renameChannel(name, next);
          onClose();
        } catch (err) {
          showError(`Could not rename the channel: ${describeError(err)}`);
        } finally {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.follows.subscriptions,
          });
        }
      }}
      onClose={() => {
        // Auto-download and cleanup changes show on the card.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.follows.subscriptions,
        });
        onClose();
      }}
    />
  );
}

function AddChannel() {
  const { can } = useAuth();
  const { showError, showToast } = useToast();
  const queryClient = useQueryClient();
  const { subscribe, mayIndex } = useSubscribe();
  const inputId = useId();
  const autoId = useId();
  const askId = useId();
  const [value, setValue] = useState("");
  const [autodownload, setAutodownload] = useState(false);
  const [indexAsk, setIndexAsk] = useState(true);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const text = value.trim();
    if (!text) return;
    setBusy(true);
    try {
      const followed = await subscribe(text, null, { indexAsk });
      const name = followed.channel_name ?? followed.channel_url;
      if (autodownload) {
        await api.updateChannelAutodownload({
          url: followed.channel_url,
          channel: followed.channel_name ?? undefined,
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
        YouTube channel link or @handle
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add a channel: link or @handle"
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className={`${button("primary")} shrink-0`}
        >
          {busy ? "Subscribing…" : "Subscribe"}
        </button>
      </div>
      {(can("download") || mayIndex) && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-300">
          {can("download") && (
            <div className="flex items-center gap-2">
              <input
                id={autoId}
                type="checkbox"
                checked={autodownload}
                onChange={(e) => setAutodownload(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <label htmlFor={autoId}>Download new uploads (1080p)</label>
            </div>
          )}
          {mayIndex && (
            <div className="flex items-center gap-2">
              <input
                id={askId}
                type="checkbox"
                checked={indexAsk}
                onChange={(e) => setIndexAsk(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <label htmlFor={askId}>
                Index for Ask and search{" "}
                <span className="text-muted">
                  (asks first above 500 videos)
                </span>
              </label>
            </div>
          )}
        </div>
      )}
    </form>
  );
}

export default function Subscriptions() {
  const { can } = useAuth();
  const { items, isLoading, isError, error } = useSubscriptions();
  const askChannels = useAskChannels(true).data?.items ?? [];
  const [open, setOpen] = useState<Subscription | null>(null);
  const mine = items.filter((s) => s.following);
  const server = items.filter((s) => !s.following);
  const askFor = (sub: Subscription) =>
    findAskChannel(askChannels, sub.channel_url, sub.channel_name);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-2xl font-bold text-gray-100">Subscriptions</h1>
        {mine.length > 0 && (
          <span className="text-sm text-muted">{mine.length}</span>
        )}
      </div>
      <p className="mb-5 max-w-2xl text-sm text-gray-400">
        Your channels: they show when they go live, and their new uploads land
        in Recommended+. Settings on each one add automatic downloads, cleanup
        and Ask indexing, which apply for everyone on this server.
      </p>
      {can("manage_subscriptions") && <AddChannel />}
      {isLoading ? (
        <LoadingIndicator />
      ) : isError ? (
        <p className="text-sm text-danger" role="alert">
          Could not load subscriptions: {describeError(error)}
        </p>
      ) : (
        <>
          {mine.length === 0 ? (
            <div className="py-10 text-center text-muted">
              <p className="text-lg">No subscriptions yet.</p>
              <p className="mt-1 text-sm">
                Paste a channel link above, or open a channel from the library
                and press Subscribe.
              </p>
            </div>
          ) : (
            <ul
              className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
              aria-label="Subscriptions"
            >
              {mine.map((sub) => (
                <SubscriptionCard
                  key={sub.channel_url}
                  sub={sub}
                  ask={askFor(sub)}
                  onOpen={setOpen}
                />
              ))}
            </ul>
          )}
          {server.length > 0 && (
            <section className="mt-8" aria-labelledby="server-channels">
              <h2
                id="server-channels"
                className="mb-1 text-sm font-medium text-gray-200"
              >
                Downloading for everyone
              </h2>
              <p className="mb-2 text-xs text-muted">
                Channels with automatic downloads or cleanup that you do not
                subscribe to.
              </p>
              <ul className="space-y-0.5" aria-label="Downloading for everyone">
                {server.map((sub) => (
                  <ServerChannelRow
                    key={sub.channel_url}
                    sub={sub}
                    ask={askFor(sub)}
                    onOpen={setOpen}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {open && (
        <SubscriptionSettings
          key={open.channel_url}
          sub={open}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
