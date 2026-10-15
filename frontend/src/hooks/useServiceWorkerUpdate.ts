import { useEffect } from "react";
import { useToast } from "../context/ToastContext";
import { swUpdates } from "../offline/register";

/** Shows a persistent "Update available" toast while a new release is waiting. */
export function useServiceWorkerUpdate(): void {
  const { showToast, dismissToast } = useToast();
  useEffect(() => {
    let toastId: number | null = null;
    const unsubscribe = swUpdates.subscribe((ready) => {
      if (ready && toastId === null) {
        toastId = showToast("Update available", {
          key: "sw-update",
          persistent: true,
          action: { label: "Reload", onClick: () => swUpdates.applyUpdate() },
        });
      } else if (!ready && toastId !== null) {
        dismissToast(toastId);
        toastId = null;
      }
    });
    return unsubscribe;
  }, [showToast, dismissToast]);
}
