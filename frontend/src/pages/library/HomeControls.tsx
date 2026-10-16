import ThemedSelect from "../../components/ThemedSelect";
import YoutubeSearchChip from "../../components/YoutubeSearchChip";
import {
  LIBRARY_SORT_OPTIONS,
  type LibrarySort,
} from "../../hooks/useLibrarySort";

/** Search, sort, tags and select controls on the home and tag pages. */
export default function HomeControls({
  search,
  onSearch,
  onCommitSearch,
  sort,
  order,
  onSortChange,
  onToggleOrder,
  showTagsButton,
  showTags,
  onToggleTags,
  showSelect,
  selectMode,
  onToggleSelect,
}: {
  search: string;
  onSearch: (value: string) => void;
  onCommitSearch: () => void;
  sort: LibrarySort;
  order: "asc" | "desc";
  onSortChange: (sort: LibrarySort) => void;
  onToggleOrder: () => void;
  /** The narrow-screen tags button (wide screens have one by the chips). */
  showTagsButton: boolean;
  showTags: boolean;
  onToggleTags: () => void;
  showSelect: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
}) {
  return (
    <>
      <div
        data-header-search
        className="relative hidden min-w-0 max-w-64 flex-1 basis-24 md:block md:basis-40"
      >
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitSearch();
            }
          }}
          placeholder="Search"
          className="ui-panel ui-interactive w-full rounded-lg border border-ink-700 bg-ink-900 py-2 pl-3 pr-8 text-sm text-gray-100 placeholder-muted outline-none focus:border-accent sm:pl-4"
        />
        <YoutubeSearchChip />
      </div>
      <ThemedSelect
        aria-label="Sort library"
        value={sort}
        options={[...LIBRARY_SORT_OPTIONS]}
        onChange={onSortChange}
        className="min-w-0 w-[min(12.5rem,100%)] max-md:flex-1 md:min-w-[12.5rem] md:shrink-0"
        buttonClassName="w-full sm:px-3"
        align="right"
      />
      <button
        onClick={onToggleOrder}
        className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-gray-100 hover:border-accent sm:px-3"
        title={sort === "random" ? "Shuffle again" : "Toggle sort direction"}
      >
        {sort === "random" ? "⟳" : order === "desc" ? "↓" : "↑"}
      </button>
      {showTagsButton && (
        <button
          onClick={onToggleTags}
          className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2 py-2 text-xs text-gray-300 hover:border-accent hover:text-accent lg:hidden"
        >
          {showTags ? "Hide tags" : "Tags"}
        </button>
      )}
      {showSelect && (
        <button
          onClick={onToggleSelect}
          className={`ui-panel ui-interactive shrink-0 rounded-lg border px-2.5 py-2 text-sm transition-colors sm:px-3 ${
            selectMode
              ? "border-accent bg-accent/10 text-accent"
              : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
          }`}
        >
          {selectMode ? "Cancel" : "Select"}
        </button>
      )}
    </>
  );
}
