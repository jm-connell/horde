import { useEffect } from "react";
import { useToast } from "../context/ToastContext";
import {
  OFFLINE_QUOTA_EVENT,
  quotaMessage,
  type OfflineQuotaDetail,
} from "../offline/quota";

/** Surfaces "storage full" failures from background offline downloads. */
export function useOfflineQuotaToast(): void {
  const { showError } = useToast();
  useEffect(() => {
    const onQuota = (e: Event) => {
      const { title, freeBytes } = (e as CustomEvent<OfflineQuotaDetail>)
        .detail;
      showError(quotaMessage(title, freeBytes), { key: "offline-quota" });
    };
    window.addEventListener(OFFLINE_QUOTA_EVENT, onQuota);
    return () => window.removeEventListener(OFFLINE_QUOTA_EVENT, onQuota);
  }, [showError]);
}
