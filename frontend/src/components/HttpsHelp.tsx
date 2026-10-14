import { useState } from "react";

/**
 * Plain-language explanation of why offline features need HTTPS, with setup
 * pointers. Shown on the Offline page, when tapping Download over plain
 * http, and once as a dismissible notice on Home.
 */

export const HTTPS_DOCS_URL = "/wiki/guides/offline/#https";

/** False on plain http (LAN IP, Tailscale IP); localhost counts as secure. */
export function isSecure(): boolean {
  return typeof window === "undefined" || window.isSecureContext !== false;
}

export default function HttpsHelp({ compact = false }: { compact?: boolean }) {
  if (isSecure()) {
    // Secure page but storage still unavailable (e.g. private browsing).
    return (
      <div className="space-y-2 text-sm text-gray-300">
        <p>
          This browser isn&apos;t letting Horde store videos on the device.
          Private / incognito windows usually block it — try a normal window,
          or install Horde to your home screen.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm text-gray-300">
      <p>
        Downloading videos into the app and opening it instantly without a
        connection rely on a browser feature (a <em>service worker</em> — a
        small helper the browser keeps on your device to load the app and your
        downloads without the server). Browsers only allow it on secure{" "}
        <strong>https://</strong> addresses.
      </p>
      <p>
        You&apos;re using <code className="text-gray-100">{window.location.origin}</code>,
        which is plain http, so these features are off. Everything else works
        normally.
      </p>
      {!compact && (
        <>
          <p className="font-medium text-gray-200">To turn them on, reach Horde over HTTPS:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Tailscale</strong> (easiest): enable HTTPS certificates
              in the Tailscale admin console, run{" "}
              <code className="text-gray-100">tailscale serve --bg 8686</code>{" "}
              on the Horde host, then open{" "}
              <code className="text-gray-100">https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net</code>.
            </li>
            <li>
              <strong>Reverse proxy</strong> with a certificate (Caddy, Nginx
              Proxy Manager, Traefik) in front of Horde.
            </li>
          </ul>
        </>
      )}
      <p>
        <a
          href={HTTPS_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          Step-by-step setup guide ↗
        </a>
      </p>
    </div>
  );
}

const NOTICE_KEY = "horde:httpsNoticeDismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

/** One-time Home notice when Horde is opened over plain http. */
export function HttpsNotice() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [expanded, setExpanded] = useState(false);
  if (dismissed || isSecure()) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(NOTICE_KEY, "1");
    } catch {
      // Blocked storage: the notice just comes back next visit.
    }
  };
  return (
    <div
      data-horde="https-notice"
      className="ui-panel mb-4 rounded-lg border border-amber-500/30 bg-ink-900 p-3 text-sm"
    >
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-gray-200">
          <strong>Offline videos &amp; the installable app are off</strong>{" "}
          because Horde is open over plain http. They need an https://
          address.{" "}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-accent hover:underline"
            aria-expanded={expanded}
          >
            {expanded ? "Hide details" : "Why, and how to fix"}
          </button>
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="ui-interactive shrink-0 rounded p-1 text-gray-400 hover:text-gray-100"
        >
          ✕
        </button>
      </div>
      {expanded && (
        <div className="mt-3">
          <HttpsHelp />
        </div>
      )}
    </div>
  );
}
