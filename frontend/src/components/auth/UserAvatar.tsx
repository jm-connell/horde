import { useState } from "react";
import { avatarUrl } from "../../api";

const SIZES = {
  sm: "h-6 w-6 text-xs",
  md: "h-8 w-8 text-sm",
  lg: "h-20 w-20 text-3xl",
} as const;

/**
 * A profile picture, or the first letter of the name when there is none (or
 * it cannot load, e.g. offline). Decorative: the name is always shown beside
 * it, and the letter is drawn by CSS so it is not part of that row's text.
 */
export default function UserAvatar({
  userId,
  username,
  version,
  size = "sm",
  className = "",
}: {
  userId: number;
  username: string;
  version: number | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = version != null ? avatarUrl(userId, version) : null;
  const box = `flex shrink-0 items-center justify-center overflow-hidden rounded-full ${SIZES[size]} ${className}`;

  if (src && failed !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        onError={() => setFailed(src)}
        className={`${box} object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-initial={username.slice(0, 1)}
      className={`${box} bg-accent/20 font-bold uppercase text-accent before:content-[attr(data-initial)]`}
    />
  );
}
