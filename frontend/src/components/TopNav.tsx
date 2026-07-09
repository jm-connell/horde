import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import { useDownloads } from "../context/DownloadContext";
import { useSearch } from "../context/SearchContext";
import { useSettings } from "../hooks/useSettings";
import LiquidNav from "./LiquidNav";

const NAV_LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/history", label: "History", end: false },
  { to: "/playlists", label: "Playlists", end: false },
  { to: "/download", label: "Download", end: false },
  { to: "/review", label: "Review", end: false },
  { to: "/settings", label: "Settings", end: false },
];

function isLinkActive(pathname: string, to: string, end: boolean): boolean {
  if (end) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

export default function TopNav() {
  const [reviewCount, setReviewCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const { activeCount } = useDownloads();
  const [settings] = useSettings();
  const location = useLocation();
  const { search, setSearch } = useSearch();
  const isLibrary = location.pathname === "/";
  const indicatorOn = settings.navIndicator !== "none";

  useEffect(() => {
    if (!isLibrary) setSearch("");
  }, [isLibrary, setSearch]);

  const showDownloadBadge =
    settings.showDownloadNavBadge && activeCount > 0;

  useEffect(() => {
    let active = true;
    const poll = () =>
      api
        .listReview()
        .then((items) => active && setReviewCount(items.length))
        .catch(() => undefined);
    poll();
    const id = setInterval(poll, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `ui-interactive relative z-10 px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-200 ${
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

  const reviewBadge = badge(reviewCount);
  const downloadBadge = badge(showDownloadBadge ? activeCount : 0);

  const mobileBadgeCount =
    reviewCount + (showDownloadBadge ? activeCount : 0);

  const linkBadge = (label: string) =>
    label === "Review"
      ? reviewBadge
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
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-3 md:px-6">
        <NavLink
          to="/"
          className="ui-interactive mr-4 flex items-center gap-2 rounded-lg px-2 py-1"
        >
          <span className="text-xl font-bold tracking-tight text-accent">
            HORDE
          </span>
        </NavLink>

        <LiquidNav
          className="hidden items-center gap-1 md:flex"
          dependency={location.pathname}
        >
          {desktopLinks}
        </LiquidNav>

        <input
          value={isLibrary ? search : ""}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search videos..."
          disabled={!isLibrary}
          className="ui-interactive min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent disabled:opacity-40 md:hidden"
        />

        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="ui-interactive ml-auto rounded-lg p-2 text-gray-300 hover:bg-ink-800 md:hidden"
          aria-label="Toggle navigation menu"
          aria-expanded={menuOpen}
        >
          <span className="flex items-center gap-2">
            {badge(mobileBadgeCount)}
            <span className="text-xl leading-none">{menuOpen ? "✕" : "☰"}</span>
          </span>
        </button>
      </div>

      {menuOpen && (
        <LiquidNav
          className="ui-panel border-t border-ink-700 bg-ink-950 px-3 py-2 md:hidden"
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
