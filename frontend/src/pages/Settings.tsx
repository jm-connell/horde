import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../apiErrors";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useSearch } from "../context/SearchContext";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import {
  useSettings,
  loadSettings,
  type CustomThemePreset,
} from "../hooks/useSettings";
import { newCustomFontId, parseCustomFontInput } from "../fonts";
import type {
  AiSettings,
  AiWorkloadProfile,
  AppSettings,
  BackgroundItem,
  HealthStats,
  StorageStats,
  UpdateCheck,
} from "../types";
import { appSettingsQuery, useUpdateAppSettings } from "../queries/app";
import { queryKeys } from "../queries/keys";
import {
  dataOrNull,
  metadataSyncStatusQuery,
  useAiStatus,
  useChannelCatalogStatus,
  useMetadataSyncStatus,
  useOpenRouterCosts,
  useOpenRouterModels,
  useSystemActivity,
  useSystemStats,
} from "../queries/status";
import { formatUsdCost } from "../utils";
import LiquidNav from "../components/LiquidNav";
import AppearanceTab from "./settings/AppearanceTab";
import LibraryTab from "./settings/LibraryTab";
import PlaybackTab from "./settings/PlaybackTab";
import LoadingIndicator from "../components/LoadingIndicator";
import { AiTab, SystemTab } from "./settings/lazy";
import UsersTab from "./settings/UsersTab";
import { useAuth } from "../context/AuthContext";
import {
  CHAT_MODEL_OPTIONS,
  DEFAULT_AI,
  EMBED_MODEL_OPTIONS,
  TAB_STORAGE_KEY,
  ADMIN_ONLY_TABS,
  TABS,
} from "./settings/constants";
import {
  SettingsPageProvider,
  type SettingsPageContextValue,
} from "./settings/context";
import {
  loadDismissedUpdateSha,
  loadTab,
  resolveTabParam,
} from "./settings/helpers";
import {
  firstMatchingAiPane,
  firstMatchingTab,
  matchesQuery,
  resolveAiPaneParam,
  tabMatchesQuery,
} from "./settings/search";
import type {
  AiPane,
  AiProcessAction,
  AiProviderPane,
  SettingsTab,
} from "./settings/types";

