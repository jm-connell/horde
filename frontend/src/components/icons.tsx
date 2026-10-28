/**
 * Small inline icons that replace text glyphs (✕ ▼ ✓ ⠿ ▶ ❚❚ ← ↗ ••• ⤢ ↩). Text glyphs
 * change shape and weight with the user's font choice; these do not. They
 * size to the surrounding text (1em) and take its color, so they drop in
 * where the glyph was. All are decorative (aria-hidden): the button or label
 * around them carries the name.
 */

const base = "inline-block h-[1em] w-[1em] shrink-0";

function cx(className: string): string {
  return className ? `${base} ${className}` : base;
}

/** ✕: close, remove, dismiss. */
export function CloseIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** ▼ pointing down; rotate it for other directions (-rotate-90 = ▶). */
export function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** ✓: done, selected. */
export function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** ⠿: drag handle. */
export function GripIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="currentColor"
      aria-hidden
    >
      <circle cx="6" cy="4" r="1.25" />
      <circle cx="10" cy="4" r="1.25" />
      <circle cx="6" cy="8" r="1.25" />
      <circle cx="10" cy="8" r="1.25" />
      <circle cx="6" cy="12" r="1.25" />
      <circle cx="10" cy="12" r="1.25" />
    </svg>
  );
}

/** ▶ / ►: play. */
export function PlayIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="currentColor"
      aria-hidden
    >
      <path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1L5.92 2.7A.6.6 0 0 0 5 3.2z" />
    </svg>
  );
}

/** ❚❚: pause. */
export function PauseIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="currentColor"
      aria-hidden
    >
      <rect x="4" y="3" width="2.75" height="10" rx="0.75" />
      <rect x="9.25" y="3" width="2.75" height="10" rx="0.75" />
    </svg>
  );
}

/** ← pointing left; rotate it for other directions (rotate-180 = →, rotate-90 = ↑). */
export function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13 8H3.5M7.5 4L3.5 8l4 4" />
    </svg>
  );
}

/** ↗: opens in a new tab or another site. */
export function ExternalIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 4h6v6M12 4l-7.5 7.5" />
    </svg>
  );
}

/** •••: more actions. */
export function MoreIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="currentColor"
      aria-hidden
    >
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

/** ⟳ for random order: shuffle again. */
export function ShuffleIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4.5h2.5c1.5 0 2.4.7 3.2 2l1.6 3c.8 1.3 1.7 2 3.2 2H14M2 11.5h2.5c1 0 1.8-.3 2.4-.9M9.1 5.4c.6-.6 1.4-.9 2.4-.9H14M12 2.5l2 2-2 2M12 9.5l2 2-2 2" />
    </svg>
  );
}

/** ⤢: expand to the full player. */
export function ExpandIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />
    </svg>
  );
}

/** ↩: go back to the list. */
export function UndoIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7" />
    </svg>
  );
}
