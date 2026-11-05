import { Fragment, useEffect, useRef, useState } from "react";
import type { AskScopeChannel } from "./helpChat";
import { CheckIcon, ChevronIcon } from "./icons";
import { MenuFlyout, MenuScroll } from "./MenuFlyout";

/**
 * What Ask answers from: "auto" (Horde, or the channel a question names or
 * the page is about), Horde only, or one channel.
 */
export type AskSource = "auto" | "horde" | AskScopeChannel;

const ITEM =
  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs hover:bg-ink-800";

/**
 * "Answering from …" above Ask's question box: where the next answer comes
 * from, with a menu to pick another. The menu opens inside the panel, above
 * the row, so it moves with the panel and never leaves the screen.
 */
export default function AskSourcePicker({
  label,
  hint,
  autoDetail,
  channels,
  selected,
  disabled,
  onPick,
}: {
  /** Where the next question goes, e.g. "Horde" or "Northwind or Horde". */
  label: string;
  /** Shown beside it when Ask picks per question on a channel's page. */
  hint?: string;
  /** What Automatic does here (it depends on the page). */
  autoDetail: string;
  /** The channels Ask can answer from. */
  channels: AskScopeChannel[];
  /** The checked item: a channel id, "auto", "horde", or null (several channels). */
  selected: "auto" | "horde" | number | null;
  disabled: boolean;
  onPick: (source: AskSource) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (source: AskSource) => {
    setOpen(false);
    onPick(source);
  };
  const item = (
    checked: boolean,
    text: string,
    onClick: () => void,
    detail?: string
  ) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className={ITEM}
    >
      <span className="min-w-0">
        <span
          className={`block truncate ${checked ? "font-semibold text-accent" : "text-gray-200"}`}
        >
          {text}
        </span>
        {detail && <span className="block text-muted">{detail}</span>}
      </span>
      {checked && <CheckIcon className="shrink-0 text-accent" />}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className="border-t border-ink-700 px-3 pt-2 text-xs"
      data-horde="ask-source"
    >
      <MenuFlyout
        open={open}
        className="mb-2"
        menu={{
          label: "Answer from",
          onClose: () => setOpen(false),
          triggerRef,
        }}
      >
        <MenuScroll className="max-h-56" revision={channels.length}>
          {item(
            selected === "auto",
            "Automatic",
            () => pick("auto"),
            autoDetail
          )}
          {item(
            selected === "horde",
            "Horde",
            () => pick("horde"),
            "Only Horde: using it, its settings and your library"
          )}
          {channels.length > 0 && (
            <p
              aria-hidden="true"
              className="border-t border-ink-700 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted"
            >
              Channels
            </p>
          )}
          {channels.map((c) => (
            <Fragment key={c.id}>
              {item(selected === c.id, c.name || "Unnamed channel", () =>
                pick(c)
              )}
            </Fragment>
          ))}
        </MenuScroll>
      </MenuFlyout>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted">Answering from</span>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Answering from ${label}`}
          className="ui-interactive inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-ink-800 px-2 py-0.5 text-gray-300 hover:text-accent disabled:opacity-40"
        >
          <span className="truncate">{label}</span>
          <span
            className={`shrink-0 text-[10px] leading-none transition-transform ${open ? "rotate-180" : ""}`}
          >
            <ChevronIcon />
          </span>
        </button>
        {hint && <span className="text-muted">{hint}</span>}
      </div>
    </div>
  );
}
