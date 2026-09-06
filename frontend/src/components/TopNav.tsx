import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useDownloads } from "../context/DownloadContext";
import { useSearch } from "../context/SearchContext";
import { useSettings } from "../hooks/useSettings";
import {
  IMPORT_QUEUE_EVENT,
  notifyImportQueueChanged,
} from "../utils/importQueue";
import Collapse from "./Collapse";
import LiquidNav from "./LiquidNav";
import YoutubeSearchChip from "./YoutubeSearchChip";

const NAV_LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/playlists", label: "Playlists", end: false },
  { to: "/history", label: "History", end: false },
  { to: "/download", label: "Download", end: false },
  { to: "/import", label: "Import", end: false },
  { to: "/settings", label: "Settings", end: false },
];

const ICON_BTN =
  "ui-nav-icon relative z-10 shrink-0 bg-transparent p-1.5 text-gray-300 hover:text-gray-100";

function isLinkActive(pathname: string, to: string, end: boolean): boolean {
  if (end) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

export default function TopNav() {
  const [importCount, setImportCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRendered, setMenuRendered] = useState(false);
  const [menuShown, setMenuShown] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [useHamburger, setUseHamburger] = useState(false);
  const [navHidden, setNavHidden] = useState(false);
  const [navH, setNavH] = useState(56);
  const { activeCount } = useDownloads();
  const { search, setSearch, commitSearch } = useSearch();
  const [settings] = useSettings();
  const location = useLocation();
  const navigate = useNavigate();
  const indicatorOn = settings.navIndicator !== "none";
  const measureRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastScrollY = useRef(0);

  const showDownloadBadge =
    settings.showDownloadNavBadge && activeCount > 0;

  useEffect(() => {
    let active = true;
    const poll = () =>
      api
        .listImport()
        .then((items) => {
          if (!active) return;
          setImportCount(items.length);
        })
        .catch(() => undefined);
    poll();
    const id = setInterval(poll, 30000);
    const onQueue = (e: Event) => {
      const count = (e as CustomEvent<{ count?: number }>).detail?.count;
      if (typeof count === "number") {
        setImportCount(count);
        return;
      }
      poll();
    };
    window.addEventListener(IMPORT_QUEUE_EVENT, onQueue);
    return () => {
      active = false;
      clearInterval(id);
      window.removeEventListener(IMPORT_QUEUE_EVENT, onQueue);
    };
  }, []);

  // Refresh badge when navigating (e.g. after scanner ingested files).
  useEffect(() => {
    if (location.pathname === "/import" || location.pathname === "/review") {
      api
        .listImport()
        .then((items) => {
          setImportCount(items.length);
          notifyImportQueueChanged(items.length);
        })
        .catch(() => undefined);
    }
  }, [location.pathname]);

  useEffect(() => {
    setMenuOpen(false);
    if (location.pathname !== "/") setSearchOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!useHamburger) {
      setMenuRendered(false);
      setMenuShown(false);
      return;
    }
    if (menuOpen) {
      setMenuRendered(true);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setMenuShown(true));
      });
      return () => cancelAnimationFrame(id);
    }
    setMenuShown(false);
    const t = window.setTimeout(() => setMenuRendered(false), 320);
    return () => window.clearTimeout(t);
  }, [menuOpen, useHamburger]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (headerRef.current?.contains(t) || menuPanelRef.current?.contains(t)) {
        return;
      }
      setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const id = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(id);
    };
  }, [searchOpen]);

  // Overflow check is authoritative — force hamburger whenever nav won't fit.
  useLayoutEffect(() => {
    const check = () => {
      const measure = measureRef.current;
      const row = headerRowRef.current;
      if (!measure || !row) return;
      const brandW = brandRef.current?.offsetWidth ?? 110;
      const gap = 16;
      const menuW = 48;
      const searchW = 48;
      const available = row.clientWidth - brandW - menuW - searchW - gap * 3;
      setUseHamburger(measure.scrollWidth > available - 4);
    };
    check();
    const ro = new ResizeObserver(check);
    if (headerRowRef.current) ro.observe(headerRowRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    window.addEventListener("resize", check);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [settings.fontSize, importCount, showDownloadBadge, activeCount]);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setNavH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [useHamburger, searchOpen, menuOpen, settings.fontSize]);

  useEffect(() => {
    if (!useHamburger) {
      setNavHidden(false);
      return;
    }
    lastScrollY.current = window.scrollY;
    const onScroll = () => {
      if (menuOpen || searchOpen || menuRendered) {
        setNavHidden(false);
        lastScrollY.current = window.scrollY;
        return;
      }
      const y = window.scrollY;
      const delta = y - lastScrollY.current;
      lastScrollY.current = y;
      if (y < 8) {
        setNavHidden(false);
        return;
      }
      if (delta > 4) setNavHidden(true);
      else if (delta < -4) setNavHidden(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [useHamburger, menuOpen, searchOpen, menuRendered]);

  const openSearch = () => {
    setMenuOpen(false);
    setNavHidden(false);
    setSearchOpen(true);
    if (location.pathname !== "/" || location.search) {
      navigate({ pathname: "/", search: "" });
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchInputRef.current?.blur();
  };

  const toggleMenu = () => {
    setSearchOpen(false);
    setNavHidden(false);
    setMenuOpen((v) => !v);
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `ui-interactive relative z-10 px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-200 whitespace-nowrap ${
      isActive
        ? indicatorOn
          ? "text-accent"
          : "bg-accent/15 text-accent"
        : "text-gray-400 hover:text-gray-100"
    } ${!indicatorOn && !isActive ? "hover:bg-ink-800" : ""}`;

  const mobileLinkClass = ({ isActive }: { isActive: boolean }) =>
    `ui-interactive relative z-10 block px-4 py-3 rounded-lg text-sm font-medium transition-colors duration-200 ${
      isActive
        ? indicatorOn
          ? "text-accent"
          : "bg-accent/15 text-accent"
        : "text-gray-300 hover:text-gray-100"
    } ${!indicatorOn && !isActive ? "hover:bg-ink-800" : ""}`;

  const badge = (count: number) =>
    count > 0 ? (
      <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-ink-950">
        {count}
      </span>
    ) : null;

  const importBadge = badge(importCount);
  const downloadBadge = badge(showDownloadBadge ? activeCount : 0);

  const mobileBadgeCount =
    importCount + (showDownloadBadge ? activeCount : 0);

  const linkBadge = (label: string) =>
    label === "Import"
      ? importBadge
      : label === "Download"
        ? downloadBadge
        : null;

  const desktopLinks = NAV_LINKS.map((link) => {
    const active = isLinkActive(location.pathname, link.to, link.end);
    return (
      <NavLink
        key={link.to}
        to={link.to}
        end={link.end}
        className={linkClass}
        data-liquid-active={active ? "true" : undefined}
      >
        <span className="flex items-center gap-2">
          {link.label}
          {linkBadge(link.label)}
        </span>
      </NavLink>
    );
  });

  return (
    <>
      <header
        ref={headerRef}
        data-horde="nav"
        data-nav-hidden={navHidden ? "true" : undefined}
        className={`ui-panel fixed inset-x-0 top-0 z-30 border-b border-ink-700 bg-ink-950/90 pt-[env(safe-area-inset-top)] backdrop-blur motion-reduce:transition-none ${
          settings.translucentPanelLegibility ? "ui-panel-legible" : ""
        } ${
          useHamburger ? "transition-transform duration-200 ease-out" : ""
        } ${navHidden ? "pointer-events-none -translate-y-full" : "translate-y-0"}`}
      >
        <div
          ref={headerRowRef}
          className="relative z-50 mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-1.5 md:px-6 md:py-3"
        >
          <NavLink
            ref={brandRef}
            to="/"
            className="ui-interactive mr-2 flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-0.5 sm:mr-4 sm:px-2 sm:py-1"
          >
            <span className="text-xl font-bold tracking-tight text-accent">
              HORDE
            </span>
          </NavLink>

          <div
            ref={measureRef}
            className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex w-max items-center gap-1"
            aria-hidden
          >
            {NAV_LINKS.map((link) => (
              <span
                key={link.to}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium whitespace-nowrap"
              >
                {link.label}
                {linkBadge(link.label)}
              </span>
            ))}
          </div>

          {!useHamburger && (
            <LiquidNav
              className="flex min-w-0 items-center gap-1"
              dependency={location.pathname}
            >
              {desktopLinks}
            </LiquidNav>
          )}

          {useHamburger && (
            <div
              className={`ml-auto flex min-w-0 items-center gap-0.5 ${
                searchOpen ? "flex-1" : "shrink-0"
              }`}
            >
              {searchOpen && (
                <div className="relative mr-1 min-w-0 flex-1">
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitSearch();
                      }
                    }}
                    placeholder="Search"
                    enterKeyHint="search"
                    aria-label="Search library"
                    className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-900 py-1.5 pl-3 pr-8 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent"
                  />
                  <YoutubeSearchChip />
                </div>
              )}
              <button
                type="button"
                onClick={() => (searchOpen ? closeSearch() : openSearch())}
                className={ICON_BTN}
                aria-label={searchOpen ? "Close search" : "Search"}
                aria-expanded={searchOpen}
              >
                {searchOpen ? (
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                )}
              </button>
              <button
                ref={menuBtnRef}
                type="button"
                onClick={toggleMenu}
                className={ICON_BTN}
                aria-label="Toggle navigation menu"
                aria-expanded={menuOpen}
              >
                <span className="flex items-center gap-2">
                  {badge(mobileBadgeCount)}
                  {menuOpen ? (
                    <svg
                      viewBox="0 0 24 24"
                      className="h-6 w-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      aria-hidden
                    >
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      className="h-6 w-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      aria-hidden
                    >
                      <path d="M4 7h16M4 12h16M4 17h16" />
                    </svg>
                  )}
                </span>
              </button>
            </div>
          )}
        </div>
      </header>
      {useHamburger && menuRendered && (
        <>
          <button
            type="button"
            aria-label="Close navigation menu"
            className={`fixed inset-0 z-20 cursor-default bg-black/40 transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              menuShown
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            onClick={() => setMenuOpen(false)}
          />
          <nav
            ref={menuPanelRef}
            className="fixed inset-x-0 z-40"
            style={{ top: navH }}
          >
            <Collapse
              open={menuShown}
              className="motion-reduce:transition-none"
            >
              <div
                data-horde="nav-menu"
                className={`ui-panel border-b border-ink-700 bg-ink-950 shadow-2xl ${
                  settings.translucentPanelLegibility
                    ? "ui-panel-legible"
                    : ""
                }`}
              >
                <LiquidNav
                  className="mx-auto flex max-w-[1600px] flex-col gap-1 px-3 py-3 md:px-6"
                  dependency={location.pathname}
                >
                  {NAV_LINKS.map((link) => {
                    const active = isLinkActive(
                      location.pathname,
                      link.to,
                      link.end
                    );
                    return (
                      <NavLink
                        key={link.to}
                        to={link.to}
                        end={link.end}
                        className={mobileLinkClass}
                        data-liquid-active={active ? "true" : undefined}
                      >
                        <span className="flex items-center gap-2">
                          {link.label}
                          {linkBadge(link.label)}
                        </span>
                      </NavLink>
                    );
                  })}
                </LiquidNav>
              </div>
            </Collapse>
          </nav>
        </>
      )}
      <div aria-hidden className="shrink-0" style={{ height: navH }} />
    </>
  );
}
