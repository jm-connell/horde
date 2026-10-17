import LiquidNav from "../../components/LiquidNav";
import type { NavIndicator } from "../../hooks/useSettings";
import type { HomeTab } from "../libraryStorage";

function TabButton({
  tab,
  current,
  label,
  navIndicator,
  onSelect,
}: {
  tab: HomeTab;
  current: HomeTab;
  label: string;
  navIndicator: NavIndicator;
  onSelect: (tab: HomeTab) => void;
}) {
  const active = current === tab;
  return (
    <button
      type="button"
      data-liquid-active={active ? "true" : undefined}
      onClick={() => onSelect(tab)}
      className={`ui-interactive relative z-10 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors sm:px-3 ${
        active
          ? navIndicator !== "none"
            ? "text-gray-100"
            : "bg-ink-800 text-gray-100"
          : "text-gray-400 hover:text-gray-200"
      } ${navIndicator === "none" && !active ? "hover:bg-ink-800/60" : ""}`}
    >
      {label}
    </button>
  );
}

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
  return (
    <LiquidNav
      className="ui-panel inline-flex shrink-0 rounded-xl bg-ink-900 p-1 ring-1 ring-ink-700"
      pillClassName="bg-ink-800"
      dependency={homeTab}
    >
      <TabButton
        tab="library"
        current={homeTab}
        label="Library"
        navIndicator={navIndicator}
        onSelect={onSelect}
      />
      <TabButton
        tab="recommended"
        current={homeTab}
        label="Recommended"
        navIndicator={navIndicator}
        onSelect={onSelect}
      />
    </LiquidNav>
  );
}
