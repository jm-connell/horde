import { getJson, removeItem, setJson } from "../storage";

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

function isSavedSort(v: unknown): v is SavedSort {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<SavedSort>;
  return (
    typeof s.savedAt === "number" &&
    (s.order === "asc" || s.order === "desc") &&
    LIBRARY_SORT_OPTIONS.some((o) => o.value === s.sort)
  );
}

/** The sort the user picked recently (within the TTL), or null if there is none. */
export function loadSavedLibrarySort(): LibrarySortState | null {
  const saved = getJson<SavedSort | null>(STORAGE_KEY, isSavedSort, null);
  if (!saved) return null;
  if (Date.now() - saved.savedAt > TTL_MS) {
    removeItem(STORAGE_KEY);
    return null;
  }
  return {
    sort: saved.sort,
    order: saved.order,
    randomSeed: saved.randomSeed,
  };
}

export function saveLibrarySort(state: LibrarySortState): void {
  const payload: SavedSort = { ...state, savedAt: Date.now() };
  setJson(STORAGE_KEY, payload);
}
