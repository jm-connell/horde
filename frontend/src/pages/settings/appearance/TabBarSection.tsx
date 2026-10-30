import { TabIcon } from "../../../components/BottomTabBar";
import { ChevronIcon, CloseIcon } from "../../../components/icons";
import {
  DEFAULT_TAB_BAR,
  TAB_BAR_ICONS,
  TAB_BAR_ITEMS,
  TAB_BAR_LABELS,
  TAB_BAR_MAX,
  type TabBarItem,
} from "../../../tabBar";
import { CHIP, PANEL_BTN } from "../constants";
import { useSettingsPage } from "../context";
import { Section } from "../ui";

const ICON_BTN =
  "ui-interactive rounded-md p-1.5 text-gray-400 hover:text-gray-100 disabled:pointer-events-none disabled:opacity-30";

/** Which tabs the installed app's bottom island shows on a phone, in order. */
export default function TabBarSection() {
  const { q, match, settings, update } = useSettingsPage();
  const items = settings.tabBarItems;
  const hidden = TAB_BAR_ITEMS.filter((item) => !items.includes(item));
  const isDefault =
    items.length === DEFAULT_TAB_BAR.length &&
    items.every((item, i) => item === DEFAULT_TAB_BAR[i]);

  const set = (next: TabBarItem[]) => update({ tabBarItems: next });
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    set(next);
  };

  return (
    <Section
      title="Tab bar"
      description={`On a phone, the installed app (added to the Home Screen) shows these tabs in a floating bar at the bottom of the screen, up to ${TAB_BAR_MAX}. Tabs this account cannot use, or that need the server while offline, are left out. A browser tab keeps the menu at the top.`}
      action={
        !isDefault && (
          <button
            type="button"
            className={PANEL_BTN}
            onClick={() => set([...DEFAULT_TAB_BAR])}
          >
            Reset
          </button>
        )
      }
      hidden={
        !!q &&
        !match(
          "tab bar",
          "tabs",
          "bottom bar",
          "island",
          "installed app",
          "home screen",
          "phone",
          "chat"
        )
      }
    >
      <div data-setting="tab-bar" className="flex flex-col gap-4">
        <ol aria-label="Tabs shown" className="flex max-w-sm flex-col gap-1.5">
          {items.map((item, i) => {
            const label = TAB_BAR_LABELS[item];
            return (
              <li
                key={item}
                className="ui-panel flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900 py-1.5 pl-3 pr-1.5 text-sm text-gray-200"
              >
                <TabIcon d={TAB_BAR_ICONS[item]} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {label}
                </span>
                <button
                  type="button"
                  className={ICON_BTN}
                  aria-label={`Move ${label} earlier`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ChevronIcon className="rotate-180" />
                </button>
                <button
                  type="button"
                  className={ICON_BTN}
                  aria-label={`Move ${label} later`}
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ChevronIcon />
                </button>
                <button
                  type="button"
                  className={ICON_BTN}
                  aria-label={`Remove ${label}`}
                  disabled={items.length === 1}
                  onClick={() => set(items.filter((t) => t !== item))}
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
              Add a tab
              {items.length >= TAB_BAR_MAX && (
                <span className="ml-2 text-xs font-normal text-muted">
                  Remove one first ({TAB_BAR_MAX} at most)
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {hidden.map((item) => (
                <button
                  key={item}
                  type="button"
                  disabled={items.length >= TAB_BAR_MAX}
                  aria-label={`Add ${TAB_BAR_LABELS[item]}`}
                  onClick={() => set([...items, item])}
                  className={`${CHIP} inline-flex items-center gap-2 disabled:pointer-events-none disabled:opacity-50`}
                >
                  <TabIcon d={TAB_BAR_ICONS[item]} />
                  {TAB_BAR_LABELS[item]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
