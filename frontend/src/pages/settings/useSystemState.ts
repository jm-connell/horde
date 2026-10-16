import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import {
  dataOrNull,
  useChannelCatalogStatus,
  useMetadataSyncStatus,
  useSystemActivity,
} from "../../queries/status";
import type { HealthStats, StorageStats, UpdateCheck } from "../../types";
import { useSettingsPage } from "./context";
import { loadDismissedUpdateSha } from "./helpers";

/** State and polling of the System tab: versions, storage, catalog and job activity. */
export function useSystemState() {
  const { q, match } = useSettingsPage();
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [health, setHealth] = useState<HealthStats | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [dismissedUpdateSha, setDismissedUpdateSha] = useState<string | null>(
    loadDismissedUpdateSha
  );
  const [catalogIndexing, setCatalogIndexing] = useState(false);

  useEffect(() => {
    api
      .storageStats()
      .then(setStorage)
      .catch(() => undefined);
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  const catalogStatusQuery = useChannelCatalogStatus({ interval: 5000 });
  const catalogStatus = dataOrNull(catalogStatusQuery);
  const refreshCatalogStatus = () => {
    void catalogStatusQuery.refetch();
  };
  const metadataSyncStatus =
    useMetadataSyncStatus({ interval: 5000 }).data ?? null;
  const systemActivity = dataOrNull(useSystemActivity({ interval: 2000 }));

  const refreshUpdates = useCallback((refresh = false) => {
    setUpdateChecking(true);
    return api
      .checkUpdates(refresh)
      .then(setUpdateCheck)
      .catch(() => setUpdateCheck(null))
      .finally(() => setUpdateChecking(false));
  }, []);

  useEffect(() => {
    void refreshUpdates(false);
  }, [refreshUpdates]);

  const showUpdateNotice = Boolean(
    updateCheck?.update_available &&
    updateCheck.latest_sha &&
    updateCheck.latest_sha !== dismissedUpdateSha &&
    (!q ||
      match("update", "version", "github", "git pull", "docker", "rebuild"))
  );

  return {
    storage,
    health,
    updateCheck,
    updateChecking,
    refreshUpdates,
    showUpdateNotice,
    setDismissedUpdateSha,
    catalogStatus,
    catalogIndexing,
    setCatalogIndexing,
    refreshCatalogStatus,
    systemActivity,
    metadataSyncStatus,
  };
}
