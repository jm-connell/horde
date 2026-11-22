import { useId, useRef, useState, type RefObject } from "react";
import { UI_MENU_SURFACE } from "../uiMenu";
import { CloseIcon, HistoryIcon } from "./icons";
import YoutubeSearchChip from "./YoutubeSearchChip";

/**
 * The top bar's search box. While it is focused and empty, the account's
 * recent searches open under it: about four rows, scrolling for more, each
 * one to run again or take off the list.
 */
export default function NavSearchField({
  inputRef,
  className,
  dataHorde,
  value,
  history,
  onInput,
  onSubmit,
  onPick,
  onRemove,
  onEscape,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  className: string;
  dataHorde?: string;
  value: string;
  /** Newest first. */
  history: readonly string[];
  onInput: (value: string) => void;
  /** Enter in the box. */
  onSubmit: () => void;
  /** A recent search was chosen. */
  onPick: (query: string) => void;
  onRemove: (query: string) => void;
  /** Escape in the box (the narrow layout closes the box on its own). */
  onEscape?: (input: HTMLInputElement) => void;
}) {
  const headingId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [focused, setFocused] = useState(false);
  const open = focused && value.trim() === "" && history.length > 0;

  /** The i-th recent search's button; below 0, the box. */
  const focusEntry = (i: number) => {
    if (i < 0) {
      inputRef.current?.focus();
      return;
    }
    const entries =
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-search-entry]"
      ) ?? [];
    entries[Math.min(i, entries.length - 1)]?.focus();
  };

  return (
    <div
      data-horde={dataHorde}
      className={className}
      onFocus={() => setFocused(true)}
      // Open while focus is anywhere in here: the box or the list under it.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "ArrowDown" && open) {
            e.preventDefault();
            focusEntry(0);
          } else if (e.key === "Escape") {
            onEscape?.(e.currentTarget);
          }
        }}
        placeholder="Search"
        enterKeyHint="search"
        aria-label="Search library"
        className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-900 py-1.5 pl-3 pr-8 text-sm text-gray-100 placeholder-muted outline-hidden focus:border-accent"
      />
      <YoutubeSearchChip />
      {open && (
        <div
          data-horde="search-history"
          // Not a control: it only keeps focus (and the phone's keyboard) in
          // the box when the list is clicked. The buttons in it do the work.
          role="presentation"
          onMouseDown={(e) => e.preventDefault()}
          className={`${UI_MENU_SURFACE} absolute right-0 top-full z-50 mt-1.5 w-full min-w-64 overflow-hidden py-1`}
        >
          <p
            id={headingId}
            className="px-3 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted"
          >
            Recent searches
          </p>
          <ul
            ref={listRef}
            aria-labelledby={headingId}
            // Four rows of h-9; the rest scroll.
            className="horde-scrollbar max-h-36 overflow-y-auto"
          >
            {history.map((query, i) => (
              <li key={query} className="flex h-9 items-center">
                <button
                  type="button"
                  data-search-entry
                  onClick={() => onPick(query)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      focusEntry(i + 1);
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      focusEntry(i - 1);
                    } else if (e.key === "Escape") {
                      focusEntry(-1);
                    }
                  }}
                  className="ui-interactive flex h-full min-w-0 flex-1 items-center gap-2.5 px-3 text-left text-sm text-gray-200 outline-hidden hover:bg-ink-800 focus-visible:bg-ink-800 focus-visible:text-accent"
                >
                  <HistoryIcon className="shrink-0 text-muted" />
                  <span className="truncate">{query}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Back to the box first: the button is about to go.
                    focusEntry(-1);
                    onRemove(query);
                  }}
                  aria-label={`Remove “${query}” from recent searches`}
                  title="Remove from recent searches"
                  className="ui-interactive flex h-full w-9 shrink-0 items-center justify-center text-muted outline-hidden hover:text-gray-100 focus-visible:bg-ink-800 focus-visible:text-accent"
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
