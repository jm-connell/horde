import { useState } from "react";
import { Link } from "react-router-dom";
import { isYoutubeChannelUrl } from "../../components/channelFeedYoutubeSearch";
import { useAuth } from "../../context/AuthContext";
import ChannelAvatar from "../../components/ChannelAvatar";
import { useChannelFollow } from "../../queries/follows";
import type { ChannelAutodownload, ChannelStat } from "../../types";
import { formatCompactCount, joinDotList } from "../../utils";
import {
  formatCatalogProgress,
  type CatalogProgress,
} from "../libraryCatalogProgress";
import {
  autodownloadChipLabel,
  channelHandle,
  retentionChipLabel,
  type ChannelSettingsSection,
} from "./channelSettings/channelSettingsText";

/**
 * A channel page's header: who the channel is, the primary actions (Follow,
 * Download…, Channel settings) beside how much of it is indexed, and chips
 * that sum up its active policies.
 */
export default function ChannelHeader({
  channel,
  channelUrl,
  stat,
  autodownload,
  catalogProgress,
  onOpenSettings,
}: {
  channel: string;
  channelUrl: string | null;
  /** The channel's row in the library list (absent for a channel not in it). */
  stat: ChannelStat | null;
  autodownload: ChannelAutodownload | null;
  catalogProgress: CatalogProgress | null;
  onOpenSettings: (section: ChannelSettingsSection | null) => void;
}) {
  const { can } = useAuth();
  const youtube = isYoutubeChannelUrl(channelUrl);
  const handle = channelHandle(channelUrl);
  const count = stat?.count ?? 0;
  const meta = joinDotList([
    handle,
    `${count} video${count === 1 ? "" : "s"} downloaded`,
    stat?.subscriber_count != null
      ? `${formatCompactCount(stat.subscriber_count)} subscribers`
      : null,
  ]);

  const chips: Chip[] = [];
  const autoLabel = autodownloadChipLabel(autodownload);
  if (autoLabel)
    chips.push({ section: "autodownload", label: autoLabel, tone: "accent" });
  const retentionLabel = retentionChipLabel(stat?.retention);
  if (retentionLabel)
    chips.push({ section: "retention", label: retentionLabel, tone: "accent" });
  const indexChip: Chip | null =
    youtube && catalogProgress
      ? {
          section: "manage",
          label: formatCatalogProgress(catalogProgress),
          tone: catalogProgress.status === "error" ? "error" : "muted",
        }
      : null;

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
          <ChannelAvatar
            channel={channel}
            channelUrl={youtube ? channelUrl : null}
          />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold text-gray-100">
              {channel}
            </h1>
            <p className="truncate text-xs text-muted">{meta}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {indexChip && (
            <ChipButton
              chip={indexChip}
              onClick={() => onOpenSettings(indexChip.section)}
            />
          )}
          {youtube && (
            <FollowButton channel={channel} channelUrl={channelUrl} />
          )}
          {youtube && channelUrl && can("download") && (
            <Link
              to={`/download?url=${encodeURIComponent(channelUrl)}`}
              title="Pick videos from this channel to download"
              className={actionButton}
            >
              Download…
            </Link>
          )}
          <button
            type="button"
            onClick={() => onOpenSettings(null)}
            aria-label="Channel settings"
            title="Channel settings"
            className={`${actionButton} px-2.5`}
          >
            <GearIcon />
          </button>
        </div>
      </div>
      {chips.length > 0 && (
        <ul aria-label="Channel status" className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <li key={chip.section}>
              <ChipButton
                chip={chip}
                onClick={() => onOpenSettings(chip.section)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Chip = {
  section: ChannelSettingsSection;
  label: string;
  tone: "accent" | "muted" | "error";
};

function ChipButton({ chip, onClick }: { chip: Chip; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open in channel settings"
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:border-accent ${
        chip.tone === "accent"
          ? "border-accent/40 bg-accent/10 text-accent"
          : chip.tone === "error"
            ? "border-danger/40 bg-danger/10 text-danger"
            : "border-ink-700 bg-ink-900 text-muted hover:text-gray-200"
      }`}
    >
      {chip.label}
    </button>
  );
}

const actionButton =
  "ui-panel ui-interactive inline-flex h-9 items-center justify-center rounded-lg border border-ink-700 bg-ink-900 px-3 text-sm text-gray-200 transition-colors hover:border-accent hover:text-accent disabled:opacity-50";

function FollowButton({
  channel,
  channelUrl,
}: {
  channel: string;
  channelUrl: string | null;
}) {
  const follow = useChannelFollow(channelUrl, channel);
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={follow.followed}
      disabled={follow.pending}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={follow.toggle}
      className={
        follow.followed
          ? `${actionButton} border-accent/50 text-accent`
          : "inline-flex h-9 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
      }
    >
      {follow.followed ? (hover ? "Unfollow" : "Following") : "Follow"}
    </button>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4.5 w-4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.6 2.6h2.8l.4 2.1 1.5.9 2-.7 1.4 2.4-1.6 1.4v1.8l1.6 1.4-1.4 2.4-2-.7-1.5.9-.4 2.1H8.6l-.4-2.1-1.5-.9-2 .7-1.4-2.4 1.6-1.4V9.1L3.3 7.7l1.4-2.4 2 .7 1.5-.9z"
      />
      <circle cx="10" cy="10" r="2.4" />
    </svg>
  );
}
