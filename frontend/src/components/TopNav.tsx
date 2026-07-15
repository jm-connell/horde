import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import { useDownloads } from "../context/DownloadContext";
import { useSettings } from "../hooks/useSettings";
import {
  IMPORT_QUEUE_EVENT,
  notifyImportQueueChanged,
} from "../utils/importQueue";
import LiquidNav from "./LiquidNav";

const NAV_LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/playlists", label: "Playlists", end: false },
  { to: "/history", label: "History", end: false },
  { to: "/download", label: "Download", end: false },
  { to: "/import", label: "Import", end: false },
  { to: "/settings", label: "Settings", end: false },
];

function isLinkActive(pathname: string, to: string, end: boolean): boolean {
  if (end) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

export default function TopNav() {
  const [importCount, setImportCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [useHamburger, setUseHamburger] = useState(false);
  const { activeCount } = useDownloads();
  const [settings] = useSettings();
  const location = useLocation();
  const indicatorOn = settings.navIndicator !== "none";
  const measureRef = useRef<HTMLDivElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

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
  }, [location.pathname]);

  // Overflow check is authoritative — force hamburger whenever nav won't fit.
  useLayoutEffect(() => {
    const check = () => {
      const measure = measureRef.current;
      const row = headerRowRef.current;
      if (!measure || !row) return;
      const brandW = brandRef.current?.offsetWidth ?? 110;
      const gap = 16;
      const menuW = 48;
      const available = row.clientWidth - brandW - menuW - gap * 2;
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

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `ui-interactive relative z-10 px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-200 whitespace-nowrap ${
      isActive
        ? indicatorOn
          ? "text-accent"
          : "bg-accent/15 text-accent"
        : "text-gray-400 hover:text-gray-100"
    } ${!indicatorOn && !isActive ? "hover:bg-ink-800" : ""}`;

  const mobileLinkClass = ({ isActive }: { isActive: boolean }) =>
    `ui-interactive relative z-10 block px-4 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200 ${
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
    <header className="ui-panel sticky top-0 z-30 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
      <div
        ref={headerRowRef}
        className="mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-3 md:px-6"
      >
        <NavLink
          ref={brandRef}
          to="/"
          className="ui-interactive mr-2 flex shrink-0 items-center gap-2 rounded-lg px-2 py-1 sm:mr-4"
        >
          <span className="text-xl font-bold tracking-tight text-accent">
            HORDE
          </span>
        </NavLink>

        <div
          ref={measureRef}
          className="pointer-events-none invisible absolute flex items-center gap-1"
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
          <button
            ref={menuBtnRef}
            onClick={() => setMenuOpen((v) => !v)}
            className="ui-interactive ml-auto shrink-0 rounded-lg p-2 text-gray-300 hover:bg-ink-800"
            aria-label="Toggle navigation menu"
            aria-expanded={menuOpen}
          >
            <span className="flex items-center gap-2">
              {badge(mobileBadgeCount)}
              <span className="text-xl leading-none">{menuOpen ? "✕" : "☰"}</span>
            </span>
          </button>
        )}
      </div>

      {useHamburger && menuOpen && (
        <LiquidNav
          className="ui-panel border-t border-ink-700 bg-ink-950 px-3 py-2"
          dependency={location.pathname}
        >
          {NAV_LINKS.map((link) => {
            const active = isLinkActive(location.pathname, link.to, link.end);
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
      )}
    </header>
  );
}
