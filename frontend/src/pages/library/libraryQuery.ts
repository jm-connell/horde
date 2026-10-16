import type { VideoFilters } from "../../queries/videos";
import type { LibrarySort, LibrarySortState } from "../../hooks/useLibrarySort";

/** What the address bar says the library should show. */
export interface LibraryParams {
  channel: string | null;
  tag: string | null;
  /** An old link opened a channel on its `feed` tab, which is now a setting. */
  legacyFeedTab: boolean;
}

export function readLibraryParams(params: URLSearchParams): LibraryParams {
  const channel = params.get("channel");
  return {
    channel,
    tag: params.get("tag"),
    legacyFeedTab: params.get("tab") === "feed" && Boolean(channel),
  };
}

export function withoutTabParam(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("tab");
  return next;
}

/** The sort in force when the user has not picked one (recently). */
export function defaultSortState(
  defaultSort: LibrarySort,
  seed: number
): LibrarySortState {
  return {
    sort: defaultSort,
    order: "desc",
    randomSeed: defaultSort === "random" ? seed : undefined,
  };
}

/** Picking a sort: size starts largest first, random draws a fresh shuffle. */
export function sortAfterChange(
  current: LibrarySortState,
  nextSort: LibrarySort,
  now: number
): LibrarySortState {
  return {
    sort: nextSort,
    order: nextSort === "file_size" ? "desc" : current.order,
    randomSeed: nextSort === "random" ? now : undefined,
  };
}

/** The direction button: flips the order, or reshuffles a random sort. */
export function sortAfterToggle(
  current: LibrarySortState,
  now: number
): LibrarySortState {
  if (current.sort === "random") {
    return { sort: current.sort, order: current.order, randomSeed: now };
  }
  return {
    sort: current.sort,
    order: current.order === "desc" ? "asc" : "desc",
  };
}

export function buildVideoFilters(input: {
  search: string;
  channel: string | null;
  tag: string | null;
  sort: LibrarySortState["sort"];
  order: LibrarySortState["order"];
  randomSeed: number | undefined;
}): VideoFilters {
  return {
    q: input.search || undefined,
    channel: input.channel || undefined,
    tag: input.tag || undefined,
    sort: input.sort,
    order: input.order,
    seed: input.sort === "random" ? input.randomSeed : undefined,
  };
}
