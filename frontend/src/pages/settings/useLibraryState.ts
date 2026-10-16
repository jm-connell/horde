import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { useConfirm } from "../../context/ConfirmContext";
import { useSearch } from "../../context/SearchContext";
import { useUpdateAppSettings } from "../../queries/app";
import {
  dataOrNull,
  metadataSyncStatusQuery,
  useChannelCatalogStatus,
  useMetadataSyncStatus,
  useSystemStats,
} from "../../queries/status";
import type { AppSettings } from "../../types";
import { useSettingsPage } from "./context";
import { useLoadedAppSettings } from "./useLoadedAppSettings";

/** State, polling and saves of the Library tab (display, catalog, metadata sync). */
export function useLibraryState() {
  const { update, showToast, showError } = useSettingsPage();
  const queryClient = useQueryClient();
  const saveAppSettings = useUpdateAppSettings();
  const confirm = useConfirm();
  const { setYoutubeVideoSearch } = useSearch();
  const [expiryInput, setExpiryInput] = useState<string>("");
  const [catalogMaxInput, setCatalogMaxInput] = useState<string>("1000");
  const [syncIntervalInput, setSyncIntervalInput] = useState<string>("24");
  const [metadataSyncing, setMetadataSyncing] = useState(false);
  const [metadataSyncFields, setMetadataSyncFields] = useState<string[]>([
    "all",
  ]);
  const [appSettings, setAppSettings] = useLoadedAppSettings((s) => {
    setExpiryInput(String(s.progress_expiry_days));
    setCatalogMaxInput(String(s.channel_catalog_max_videos ?? 1000));
    setSyncIntervalInput(String(s.metadata_sync_interval_hours ?? 24));
  });

  const metadataSyncStatus =
    useMetadataSyncStatus({ interval: 5000 }).data ?? null;
  const systemStats = dataOrNull(useSystemStats({ interval: false }));
  // Not shown here, but a catalog setting change refreshes the status the
  // System tab reads.
  const catalogStatusQuery = useChannelCatalogStatus({ enabled: false });
  const refreshCatalogStatus = () => {
    void catalogStatusQuery.refetch();
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

  return {
    appSettings,
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
    systemStats,
  };
}
