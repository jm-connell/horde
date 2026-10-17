import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useSettings } from "../../hooks/useSettings";
import type {
  BackgroundEffect,
  ChannelSort,
  CustomThemePreset,
  FlowingGradientPreset,
  LibrarySort,
  UiFont,
} from "../../hooks/useSettings";

/**
 * What every tab shares: the search box and the client-side preferences.
 * Anything else a tab needs (server settings, drafts, polling) lives in the
 * hook that tab calls itself.
 */
export type SettingsPageContextValue = {
  // search
  q: string;
  match: (...parts: (string | undefined | null)[]) => boolean;

  // client settings
  settings: ReturnType<typeof useSettings>[0];
  update: ReturnType<typeof useSettings>[1];
  showToast: (msg: string) => void;
  showError: (msg: string) => void;
};

// Re-exported so tabs can pull the same underlying types from one place.
export type {
  BackgroundEffect,
  ChannelSort,
  CustomThemePreset,
  FlowingGradientPreset,
  LibrarySort,
  UiFont,
};

export const SettingsPageContext =
  createContext<SettingsPageContextValue | null>(null);

export function useSettingsPage(): SettingsPageContextValue {
  const ctx = useContext(SettingsPageContext);
  if (!ctx)
    throw new Error("useSettingsPage must be used within SettingsPageContext");
  return ctx;
}

export function SettingsPageProvider({
  value,
  children,
}: {
  value: SettingsPageContextValue;
  children: ReactNode;
}) {
  return (
    <SettingsPageContext.Provider value={value}>
      {children}
    </SettingsPageContext.Provider>
  );
}
