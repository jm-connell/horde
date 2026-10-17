import HelpTip from "../../components/HelpTip";
import ThemedSelect from "../../components/ThemedSelect";
import YoutubeSearchChip from "../../components/YoutubeSearchChip";
import { isYoutubeChannelUrl } from "../../components/channelFeedYoutubeSearch";
import {
  FEED_INDEX_TIP,
  formatCatalogProgress,
  showChannelIndexButton,
  type CatalogProgress,
} from "../libraryCatalogProgress";
import { DIRECT_YOUTUBE_SEARCH_CHANNEL_TIP } from "../settings/constants";
import type { FeedLayout, FeedSort } from "./useChannelFeedControls";

/** Search, sort, layout and index controls on a channel page. */
export default function ChannelControls({
  channelUrl,
  feedSearch,
  onFeedSearch,
  feedSort,
  onFeedSort,
  feedOrder,
  onToggleFeedOrder,
  feedLayout,
  onFeedLayout,
  catalogProgress,
  indexingChannel,
  onIndexChannel,
  youtubePrefSaving,
  onToggleYoutubeSearch,
  hasTags,
  showTags,
  onToggleTags,
}: {
  channelUrl: string | null;
  feedSearch: string;
  onFeedSearch: (value: string) => void;
  feedSort: FeedSort;
  onFeedSort: (sort: FeedSort) => void;
  feedOrder: "asc" | "desc";
  onToggleFeedOrder: () => void;
  feedLayout: FeedLayout;
  onFeedLayout: (layout: FeedLayout) => void;
  catalogProgress: CatalogProgress | null;
  indexingChannel: boolean;
  onIndexChannel: () => void;
  youtubePrefSaving: boolean;
  onToggleYoutubeSearch: (value: boolean) => void;
  hasTags: boolean;
  showTags: boolean;
  onToggleTags: () => void;
}) {
  const youtubeChannel = isYoutubeChannelUrl(channelUrl);
  return (
    <>
      <div className="relative min-w-[10rem] w-40 max-w-64 grow sm:min-w-[13rem] sm:w-52">
        <input
          data-header-search
          value={feedSearch}
          onChange={(e) => onFeedSearch(e.target.value)}
          placeholder="Search this channel"
          className={`ui-panel ui-interactive w-full rounded-lg border border-ink-700 bg-ink-900 py-2 pl-3 text-sm text-gray-100 placeholder-muted outline-none focus:border-accent sm:pl-4 ${
            youtubeChannel ? "pr-8" : "pr-3 sm:pr-4"
          }`}
        />
        {youtubeChannel ? (
          <YoutubeSearchChip
            checked={catalogProgress?.youtubeSearchEffective ?? true}
            disabled={youtubePrefSaving || !channelUrl}
            title={DIRECT_YOUTUBE_SEARCH_CHANNEL_TIP}
            onToggle={() =>
              onToggleYoutubeSearch(
                !(catalogProgress?.youtubeSearchEffective ?? true)
              )
            }
          />
        ) : null}
      </div>
      {youtubeChannel &&
        (indexingChannel || showChannelIndexButton(catalogProgress)) && (
          <button
            type="button"
            onClick={onIndexChannel}
            disabled={indexingChannel || !channelUrl}
            className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            title="Index this channel’s uploads for search"
          >
            {indexingChannel ? "Queuing…" : "Index channel"}
          </button>
        )}
      <ThemedSelect
        aria-label="Feed sort"
        value={feedSort}
        options={[
          { value: "recent", label: "Recent" },
          { value: "popular", label: "Popular" },
        ]}
        onChange={onFeedSort}
        className="min-w-[6.5rem] shrink-0"
        buttonClassName="w-full sm:px-3"
      />
      <button
        type="button"
        onClick={onToggleFeedOrder}
        className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-gray-100 hover:border-accent sm:px-3"
        title="Toggle sort direction"
      >
        {feedOrder === "desc" ? "↓" : "↑"}
      </button>
      <div className="ui-panel flex shrink-0 rounded-lg border border-ink-700 bg-ink-900 p-0.5">
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
          className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent"
        >
          {showTags ? "Hide tags" : "Show tags"}
        </button>
      )}
      {catalogProgress && (
        <span
          className={`ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${
            catalogProgress.status === "error" ? "text-red-400" : "text-muted"
          }`}
          title={catalogProgress.lastError || undefined}
        >
          {formatCatalogProgress(catalogProgress)}
          <HelpTip text={FEED_INDEX_TIP} placement="bottom" />
        </span>
      )}
    </>
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
