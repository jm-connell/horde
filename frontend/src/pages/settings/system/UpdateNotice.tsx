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
  } = system;

  return (
    <>
      {showUpdateNotice && updateCheck && (
        <div className="mb-6 rounded-lg border border-ink-700 bg-ink-950/60 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-gray-200">
                A newer version is available
                {updateCheck.current_short && updateCheck.latest_short ? (
                  <span className="text-muted">
                    {" "}
                    (
                    <span className="font-mono">
                      {updateCheck.current_short}
                    </span>
                    {" → "}
                    <span className="font-mono">
                      {updateCheck.latest_short}
                    </span>
                    )
                  </span>
                ) : null}
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted hover:text-gray-400">
                  How to update
                </summary>
                <div className="mt-2 space-y-2 text-xs text-gray-400">
                  <p>
                    On the TrueNAS shell (not Dockge Bash), go to your stack
                    folder and run:
                  </p>
                  <pre className="overflow-x-auto rounded bg-ink-900/80 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
                    {`cd /mnt/tank/dockge/stacks/horde   # adjust to your path
      bash update.sh`}
                  </pre>
                  <p>
                    Use <span className="font-mono">bash update.sh</span> so you
                    do not need <span className="font-mono">chmod +x</span>.
                    Then hard-refresh the browser (
                    <kbd className="font-mono">Ctrl+Shift+R</kbd>
                    ). Library data stays on host volumes.
                  </p>
                  {safeHref(updateCheck.latest_html_url) && (
                    <a
                      href={safeHref(updateCheck.latest_html_url)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block text-accent underline underline-offset-2"
                    >
                      View latest commit on GitHub
                    </a>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted hover:text-gray-400">
                      Advanced: manual commands
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-ink-900/80 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
                      {`git pull
      sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose build horde
      sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose up -d`}
                    </pre>
                  </details>
                </div>
              </details>
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
      )}
    </>
  );
}
