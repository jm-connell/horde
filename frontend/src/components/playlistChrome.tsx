import type { DragEvent } from "react";

export function ExpandChevron({ open }: { open: boolean }) {
  return (
    <span
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-500 transition-[transform,color,background-color] duration-200 ease-out group-hover:bg-ink-800 group-hover:text-gray-300 ${
        open ? "rotate-90 text-gray-300" : ""
      }`}
      aria-hidden
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
        <path
          d="M7.25 4.75 12.5 10 7.25 15.25"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function CoverEditIcon({ active }: { active?: boolean }) {
  return (
    <span
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
        active
          ? "bg-ink-800 text-accent"
          : "text-gray-500 hover:bg-ink-800 hover:text-gray-300"
      }`}
      aria-hidden
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
        <path
          d="M12.6 4.35 15.65 7.4M4 16l.85-3.35 7.7-7.7a1.15 1.15 0 0 1 1.63 0l1.22 1.22a1.15 1.15 0 0 1 0 1.63l-7.7 7.7L4 16Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function DragHandle({
  label,
  onDragStart,
  onDragEnd,
}: {
  label: string;
  onDragStart: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnd?: () => void;
}) {
  return (
    <span
      draggable
      role="button"
      tabIndex={0}
      title={label}
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="inline-flex shrink-0 cursor-grab items-center justify-center self-stretch px-1.5 text-gray-600 hover:text-gray-400 active:cursor-grabbing"
    >
      <svg
        width="10"
        height="16"
        viewBox="0 0 10 16"
        aria-hidden
        className="fill-current"
      >
        <circle cx="3" cy="3" r="1.15" />
        <circle cx="7" cy="3" r="1.15" />
        <circle cx="3" cy="8" r="1.15" />
        <circle cx="7" cy="8" r="1.15" />
        <circle cx="3" cy="13" r="1.15" />
        <circle cx="7" cy="13" r="1.15" />
      </svg>
    </span>
  );
}

export function PlaylistThumb({
  src,
  className = "",
}: {
  src: string | null;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-md bg-ink-800 ${className}`}
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-ink-600">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
            <path d="M8 12.5h8M10 9.5h4" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

export function beginReorderDrag(
  event: DragEvent,
  payload: string,
  image?: HTMLElement | null
) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", payload);
  if (image) {
    event.dataTransfer.setDragImage(image, 28, 20);
  }
}
