import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // Skip display:none / collapsed content: it has no layout boxes.
    (el) => el.getClientRects().length > 0
  );
}

/** Only the most recently opened modal reacts, so stacked dialogs behave. */
function isTopmostModal(root: HTMLElement): boolean {
  const modals = document.querySelectorAll('[aria-modal="true"]');
  return modals.length === 0 || modals[modals.length - 1] === root;
}

export interface FocusTrapOptions {
  /** Trap only while true (for dialogs that stay mounted while closed). */
  active?: boolean;
  /** Called when Escape is pressed inside the topmost modal. */
  onEscape?: () => void;
  /**
   * Element to focus on open. Defaults to the first `[data-autofocus]` child,
   * else the container itself (give it tabIndex={-1}).
   */
  initialFocus?: RefObject<HTMLElement>;
}

/**
 * Modal focus management without a dependency: moves focus into `containerRef`
 * on open, keeps Tab/Shift+Tab inside it, closes on Escape and gives focus back
 * to whatever had it before when the modal closes or unmounts.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement>,
  { active = true, onEscape, initialFocus }: FocusTrapOptions = {}
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    const root = containerRef.current;
    if (!active || !root) return;
    const previous = document.activeElement as HTMLElement | null;

    const target =
      initialFocusRef.current?.current ??
      root.querySelector<HTMLElement>("[data-autofocus]") ??
      root;
    target.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(root)) return;
      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!root.contains(current) || current === root) {
        // Focus escaped (or sits on the container): pull it back in.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [active, containerRef]);
}
