import type { ReactNode } from "react";

/** Smooth height expand/collapse using CSS grid 0fr → 1fr. */
export default function Collapse({
  open,
  children,
  className = "",
  durationClass = "duration-300",
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  durationClass?: string;
}) {
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] ${durationClass} ease-[cubic-bezier(0.22,1,0.36,1)] ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      } ${className}`}
    >
      <div className="min-h-0 overflow-hidden" {...(!open ? { inert: true } : {})}>
        {children}
      </div>
    </div>
  );
}
