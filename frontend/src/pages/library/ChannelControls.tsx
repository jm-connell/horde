import ThemedSelect from "../../components/ThemedSelect";
import YoutubeSearchChip from "../../components/YoutubeSearchChip";
import { isYoutubeChannelUrl } from "../../components/channelFeedYoutubeSearch";
import { useAuth } from "../../context/AuthContext";
import { Toggle } from "../settings/ui";
import { DIRECT_YOUTUBE_SEARCH_CHANNEL_TIP } from "../settings/constants";
import type { ChannelTab } from "../../api";
import type { CatalogProgress } from "../libraryCatalogProgress";
import type { FeedLayout, FeedSort } from "./useChannelFeedControls";

const box = "ui-panel rounded-lg border border-ink-700 bg-ink-900";

/**
 * The quick view controls above a channel's feed: search, Videos/Live,
 * sort, the undownloaded filter, layout and tags. Settings that stick to the
 * channel live in the channel settings sheet instead.
 */
export default function ChannelControls({
  channelUrl,
  channelTab,
  onChannelTab,
  feedSearch,
  onFeedSearch,
  feedSort,
  onFeedSort,
  feedOrder,
  onToggleFeedOrder,
  feedLayout,
  onFeedLayout,
  showUndownloaded,
  onToggleUndownloaded,
  catalogProgress,
  youtubePrefSaving,
  onToggleYoutubeSearch,
  hasTags,
  showTags,
  onToggleTags,
}: {
  channelUrl: string | null;
  channelTab: ChannelTab;
  onChannelTab: (tab: ChannelTab) => void;
  feedSearch: string;
  onFeedSearch: (value: string) => void;
  feedSort: FeedSort;
  onFeedSort: (sort: FeedSort) => void;
  feedOrder: "asc" | "desc";
  onToggleFeedOrder: () => void;
  feedLayout: FeedLayout;
  onFeedLayout: (layout: FeedLayout) => void;
  showUndownloaded: boolean;
  onToggleUndownloaded: () => void;
  catalogProgress: CatalogProgress | null;
  youtubePrefSaving: boolean;
  onToggleYoutubeSearch: (value: boolean) => void;
  hasTags: boolean;
  showTags: boolean;
  onToggleTags: () => void;
}) {
  const { can } = useAuth();
  const youtubeChannel = isYoutubeChannelUrl(channelUrl);
  const streamsTab = channelTab === "streams";
  return (
    <div
      role="group"
      aria-label="Feed view"
      className={`flex flex-wrap items-center gap-2 ${
        showTags && hasTags ? "mb-2" : "mb-5"
      }`}
    >
      <div className="relative min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-56">
        <input
          type="search"
          aria-label={streamsTab ? "Filter streams" : "Search this channel"}
          value={feedSearch}
          onChange={(e) => onFeedSearch(e.target.value)}
          placeholder={streamsTab ? "Filter streams" : "Search this channel"}
          className={`${box} ui-interactive w-full py-2 pl-3 text-sm text-gray-100 placeholder-muted outline-hidden focus:border-accent ${
            youtubeChannel ? "pr-8" : "pr-3"
          }`}
        />
        {youtubeChannel && !streamsTab ? (
          <YoutubeSearchChip
            checked={catalogProgress?.youtubeSearchEffective ?? true}
            disabled={youtubePrefSaving || !channelUrl || !can("edit_metadata")}
            title={DIRECT_YOUTUBE_SEARCH_CHANNEL_TIP}
            onToggle={() =>
              onToggleYoutubeSearch(
                !(catalogProgress?.youtubeSearchEffective ?? true)
              )
            }
          />
        ) : null}
      </div>
      {youtubeChannel && (
        <div
          role="group"
          aria-label="Channel tab"
          className={`${box} flex shrink-0 p-0.5`}
        >
          {(
            [
              ["videos", "Videos", "Uploads"],
              ["streams", "Live", "Past and current live streams"],
            ] as const
          ).map(([tab, label, title]) => (
            <button
              key={tab}
              type="button"
              aria-pressed={channelTab === tab}
              title={title}
              onClick={() => onChannelTab(tab)}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${
                channelTab === tab
                  ? "bg-accent/15 text-accent"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <ThemedSelect
          aria-label="Feed sort"
          value={feedSort}
          options={[
            { value: "recent", label: "Recent" },
            { value: "popular", label: "Popular" },
          ]}
          onChange={onFeedSort}
          className="min-w-26 shrink-0"
          buttonClassName="w-full sm:px-3"
        />
        <button
          type="button"
          onClick={onToggleFeedOrder}
          className={`${box} ui-interactive shrink-0 px-2.5 py-2 text-sm text-gray-100 hover:border-accent`}
          aria-label={
            feedOrder === "desc" ? "Sort descending" : "Sort ascending"
          }
          title="Toggle sort direction"
        >
          {feedOrder === "desc" ? "↓" : "↑"}
        </button>
      </div>
      <label className="inline-flex shrink-0 items-center gap-2 px-1 text-sm text-gray-300">
        Undownloaded
        <Toggle checked={showUndownloaded} onChange={onToggleUndownloaded} />
      </label>
      <div
        role="group"
        aria-label="Layout"
        className={`${box} flex shrink-0 p-0.5 sm:ml-auto`}
      >
        <LayoutButton
          layout="grid"
          current={feedLayout}
          title="Grid view"
          onSelect={onFeedLayout}
        >
          <rect x="1" y="1" width="6" height="6" rx="1" />
          <rect x="9" y="1" width="6" height="6" rx="1" />
          <rect x="1" y="9" width="6" height="6" rx="1" />
          <rect x="9" y="9" width="6" height="6" rx="1" />
        </LayoutButton>
        <LayoutButton
          layout="list"
          current={feedLayout}
          title="List view"
          onSelect={onFeedLayout}
        >
          <rect x="1" y="2" width="14" height="2.5" rx="0.5" />
          <rect x="1" y="6.75" width="14" height="2.5" rx="0.5" />
          <rect x="1" y="11.5" width="14" height="2.5" rx="0.5" />
        </LayoutButton>
      </div>
      {hasTags && (
        <button
          type="button"
          onClick={onToggleTags}
          aria-pressed={showTags}
          className={`${box} ui-interactive shrink-0 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent`}
        >
          {showTags ? "Hide tags" : "Tags"}
        </button>
      )}
    </div>
  );
}

function LayoutButton({
  layout,
  current,
  title,
  onSelect,
  children,
}: {
  layout: FeedLayout;
  current: FeedLayout;
  title: string;
  onSelect: (layout: FeedLayout) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(layout)}
      title={title}
      aria-label={title}
      aria-pressed={current === layout}
      className={`rounded-md px-2.5 py-1.5 transition-colors ${
        current === layout
          ? "bg-accent/15 text-accent"
          : "text-gray-400 hover:text-gray-200"
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-4 w-4"
        fill="currentColor"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  );
}
