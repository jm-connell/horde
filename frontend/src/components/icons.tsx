/**
 * Small inline icons that replace text glyphs (✕ ▼ ✓ ⠿ ▶ ❚❚). Text glyphs
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
