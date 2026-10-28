import { useState } from "react";
import { bookmarkletHref } from "../shareTarget";
import Collapse from "./Collapse";
import { ChevronIcon } from "./icons";

/**
 * Unobtrusive help below the download form: how to send a link to Horde from
 * another browser tab or app. The share sheet works once Horde is installed
 * (Android); everything else uses the bookmarklet, which opens
 * `/download?url=<current page>` in a new tab.
 */
export default function SendLinksHelp() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const href = bookmarkletHref(window.location.origin);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied("yes");
    } catch {
      // Insecure (plain http) pages have no clipboard API: the field below
      // is selectable so the user can copy it by hand.
      setCopied("failed");
    }
  };

  return (
    <section className="mt-4 text-sm" aria-label="Send links from your browser">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="send-links-help"
        className="ui-interactive flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-gray-400 hover:text-gray-200"
      >
        <ChevronIcon
          className={`transition-transform duration-200 ease-fluid ${open ? "" : "-rotate-90"}`}
        />
        Send links from your browser
      </button>
      <Collapse open={open}>
        <div
          id="send-links-help"
          className="ui-panel space-y-3 rounded-xl bg-ink-900 p-4 text-xs leading-relaxed text-gray-400 ring-1 ring-ink-700"
        >
          <p>
            On a computer, drag this link to your bookmarks bar. Click it on any
            video page to open that page here, ready to download.
          </p>
          <p>
            {/* eslint-disable-next-line jsx-a11y/anchor-is-valid -- React refuses a javascript: href in JSX, so it is set on the element through the ref */}
            <a
              ref={(el) => el?.setAttribute("href", href)}
              draggable
              className="inline-block cursor-grab rounded-lg bg-accent/15 px-3 py-1.5 font-medium text-accent ring-1 ring-accent/40"
            >
              Send to Horde
            </a>
          </p>
          <p>
            On a phone, copy the bookmarklet, save any bookmark, and paste it
            into that bookmark’s address.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="ui-interactive rounded-lg bg-ink-800 px-3 py-1.5 font-medium text-gray-200 hover:bg-ink-700"
            >
              Copy bookmarklet
            </button>
            {copied === "yes" && <span role="status">Copied.</span>}
            {copied === "failed" && (
              <span role="status">
                Couldn’t copy here (needs HTTPS). Select the text below.
              </span>
            )}
          </div>
          {copied === "failed" && (
            <input
              readOnly
              aria-label="Bookmarklet code"
              value={href}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 font-mono text-xs text-gray-300"
            />
          )}
          <p>
            Installed Horde on Android? It also appears in the share sheet. See
            the downloads guide for the iPhone Shortcut.
          </p>
        </div>
      </Collapse>
    </section>
  );
}
