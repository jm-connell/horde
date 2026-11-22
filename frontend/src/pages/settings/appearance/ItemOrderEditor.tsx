import { useLayoutEffect, useRef, type RefObject, type ReactNode } from "react";
import { ChevronIcon, CloseIcon } from "../../../components/icons";
import { CHIP } from "../constants";

const ICON_BTN =
  "ui-interactive rounded-md p-1.5 text-gray-400 hover:text-gray-100 disabled:pointer-events-none disabled:opacity-30";

/**
 * Pick some of `all` and put them in order: each chosen item moves earlier or
 * later or is removed, and the rest are offered below to add. Used for the
 * phone's tab bar and the top bar's links.
 */
export default function ItemOrderEditor<T extends string>({
  items,
  all,
  label,
  icon,
  max,
  listLabel,
  addHeading,
  focusAfter,
  onChange,
}: {
  items: readonly T[];
  /** Every item, in the order the unchosen ones are offered. */
  all: readonly T[];
  label: (item: T) => string;
  icon?: (item: T) => ReactNode;
  /** At most this many chosen. */
  max?: number;
  /** Accessible name of the chosen list, e.g. "Tabs shown". */
  listLabel: string;
  /** Over the items to add, e.g. "Add a tab". */
  addHeading: string;
  /**
   * Accessible names of controls to focus after the next change, the first
   * one there and enabled; the section sets it for its own Reset.
   */
  focusAfter: RefObject<string[]>;
  onChange: (next: T[]) => void;
}) {
  const hidden = all.filter((item) => !items.includes(item));
  const full = max !== undefined && items.length >= max;

  const rootRef = useRef<HTMLDivElement>(null);
  // Moving, removing or adding an item re-renders the control that was used
  // (or drops it), so keep keyboard focus on the first of these that is
  // there and enabled afterwards, by accessible name.
  useLayoutEffect(() => {
    const names = focusAfter.current;
    focusAfter.current = [];
    for (const name of names) {
      const el = rootRef.current?.querySelector<HTMLButtonElement>(
        `button[aria-label="${name}"]:not(:disabled)`
      );
      if (el) {
        el.focus();
        return;
      }
    }
  }, [items, focusAfter]);

  const set = (next: T[], focus: string[]) => {
    focusAfter.current = focus;
    onChange(next);
  };
  const name = (item: T | undefined) => (item ? label(item) : "");
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    const n = name(items[i]);
    set(next, [
      `Move ${n} ${by < 0 ? "earlier" : "later"}`,
      `Move ${n} ${by < 0 ? "later" : "earlier"}`,
    ]);
  };
  const remove = (i: number) => {
    const next = items.filter((_, j) => j !== i);
    set(next, [
      `Remove ${name(next[i])}`,
      `Remove ${name(next[i - 1])}`,
      `Add ${name(items[i])}`,
    ]);
  };
  const add = (item: T) => {
    const k = hidden.indexOf(item);
    set(
      [...items, item],
      [
        `Add ${name(hidden[k + 1])}`,
        `Add ${name(hidden[k - 1])}`,
        `Remove ${name(item)}`,
      ]
    );
  };

  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      <ol aria-label={listLabel} className="flex max-w-sm flex-col gap-1.5">
        {items.map((item, i) => {
          const n = label(item);
          return (
            <li
              key={item}
              className="ui-panel flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900 py-1.5 pl-3 pr-1.5 text-sm text-gray-200"
            >
              {icon?.(item)}
              <span className="min-w-0 flex-1 truncate font-medium">{n}</span>
              <button
                type="button"
                className={ICON_BTN}
                aria-label={`Move ${n} earlier`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ChevronIcon className="rotate-180" />
              </button>
              <button
                type="button"
                className={ICON_BTN}
                aria-label={`Move ${n} later`}
                disabled={i === items.length - 1}
                onClick={() => move(i, 1)}
              >
                <ChevronIcon />
              </button>
              <button
                type="button"
                className={ICON_BTN}
                aria-label={`Remove ${n}`}
                disabled={items.length === 1}
                onClick={() => remove(i)}
              >
                <CloseIcon />
              </button>
            </li>
          );
        })}
      </ol>
      {hidden.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-gray-200">
            {addHeading}
            {full && (
              <span className="ml-2 text-xs font-normal text-muted">
                Remove one first ({max} at most)
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            {hidden.map((item) => (
              <button
                key={item}
                type="button"
                disabled={full}
                aria-label={`Add ${label(item)}`}
                onClick={() => add(item)}
                className={`${CHIP} inline-flex items-center gap-2 disabled:pointer-events-none disabled:opacity-50`}
              >
                {icon?.(item)}
                {label(item)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
