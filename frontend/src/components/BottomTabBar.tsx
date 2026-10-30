import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useDownloads } from "../context/DownloadContext";
import { useHelpChat } from "../context/HelpChatContext";
import { useHomeReset } from "../context/HomeResetContext";
import { useSearch } from "../context/SearchContext";
import { useInstalledApp } from "../hooks/useInstalledApp";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import { isTextEntryTarget } from "../utils/keyboardTarget";
import { TAB_BAR_ICONS, TAB_BAR_LABELS, type TabBarItem } from "../tabBar";
import { HELP_PANEL_ID } from "./helpChat";
import { isLinkActive, useNavLinks } from "./navLinks";

/** Fields that use a picker or file chooser instead of the keyboard. */
const NO_KEYBOARD_TYPES = new Set([
  "file",
  "color",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Focus is in a field that brings up the on-screen keyboard. */
function opensKeyboard(el: Element | null): boolean {
  if (!isTextEntryTarget(el) || el instanceof HTMLSelectElement) return false;
  return !(el instanceof HTMLInputElement && NO_KEYBOARD_TYPES.has(el.type));
}

/** The bar's height (with the home-indicator inset), for fixed layers that
 *  must sit above it: 0 while it is away for the keyboard, unset when there
 *  is no bar. */
const BAR_VAR = "--horde-bottom-bar";

/**
 * Phone tab bar for the installed app: a floating island at the bottom of the
 * screen with the tabs chosen in Settings (Home, Search, Download and Chat by
 * default), as in a native app. A browser tab keeps the header menu only.
 * Tapping the current tab scrolls back to the top; Search opens the header's
 * search box and Chat the Ask about Horde panel; the island slides away while
 * the keyboard is up. It follows the panel transparency settings (not
 * the legibility boost: it holds icons, not text to read).
 */
export default function BottomTabBar() {
  const installed = useInstalledApp();
  const isMobile = useIsMobile();
  const links = useNavLinks();
  const location = useLocation();
  const { resetHome } = useHomeReset();
  const { search } = useSearch();
  const help = useHelpChat();
  const { activeCount } = useDownloads();
  const [settings] = useSettings();
  const [typing, setTyping] = useState(false);
  const [barH, setBarH] = useState(0);
  const barRef = useRef<HTMLElement>(null);
  const shown = installed && isMobile;

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => {
      setBarH(el.offsetHeight);
      root.style.setProperty(BAR_VAR, `${typing ? 0 : el.offsetHeight}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty(BAR_VAR);
    };
  }, [shown, typing]);

  useEffect(() => {
    if (!shown) return;
    const vv = window.visualViewport;
    let keyboardSeen = false;
    const onFocus = () => {
      keyboardSeen = false;
      setTyping(opensKeyboard(document.activeElement));
    };
    // Android closes the keyboard (back, swipe down) without moving focus:
    // bring the bar back once the viewport is full height again.
    const onViewportResize = () => {
      if (!vv) return;
      if (vv.height * vv.scale < window.innerHeight - 120) {
        keyboardSeen = true;
      } else if (keyboardSeen) {
        keyboardSeen = false;
        setTyping(false);
      }
    };
    onFocus();
    window.addEventListener("focusin", onFocus);
    window.addEventListener("focusout", onFocus);
    vv?.addEventListener("resize", onViewportResize);
    return () => {
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("focusout", onFocus);
      vv?.removeEventListener("resize", onViewportResize);
    };
  }, [shown]);

  if (!shown) return null;

  // Chat opens over the page, so while it is open it is the current tab.
  const chatOpen = help.available && help.open;
  const onHome = location.pathname === "/";
  const searching = onHome && search.trim() !== "";
  const pageLinks = new Set(links.map((link) => link.to));
  const downloadBadge = settings.showDownloadNavBadge ? activeCount : 0;

  const scrollTopIfCurrent = (current: boolean) => {
    if (!current) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  const renderTab = (item: TabBarItem) => {
    const label = TAB_BAR_LABELS[item];
    if (item === "search" || item === "chat") {
      const current = item === "chat" ? chatOpen : searching && !chatOpen;
      return (
        <button
          key={item}
          type="button"
          onClick={() => {
            if (item === "chat") help.setOpen(!help.open);
            else {
              if (chatOpen) help.setOpen(false);
              window.dispatchEvent(new Event("horde:open-search"));
            }
          }}
          aria-current={item === "search" && current ? "page" : undefined}
          aria-expanded={item === "chat" ? chatOpen : undefined}
          aria-controls={
            item === "chat" && chatOpen ? HELP_PANEL_ID : undefined
          }
          className={tabClass(current)}
        >
          <TabIcon d={TAB_BAR_ICONS[item]} />
          <TabLabel shown={current}>{label}</TabLabel>
        </button>
      );
    }
    const to = item === "home" ? "/" : `/${item}`;
    const onPage =
      item === "home"
        ? onHome && !searching
        : isLinkActive(location.pathname, to, false);
    const current = onPage && !chatOpen;
    const badge = item === "download" ? downloadBadge : 0;
    return (
      <NavLink
        key={item}
        to={to}
        end={item === "home"}
        onClick={() => {
          if (chatOpen) help.setOpen(false);
          if (item === "home") resetHome();
          scrollTopIfCurrent(onPage);
        }}
        aria-current={current ? "page" : undefined}
        className={tabClass(current)}
      >
        <span className="relative shrink-0">
          <TabIcon d={TAB_BAR_ICONS[item]} />
          {badge > 0 && (
            <span className="absolute -right-2 -top-1.5 rounded-full bg-accent px-1.5 text-[10px] font-bold leading-4 text-on-accent">
              {badge}
            </span>
          )}
        </span>
        <TabLabel shown={current}>{label}</TabLabel>
      </NavLink>
    );
  };

  // Tabs this account can use here and now: pages from the nav (permissions,
  // offline mode), Chat when this account may use AI.
  const available = (item: TabBarItem) => {
    if (item === "home" || item === "search") return true;
    if (item === "chat") return help.available;
    return pageLinks.has(`/${item}`);
  };

  // Home stands in when none of the chosen tabs can be used here.
  const usable = settings.tabBarItems.filter(available);

  return (
    <>
      <div aria-hidden className="shrink-0" style={{ height: barH }} />
      <nav
        ref={barRef}
        aria-label="Tabs"
        data-horde="tab-bar"
        className={`pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none ${
          typing ? "translate-y-full opacity-0" : ""
        }`}
      >
        <div
          className={`ui-panel flex max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-full border border-ink-700/70 bg-ink-900/95 p-1.5 shadow-[0_8px_28px_rgb(0_0_0/0.45)] backdrop-blur-md ${
            typing ? "" : "pointer-events-auto"
          }`}
        >
          {(usable.length > 0 ? usable : (["home"] as const)).map(renderTab)}
        </div>
      </nav>
    </>
  );
}

/** A tab: icon only, or a tinted capsule with its label when current. */
function tabClass(current: boolean): string {
  return `flex h-11 min-w-0 items-center rounded-full px-3.5 transition-colors duration-200 motion-reduce:transition-none ${
    current ? "bg-accent/15 text-accent" : "text-gray-300 active:bg-ink-700/60"
  }`;
}

export function TabIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[22px] w-[22px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** The label opens out beside the icon of the current tab. Hidden ones stay
 *  in the DOM so every tab keeps its accessible name. */
function TabLabel({
  shown,
  children,
}: {
  shown: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`min-w-0 truncate text-sm font-semibold transition-[max-width,opacity,margin] duration-200 ease-out motion-reduce:transition-none ${
        shown ? "ml-2 max-w-24 opacity-100" : "ml-0 max-w-0 opacity-0"
      }`}
    >
      {children}
    </span>
  );
}
