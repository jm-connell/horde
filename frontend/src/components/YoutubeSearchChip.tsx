import { useSearch } from "../context/SearchContext";
import { YOUTUBE_VIDEO_SEARCH_HEADER_TIP } from "../pages/settings/constants";

type YoutubeSearchChipProps = {
  checked?: boolean;
  disabled?: boolean;
  title?: string;
  onToggle?: () => void;
};

export default function YoutubeSearchChip({
  checked,
  disabled,
  title,
  onToggle,
}: YoutubeSearchChipProps) {
  const {
    youtubeVideoSearch,
    youtubeVideoSearchSaving,
    toggleYoutubeVideoSearch,
  } = useSearch();
  const isOn = checked ?? youtubeVideoSearch;
  const isDisabled = disabled ?? youtubeVideoSearchSaving;
  const label = title ?? YOUTUBE_VIDEO_SEARCH_HEADER_TIP;

  return (
    <span className="absolute right-1.5 inset-y-0 z-10 flex items-center">
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-label={label}
        title={label}
        disabled={isDisabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (onToggle ? onToggle() : toggleYoutubeVideoSearch())}
        className={`youtube-search-chip rounded px-1 text-[10px] font-semibold tracking-wide transition-[color,opacity] duration-75 disabled:cursor-not-allowed disabled:opacity-50 ${
          isOn
            ? "text-accent hover:text-accent-soft"
            : "text-gray-600 hover:text-gray-400"
        }`}
      >
        YT
      </button>
    </span>
  );
}
