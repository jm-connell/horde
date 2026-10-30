import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useDownloads } from "../context/DownloadContext";
import { useHomeReset } from "../context/HomeResetContext";
import { useInstalledApp } from "../hooks/useInstalledApp";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import { isTextEntryTarget } from "../utils/keyboardTarget";
import { isLinkActive, useNavLinks } from "./navLinks";

/** Pages that get a tab; the rest stay in the header menu. */
const TAB_ICONS: Record<string, string> = {
  "/": "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z",
  "/playlists": "M4 6h16M4 12h10M4 18h10m4-5v6l4-3z",
  "/history": "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4",
  "/offline": "M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14",
  "/download":
    "M12 8v8m-4-4h8M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
};

/** The bar's height (with the home-indicator inset), for fixed layers that
 *  must sit above it. Unset when there is no bar. */
const BAR_VAR = "--horde-bottom-bar";

/**
 * Phone tab bar for the installed app: the main pages one tap away at the
 * bottom of the screen, as in a native app. A browser tab keeps the header
 * menu only. Tapping the current tab scrolls back to the top; the bar slides
 * away while the keyboard is up.
 */
export default function BottomTabBar() {
  const installed = useInstalledApp();
  const isMobile = useIsMobile();
  const links = useNavLinks().filter((link) => link.to in TAB_ICONS);
  const location = useLocation();
  const { resetHome } = useHomeReset();
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
      root.style.setProperty(BAR_VAR, `${el.offsetHeight}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty(BAR_VAR);
    };
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const onFocus = () => setTyping(isTextEntryTarget(document.activeElement));
    window.addEventListener("focusin", onFocus);
    window.addEventListener("focusout", onFocus);
    return () => {
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("focusout", onFocus);
    };
  }, [shown]);

  if (!shown) return null;

  const onTabClick = (to: string, end: boolean) => {
    if (to === "/") resetHome();
    if (isLinkActive(location.pathname, to, end)) {
      const reduce = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    }
  };

  const downloadBadge = settings.showDownloadNavBadge ? activeCount : 0;

  return (
    <>
      <div aria-hidden className="shrink-0" style={{ height: barH }} />
      <nav
        ref={barRef}
        aria-label="Tabs"
        data-horde="tab-bar"
        className={`ui-panel fixed inset-x-0 bottom-0 z-30 flex border-t border-ink-700 bg-ink-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm transition-transform duration-200 ease-out motion-reduce:transition-none ${
          settings.translucentPanelLegibility ? "ui-panel-legible" : ""
        } ${typing ? "pointer-events-none translate-y-full" : ""}`}
      >
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            onClick={() => onTabClick(link.to, link.end)}
            className={({ isActive }) =>
              `relative flex min-w-0 flex-1 flex-col items-center gap-0.5 pb-1.5 pt-2 text-[11px] font-medium transition-colors duration-150 ${
                isActive ? "text-accent" : "text-gray-400"
              }`
            }
          >
            <span className="relative">
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={TAB_ICONS[link.to]} />
              </svg>
              {link.to === "/download" && downloadBadge > 0 && (
                <span className="absolute -right-2.5 -top-1.5 rounded-full bg-accent px-1.5 text-[10px] font-bold leading-4 text-on-accent">
                  {downloadBadge}
                </span>
              )}
            </span>
            <span className="truncate">{link.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
