import ThemedSelect from "../../components/ThemedSelect";
import {
  LIBRARY_SORT_OPTIONS,
  type LibrarySort,
} from "../../hooks/useLibrarySort";
import { ArrowIcon, ShuffleIcon } from "../../components/icons";

/** Sort, tags and select controls on the home and tag pages (search is in the nav). */
export default function HomeControls({
  sort,
  order,
  onSortChange,
  onToggleOrder,
  showSort,
  showTagsButton,
  showTags,
  onToggleTags,
  showSelect,
  selectMode,
  onToggleSelect,
}: {
  sort: LibrarySort;
  order: "asc" | "desc";
  onSortChange: (sort: LibrarySort) => void;
  onToggleOrder: () => void;
  /** False on the Recommended tab, which has its own fixed order. */
  showSort: boolean;
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
      {showSort && (
        <>
          <ThemedSelect
            aria-label="Sort library"
            value={sort}
            options={[...LIBRARY_SORT_OPTIONS]}
            onChange={onSortChange}
            className="min-w-0 w-[min(12.5rem,100%)] max-md:flex-1 md:min-w-50 md:shrink-0"
            buttonClassName="w-full sm:px-3"
            align="right"
          />
          <button
            onClick={onToggleOrder}
            className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-sm text-gray-100 hover:border-accent sm:px-3"
            title={
              sort === "random" ? "Shuffle again" : "Toggle sort direction"
            }
            aria-label={
              sort === "random"
                ? "Shuffle again"
                : order === "desc"
                  ? "Sort descending"
                  : "Sort ascending"
            }
          >
            {sort === "random" ? (
              <ShuffleIcon />
            ) : (
              <ArrowIcon
                className={order === "desc" ? "-rotate-90" : "rotate-90"}
              />
            )}
          </button>
        </>
      )}
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
