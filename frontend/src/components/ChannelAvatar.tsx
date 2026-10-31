import { useState } from "react";
import { useChannelAvatar } from "../queries/follows";

/**
 * The channel's YouTube profile picture, or its first letter when it has none
 * (or it cannot load). Decorative: the name is the heading beside it.
 */
export default function ChannelAvatar({
  channel,
  channelUrl,
  size = "h-11 w-11 text-lg",
}: {
  channel: string;
  /** Only for a YouTube channel. */
  channelUrl: string | null;
  /** Width, height and letter size classes. */
  size?: string;
}) {
  const src = useChannelAvatar(channelUrl);
  const [failed, setFailed] = useState<string | null>(null);
  const box = `flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-full`;
  if (src && failed !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setFailed(src)}
        className={`${box} bg-ink-800 object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${box} bg-accent/15 font-semibold text-accent`}
    >
      {channel.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
