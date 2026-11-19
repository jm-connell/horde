import type { KeyboardEvent } from "react";
import LiquidNav from "../../components/LiquidNav";
import type { NavIndicator } from "../../hooks/useSettings";
import type { HomeTab } from "../libraryStorage";

const TABS: { id: HomeTab; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "recommended", label: "Recommended" },
];

/** Library / Recommended switch at the top of the home page. */
export default function HomeTabs({
  homeTab,
  navIndicator,
  onSelect,
}: {
  homeTab: HomeTab;
  navIndicator: NavIndicator;
  onSelect: (tab: HomeTab) => void;
}) {
  // Roving tabindex, as on Settings: only the selected tab is in the Tab
  // order; arrows move between tabs and select them.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((t) => t.id === homeTab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft")
      next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(TABS[next].id);
    document.getElementById(`home-tab-${TABS[next].id}`)?.focus();
  };

  return (
    <LiquidNav
      className="ui-panel inline-flex shrink-0 rounded-xl bg-ink-900 p-1 ring-1 ring-ink-700"
      pillClassName="bg-ink-800"
      dependency={homeTab}
      role="tablist"
      aria-label="Home"
    >
      {TABS.map((t) => {
        const active = homeTab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`home-tab-${t.id}`}
            aria-selected={active}
            aria-controls="home-panel"
            tabIndex={active ? 0 : -1}
            onKeyDown={onKeyDown}
            data-liquid-active={active ? "true" : undefined}
            onClick={() => onSelect(t.id)}
            className={`ui-interactive relative z-10 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors sm:px-3 [@media(pointer:coarse)]:py-2 ${
              active
                ? navIndicator !== "none"
                  ? "text-gray-100"
                  : "bg-ink-800 text-gray-100"
                : "text-gray-400 hover:text-gray-200"
            } ${navIndicator === "none" && !active ? "hover:bg-ink-800/60" : ""}`}
          >
            {t.label}
          </button>
        );
      })}
    </LiquidNav>
  );
}
