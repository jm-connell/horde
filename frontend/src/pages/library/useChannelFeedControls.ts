import { useCallback, useEffect, useState } from "react";
import { loadFeedLayout, saveFeedLayout } from "../libraryStorage";

export type FeedSort = "recent" | "popular";
export type FeedLayout = "grid" | "list";

/** The channel page's own search, sort and layout; they start over per channel. */
export function useChannelFeedControls(activeChannel: string | null) {
  const [feedSearch, setFeedSearch] = useState("");
  const [feedSort, setFeedSort] = useState<FeedSort>("recent");
  const [feedOrder, setFeedOrder] = useState<"asc" | "desc">("desc");
  const [feedLayout, setFeedLayoutState] = useState<FeedLayout>(loadFeedLayout);

  useEffect(() => {
    setFeedSearch("");
    setFeedSort("recent");
    setFeedOrder("desc");
  }, [activeChannel]);

  const setFeedLayout = useCallback((layout: FeedLayout) => {
    setFeedLayoutState(layout);
    saveFeedLayout(layout);
  }, []);

  const toggleFeedOrder = () =>
    setFeedOrder((o) => (o === "desc" ? "asc" : "desc"));

  return {
    feedSearch,
    setFeedSearch,
    feedSort,
    setFeedSort,
    feedOrder,
    toggleFeedOrder,
    feedLayout,
    setFeedLayout,
  };
}
