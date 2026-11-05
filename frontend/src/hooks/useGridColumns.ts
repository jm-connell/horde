import { useCallback, useState } from "react";

/**
 * How many columns a CSS grid shows right now (its computed template), kept
 * current as it resizes. Attach the returned callback ref to the grid.
 */
export function useGridColumns(fallback: number) {
  const [columns, setColumns] = useState(fallback);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const measure = () => {
        const template = getComputedStyle(el).gridTemplateColumns;
        const n =
          template && template !== "none" ? template.split(" ").length : 0;
        setColumns(n > 0 ? n : fallback);
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    },
    [fallback]
  );
  return [columns, ref] as const;
}
