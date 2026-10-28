import { Component, type ErrorInfo, type ReactNode } from "react";
import { getItem, setItem } from "../storage";
import { button } from "./buttons";

interface Props {
  children: ReactNode;
  /** When this value changes while an error is showing, the boundary resets. */
  resetKey?: string;
  /** Short label for logs, e.g. "route" or "app". */
  scope?: string;
  /** Fill the viewport (top-level) instead of sitting inside the page shell. */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
  componentStack: string;
}

/** True for a lazy chunk that could not be fetched (offline, or deployed over). */
function isChunkLoadError(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      error.message
    )
  );
}

const CHUNK_RELOAD_KEY = "horde.chunkReloadAt";
const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

/**
 * A lazy chunk that fails to load usually means a release replaced the files
 * this tab was built against: one hard reload fixes it. The timestamp (kept in
 * sessionStorage) stops a genuinely offline/broken chunk from reloading in a loop.
 */
function shouldAutoReload(): boolean {
  const last = Number(getItem(CHUNK_RELOAD_KEY, "session"));
  if (Number.isFinite(last) && Date.now() - last < CHUNK_RELOAD_COOLDOWN_MS) {
    return false;
  }
  return setItem(CHUNK_RELOAD_KEY, String(Date.now()), "session");
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.scope ?? "app"}]`,
      error,
      info.componentStack
    );
    this.setState({ componentStack: info.componentStack ?? "" });
    if (isChunkLoadError(error) && shouldAutoReload()) window.location.reload();
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, componentStack: "" });
    }
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    return (
      <div
        role="alert"
        data-horde="error-boundary"
        className={
          this.props.fullPage
            ? "flex min-h-svh items-center justify-center bg-ink-950 px-4 text-gray-200"
            : "flex items-center justify-center px-4 py-16"
        }
      >
        <div className="w-full max-w-lg rounded-xl bg-ink-800 p-6 ring-1 ring-ink-600">
          <h1 className="text-xl font-semibold text-gray-100">
            {chunk ? "This page could not be loaded" : "Something went wrong"}
          </h1>
          <p className="mt-2 text-sm text-gray-400">
            {chunk
              ? "Part of Horde failed to download. You may be offline, or Horde was updated while this tab was open. Reloading usually fixes it."
              : "Horde hit an unexpected error while showing this page. Your library and downloads are not affected."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={button("primary")}
            >
              Reload
            </button>
            {/* A real navigation so the app restarts from a clean state. */}
            <a
              href="/"
              className="rounded-lg bg-ink-700 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-ink-600"
            >
              Go home
            </a>
          </div>
          <details className="mt-4 text-xs text-gray-400">
            <summary className="cursor-pointer select-none">
              Error details
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-sm bg-ink-900 p-3 text-gray-300">
              {`${error.name}: ${error.message}\n${error.stack ?? ""}${
                componentStack ? `\nComponent stack:${componentStack}` : ""
              }`}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
