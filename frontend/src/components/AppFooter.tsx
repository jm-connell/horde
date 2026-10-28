import { useHelpChat } from "../context/HelpChatContext";
import { HELP_PANEL_ID } from "./helpChat";

const REPO_URL = "https://github.com/jm-connell/horde";

const LINK =
  "rounded-sm text-muted underline-offset-2 hover:text-accent hover:underline";

/** The quiet strip under every page: help, docs and where to report bugs. */
export default function AppFooter() {
  const help = useHelpChat();
  return (
    // No z-index: above the background (earlier, z-0) but below <main>'s
    // layer, which holds fixed bars such as the library's bulk actions.
    <footer
      data-horde="footer"
      className="relative mx-auto mt-auto flex w-full max-w-[1920px] flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-ink-800 px-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 text-xs md:px-6"
    >
      {help.available && (
        <button
          type="button"
          aria-expanded={help.open}
          aria-controls={help.open ? HELP_PANEL_ID : undefined}
          onClick={() => help.setOpen(!help.open)}
          className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 font-medium text-gray-200 hover:border-accent hover:text-accent"
        >
          Ask about Horde
        </button>
      )}
      <a href="/wiki/" target="_blank" rel="noreferrer" className={LINK}>
        Docs
      </a>
      <a
        href={`${REPO_URL}/issues/new`}
        target="_blank"
        rel="noreferrer"
        className={LINK}
      >
        Report a bug or idea
      </a>
      <a href={REPO_URL} target="_blank" rel="noreferrer" className={LINK}>
        Source on GitHub
      </a>
    </footer>
  );
}
