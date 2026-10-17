import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { focusOnMount } from "../../utils";
import {
  useFollows,
  useFollowMutation,
  useUnfollowMutation,
} from "../../queries/follows";
import {
  isYoutubeChannelUrl,
  normalizeChannelUrl,
} from "../../utils/followUrl";

/**
 * The page title. On a channel page it carries a pencil to rename the channel
 * in place (for accounts that may edit metadata).
 */
export default function ChannelHeader({
  headline,
  activeChannel,
  isHome,
  channelUrl,
  onRename,
}: {
  headline: string;
  activeChannel: string | null;
  isHome: boolean;
  /** The channel's URL from the library list; the follow button needs it. */
  channelUrl?: string | null;
  /** Renames the channel; the page follows it. Reports its own errors. */
  onRename: (oldName: string, newName: string) => Promise<void>;
}) {
  const { can } = useAuth();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const followable = !!activeChannel && isYoutubeChannelUrl(channelUrl);
  const { follows } = useFollows(followable);
  const follow = useFollowMutation();
  const unfollow = useUnfollowMutation();
  const [hover, setHover] = useState(false);
  const normalized = channelUrl ? normalizeChannelUrl(channelUrl) : null;
  const followed =
    !!normalized && follows.some((f) => f.channel_url === normalized);

  const submitRename = async (oldName: string) => {
    const next = renameValue.trim();
    setRenaming(null);
    if (!next || next === oldName) return;
    await onRename(oldName, next);
  };

  if (activeChannel && renaming === activeChannel) {
    return (
      <input
        ref={focusOnMount}
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={() => submitRename(activeChannel)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submitRename(activeChannel);
          if (e.key === "Escape") setRenaming(null);
        }}
        className="rounded-lg border border-accent bg-ink-950 px-3 py-1 text-2xl font-bold text-gray-100 outline-none"
      />
    );
  }
  return (
    <>
      <h1
        className={`group ${
          isHome ? "sr-only lg:not-sr-only lg:flex" : "flex"
        } shrink-0 items-center gap-2 text-2xl font-bold text-gray-100`}
      >
        {headline}
        {activeChannel && can("edit_metadata") && (
          <button
            onClick={() => {
              setRenameValue(activeChannel);
              setRenaming(activeChannel);
            }}
            title="Rename channel"
            className="text-base text-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
          >
            ✎
          </button>
        )}
      </h1>
      {followable && channelUrl && (
        <button
          type="button"
          aria-pressed={followed}
          disabled={follow.isPending || unfollow.isPending}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={() =>
            followed && normalized
              ? unfollow.mutate(normalized)
              : follow.mutate({ url: channelUrl, name: activeChannel })
          }
          className="shrink-0 text-xs text-muted transition-colors hover:text-accent disabled:opacity-50"
        >
          {followed ? (hover ? "Unfollow" : "Following") : "Follow"}
        </button>
      )}
    </>
  );
}
