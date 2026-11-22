import { useRef } from "react";
import {
  DEFAULT_NAV_BAR,
  NAV_BAR_ITEMS,
  NAV_BAR_LABELS,
  NAV_BAR_REQUIRED,
  type NavBarItem,
} from "../../../navBar";
import { PANEL_BTN } from "../constants";
import { useSettingsPage } from "../context";
import { Section } from "../ui";
import ItemOrderEditor from "./ItemOrderEditor";

/** Which pages the top bar links to on a wider screen, in order. */
export default function NavBarSection() {
  const { q, match, settings, update } = useSettingsPage();
  const items = settings.navBarItems;
  const isDefault =
    items.length === DEFAULT_NAV_BAR.length &&
    items.every((item, i) => item === DEFAULT_NAV_BAR[i]);
  const set = (next: NavBarItem[]) => update({ navBarItems: next });
  const focusAfter = useRef<string[]>([]);

  return (
    <Section
      anchor="nav-bar"
      title="Top bar"
      description="On a wider screen, the top bar links to these pages, in this order, on every device you sign in on. Settings always stays. Pages this account cannot use are left out, and Offline shows only when this device has offline downloads. On a phone or a narrow window the ☰ menu still lists every page."
      action={
        !isDefault && (
          <button
            type="button"
            className={PANEL_BTN}
            onClick={() => {
              focusAfter.current = [
                `Remove ${NAV_BAR_LABELS[DEFAULT_NAV_BAR[0]]}`,
              ];
              set([...DEFAULT_NAV_BAR]);
            }}
          >
            Reset
          </button>
        )
      }
      hidden={
        !!q &&
        !match(
          "top bar",
          "nav bar",
          "navigation",
          "menu",
          "links",
          "header",
          "desktop"
        )
      }
    >
      <ItemOrderEditor
        items={items}
        all={NAV_BAR_ITEMS}
        label={(item) => NAV_BAR_LABELS[item]}
        locked={NAV_BAR_REQUIRED}
        listLabel="Pages in the top bar"
        addHeading="Add a page"
        focusAfter={focusAfter}
        onChange={set}
      />
    </Section>
  );
}