import { getItem, setItem } from "../storage";
export default function Settings() {
  const [settings, update] = useSettings();
  const { showToast, showError } = useToast();
  const queryClient = useQueryClient();
  const saveAppSettings = useUpdateAppSettings();
  const confirm = useConfirm();
  const { setYoutubeVideoSearch } = useSearch();
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
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [health, setHealth] = useState<HealthStats | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [dismissedUpdateSha, setDismissedUpdateSha] = useState<string | null>(
    loadDismissedUpdateSha
  );
  const [aiDraft, setAiDraft] = useState<AiSettings>(DEFAULT_AI);
  const [aiTesting, setAiTesting] = useState(false);
  const [openRouterTesting, setOpenRouterTesting] = useState(false);
  const [openRouterKeyDraft, setOpenRouterKeyDraft] = useState("");
  const [aiProviderPane, setAiProviderPane] = useState<AiProviderPane>("local");
  const aiProviderPaneFromBackendRef = useRef(false);
  const [aiPane, setAiPane] = useState<AiPane>(() => {
    const fromUrl = resolveAiPaneParam(
      new URLSearchParams(window.location.search).get("pane")
    );
    if (fromUrl) return fromUrl;
    const v = getItem("horde.aiPane");
    if (v === "providers" || v === "features" || v === "jobs") return v;
    return "providers";
  });
  const [embedCustom, setEmbedCustom] = useState(false);
  const [chatCustom, setChatCustom] = useState(false);
  const [advancedModelsOpen, setAdvancedModelsOpen] = useState(false);
  const [reindexPrompt, setReindexPrompt] = useState<string | null>(null);
  const [catchUpScope, setCatchUpScope] = useState<"all_recent" | "all_full">(
    "all_recent"
  );
  const [individualStepsOpen, setIndividualStepsOpen] = useState(false);
  const [expiryInput, setExpiryInput] = useState<string>("");
  const [catalogMaxInput, setCatalogMaxInput] = useState<string>("1000");
  const [syncIntervalInput, setSyncIntervalInput] = useState<string>("24");
  const [catalogIndexing, setCatalogIndexing] = useState(false);
  const [metadataSyncing, setMetadataSyncing] = useState(false);
  const [metadataSyncFields, setMetadataSyncFields] = useState<string[]>([
    "all",
  ]);
  const [aiProcessingAction, setAiProcessingAction] = useState<string | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [navPreview, setNavPreview] = useState<"home" | "library" | "settings">(
    "home"
  );
  const [bgUploading, setBgUploading] = useState(false);
  const [paletteColors, setPaletteColors] = useState<string[]>([]);
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [customFontDraft, setCustomFontDraft] = useState("");
  const [themeNameDraft, setThemeNameDraft] = useState("");
  const [bgLibrary, setBgLibrary] = useState<BackgroundItem[]>([]);
  const [lastUploadedName, setLastUploadedName] = useState<string | null>(null);

  const q = searchQuery.trim().toLowerCase();
  const match = (...parts: (string | undefined | null)[]) =>
    matchesQuery(q, ...parts);

  const showUpdateNotice = Boolean(
    updateCheck?.update_available &&
    updateCheck.latest_sha &&
    updateCheck.latest_sha !== dismissedUpdateSha &&
    (!q ||
      match("update", "version", "github", "git pull", "docker", "rebuild"))
  );

  // Live status panels. Each resource is one shared query (see queries/status),
  // so the AI status the Library polls is the same request as this one.
  const onAiOrSystem = tab === "ai" || tab === "system";
  const aiStatusQuery = useAiStatus({ interval: onAiOrSystem ? 5000 : false });
  const aiStatus = dataOrNull(aiStatusQuery);
  const refreshAiStatus = () => {
    void aiStatusQuery.refetch();
  };
  const catalogStatusQuery = useChannelCatalogStatus({
    enabled: tab === "system",
    interval: 5000,
  });
  const catalogStatus = dataOrNull(catalogStatusQuery);
  const refreshCatalogStatus = () => {
    void catalogStatusQuery.refetch();
  };
  const metadataSyncQuery = useMetadataSyncStatus({
    enabled: tab === "system" || tab === "library",
    interval: 5000,
  });
  const metadataSyncStatus = metadataSyncQuery.data ?? null;
  const systemStatsQuery = useSystemStats({
    enabled: tab === "library" || onAiOrSystem,
    interval: tab === "library" ? false : 3000,
  });
  const systemStats = dataOrNull(systemStatsQuery);
  const systemActivityQuery = useSystemActivity({
    enabled: tab === "system",
    interval: 2000,
  });
  const systemActivity = dataOrNull(systemActivityQuery);
  const openRouterCostsQuery = useOpenRouterCosts({
    enabled: onAiOrSystem,
    interval: 15000,
  });
  const openRouterCosts = onAiOrSystem
    ? dataOrNull(openRouterCostsQuery)
    : null;
  const openRouterModelsEnabled =
    tab === "ai" &&
    !!aiDraft.openrouter_enabled &&
    !!aiDraft.openrouter_api_key_set;
  const openRouterModelsQuery = useOpenRouterModels(openRouterModelsEnabled);
  const refreshOpenRouterModels = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.ai.models });
  const openRouterModels = openRouterModelsEnabled
    ? (openRouterModelsQuery.data?.models ?? [])
    : [];
  const openRouterEmbedModels = openRouterModelsEnabled
    ? (openRouterModelsQuery.data?.embedding_models ?? [])
    : [];

  useEffect(() => {
    api
      .storageStats()
      .then(setStorage)
      .catch(() => undefined);
    queryClient
      .fetchQuery(appSettingsQuery())
      .then((s) => {
        setAppSettings(s);
        setExpiryInput(String(s.progress_expiry_days));
        setCatalogMaxInput(String(s.channel_catalog_max_videos ?? 1000));
        setSyncIntervalInput(String(s.metadata_sync_interval_hours ?? 24));
        if (s.ai) {
          const merged = { ...DEFAULT_AI, ...s.ai };
          setAiDraft(merged);
          setEmbedCustom(
            !EMBED_MODEL_OPTIONS.some(
              (o) => o.value !== "__custom__" && o.value === merged.embed_model
            )
          );
          setChatCustom(
            !CHAT_MODEL_OPTIONS.some(
              (o) => o.value !== "__custom__" && o.value === merged.chat_model
            )
          );
        }
      })
      .catch(() => undefined);
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => undefined);
  }, [queryClient]);

  useEffect(() => {
    if (!appSettings?.ai || aiProviderPaneFromBackendRef.current) return;
    if (q) return;
    aiProviderPaneFromBackendRef.current = true;
    const orInUse =
      !!appSettings.ai.openrouter_enabled &&
      !!appSettings.ai.openrouter_api_key_set;
    setAiProviderPane(orInUse ? "openrouter" : "local");
  }, [appSettings, q]);

  useEffect(() => {
    if (!openRouterCosts?.over_budget) return;
    const budget = openRouterCosts.weekly_budget_usd;
    if (budget == null || budget <= 0) return;
    const dayKey = Math.floor(Date.now() / 86_400_000);
    const storageKey = `horde:or-budget-warn:${budget}:${dayKey}`;
    if (getItem(storageKey)) return;
    setItem(storageKey, "1");
    const spent = formatUsdCost(openRouterCosts.d7) || "$0";
    const limit = formatUsdCost(budget) || `$${budget}`;
    if (openRouterCosts.blocked) {
      showToast(
        `OpenRouter weekly budget exceeded (${spent} / ${limit}). Calls blocked.`
      );
    } else {
      showToast(`OpenRouter weekly spend is ${spent} (limit ${limit}).`);
    }
  }, [openRouterCosts, showToast]);

  // Search auto-switch: AI pane + Local/OpenRouter within Providers.
  useEffect(() => {
    if (tab !== "ai" || !q) return;
    const pane = firstMatchingAiPane(q);
    if (pane && pane !== aiPane) {
      setAiPane(pane);
      setItem("horde.aiPane", pane);
    }
    const qq = q.toLowerCase();
    if (
      qq.includes("openrouter") ||
      qq.includes("api key") ||
      qq.includes("budget") ||
      qq.includes("cost") ||
      qq.includes("usage") ||
      qq.includes("cloud llm")
    ) {
      setAiProviderPane("openrouter");
    } else if (
      qq.includes("ollama") ||
      qq.includes("vram") ||
      qq.includes("workload")
    ) {
      setAiProviderPane("local");
    }
  }, [q, tab, aiPane]);

  const refreshUpdates = (refresh = false) => {
    setUpdateChecking(true);
    return api
      .checkUpdates(refresh)
      .then(setUpdateCheck)
      .catch(() => setUpdateCheck(null))
      .finally(() => setUpdateChecking(false));
  };

  useEffect(() => {
    if (tab !== "system") return;
    void refreshUpdates(false);
  }, [tab]);

  useEffect(() => {
    setPaletteColors([]);
  }, [settings.customBackgroundId]);

  const refreshBgLibrary = () =>
    api
      .listBackgrounds()
      .then((r) => setBgLibrary(r.items ?? []))
      .catch(() => setBgLibrary([]));

  useEffect(() => {
    if (
      settings.backgroundEffect === "custom-image" ||
      (tab === "appearance" && settings.backgroundEffect !== "none")
    ) {
      refreshBgLibrary();
    }
  }, [settings.backgroundEffect, tab]);

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
  }, [searchParams, selectTab]);

  // Cross-tab search: jump to the first tab that matches when the current one doesn't.
  useEffect(() => {
    if (!q) return;
    if (tabMatchesQuery(tab, q)) return;
    const next = firstMatchingTab(q);
    if (next && next !== tab) selectTab(next);
  }, [q, tab, selectTab]);

  const saveAi = async (patch: Partial<AiSettings>) => {
    const next = { ...aiDraft, ...patch };
    setAiDraft(next);
    const updated = await saveAppSettings({ ai: patch }).catch((err) => {
      showError(`Could not save AI settings: ${describeError(err)}`);
      return null;
    });
    if (updated?.ai) {
      setAppSettings(updated);
      setAiDraft({ ...DEFAULT_AI, ...updated.ai });
    }
    refreshAiStatus();
  };

  const saveExpiry = async () => {
    const days = parseInt(expiryInput, 10);
    if (isNaN(days) || days < 1 || days > 365) return;
    const updated = await saveAppSettings({ progress_expiry_days: days }).catch(
      (err) => {
        showError(`Could not save setting: ${describeError(err)}`);
        return null;
      }
    );
    if (updated) {
      setAppSettings(updated);
      update({ progressExpiryDays: updated.progress_expiry_days });
    }
  };

  const saveCatalogSettings = async (
    patch: Partial<
      Pick<
        AppSettings,
        | "channel_catalog_enabled"
        | "channel_catalog_max_videos"
        | "metadata_sync_interval_hours"
        | "direct_youtube_search"
        | "youtube_video_search"
      >
    >
  ) => {
    const updated = await saveAppSettings(patch).catch((err) => {
      showError(`Could not save setting: ${describeError(err)}`);
      return null;
    });
    if (updated) {
      setAppSettings(updated);
      setCatalogMaxInput(String(updated.channel_catalog_max_videos ?? 1000));
      setSyncIntervalInput(String(updated.metadata_sync_interval_hours ?? 24));
      if (patch.youtube_video_search != null) {
        setYoutubeVideoSearch(
          updated.youtube_video_search ?? patch.youtube_video_search
        );
      }
      refreshCatalogStatus();
    }
  };

  const resyncAllMetadata = async () => {
    if (metadataSyncing) return;
    const fields =
      metadataSyncFields.includes("all") || metadataSyncFields.length === 0
        ? ["all"]
        : metadataSyncFields;
    const label = fields.includes("all") ? "all metadata" : fields.join(", ");
    const ok = await confirm({
      title: "Resync metadata?",
      body: `Resync ${label} for all videos with a source URL?`,
      confirmLabel: "Resync",
    });
    if (!ok) return;
    setMetadataSyncing(true);
    try {
      const result = await api.refreshMetadataBulk(undefined, fields);
      if (!result.started) {
        showToast(result.detail || "Could not start metadata sync");
        setMetadataSyncing(false);
        return;
      }
      showToast(result.detail || "Metadata sync started");
      const poll = async () => {
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const status = await queryClient.fetchQuery({
              ...metadataSyncStatusQuery(),
              staleTime: 0,
            });
            if (!status.running) {
              showToast(
                `Synced ${status.done} video${status.done === 1 ? "" : "s"}` +
                  (status.failed ? ` (${status.failed} failed)` : "") +
                  (status.skipped ? ` (${status.skipped} skipped)` : "")
              );
              break;
            }
          } catch {
            break;
          }
        }
        setMetadataSyncing(false);
      };
      void poll();
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Metadata sync failed"
      );
      setMetadataSyncing(false);
    }
  };

  const toggleSyncField = (field: string) => {
    setMetadataSyncFields((prev) => {
      if (field === "all") return ["all"];
      const withoutAll = prev.filter((f) => f !== "all");
      if (withoutAll.includes(field)) {
        const next = withoutAll.filter((f) => f !== field);
        return next.length === 0 ? ["all"] : next;
      }
      return [...withoutAll, field];
    });
  };

  const runAiProcess = async (action: AiProcessAction) => {
    if (aiProcessingAction) return;
    setAiProcessingAction(action);
    try {
      const result = await api.processAiLibrary(action);
      showToast(result.detail || "Nothing to process");
      refreshAiStatus();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not enqueue library";
      showToast(msg);
    } finally {
      setAiProcessingAction(null);
    }
  };

  const applyWorkload = async (profile: AiWorkloadProfile) => {
    try {
      const result = await api.applyAiWorkload(profile);
      const updated = await queryClient
        .fetchQuery({ ...appSettingsQuery(), staleTime: 0 })
        .catch(() => null);
      if (updated?.ai) {
        setAppSettings(updated);
        setAiDraft({ ...DEFAULT_AI, ...updated.ai });
      }
      showToast(result.detail || `Applied ${profile} workload`);
      refreshAiStatus();
      if (result.embed_model_changed) {
        setReindexPrompt(
          "Embedding model changed with this workload. Rebuild search indexes so semantic search and categories use the new model? Categories refresh automatically when indexing finishes."
        );
      } else {
        setReindexPrompt(null);
      }
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Could not apply workload"
      );
    }
  };

  const saveModels = async () => {
    const embed = aiDraft.embed_model.trim();
    const chat = aiDraft.chat_model.trim();
    const prevEmbed = (
      appSettings?.ai.embed_model || DEFAULT_AI.embed_model
    ).trim();
    const embedChanged = embed !== prevEmbed;
    await saveAi({
      embed_model: embed,
      chat_model: chat,
    });
    if (embedChanged) {
      setReindexPrompt(
        "Embedding model changed. Rebuild search indexes so semantic search, related videos, and category shelves use the new model? Categories refresh automatically when indexing finishes."
      );
      refreshAiStatus();
      return;
    }
    setReindexPrompt(null);
    showToast("Models saved");
    refreshAiStatus();
  };

  const uploadCustomBackground = async (file: File | null) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast("Large file (>10MB) — upload may be slow");
    }
    setBgUploading(true);
    let result: Awaited<ReturnType<typeof api.uploadBackground>>;
    try {
      result = await api.uploadBackground(file);
    } catch (err) {
      showError(`Background upload failed: ${describeError(err)}`);
      return;
    } finally {
      setBgUploading(false);
    }
    const name = result.filename || file.name;
    setLastUploadedName(name);
    update({
      backgroundEffect: "custom-image",
      customBackgroundId: result.id,
      customBackgroundMime: result.mime,
    });
    setPaletteColors([]);
    await refreshBgLibrary();
    showToast("Background uploaded");
  };

  const deleteLibraryBackground = async (id: string) => {
    const ok = await confirm({
      title: "Delete this background?",
      body: "The image is removed from your library and can't be restored.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const result = await api.deleteBackground(id).catch((err) => {
      showError(`Could not delete background: ${describeError(err)}`);
      return null;
    });
    if (!result?.ok) {
      if (result) showError("Could not delete background");
      return;
    }
    if (settings.customBackgroundId === id) {
      const remaining = bgLibrary.filter((b) => b.id !== id);
      const next = remaining[0];
      if (next) {
        update({
          customBackgroundId: next.id,
          customBackgroundMime: next.mime,
        });
      } else {
        update({
          customBackgroundId: null,
          customBackgroundMime: null,
        });
      }
    }
    await refreshBgLibrary();
  };

  const saveCurrentAsTheme = () => {
    const name = themeNameDraft.trim();
    if (!name) {
      showToast("Enter a theme name");
      return;
    }
    const current = loadSettings();
    const preset: CustomThemePreset = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now()),
      name: name.slice(0, 64),
      customColors: { ...current.customColors },
      backgroundEffect: current.backgroundEffect,
      backgroundOpacity: current.backgroundOpacity,
      backgroundEffectSpeed: current.backgroundEffectSpeed,
      backgroundEffectSize: current.backgroundEffectSize,
      backgroundEffectColorMode: current.backgroundEffectColorMode,
      backgroundEffectColor: current.backgroundEffectColor,
      flowingGradientPreset: current.flowingGradientPreset,
      customBackgroundId: current.customBackgroundId,
      customBackgroundMime: current.customBackgroundMime,
      customBackgroundBlur: current.customBackgroundBlur,
      customBackgroundTint: current.customBackgroundTint,
      customBackgroundTintOpacity: current.customBackgroundTintOpacity,
      pauseBackgroundWhileWatching: current.pauseBackgroundWhileWatching,
      navIndicator: current.navIndicator,
      hoverMotion: current.hoverMotion,
      translucentPanelStrength: current.translucentPanelStrength,
      translucentPanelBlur: current.translucentPanelBlur,
      translucentPanelTintEnabled: current.translucentPanelTintEnabled,
      translucentPanelTint: current.translucentPanelTint,
      translucentPanelTintStrength: current.translucentPanelTintStrength,
      translucentPanelLegibility: current.translucentPanelLegibility,
      loadingStyle: current.loadingStyle,
      fontSize: current.fontSize,
      uiFont: current.uiFont === "custom" ? "default" : current.uiFont,
      customCss: current.customCss,
      customCssEnabled: current.customCssEnabled,
    };
    update({ customThemes: [...current.customThemes, preset] });
    setThemeNameDraft("");
    showToast(`Saved theme “${preset.name}”`);
  };

  const addCustomFontFromUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const parsed = parseCustomFontInput(trimmed);
    if (!parsed.family || !parsed.cssUrl) {
      showToast("Could not parse that font");
      return;
    }
    const current = loadSettings();
    const existing = current.customFonts.find(
      (f) =>
        f.source === "url" &&
        (f.url === trimmed ||
          f.name.toLowerCase() === parsed.family!.toLowerCase())
    );
    if (existing) {
      update({ uiFont: existing.id });
      setCustomFontDraft("");
      showToast(`“${existing.name}” is already saved`);
      return;
    }
    const id = newCustomFontId();
    update({
      customFonts: [
        ...current.customFonts,
        { id, name: parsed.family, source: "url", url: trimmed },
      ],
      uiFont: id,
    });
    setCustomFontDraft("");
    showToast(`Saved “${parsed.family}”`);
  };

  const applyCustomTheme = (preset: CustomThemePreset) => {
    update({
      theme: "custom",
      customColors: { ...preset.customColors },
      backgroundEffect: preset.backgroundEffect,
      backgroundOpacity: preset.backgroundOpacity,
      backgroundEffectSpeed: preset.backgroundEffectSpeed,
      backgroundEffectSize: preset.backgroundEffectSize,
      backgroundEffectColorMode: preset.backgroundEffectColorMode,
      backgroundEffectColor: preset.backgroundEffectColor,
      flowingGradientPreset: preset.flowingGradientPreset,
      customBackgroundId: preset.customBackgroundId,
      customBackgroundMime: preset.customBackgroundMime,
      customBackgroundBlur: preset.customBackgroundBlur,
      customBackgroundTint: preset.customBackgroundTint,
      customBackgroundTintOpacity: preset.customBackgroundTintOpacity,
      pauseBackgroundWhileWatching: preset.pauseBackgroundWhileWatching,
      navIndicator: preset.navIndicator,
      hoverMotion: preset.hoverMotion,
      translucentPanelStrength: preset.translucentPanelStrength,
      translucentPanelBlur: preset.translucentPanelBlur,
      translucentPanelTintEnabled: preset.translucentPanelTintEnabled,
      translucentPanelTint: preset.translucentPanelTint,
      translucentPanelTintStrength: preset.translucentPanelTintStrength,
      translucentPanelLegibility: preset.translucentPanelLegibility,
      loadingStyle: preset.loadingStyle,
      fontSize: preset.fontSize,
      uiFont: preset.uiFont,
      customCss: preset.customCss,
      customCssEnabled: preset.customCssEnabled,
    });
    showToast(`Applied “${preset.name}”`);
  };

  const deleteCustomTheme = (id: string) => {
    update({
      customThemes: settings.customThemes.filter((t) => t.id !== id),
    });
  };

  const extractPalette = async () => {
    if (!settings.customBackgroundId || paletteLoading) return;
    setPaletteLoading(true);
    const result = await api
      .extractBackgroundPalette(settings.customBackgroundId)
      .catch((err) => {
        showError(`Could not extract palette: ${describeError(err)}`);
        return null;
      });
    setPaletteLoading(false);
    if (result && !result.colors?.length) {
      showError("Could not extract palette");
    }
    if (!result?.colors?.length) return;
    setPaletteColors(result.colors);
  };

  const applyPaletteColor = (color: string) => {
    const hex = color.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const dark = `#${Math.round(r * 0.12)
      .toString(16)
      .padStart(2, "0")}${Math.round(g * 0.12)
      .toString(16)
      .padStart(2, "0")}${Math.round(b * 0.12)
      .toString(16)
      .padStart(2, "0")}`;
    update({
      theme: "custom",
      customColors: {
        accent: color.toLowerCase(),
        background: dark,
      },
      customBackgroundTint: dark,
    });
  };

  const ctxValue: SettingsPageContextValue = {
    q,
    match,
    settings,
    update,
    showToast,
    showError,
    themeNameDraft,
    setThemeNameDraft,
    saveCurrentAsTheme,
    applyCustomTheme,
    deleteCustomTheme,
    customFontDraft,
    setCustomFontDraft,
    addCustomFontFromUrl,
    bgUploading,
    uploadCustomBackground,
    lastUploadedName,
    bgLibrary,
    deleteLibraryBackground,
    paletteColors,
    paletteLoading,
    extractPalette,
    applyPaletteColor,
    navPreview,
    setNavPreview,
    appSettings,
    setAppSettings,
    catalogMaxInput,
    setCatalogMaxInput,
    syncIntervalInput,
    setSyncIntervalInput,
    saveCatalogSettings,
    metadataSyncFields,
    toggleSyncField,
    resyncAllMetadata,
    metadataSyncing: metadataSyncing || !!metadataSyncStatus?.running,
    metadataSyncStatus,
    expiryInput,
    setExpiryInput,
    saveExpiry,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    systemStats,
    refreshAiStatus,
    aiProviderPane,
    setAiProviderPane,
    aiPane,
    setAiPane,
    aiTesting,
    setAiTesting,
    openRouterTesting,
    setOpenRouterTesting,
    openRouterKeyDraft,
    setOpenRouterKeyDraft,
    openRouterModels,
    openRouterEmbedModels,
    refreshOpenRouterModels,
    openRouterCosts,
    embedCustom,
    setEmbedCustom,
    chatCustom,
    setChatCustom,
    advancedModelsOpen,
    setAdvancedModelsOpen,
    reindexPrompt,
    setReindexPrompt,
    aiProcessingAction,
    runAiProcess,
    applyWorkload,
    saveModels,
    catchUpScope,
    setCatchUpScope,
    individualStepsOpen,
    setIndividualStepsOpen,
    storage,
    health,
    updateCheck,
    updateChecking,
    refreshUpdates,
    showUpdateNotice,
    dismissedUpdateSha,
    setDismissedUpdateSha,
    catalogStatus,
    catalogIndexing,
    setCatalogIndexing,
    refreshCatalogStatus,
    systemActivity,
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
            {tab === "ai" && <AiTab />}
            {tab === "system" && <SystemTab />}
            {tab === "users" && isAdmin && <UsersTab />}
          </Suspense>
        </div>
      </SettingsPageProvider>
    </div>
  );
}
