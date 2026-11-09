import { useLayoutEffect, useRef } from "react";
import { ChevronIcon, CloseIcon } from "../../../components/icons";
import {
  DEFAULT_NAV_ITEMS,
  NAV_ITEMS,
  NAV_ITEM_LABELS,
  REQUIRED_NAV_ITEM,
  type NavItem,
} from "../../../navItems";
import { CHIP, PANEL_BTN } from "../constants";
import { useSettingsPage } from "../context";
import { Section } from "../ui";

const ICON_BTN =
  "ui-interactive rounded-md p-1.5 text-gray-400 hover:text-gray-100 disabled:pointer-events-none disabled:opacity-30";

/** Which pages the nav bar at the top shows on a computer, in order. */
export default function NavBarSection() {
  const { q, match, settings, update } = useSettingsPage();
  const items = settings.navItems;
  const hidden = NAV_ITEMS.filter((item) => !items.includes(item));
  const isDefault =
    items.length === DEFAULT_NAV_ITEMS.length &&
    items.every((item, i) => item === DEFAULT_NAV_ITEMS[i]);

  const rootRef = useRef<HTMLDivElement>(null);
  // Keep keyboard focus on the control that was used (or the next one).
  const focusNext = useRef<string[]>([]);
  useLayoutEffect(() => {
    const names = focusNext.current;
    focusNext.current = [];
    for (const name of names) {
      const el = rootRef.current?.querySelector<HTMLButtonElement>(
        `button[aria-label="${name}"]:not(:disabled)`
      );
      if (el) {
        el.focus();
        return;
      }
    }
  }, [items]);

  const set = (next: NavItem[], focus: string[]) => {
    focusNext.current = focus;
    update({ navItems: next });
  };
  const label = (item: NavItem | undefined) =>
    item ? NAV_ITEM_LABELS[item] : "";
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    const name = label(items[i]);
    set(next, [
      `Move ${name} ${by < 0 ? "earlier" : "later"}`,
      `Move ${name} ${by < 0 ? "later" : "earlier"}`,
    ]);
  };
  const remove = (i: number) => {
    const next = items.filter((_, j) => j !== i);
    set(next, [
      `Hide ${label(next[i])}`,
      `Hide ${label(next[i - 1])}`,
      `Show ${label(items[i])}`,
    ]);
  };
  const add = (item: NavItem) => {
    const k = hidden.indexOf(item);
    // Back where it was in the default order, before Settings at the latest.
    const at = items.findIndex(
      (x) => DEFAULT_NAV_ITEMS.indexOf(x) > DEFAULT_NAV_ITEMS.indexOf(item)
    );
    const next = [...items];
    next.splice(at < 0 ? next.length : at, 0, item);
    set(next, [
      `Show ${label(hidden[k + 1])}`,
      `Show ${label(hidden[k - 1])}`,
      `Hide ${label(item)}`,
    ]);
  };

  return (
    <Section
      anchor="nav-bar"
      title="Nav bar"
      description="On a computer, the bar at the top shows these pages in this order. You can also drag them along the bar itself. Settings always stays; pages this account cannot use are left out. Phones use the menu and the Tab bar below."
      action={
        !isDefault && (
          <button
            type="button"
            className={PANEL_BTN}
            onClick={() =>
              set(
                [...DEFAULT_NAV_ITEMS],
                [`Hide ${label(DEFAULT_NAV_ITEMS[0])}`]
              )
            }
          >
            Reset
          </button>
        )
      }
      hidden={
        !!q &&
        !match("nav bar", "navigation", "menu", "top bar", "pages", "reorder")
      }
    >
      <div ref={rootRef} className="flex flex-col gap-4">
        <ol
          aria-label="Pages in the nav bar"
          className="flex max-w-sm flex-col gap-1.5"
        >
          {items.map((item, i) => {
            const name = NAV_ITEM_LABELS[item];
            return (
              <li
                key={item}
                className="ui-panel flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900 py-1.5 pl-3 pr-1.5 text-sm text-gray-200"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {name}
                </span>
                <button
                  type="button"
                  className={ICON_BTN}
                  aria-label={`Move ${name} earlier`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ChevronIcon className="rotate-180" />
                </button>
                <button
                  type="button"
                  className={ICON_BTN}
                  aria-label={`Move ${name} later`}
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ChevronIcon />
                </button>
                <button
                  type="button"
                  className={ICON_BTN}
                  aria-label={`Hide ${name}`}
                  disabled={item === REQUIRED_NAV_ITEM}
                  title={
                    item === REQUIRED_NAV_ITEM
                      ? "Settings always stays, so this can be changed back"
                      : undefined
                  }
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
              Hidden pages
            </p>
            <div className="flex flex-wrap gap-2">
              {hidden.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-label={`Show ${NAV_ITEM_LABELS[item]}`}
                  onClick={() => add(item)}
                  className={CHIP}
                >
                  + {NAV_ITEM_LABELS[item]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
