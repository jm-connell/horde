import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { DiscoverCategory } from "../types";
import { chipClass } from "./chipClass";
import { ChevronIcon } from "./icons";

const ARROW =
  "ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent";

/**
 * "For you" and the user's categories as a scrolling row of chips on
 * Recommended (with arrows when it overflows), and the feed's actions at the
 * right end after a rule.
 */
export default function CategoryChips({
  categories,
  active,
  onSelect,
  actions,
}: {
  categories: DiscoverCategory[];
  /** The open category's id; null for "For you". */
  active: number | null;
  onSelect: (category: number | null) => void;
  /** Buttons that stay at the right end (Algorithm, Refresh). */
  actions?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [categories, update]);

  const scroll = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(160, el.clientWidth * 0.6),
      behavior: "smooth",
    });
  };

  return (
    <div
      className="relative flex items-center gap-2"
      data-horde="rec-category-row"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scroll(-1)}
            className={ARROW}
            aria-label="Scroll categories left"
          >
            <ChevronIcon className="rotate-90" />
          </button>
        )}
        <div
          ref={scrollRef}
          className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 scrollbar-none [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={chipClass(active === null)}
            aria-pressed={active === null}
          >
            For you
          </button>
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => onSelect(category.id)}
              className={chipClass(active === category.id)}
              aria-pressed={active === category.id}
            >
              {category.name}
            </button>
          ))}
        </div>
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scroll(1)}
            className={ARROW}
            aria-label="Scroll categories right"
          >
            <ChevronIcon className="-rotate-90" />
          </button>
        )}
      </div>
      {actions && (
        <>
          <span
            aria-hidden="true"
            className="mb-1 h-6 w-px shrink-0 bg-ink-700"
          />
          <div
            data-horde="rec-actions"
            className="mb-1 flex shrink-0 items-center gap-1.5 sm:gap-2"
          >
            {actions}
          </div>
        </>
      )}
    </div>
  );
}
