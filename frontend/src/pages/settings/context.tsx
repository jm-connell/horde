import { createContext, useContext } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useSettings } from "../../hooks/useSettings";
import type {
  BackgroundEffect,
  ChannelSort,
  CustomThemePreset,
  FlowingGradientPreset,
  LibrarySort,
  UiFont,
} from "../../hooks/useSettings";
import type {
  AiSettings,
  AiStatus,
  AiWorkloadProfile,
  AppSettings,
  ChannelCatalogStatus,
  HealthStats,
  OpenRouterCosts,
  StorageStats,
  SystemActivity,
  SystemStats,
  UpdateCheck,
} from "../../types";
import type { AiPane, AiProcessAction, AiProviderPane } from "./types";

export type SettingsPageContextValue = {
  // search
  q: string;
  match: (...parts: (string | undefined | null)[]) => boolean;

  // client settings
  settings: ReturnType<typeof useSettings>[0];
  update: ReturnType<typeof useSettings>[1];
  showToast: (msg: string) => void;

  // appearance
  themeNameDraft: string;
  setThemeNameDraft: Dispatch<SetStateAction<string>>;
  saveCurrentAsTheme: () => void;
  applyCustomTheme: (preset: CustomThemePreset) => void;
  deleteCustomTheme: (id: string) => void;
  customFontDraft: string;
  setCustomFontDraft: Dispatch<SetStateAction<string>>;
  addCustomFontFromUrl: (raw: string) => void;
  bgUploading: boolean;
  uploadCustomBackground: (file: File | null) => Promise<void>;
  lastUploadedName: string | null;
  bgLibrary: { id: string; url: string; mime: string; animated: boolean; filename?: string }[];
  deleteLibraryBackground: (id: string) => Promise<void>;
  paletteColors: string[];
  paletteLoading: boolean;
  extractPalette: () => Promise<void>;
  applyPaletteColor: (color: string) => void;
  navPreview: "home" | "library" | "settings";
  setNavPreview: Dispatch<SetStateAction<"home" | "library" | "settings">>;

  // library / downloads / metadata
  appSettings: AppSettings | null;
  setAppSettings: Dispatch<SetStateAction<AppSettings | null>>;
  catalogMaxInput: string;
  setCatalogMaxInput: Dispatch<SetStateAction<string>>;
  syncIntervalInput: string;
  setSyncIntervalInput: Dispatch<SetStateAction<string>>;
  saveCatalogSettings: (patch: Partial<Pick<AppSettings, "channel_catalog_enabled" | "channel_catalog_max_videos" | "metadata_sync_interval_hours" | "direct_youtube_search" | "youtube_video_search">>) => Promise<void>;
  metadataSyncFields: string[];
  toggleSyncField: (field: string) => void;
  resyncAllMetadata: () => Promise<void>;
  metadataSyncing: boolean;
  metadataSyncStatus: {
    running: boolean;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    current_title: string | null;
    last_error: string | null;
  } | null;
  expiryInput: string;
  setExpiryInput: Dispatch<SetStateAction<string>>;
  saveExpiry: () => Promise<void>;

  // AI
  aiDraft: AiSettings;
  setAiDraft: Dispatch<SetStateAction<AiSettings>>;
  saveAi: (patch: Partial<AiSettings>) => Promise<void>;
  aiStatus: AiStatus | null;
  systemStats: SystemStats | null;
  refreshAiStatus: () => void;
  aiProviderPane: AiProviderPane;
  setAiProviderPane: Dispatch<SetStateAction<AiProviderPane>>;
  aiPane: AiPane;
  setAiPane: Dispatch<SetStateAction<AiPane>>;
  aiTesting: boolean;
  setAiTesting: Dispatch<SetStateAction<boolean>>;
  openRouterTesting: boolean;
  setOpenRouterTesting: Dispatch<SetStateAction<boolean>>;
  openRouterKeyDraft: string;
  setOpenRouterKeyDraft: Dispatch<SetStateAction<string>>;
  openRouterModels: { id: string; name: string }[];
  setOpenRouterModels: Dispatch<SetStateAction<{ id: string; name: string }[]>>;
  openRouterEmbedModels: { id: string; name: string }[];
  setOpenRouterEmbedModels: Dispatch<SetStateAction<{ id: string; name: string }[]>>;
  openRouterModelFilter: string;
  setOpenRouterModelFilter: Dispatch<SetStateAction<string>>;
  openRouterCosts: OpenRouterCosts | null;
  embedCustom: boolean;
  setEmbedCustom: Dispatch<SetStateAction<boolean>>;
  chatCustom: boolean;
  setChatCustom: Dispatch<SetStateAction<boolean>>;
  advancedModelsOpen: boolean;
  setAdvancedModelsOpen: Dispatch<SetStateAction<boolean>>;
  reindexPrompt: string | null;
  setReindexPrompt: Dispatch<SetStateAction<string | null>>;
  aiProcessingAction: string | null;
  runAiProcess: (action: AiProcessAction) => Promise<void>;
  applyWorkload: (profile: AiWorkloadProfile) => Promise<void>;
  saveModels: () => Promise<void>;
  catchUpScope: "all_recent" | "all_full";
  setCatchUpScope: Dispatch<SetStateAction<"all_recent" | "all_full">>;
  individualStepsOpen: boolean;
  setIndividualStepsOpen: Dispatch<SetStateAction<boolean>>;

  // system
  storage: StorageStats | null;
  health: HealthStats | null;
  updateCheck: UpdateCheck | null;
  updateChecking: boolean;
  refreshUpdates: (refresh?: boolean) => Promise<void> | void;
  showUpdateNotice: boolean;
  dismissedUpdateSha: string | null;
  setDismissedUpdateSha: Dispatch<SetStateAction<string | null>>;
  catalogStatus: ChannelCatalogStatus | null;
  catalogIndexing: boolean;
  setCatalogIndexing: Dispatch<SetStateAction<boolean>>;
  refreshCatalogStatus: () => void;
  systemActivity: SystemActivity | null;
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

export const SettingsPageContext = createContext<SettingsPageContextValue | null>(
  null
);

export function useSettingsPage(): SettingsPageContextValue {
  const ctx = useContext(SettingsPageContext);
  if (!ctx) throw new Error("useSettingsPage must be used within SettingsPageContext");
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
