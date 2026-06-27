export const LIBRARY_SORT_OPTIONS = [
  { value: "added_at", label: "Recently added" },
  { value: "published_at", label: "Publish date" },
  { value: "title", label: "Title" },
  { value: "duration", label: "Duration" },
  { value: "file_size", label: "File size" },
  { value: "view_count", label: "View count" },
  { value: "random", label: "Random" },
] as const;

export type LibrarySort = (typeof LIBRARY_SORT_OPTIONS)[number]["value"];

const STORAGE_KEY = "horde.library-sort";
const TTL_MS = 3 * 60 * 60 * 1000;

export interface LibrarySortState {
  sort: LibrarySort;
  order: "asc" | "desc";
  randomSeed?: number;
}

interface SavedSort extends LibrarySortState {
  savedAt: number;
}

export function loadLibrarySort(defaultSort: LibrarySort): LibrarySortState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { sort: defaultSort, order: "desc" };
    }
    const saved = JSON.parse(raw) as SavedSort;
    if (Date.now() - saved.savedAt > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return {
        sort: defaultSort,
        order: "desc",
        randomSeed: defaultSort === "random" ? Date.now() : undefined,
      };
    }
    return {
      sort: saved.sort,
      order: saved.order,
      randomSeed: saved.randomSeed,
    };
  } catch {
    return { sort: defaultSort, order: "desc" };
  }
}

export function saveLibrarySort(state: LibrarySortState): void {
  const payload: SavedSort = { ...state, savedAt: Date.now() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}
