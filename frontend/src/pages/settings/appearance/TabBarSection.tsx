import { useRef } from "react";
import { TabIcon } from "../../../components/BottomTabBar";
import {
  DEFAULT_TAB_BAR,
  TAB_BAR_ICONS,
  TAB_BAR_ITEMS,
  TAB_BAR_LABELS,
  TAB_BAR_MAX,
  type TabBarItem,
} from "../../../tabBar";
import { PANEL_BTN } from "../constants";
import { useSettingsPage } from "../context";
import { Section } from "../ui";
import ItemOrderEditor from "./ItemOrderEditor";

/** Which tabs the installed app's bottom island shows on a phone, in order. */
export default function TabBarSection() {
  const { q, match, settings, update } = useSettingsPage();
  const items = settings.tabBarItems;
  const isDefault =
    items.length === DEFAULT_TAB_BAR.length &&
    items.every((item, i) => item === DEFAULT_TAB_BAR[i]);
  const set = (next: TabBarItem[]) => update({ tabBarItems: next });
  const focusAfter = useRef<string[]>([]);

  return (
    <Section
      anchor="tab-bar"
      title="Tab bar"
      description={`On a phone, the installed app (added to the Home Screen) shows these tabs in a floating bar at the bottom of the screen, up to ${TAB_BAR_MAX}. Tabs this account cannot use, or that need the server while offline, are left out. A browser tab keeps the menu at the top.`}
      action={
        !isDefault && (
          <button
            type="button"
            className={PANEL_BTN}
            onClick={() => {
              focusAfter.current = [
                `Remove ${TAB_BAR_LABELS[DEFAULT_TAB_BAR[0]]}`,
              ];
              set([...DEFAULT_TAB_BAR]);
            }}
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
      <ItemOrderEditor
        items={items}
        all={TAB_BAR_ITEMS}
        label={(item) => TAB_BAR_LABELS[item]}
        icon={(item) => <TabIcon d={TAB_BAR_ICONS[item]} />}
        max={TAB_BAR_MAX}
        listLabel="Tabs shown"
        addHeading="Add a tab"
        focusAfter={focusAfter}
        onChange={set}
      />
    </Section>
  );
}
