import { useEffect } from "react";
import LoadingIndicator from "../../../components/LoadingIndicator";
import { swUpdates } from "../../../offline/register";
import { formatRelative, safeHref } from "../../../utils";
import { PANEL_BTN } from "../constants";
import { useSettingsPage } from "../context";
import { Section } from "../ui";
import type { SystemState } from "../useSystemState";
import type { UpdateTone } from "./updateView";

const TONE_CLASS: Record<UpdateTone, string> = {
  progress: "text-gray-200",
  success: "text-emerald-400",
  warning: "text-amber-400",
  error: "text-red-400",
  muted: "text-muted",
};

const PRIMARY_BTN =
  "ui-interactive rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

const SHELL_PATH = "/mnt/tank/dockge/stacks/horde";

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-sm bg-ink-900/80 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
      {children}
    </pre>
  );
}

export function UpdateSetupHelp() {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        One-click updates aren’t set up on this server yet. An administrator
        sets this up once on the server; after that anyone with admin access can
        update from here.
      </p>
      <details>
        <summary className="cursor-pointer text-xs text-muted hover:text-gray-400">
          How to set it up
        </summary>
        <div className="mt-2 space-y-2 text-xs text-gray-400">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Open the TrueNAS shell (System → Shell) or SSH to the Docker host.
              Not Dockge&apos;s Bash button: that shell is inside the container.
            </li>
            <li>
              Run this, replacing the folder with the one you cloned Horde into.
              It checks the connection and prints the exact command to use:
              <Code>{`sudo bash ${SHELL_PATH}/scripts/update_watch.sh --setup`}</Code>
            </li>
            <li>
              In TrueNAS go to System → Advanced Settings → Cron Jobs → Add.
              Description:{" "}
              <span className="font-mono">Horde update button</span>. Command:{" "}
              <span className="font-mono">
                bash {SHELL_PATH}/scripts/update_watch.sh
              </span>
              . Run As User: <span className="font-mono">root</span>. Schedule:
              Custom, every minute (<span className="font-mono">* * * * *</span>
              ). Leave “Hide Standard Output” checked and save.
              <br />
              Not on TrueNAS? Run{" "}
              <span className="font-mono">sudo crontab -e</span> and add this
              line instead:
              <Code>{`* * * * * bash ${SHELL_PATH}/scripts/update_watch.sh`}</Code>
            </li>
            <li>Within a minute this page shows the Update now button.</li>
          </ol>
          <details>
            <summary className="cursor-pointer text-xs text-muted hover:text-gray-400">
              Update from the shell instead
            </summary>
            <div className="mt-2">
              <Code>{`cd ${SHELL_PATH}   # adjust to your path
bash update.sh`}</Code>
            </div>
          </details>
        </div>
      </details>
    </div>
  );
}

export default function UpdatesSection({ system }: { system: SystemState }) {
  const { match } = useSettingsPage();
  const { health, updateCheck, updateChecking, refreshUpdates, updateRun } =
    system;
  const { control, view, connected, unreachable, updatedHere } = updateRun;
  const available = Boolean(updateCheck?.update_available);
  const showReload = updatedHere && control?.state === "updated";

  // The page's bundle is from the old version: reload once the update landed
  // (through the service worker, whose cached shell is the old release too).
  useEffect(() => {
    if (!showReload) return;
    const t = window.setTimeout(() => swUpdates.reloadToLatest(), 2000);
    return () => window.clearTimeout(t);
  }, [showReload]);

  const latest = updateCheck?.latest_version || updateCheck?.latest_short;
  const latestHref = available ? safeHref(updateCheck?.latest_html_url) : null;
  const when = control?.finished_at ? formatRelative(control.finished_at) : "";

  return (
    <Section
      first
      title="Updates"
      hidden={
        !view.busy &&
        !match(
          "updates",
          "update",
          "upgrade",
          "version",
          "cron",
          "truenas",
          "release",
          "github"
        )
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-gray-400">Version</span>
          <span className="font-mono text-gray-200">
            {health?.horde_version ?? "unknown"}
          </span>
          {updateCheck && !updateCheck.error ? (
            <span className={available ? "text-accent" : "text-muted"}>
              {available
                ? `Update available${latest ? `: ${latest}` : ""}`
                : "Up to date"}
            </span>
          ) : null}
          {latestHref && (
            <a
              href={latestHref}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-accent underline underline-offset-2"
            >
              {updateCheck?.latest_version ? "Release notes" : "What changed"}
            </a>
          )}
          <button
            type="button"
            disabled={updateChecking}
            onClick={() => void refreshUpdates(true)}
            className="text-xs text-muted hover:text-gray-300 disabled:opacity-50"
          >
            {updateChecking ? "Checking…" : "Check for updates"}
          </button>
        </div>

        {(connected || view.canCancel) && (
          <div className="flex flex-wrap items-center gap-2">
            {connected && (
              <button
                type="button"
                disabled={view.busy}
                onClick={() => void updateRun.start(available)}
                className={available ? PRIMARY_BTN : PANEL_BTN}
              >
                {available ? "Update now" : "Run update"}
              </button>
            )}
            {/* Also offered when the host job stopped checking in, so a
                request it will never pick up can be withdrawn. */}
            {view.canCancel && (
              <button
                type="button"
                onClick={() => void updateRun.cancel()}
                className={PANEL_BTN}
              >
                Cancel
              </button>
            )}
          </div>
        )}
        {!connected && control ? <UpdateSetupHelp /> : null}

        {view.message && (
          <div role="status" aria-live="polite" className="space-y-2">
            {view.tone === "progress" && (
              <LoadingIndicator
                label={view.message}
                labelVisible
                className="items-start justify-start py-1"
              />
            )}
            {view.tone !== "progress" && view.tone && (
              <p className={`text-sm ${TONE_CLASS[view.tone]}`}>
                {view.message}
                {when ? <span className="text-muted"> ({when})</span> : null}
              </p>
            )}
            {showReload && (
              <button
                type="button"
                onClick={() => swUpdates.reloadToLatest()}
                className={PANEL_BTN}
              >
                Reload page
              </button>
            )}
          </div>
        )}

        {view.showLog && control && !unreachable && (
          <details>
            <summary className="cursor-pointer text-xs text-muted hover:text-gray-400">
              Show details
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-sm bg-ink-900/80 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
              {(control.log_tail ?? []).join("\n")}
            </pre>
          </details>
        )}

        {health?.wiki_available && (
          <p className="text-xs text-muted">
            <a
              href="/wiki/getting-started/updating/"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-2"
            >
              Updating guide
            </a>
          </p>
        )}
      </div>
    </Section>
  );
}
