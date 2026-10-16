import { useCallback, useState } from "react";
import type { Chapter } from "../../utils";

/** The chapter that contains `time` (the first one before any has started). */
export function activeChapterAt(
  chapters: Chapter[],
  time: number
): Chapter | null {
  if (chapters.length === 0) return null;
  let active = chapters[0];
  for (const ch of chapters) {
    if (ch.startSec <= time) active = ch;
    else break;
  }
  return active;
}

export function isChapterActive(
  chapters: Chapter[],
  chapterIndex: number,
  time: number
): boolean {
  const ch = chapters[chapterIndex];
  const next = chapters[chapterIndex + 1];
  return time >= ch.startSec && (!next || time < next.startSec);
}

/** Chapter lookups for the seek bar, the time label and the `n` shortcut. */
export function useChapters(chapters: Chapter[]) {
  const [hoveredChapterSec, setHoveredChapterSec] = useState<number | null>(
    null
  );
  const hoveredChapter =
    hoveredChapterSec != null
      ? (chapters.find((ch) => ch.startSec === hoveredChapterSec) ?? null)
      : null;

  /** Start of the first chapter more than a second past `time`, if any. */
  const nextChapterStart = useCallback(
    (time: number): number | null =>
      chapters.find((c) => c.startSec > time + 1)?.startSec ?? null,
    [chapters]
  );

  return { hoveredChapter, setHoveredChapterSec, nextChapterStart };
}
