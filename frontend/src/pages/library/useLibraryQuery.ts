import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSearch } from "../../context/SearchContext";
import {
  loadSavedLibrarySort,
  saveLibrarySort,
  type LibrarySort,
  type LibrarySortState,
} from "../../hooks/useLibrarySort";
import type { Settings } from "../../hooks/useSettings";
import {
  buildVideoFilters,
  defaultSortState,
  readLibraryParams,
  sortAfterChange,
  sortAfterToggle,
  withoutTabParam,
} from "./libraryQuery";

/**
 * The state that decides which videos the library lists: the channel and tag
 * (from the address, and set by clicks), the sort and the typed search.
 */
export function useLibraryQuery(
  settings: Settings,
  update: (patch: Partial<Settings>) => void
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { search } = useSearch();
  const [activeChannel, setActiveChannel] = useState<string | null>(
    searchParams.get("channel")
  );
  const [activeTag, setActiveTag] = useState<string | null>(
    searchParams.get("tag")
  );

  // A sort the user picked (recently) wins; otherwise the saved default, which
  // may only arrive after mount (fresh device, or another user just signed in).
  const [chosenSort, setSortState] = useState<LibrarySortState | null>(
    loadSavedLibrarySort
  );
  const [defaultSeed] = useState(() => Date.now());
  const defaultSort = settings.defaultLibrarySort;
  const sortState = useMemo<LibrarySortState>(
    () => chosenSort ?? defaultSortState(defaultSort, defaultSeed),
    [chosenSort, defaultSort, defaultSeed]
  );
  const { sort, order, randomSeed } = sortState;

  useEffect(() => {
    const params = readLibraryParams(searchParams);
    setActiveTag(params.tag);
    setActiveChannel(params.channel);
    if (params.legacyFeedTab) {
      update({ showUndownloadedOnChannel: true });
      setSearchParams(withoutTabParam(searchParams), { replace: true });
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps -- sync from the URL only; update/setSearchParams are not inputs to this sync

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const mainFilters = buildVideoFilters({
    search: debouncedSearch,
    channel: activeChannel,
    tag: activeTag,
    sort,
    order,
    randomSeed,
  });

  const chooseSort = (next: LibrarySortState) => {
    setSortState(next);
    saveLibrarySort(next);
  };
  const handleSortChange = (nextSort: LibrarySort) =>
    chooseSort(sortAfterChange(sortState, nextSort, Date.now()));
  const toggleOrder = () => chooseSort(sortAfterToggle(sortState, Date.now()));

  return {
    activeChannel,
    setActiveChannel,
    activeTag,
    setActiveTag,
    sort,
    order,
    debouncedSearch,
    mainFilters,
    handleSortChange,
    toggleOrder,
  };
}
