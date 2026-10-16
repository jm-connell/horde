import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "../context/ToastContext";
import { useSettings } from "../hooks/useSettings";
import LiquidNav from "../components/LiquidNav";
import LoadingIndicator from "../components/LoadingIndicator";
import { useAuth } from "../context/AuthContext";
import { setItem } from "../storage";
import AppearanceTab from "./settings/AppearanceTab";
import LibraryTab from "./settings/LibraryTab";
import PlaybackTab from "./settings/PlaybackTab";
import UsersTab from "./settings/UsersTab";
import { useAiPaneState } from "./settings/ai/useAiPaneState";
import { AiTab, SystemTab } from "./settings/lazy";
import { ADMIN_ONLY_TABS, TAB_STORAGE_KEY, TABS } from "./settings/constants";
import {
  SettingsPageProvider,
  type SettingsPageContextValue,
} from "./settings/context";
import { loadTab, resolveTabParam } from "./settings/helpers";
import {
  firstMatchingTab,
  matchesQuery,
  resolveAiPaneParam,
  tabMatchesQuery,
} from "./settings/search";
import type { SettingsTab } from "./settings/types";

/**
 * The settings page shell: the tab bar, the search box and which tab is open
 * (`?tab=`, `?pane=`). Each tab owns its own state and polling.
 */
export default function Settings() {
  const [settings, update] = useSettings();
  const { showToast, showError } = useToast();
  const [searchParams] = useSearchParams();
  const { isAdmin } = useAuth();
  // Server-wide areas are for administrators; members keep their own preferences.
  const tabAllowed = useCallback(
    (id: SettingsTab) => isAdmin || !ADMIN_ONLY_TABS.has(id),
    [isAdmin]
  );
  const tabs = TABS.filter((t) => tabAllowed(t.id));
  const [tab, setTab] = useState<SettingsTab>(() => {
    const fromUrl = resolveTabParam(
      new URLSearchParams(window.location.search).get("tab")
    );
    const first = fromUrl ?? loadTab();
    return tabAllowed(first) ? first : "appearance";
  });
  const paneState = useAiPaneState();
  const { setAiPane } = paneState;
  const [searchQuery, setSearchQuery] = useState("");

  const q = searchQuery.trim().toLowerCase();
  const match = (...parts: (string | undefined | null)[]) =>
    matchesQuery(q, ...parts);

  const selectTab = useCallback(
    (next: SettingsTab) => {
      if (!tabAllowed(next)) return;
      setTab(next);
      setItem(TAB_STORAGE_KEY, next);
    },
    [tabAllowed]
  );

  // Deep link: /settings?tab=playback&pane=jobs
  useEffect(() => {
    const fromUrl = resolveTabParam(searchParams.get("tab"));
    if (fromUrl) selectTab(fromUrl);
    const pane = resolveAiPaneParam(searchParams.get("pane"));
    if (pane) {
      setAiPane(pane);
      setItem("horde.aiPane", pane);
    }
  }, [searchParams, selectTab, setAiPane]);

  // Cross-tab search: jump to the first tab that matches when the current one doesn't.
  useEffect(() => {
    if (!q) return;
    if (tabMatchesQuery(tab, q)) return;
    const next = firstMatchingTab(q);
    if (next && next !== tab) selectTab(next);
  }, [q, tab, selectTab]);

  const ctxValue: SettingsPageContextValue = {
    q,
    match,
    settings,
    update,
    showToast,
    showError,
  };

  // Roving tabindex: only the selected tab is in the Tab order; arrows move
  // between tabs and select them.
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") {
      next = (index - 1 + tabs.length) % tabs.length;
    } else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(tabs[next].id);
    document.getElementById(`settings-tab-${tabs[next].id}`)?.focus();
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold text-gray-100">Settings</h1>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <LiquidNav
          className="ui-panel flex w-full min-w-0 max-w-full flex-wrap gap-1 rounded-xl bg-ink-900 p-1 ring-1 ring-ink-700 sm:inline-flex sm:w-fit sm:flex-nowrap sm:overflow-x-auto"
          pillClassName="bg-ink-800"
          dependency={tab}
          role="tablist"
          aria-label="Settings sections"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-controls="settings-panel"
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              onKeyDown={onTabKeyDown}
              data-liquid-active={tab === t.id ? "true" : undefined}
              onClick={() => selectTab(t.id)}
              className={`ui-interactive relative z-10 shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? settings.navIndicator !== "none"
                    ? "text-gray-100"
                    : "bg-ink-800 text-gray-100"
                  : "text-gray-400 hover:text-gray-200"
              } ${
                settings.navIndicator === "none" && tab !== t.id
                  ? "hover:bg-ink-800/60"
                  : ""
              }`}
            >
              {t.label}
            </button>
          ))}
        </LiquidNav>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search settings"
          className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-gray-100 outline-none placeholder:text-muted focus:border-accent sm:ml-auto sm:w-44 sm:shrink-0"
        />
      </div>

      <SettingsPageProvider value={ctxValue}>
        <div
          role="tabpanel"
          id="settings-panel"
          aria-labelledby={`settings-tab-${tab}`}
          className="ui-panel space-y-6 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700"
        >
          {tab === "appearance" && <AppearanceTab />}
          {tab === "library" && <LibraryTab />}
          {tab === "playback" && <PlaybackTab />}
          <Suspense fallback={<LoadingIndicator label="Loading" />}>
            {tab === "ai" && <AiTab paneState={paneState} />}
            {tab === "system" && <SystemTab />}
            {tab === "users" && isAdmin && <UsersTab />}
          </Suspense>
        </div>
      </SettingsPageProvider>
    </div>
  );
}
