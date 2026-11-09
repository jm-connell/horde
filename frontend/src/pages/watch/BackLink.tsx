import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowIcon } from "../../components/icons";

/** React Router records each entry's position in the session history. */
function canGoBack(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx > 0;
}

/**
 * "Back" on the watch page: to wherever the video was opened from (home,
 * Recommended, a channel, search), or home when it was opened directly.
 */
export default function BackLink({ className }: { className: string }) {
  const navigate = useNavigate();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (!canGoBack()) return;
    e.preventDefault();
    navigate(-1);
  };
  return (
    <Link to="/" onClick={onClick} className={className}>
      <ArrowIcon />
      Back
    </Link>
  );
}
