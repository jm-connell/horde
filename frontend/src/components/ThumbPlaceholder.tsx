import { PlayIcon } from "./icons";

/** A card's thumbnail area when there is no picture (none, or it failed to load). */
export default function ThumbPlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center text-muted">
      <PlayIcon className="text-4xl" />
    </div>
  );
}
