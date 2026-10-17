import { useCallback } from "react";
import { useConfirm } from "../../../context/ConfirmContext";
import { describeError } from "../../../apiErrors";
import { useUpdateControl } from "../../../queries/update";
import { useSettingsPage } from "../context";
import {
  describeUpdate,
  UPDATE_CONFIRM_AVAILABLE,
  UPDATE_CONFIRM_RUN,
} from "./updateView";

/** The "Update now" button: server state, view model, and confirmed actions. */
export function useUpdateRun() {
  const confirm = useConfirm();
  const { showError, showToast } = useSettingsPage();
  const { control, unreachable, updatedHere, request, cancel } =
    useUpdateControl();
  const view = describeUpdate(control, unreachable);

  const start = useCallback(
    async (updateAvailable: boolean) => {
      const ok = await confirm(
        updateAvailable ? UPDATE_CONFIRM_AVAILABLE : UPDATE_CONFIRM_RUN
      );
      if (!ok) return;
      try {
        await request();
      } catch (err) {
        showError(`Could not start the update: ${describeError(err)}`);
      }
    },
    [confirm, request, showError]
  );

  const cancelRequest = useCallback(async () => {
    try {
      await cancel();
      showToast("Update cancelled");
    } catch (err) {
      showError(`Could not cancel the update: ${describeError(err)}`);
    }
  }, [cancel, showError, showToast]);

  return {
    control,
    unreachable,
    updatedHere,
    view,
    connected: control?.watcher_connected ?? false,
    start,
    cancel: cancelRequest,
  };
}

export type UpdateRun = ReturnType<typeof useUpdateRun>;
