import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import { useDownloads } from "../context/DownloadContext";
import { useSettings } from "../hooks/useSettings";

const NAV_LINKS = [
  { to: "/", label: "Library", end: true },
  { to: "/history", label: "History", end: false },
  { to: "/playlists", label: "Playlists", end: false },
  { to: "/download", label: "Download", end: false },
  { to: "/review", label: "Review", end: false },
  { to: "/settings", label: "Settings", end: false },
];

export default function TopNav() {
  const [reviewCount, setReviewCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const { activeCount } = useDownloads();
  const [settings] = useSettings();
  const location = useLocation();

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

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? "bg-accent/15 text-accent"
        : "text-gray-400 hover:text-gray-100 hover:bg-ink-800"
    }`;

  const mobileLinkClass = ({ isActive }: { isActive: boolean }) =>
    `block px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? "bg-accent/15 text-accent"
        : "text-gray-300 hover:text-gray-100 hover:bg-ink-800"
    }`;

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

  return (
    <header className="sticky top-0 z-30 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-3 md:px-6">
        <NavLink to="/" className="mr-4 flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-accent">
            HORDE
          </span>
        </NavLink>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={linkClass}
            >
              <span className="flex items-center gap-2">
                {link.label}
                {linkBadge(link.label)}
              </span>
            </NavLink>
          ))}
        </nav>

        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="ml-auto rounded-lg p-2 text-gray-300 hover:bg-ink-800 md:hidden"
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
        <nav className="border-t border-ink-700 bg-ink-950 px-3 py-2 md:hidden">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={mobileLinkClass}
            >
              <span className="flex items-center gap-2">
                {link.label}
                {linkBadge(link.label)}
              </span>
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );
}
