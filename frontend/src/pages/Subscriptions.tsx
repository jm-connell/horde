import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { describeError } from "../apiErrors";
import LoadingIndicator from "../components/LoadingIndicator";
import { button } from "../components/buttons";
import { MoreIcon } from "../components/icons";
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
import { formatCompactCount, formatRelative } from "../utils";
import { findAskChannel } from "./ask/askLinks";
import { saveChannelUrl } from "./libraryStorage";
import AddChannel from "./subscriptions/AddChannel";
import {
  isSubscriptionSort,
  SUBSCRIPTION_SORTS,
  sortSubscriptions,
  subscriptionMatches,
  type SubscriptionSort,
} from "./subscriptions/match";
import ThemedSelect from "../components/ThemedSelect";
import { getItem, setItem } from "../storage";
import { normalizeChannelUrl } from "../utils/followUrl";
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
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-ink-800 px-1.5 py-px text-[11px] leading-4 text-gray-300 ring-1 ring-ink-700";

function Avatar({ sub, size }: { sub: Subscription; size: "md" | "sm" }) {
  const avatar = useChannelAvatar(sub.channel_url);
  const box = size === "md" ? "h-10 w-10 text-base" : "h-8 w-8 text-sm";
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
  const autoTitle = autodownloadChipLabel(
    sub.autodownload
      ? { enabled: true, quality_preset: sub.quality_preset ?? "1080p" }
      : null
  );
  const auto = sub.autodownload
    ? `Auto ${sub.quality_preset ?? "1080p"}`
    : null;
  const keep = retentionChipLabel(sub.retention);
  if (!auto && !keep && !ask) return null;
  return (
    <ul
      className="flex min-w-0 shrink gap-1 overflow-hidden"
      aria-label="Turned on"
    >
      {auto && (
        <li className={chip} title={autoTitle ?? undefined}>
          {auto}
        </li>
      )}
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
      title="Channel settings"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-ink-800 hover:text-accent"
    >
      <MoreIcon className="h-4 w-4" />
    </button>
  );
}

function videoCount(sub: Subscription): string {
  if (sub.video_count === 0) return "No videos";
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
    <li className="ui-panel flex items-center gap-2.5 rounded-xl bg-ink-900 py-2 pl-2.5 pr-1.5 ring-1 ring-ink-700">
      <Avatar sub={sub} size="md" />
      <div className="min-w-0 flex-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <Link
              to={channelHref(sub)}
              onClick={() => saveChannelUrl(name, sub.channel_url)}
              className="min-w-0 truncate text-sm font-medium text-gray-100 hover:text-accent"
            >
              {name}
            </Link>
            {sub.subscriber_count != null && (
              <span
                className="shrink-0 text-xs text-muted"
                title={`${sub.subscriber_count.toLocaleString()} subscribers on YouTube`}
              >
                {formatCompactCount(sub.subscriber_count)} subs
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <p
              className="min-w-0 shrink-[2] truncate text-xs text-muted"
              title={
                sub.checked_at
                  ? `Checked ${formatRelative(sub.checked_at)}`
                  : undefined
              }
            >
              {videoCount(sub)}
            </p>
            <StatusChips sub={sub} ask={ask} />
          </div>
        </div>
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

/** The chosen order, remembered on this device. */
const SORT_KEY = "horde.subscriptions.sort";

export default function Subscriptions() {
  const { can } = useAuth();
  const { items, isLoading, isError, error } = useSubscriptions();
  const askChannels = useAskChannels(true).data?.items ?? [];
  const [open, setOpen] = useState<Subscription | null>(null);
  const [typed, setTyped] = useState("");
  const [sort, setSortState] = useState<SubscriptionSort>(() => {
    const saved = getItem(SORT_KEY);
    return isSubscriptionSort(saved) ? saved : "name";
  });
  const setSort = (next: SubscriptionSort) => {
    setSortState(next);
    setItem(SORT_KEY, next);
  };
  const allMine = sortSubscriptions(
    items.filter((s) => s.following),
    sort
  );
  const allServer = items.filter((s) => !s.following);
  // Typing a channel you already have narrows the list to it; a channel you
  // do not have leaves the whole list in view.
  const matched =
    typed.length >= 2 ? items.filter((s) => subscriptionMatches(s, typed)) : [];
  const filtering = matched.length > 0;
  const mine = filtering ? allMine.filter((s) => matched.includes(s)) : allMine;
  const server = filtering
    ? allServer.filter((s) => matched.includes(s))
    : allServer;
  const askFor = (sub: Subscription) =>
    findAskChannel(askChannels, sub.channel_url, sub.channel_name);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-2xl font-bold text-gray-100">Subscriptions</h1>
        {allMine.length > 0 && (
          <span className="text-sm text-muted">{allMine.length}</span>
        )}
      </div>
      <p className="mb-5 max-w-2xl text-sm text-gray-400">
        Your channels: they show when they go live, and their new uploads land
        in Recommended+. Settings on each one add automatic downloads, cleanup
        and Ask indexing, which apply for everyone on this server.
      </p>
      {can("manage_subscriptions") && (
        <AddChannel
          subscribed={
            new Set(
              allMine.map((s) => normalizeChannelUrl(s.channel_url) ?? "")
            )
          }
          onTextChange={setTyped}
        />
      )}
      {allMine.length > 1 && (
        <div className="mb-3 flex justify-end">
          <ThemedSelect
            value={sort}
            options={SUBSCRIPTION_SORTS}
            onChange={setSort}
            size="compact"
            align="right"
            aria-label="Sort subscriptions"
          />
        </div>
      )}
      <p role="status" className="mb-2 text-sm text-muted empty:hidden">
        {filtering
          ? `Showing ${matched.length} ${
              matched.length === 1 ? "channel" : "channels"
            } you already have matching “${typed}”`
          : ""}
      </p>
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
                Search for a channel above, or open one from the library and
                press Subscribe.
              </p>
            </div>
          ) : (
            <ul
              className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
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
