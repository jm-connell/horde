import { useEffect, useRef, type RefObject } from "react";

const ITEM_SELECTOR =
  '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export type MenuKind =
  /** role="menu": arrow-key navigation over menuitem* children. */
  | "menu"
  /** Non-modal popup (role="dialog") with ordinary controls inside. */
  | "popup";

export interface MenuBehavior {
  kind?: MenuKind;
  /** Accessible name of the menu / popup. */
  label: string;
  /** Close the menu (Escape, Tab, or focus leaving through the ends). */
  onClose: () => void;
  /** The button that opened it; receives focus when the menu closes by key. */
  triggerRef: RefObject<HTMLElement | null>;
}

function visible(el: HTMLElement) {
  return el.getClientRects().length > 0;
}

function items(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && visible(el)
  );
}

/**
 * Keyboard behaviour for an open menu/popup (WAI-ARIA APG menu button):
 * focus moves in on open; Arrow/Home/End navigate menus; Escape closes and
 * returns focus to the trigger; Tab closes (menus) or closes when leaving the
 * popup's first/last control.
 *
 * Keys are handled in the capture phase and stopped, so global shortcuts (the
 * player's arrow-key seek, Escape-to-leave-theater) do not also fire.
 */
export function useMenuKeyboard(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
  behavior: MenuBehavior | undefined
) {
  const behaviorRef = useRef(behavior);
  behaviorRef.current = behavior;
  const enabled = active && behavior !== undefined;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    const kind = behaviorRef.current?.kind ?? "menu";

    const first =
      kind === "menu"
        ? (root.querySelector<HTMLElement>(
            '[role="menuitemradio"][aria-checked="true"]'
          ) ?? items(root)[0])
        : (root.querySelector<HTMLElement>("[data-autofocus]") ??
          Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
            visible
          ));
    first?.focus({ preventScroll: true });

    const closeAndRestore = (restoreFocus: boolean) => {
      const b = behaviorRef.current;
      if (!b) return;
      b.onClose();
      if (restoreFocus) b.triggerRef.current?.focus({ preventScroll: true });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const b = behaviorRef.current;
      if (!b) return;
      const target = event.target as Node | null;
      const inRoot = !!target && root.contains(target);
      const onTrigger = !!target && !!b.triggerRef.current?.contains(target);
      if (!inRoot && !onTrigger) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestore(true);
        return;
      }

      if (event.key === "Tab") {
        if (kind === "menu") {
          // Focus goes to the trigger first, so the default Tab continues from
          // there instead of from a menu that is about to unmount.
          closeAndRestore(true);
          return;
        }
        if (!inRoot) return;
        const controls = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE)
        ).filter(visible);
        const current = document.activeElement;
        const leavingForward =
          !event.shiftKey && current === controls[controls.length - 1];
        const leavingBackward = event.shiftKey && current === controls[0];
        if (controls.length === 0 || leavingForward || leavingBackward) {
          closeAndRestore(true);
        }
        return;
      }

      if (kind !== "menu") return;
      const list = items(root);
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement | undefined;
      switch (event.key) {
        case "ArrowDown":
          next = list[index < 0 ? 0 : (index + 1) % list.length];
          break;
        case "ArrowUp":
          next =
            list[
              index < 0
                ? list.length - 1
                : (index - 1 + list.length) % list.length
            ];
          break;
        case "Home":
          next = list[0];
          break;
        case "End":
          next = list[list.length - 1];
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      next?.focus({ preventScroll: true });
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, rootRef]);
}
