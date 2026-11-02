import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { DiscoverItem } from "../../types";
import { backdropClick } from "../../utils";
import { button } from "../buttons";
import { DIALOG_BACKDROP_ENTER, DIALOG_PANEL_ENTER } from "../dialogMotion";
import { BUCKET_LABEL } from "./buckets";

function signed(value: number): string {
  const v = Math.round(value * 100) / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
}

/**
 * Why Recommended+ placed one video: the kind of pick it is, where it was
 * found, and every part of its score, with a way to open the algorithm.
 */
export default function WhyDialog({
  item,
  onClose,
  onOpenAlgorithm,
}: {
  item: DiscoverItem;
  onClose: () => void;
  onOpenAlgorithm: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, { onEscape: onClose });
  const why = item.why;
  const title = item.video?.title ?? item.stream?.title ?? "This video";
  const parts = why?.parts ?? [];
  const biggest = Math.max(0.01, ...parts.map((p) => Math.abs(p.value)));

  return createPortal(
    <div
      className={`fixed inset-0 z-80 flex items-center justify-center bg-black/60 p-4 ${DIALOG_BACKDROP_ENTER}`}
      role="presentation"
      onClick={backdropClick(onClose)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-horde="why-dialog"
        className={`ui-panel ui-panel-legible max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-ink-900 p-5 shadow-xl outline-hidden ring-1 ring-ink-600 ${DIALOG_PANEL_ENTER}`}
      >
        <h2 id={titleId} className="text-base font-semibold text-gray-100">
          Why this video?
        </h2>
        <p className="mt-1 line-clamp-2 text-sm text-gray-300">{title}</p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Reason</dt>
            <dd className="text-right text-gray-200">
              {item.reason.detail ?? item.reason.text}
            </dd>
          </div>
          {why && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Kind of pick</dt>
              <dd className="text-right text-gray-200">
                {BUCKET_LABEL[why.bucket] ?? why.bucket}
              </dd>
            </div>
          )}
          {why?.found_by && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Found in</dt>
              <dd className="min-w-0 truncate text-right text-gray-200">
                {why.found_by}
              </dd>
            </div>
          )}
        </dl>
        {why && parts.length > 0 && (
          <>
            <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              Score
            </h3>
            <ul className="mt-2 space-y-1.5">
              {parts.map((p) => (
                <li key={p.label} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-300">{p.label}</span>
                    <span
                      className={`shrink-0 tabular-nums ${p.value < 0 ? "text-warning" : "text-gray-200"}`}
                    >
                      {signed(p.value)}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1 w-full rounded-full bg-ink-800">
                    <div
                      className={`h-1 rounded-full ${p.value < 0 ? "bg-warning/60" : "bg-accent/70"}`}
                      style={{
                        width: `${Math.round((Math.abs(p.value) / biggest) * 100)}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-between border-t border-ink-700 pt-2 text-sm">
              <span className="text-gray-300">Total</span>
              <span className="tabular-nums font-semibold text-gray-100">
                {signed(why.score)}
              </span>
            </div>
            {!why.eligible && (
              <p className="mt-2 text-xs text-muted">
                Not a close match for its kind, so it waits near the end of the
                feed.
              </p>
            )}
          </>
        )}
        {!why && (
          <p className="mt-4 text-sm text-muted">
            Live broadcasts from your channels always lead the feed.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onOpenAlgorithm}
            className={button("secondary", "sm")}
          >
            Open algorithm
          </button>
          <button
            type="button"
            onClick={onClose}
            className={button("primary", "sm")}
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
