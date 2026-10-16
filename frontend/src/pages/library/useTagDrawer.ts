import { useEffect, useMemo, useState } from "react";
import type { TagStat } from "../../types";

const TAG_MIN_COUNT = 3;
const TAG_PAGE_SIZE = 20;

/** Which tags the drawer lists and whether it is open. */
export function useTagDrawer(
  tags: TagStat[],
  activeTag: string | null,
  activeChannel: string | null
) {
  const [showTags, setShowTags] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);

  useEffect(() => {
    setShowAllTags(false);
  }, [activeChannel]);

  // Rare tags are noise, except the one that is open.
  const common = useMemo(
    () => tags.filter((t) => t.count > TAG_MIN_COUNT || t.tag === activeTag),
    [tags, activeTag]
  );
  const visibleTags = useMemo(
    () =>
      !showAllTags && common.length > TAG_PAGE_SIZE
        ? common.slice(0, TAG_PAGE_SIZE)
        : common,
    [common, showAllTags]
  );
  const hiddenTagCount = showAllTags
    ? 0
    : Math.max(0, common.length - TAG_PAGE_SIZE);

  return {
    showTags,
    setShowTags,
    setShowAllTags,
    hasTags: common.length > 0,
    visibleTags,
    hiddenTagCount,
  };
}
