import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import {
  dataOrNull,
  useChannelCatalogStatus,
  useMetadataSyncStatus,
  useStorageStats,
  useSystemActivity,
} from "../../queries/status";
import type { HealthStats, UpdateCheck } from "../../types";
import { useUpdateRun } from "./system/useUpdateRun";

/** State and polling of the System tab: versions, storage, catalog and job activity. */
export function useSystemState() {
  const storage = useStorageStats().data ?? null;
  const [health, setHealth] = useState<HealthStats | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [catalogIndexing, setCatalogIndexing] = useState(false);
  const updateRun = useUpdateRun();

  useEffect(() => {
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

  return {
    storage,
    health,
    updateCheck,
    updateChecking,
    refreshUpdates,
    updateRun,
    catalogStatus,
    catalogIndexing,
    setCatalogIndexing,
    refreshCatalogStatus,
    systemActivity,
    metadataSyncStatus,
  };
}

export type SystemState = ReturnType<typeof useSystemState>;
