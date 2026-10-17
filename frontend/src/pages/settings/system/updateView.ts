import type { UpdateControl } from "../../../types";

export type UpdateTone = "progress" | "success" | "warning" | "error" | "muted";

export interface UpdateView {
  /** An update is waiting for or running on the host: block starting another. */
  busy: boolean;
  canCancel: boolean;
  message: string | null;
  tone: UpdateTone | null;
  /** Offer the update.sh output (collapsed). */
  showLog: boolean;
}

export const UPDATE_CONFIRM_AVAILABLE = {
  title: "Update Horde now?",
  body: "Horde will download the newest release, back up its database, and restart. It will be unavailable for a few minutes and downloads in progress will start again afterwards. If the new version doesn’t start properly, Horde automatically goes back to the current version. Your library and settings are not affected.",
  confirmLabel: "Update now",
};

export const UPDATE_CONFIRM_RUN = {
  title: "Run the update now?",
  body: "Horde will check for a newer release. If it is already up to date, nothing changes. Otherwise it downloads the release, backs up its database, and restarts, which takes a few minutes and restarts downloads in progress. If the new version doesn’t start properly, Horde automatically goes back to the current version. Your library and settings are not affected.",
  confirmLabel: "Run update",
};

/** Maps the server state (plus "server not answering") to what the UI shows. */
export function describeUpdate(
  c: UpdateControl | null,
  unreachable: boolean
): UpdateView {
  const none: UpdateView = {
    busy: false,
    canCancel: false,
    message: null,
    tone: null,
    showLog: false,
  };
  if (!c) return none;
  const hasLog = (c.log_tail?.length ?? 0) > 0;
  switch (c.state) {
    case "requested":
      return {
        busy: true,
        canCancel: !unreachable,
        message: unreachable
          ? "Horde is restarting… waiting for it to come back."
          : "Waiting for the server to start the update (usually within a minute)…",
        tone: "progress",
        showLog: false,
      };
    case "running":
      return {
        busy: true,
        canCancel: false,
        message: unreachable
          ? "Horde is restarting… waiting for it to come back."
          : "Updating… This takes a few minutes. Horde will restart; this page reconnects by itself.",
        tone: "progress",
        showLog: hasLog && !unreachable,
      };
    case "updated":
      return { ...none, message: "Updated successfully.", tone: "success" };
    case "up_to_date":
      return {
        ...none,
        message: "Horde was already up to date.",
        tone: "muted",
      };
    case "rolled_back":
      return {
        ...none,
        message:
          "The new version didn’t start properly, so Horde went back to the previous version. Your library and settings are kept. You can try again later; see details or the Updating guide in the wiki.",
        tone: "warning",
        showLog: hasLog,
      };
    case "failed":
      return {
        ...none,
        message:
          "The update didn’t finish. Usually nothing was changed and Horde is still on the previous version. See the details or the Updating guide in the wiki.",
        tone: "error",
        showLog: hasLog,
      };
    case "interrupted":
      return {
        ...none,
        message:
          "The last update was interrupted (the server may have restarted). Check that Horde works, then try again.",
        tone: "warning",
        showLog: hasLog,
      };
    default:
      return none;
  }
}
