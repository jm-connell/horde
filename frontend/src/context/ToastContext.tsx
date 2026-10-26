import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CloseIcon } from "../components/icons";

export type ToastVariant = "info" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  variant?: ToastVariant;
  /** Replaces a visible toast with the same key instead of stacking. */
  key?: string;
  /** Stays until dismissed (or until its action is used). */
  persistent?: boolean;
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  key?: string;
  message: string;
  variant: ToastVariant;
  persistent: boolean;
  action?: ToastAction;
}

interface ToastContextValue {
  /** Info toast: polite live region, auto-dismissed. */
  showToast: (message: string, options?: ToastOptions) => number;
  /** Error toast: assertive alert, stays long enough to read. */
  showError: (message: string, options?: ToastOptions) => number;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<ToastContextValue | null>(null);

const INFO_MS = 4000;
// Errors are rarely glanceable: give them time and a dismiss button.
const ERROR_MS = 10000;
// A toast with an action (Undo) stays long enough to reach the button.
const ACTION_MS = 10000;

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());
  const toastsRef = useRef<ToastItem[]>([]);
  toastsRef.current = toasts;

  const dismissToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Pending dismiss timers must not outlive the provider.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const push = useCallback(
    (message: string, options: ToastOptions, variant: ToastVariant) => {
      const id = ++nextId;
      const persistent = options.persistent ?? false;
      if (options.key) {
        for (const old of toastsRef.current) {
          if (old.key === options.key) dismissToast(old.id);
        }
      }
      setToasts((prev) => [
        ...prev,
        {
          id,
          key: options.key,
          message,
          variant,
          persistent,
          action: options.action,
        },
      ]);
      if (!persistent) {
        timers.current.set(
          id,
          window.setTimeout(
            () => dismissToast(id),
            variant === "error"
              ? ERROR_MS
              : options.action
                ? ACTION_MS
                : INFO_MS
          )
        );
      }
      return id;
    },
    [dismissToast]
  );

  const showToast = useCallback(
    (message: string, options: ToastOptions = {}) =>
      push(message, options, options.variant ?? "info"),
    [push]
  );
  const showError = useCallback(
    (message: string, options: ToastOptions = {}) =>
      push(message, options, "error"),
    [push]
  );

  const value = useMemo(
    () => ({ showToast, showError, dismissToast }),
    [showToast, showError, dismissToast]
  );

  const renderToast = (t: ToastItem) => (
    <div
      key={t.id}
      data-horde="toast"
      data-variant={t.variant}
      className={`pointer-events-auto flex items-start gap-3 rounded-lg bg-ink-800 px-4 py-3 text-sm text-gray-100 shadow-xl ring-1 ${
        t.variant === "error" ? "ring-red-400/60" : "ring-ink-600"
      }`}
    >
      <span className="min-w-0 wrap-break-word">{t.message}</span>
      {t.action ? (
        <button
          type="button"
          onClick={() => {
            t.action?.onClick();
            dismissToast(t.id);
          }}
          className="shrink-0 rounded-sm px-2 py-0.5 font-medium text-accent hover:underline"
        >
          {t.action.label}
        </button>
      ) : null}
      {t.variant === "error" || t.persistent ? (
        <button
          type="button"
          onClick={() => dismissToast(t.id)}
          aria-label="Dismiss notification"
          className="shrink-0 rounded-sm px-1 text-muted hover:text-gray-100"
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );

  // Both regions stay mounted (even when empty) so screen readers register
  // them before the first message is inserted.
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2">
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-end gap-2"
        >
          {toasts.filter((t) => t.variant === "info").map(renderToast)}
        </div>
        <div
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-end gap-2"
        >
          {toasts.filter((t) => t.variant === "error").map(renderToast)}
        </div>
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
