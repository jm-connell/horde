import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { describeError } from "../apiErrors";
import LoadingIndicator from "../components/LoadingIndicator";
import { button } from "../components/buttons";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import {
  useChannelAvatar,
  useFollowMutation,
  useSubscriptions,
  useUnfollowMutation,
} from "../queries/follows";
import { queryKeys } from "../queries/keys";
import type { Subscription } from "../types";
import { formatRelative } from "../utils";
import { saveChannelUrl } from "./libraryStorage";
import {
  autodownloadChipLabel,
  retentionChipLabel,
  type ChannelSettingsSection,
} from "./library/channelSettings/channelSettingsText";

/** The channel page, with its URL remembered for channels the library lacks. */
function channelHref(
  sub: Subscription,
  section?: ChannelSettingsSection
): string {
  const name = sub.channel_name ?? sub.channel_url;
  const qs = new URLSearchParams({ channel: name });
  if (section) qs.set("settings", section);
  return `/?${qs}`;
}

const chip =
  "inline-flex items-center rounded-full bg-ink-800 px-2.5 py-0.5 text-xs text-gray-300 ring-1 ring-ink-700";

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const { can } = useAuth();
  const { showError, showToast } = useToast();
  const queryClient = useQueryClient();
  const avatar = useChannelAvatar(sub.channel_url);
  const follow = useFollowMutation();
  const unfollow = useUnfollowMutation();
  const [savingAuto, setSavingAuto] = useState(false);
  const name = sub.channel_name ?? sub.channel_url;
  const autoLabel = autodownloadChipLabel(
    sub.autodownload
      ? { enabled: true, quality_preset: sub.quality_preset ?? "1080p" }
      : null
  );
  const keepLabel = retentionChipLabel(sub.retention);
  const remember = () => saveChannelUrl(name, sub.channel_url);

  const toggleFollow = () => {
    const done = {
      onError: (err: unknown) =>
        showError(`Could not change following: ${describeError(err)}`),
    };
    if (sub.following) unfollow.mutate(sub.channel_url, done);
    else follow.mutate({ url: sub.channel_url, name }, done);
  };

  const toggleAutodownload = async () => {
    setSavingAuto(true);
    try {
      // Keep the channel's other choices (quality, older videos) as they are.
      const current = await api.getChannelAutodownload({
        url: sub.channel_url,
      });
      await api.updateChannelAutodownload({
        url: sub.channel_url,
        channel: sub.channel_name ?? undefined,
        enabled: !sub.autodownload,
        // Turning it on here means new uploads only (as the button says): an
        // earlier "all older videos" choice must not fill the disk on a click.
        previous_mode: sub.autodownload ? current.previous_mode : "none",
        previous_count: current.previous_count,
        quality_preset: current.quality_preset,
        include_completed_streams: current.include_completed_streams,
      });
      showToast(
        sub.autodownload
          ? `Stopped downloading new uploads of ${name}`
          : `New uploads of ${name} will download by themselves`
      );
    } catch (err) {
      showError(`Could not change automatic downloads: ${describeError(err)}`);
    } finally {
      setSavingAuto(false);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.follows.subscriptions,
      });
    }
  };

  const followBusy = follow.isPending || unfollow.isPending;
  return (
    <li className="ui-panel flex flex-wrap items-center gap-3 rounded-xl bg-ink-900 p-3 ring-1 ring-ink-700">
      <Link
        to={channelHref(sub)}
        onClick={remember}
        className="flex min-w-0 flex-1 items-center gap-3 hover:text-accent"
      >
        {avatar ? (
          <img
            src={avatar}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-800 text-sm text-gray-300"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate font-medium text-gray-100">
            {name}
          </span>
          <span className="block truncate text-xs text-muted">
            {sub.video_count === 1 ? "1 video" : `${sub.video_count} videos`} in
            the library
            {sub.checked_at
              ? ` · checked ${formatRelative(sub.checked_at)}`
              : ""}
          </span>
        </span>
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        {keepLabel && (
          <Link
            to={channelHref(sub, "retention")}
            onClick={remember}
            className={`${chip} hover:text-accent`}
          >
            {keepLabel}
          </Link>
        )}
        <button
          type="button"
          aria-pressed={sub.following}
          disabled={followBusy}
          onClick={toggleFollow}
          className={button(sub.following ? "secondary" : "primary", "sm")}
          title="Following shows when the channel is live and puts its new uploads in Recommended+ (for you only)"
        >
          {sub.following ? "Following" : "Follow"}
        </button>
        {can("download") && (
          <button
            type="button"
            aria-pressed={sub.autodownload}
            disabled={savingAuto}
            onClick={() => void toggleAutodownload()}
            className={button(sub.autodownload ? "secondary" : "quiet", "sm")}
            title="Download new uploads by themselves (for everyone on this server)"
          >
            {savingAuto ? "Saving…" : (autoLabel ?? "Auto-download off")}
          </button>
        )}
        <Link
          to={channelHref(sub, "autodownload")}
          onClick={remember}
          className={button("quiet", "sm")}
        >
          Settings
        </Link>
      </div>
    </li>
  );
}

function AddChannel() {
  const { can } = useAuth();
  const { showError, showToast } = useToast();
  const queryClient = useQueryClient();
  const follow = useFollowMutation();
  const inputId = useId();
  const autoId = useId();
  const [value, setValue] = useState("");
  const [autodownload, setAutodownload] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const text = value.trim();
    if (!text) return;
    setBusy(true);
    try {
      const followed = await follow.mutateAsync({ url: text });
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
          ? `Following ${name}; new uploads will download by themselves`
          : `Following ${name}`
      );
      setValue("");
    } catch (err) {
      showError(`Could not add the channel: ${describeError(err)}`);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.follows.subscriptions,
      });
    }
  };

  return (
    <form
      className="ui-panel mb-6 rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label
        htmlFor={inputId}
        className="mb-2 block text-sm font-medium text-gray-200"
      >
        Add a YouTube channel
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Channel link or @handle"
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className={`${button("primary")} shrink-0`}
        >
          {busy ? "Adding…" : "Follow"}
        </button>
      </div>
      {can("download") && (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-300">
          <input
            id={autoId}
            type="checkbox"
            checked={autodownload}
            onChange={(e) => setAutodownload(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          <label htmlFor={autoId}>
            Also download its new uploads automatically (1080p; change it in the
            channel&rsquo;s settings)
          </label>
        </div>
      )}
    </form>
  );
}

export default function Subscriptions() {
  const { items, isLoading, isError, error } = useSubscriptions();
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Subscriptions</h1>
      <p className="mb-6 text-sm text-gray-400">
        Channels you follow, and channels Horde downloads or cleans up by
        itself. Following is yours alone; automatic downloads and cleanup rules
        apply to everyone on this server.
      </p>
      <AddChannel />
      {isLoading ? (
        <LoadingIndicator />
      ) : isError ? (
        <p className="text-sm text-danger" role="alert">
          Could not load subscriptions: {describeError(error)}
        </p>
      ) : items.length === 0 ? (
        <div className="py-10 text-center text-muted">
          <p className="text-lg">No subscriptions yet.</p>
          <p className="mt-1 text-sm">
            Paste a channel link above, or open a channel from the library and
            press Follow.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Subscriptions">
          {items.map((sub) => (
            <SubscriptionRow key={sub.channel_url} sub={sub} />
          ))}
        </ul>
      )}
    </div>
  );
}
