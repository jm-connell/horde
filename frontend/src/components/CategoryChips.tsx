import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { chipClass } from "./chipClass";
import { ChevronIcon } from "./icons";

const ARROW =
  "ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-300 hover:border-accent hover:text-accent";

/**
 * "For you" and the AI categories as a scrolling row of chips on Recommended,
 * with arrows when it overflows. `children` go after the row.
 */
export default function CategoryChips({
  categories,
  active,
  onSelect,
  children,
}: {
  categories: string[];
  /** The open category; null for "For you". */
  active: string | null;
  onSelect: (category: string | null) => void;
  children?: ReactNode;
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
    <div className="relative flex items-center gap-2">
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
          className={chipClass(!active)}
        >
          For you
        </button>
        {categories.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onSelect(name)}
            className={chipClass(active === name)}
          >
            {name}
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
      {children}
    </div>
  );
}
