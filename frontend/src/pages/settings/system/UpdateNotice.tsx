import { saveDismissedUpdateSha } from "../helpers";
import { safeHref } from "../../../utils";
import type { SystemState } from "../useSystemState";

export default function UpdateNotice({ system }: { system: SystemState }) {
  const {
    updateCheck,
    updateChecking,
    refreshUpdates,
    showUpdateNotice,
    setDismissedUpdateSha,
    updateRun,
  } = system;

  if (!showUpdateNotice || !updateCheck) return null;
  const href = safeHref(updateCheck.latest_html_url);
  const hasVersion = Boolean(updateCheck.latest_version);

  return (
    <div className="mb-6 rounded-lg border border-ink-700 bg-ink-950/60 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-gray-200">
            A newer version is available
            {updateCheck.latest_version ? (
              <span className="text-muted">
                {" "}
                (<span className="font-mono">{updateCheck.latest_version}</span>
                )
              </span>
            ) : updateCheck.current_short && updateCheck.latest_short ? (
              <span className="text-muted">
                {" "}
                (<span className="font-mono">{updateCheck.current_short}</span>
                {" → "}
                <span className="font-mono">{updateCheck.latest_short}</span>)
              </span>
            ) : null}
          </p>
          {updateRun.connected ? (
            <button
              type="button"
              disabled={updateRun.view.busy}
              onClick={() => void updateRun.start(true)}
              className="ui-interactive rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {updateRun.view.busy ? "Updating…" : "Update now"}
            </button>
          ) : (
            <p className="text-xs text-muted">
              To install it, see “Updates” below for how to turn on the Update
              now button, or run{" "}
              <span className="font-mono">bash update.sh</span> on the server.
            </p>
          )}
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="block text-xs text-accent underline underline-offset-2"
            >
              {hasVersion
                ? "View release notes"
                : "View latest commit on GitHub"}
            </a>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={updateChecking}
            onClick={() => void refreshUpdates(true)}
            className="text-xs text-muted hover:text-gray-300 disabled:opacity-50"
          >
            {updateChecking ? "Checking…" : "Check again"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!updateCheck.latest_sha) return;
              saveDismissedUpdateSha(updateCheck.latest_sha);
              setDismissedUpdateSha(updateCheck.latest_sha);
            }}
            className="text-xs text-muted hover:text-gray-300"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
