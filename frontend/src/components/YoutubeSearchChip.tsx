import { useSearch } from "../context/SearchContext";
import { YOUTUBE_VIDEO_SEARCH_HEADER_TIP } from "../pages/settings/constants";

export default function YoutubeSearchChip() {
  const {
    youtubeVideoSearch,
    youtubeVideoSearchSaving,
    toggleYoutubeVideoSearch,
  } = useSearch();
  return (
    <span className="absolute right-1.5 inset-y-0 z-10 flex items-center">
      <button
        type="button"
        role="switch"
        aria-checked={youtubeVideoSearch}
        aria-label={YOUTUBE_VIDEO_SEARCH_HEADER_TIP}
        title={YOUTUBE_VIDEO_SEARCH_HEADER_TIP}
        disabled={youtubeVideoSearchSaving}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleYoutubeVideoSearch()}
        className={`youtube-search-chip rounded px-1 text-[10px] font-semibold tracking-wide transition-[color,opacity] duration-75 disabled:cursor-not-allowed disabled:opacity-50 ${
          youtubeVideoSearch
            ? "text-accent hover:text-accent-soft"
            : "text-gray-600 hover:text-gray-400"
        }`}
      >
        YT
      </button>
    </span>
  );
}
