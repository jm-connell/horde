import { useHelpChat } from "../context/HelpChatContext";
import { HELP_PANEL_ID } from "./helpChat";

function ChatIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

/**
 * Ask in the top bar, left of the search box: a square icon button the
 * search box's height, or an icon beside the search icon under the hamburger. Opens the panel,
 * unfolds it when minimized, or closes it.
 */
export default function NavAskButton({
  compact,
  className = "",
}: {
  compact: boolean;
  className?: string;
}) {
  const help = useHelpChat();
  if (!help.available) return null;
  const common = {
    type: "button" as const,
    onClick: () => help.toggleOpen(),
    "aria-expanded": help.open,
    "aria-controls": help.open ? HELP_PANEL_ID : undefined,
    "data-horde": "nav-ask",
  };
  if (compact)
    return (
      <button {...common} aria-label="Ask" title="Ask" className={className}>
        <ChatIcon className="h-5 w-5" />
      </button>
    );
  return (
    <button
      {...common}
      aria-label="Ask"
      title="Ask"
      className={`ui-panel ui-interactive mr-1.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center self-center rounded-lg border bg-ink-900 transition-colors ${
        help.open
          ? "border-accent/60 text-accent"
          : "border-ink-700 text-gray-300 hover:border-accent hover:text-accent"
      } ${className}`}
    >
      <ChatIcon className="h-4 w-4" />
    </button>
  );
}
