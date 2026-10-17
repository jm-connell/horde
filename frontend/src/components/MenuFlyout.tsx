import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useMenuKeyboard, type MenuBehavior } from "../hooks/useMenuKeyboard";
import { UI_MENU_SURFACE } from "../uiMenu";
import Collapse from "./Collapse";
import OverlayScrollThumb from "./OverlayScrollThumb";

/** Open/close height animation. Keep in sync with unmount delay. */
export const MENU_FLYOUT_MS = 150;
const MENU_FLYOUT_UNMOUNT_MS = MENU_FLYOUT_MS + 50;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Stay mounted through the close animation, then drop. */
export function useMenuPresence(open: boolean): boolean {
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (prefersReducedMotion()) {
      setPresent(false);
      return;
    }
    const t = window.setTimeout(
      () => setPresent(false),
      MENU_FLYOUT_UNMOUNT_MS
    );
    return () => window.clearTimeout(t);
  }, [open]);

  return present;
}

/** Positioned dropdown chrome with height expand/collapse. */
export function MenuFlyout({
  open = true,
  unmountOnExit = true,
  className = "",
  menu,
  children,
  ...rest
}: {
  open?: boolean;
  /** When false, stay mounted while the parent owns exit timing. */
  unmountOnExit?: boolean;
  /**
   * Accessible menu/popup behaviour: role, focus on open, arrow keys, Escape
   * and Tab handling. Menu items must be role="menuitem*" elements. Omit for
   * widgets that bring their own semantics (combobox lists, listboxes).
   */
  menu?: MenuBehavior;
} & HTMLAttributes<HTMLDivElement>) {
  const present = useMenuPresence(open);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(() =>
    prefersReducedMotion() ? open : false
  );
  // Wait for `expanded`: the collapsed content is inert and cannot take focus.
  useMenuKeyboard(surfaceRef, open && present && expanded, menu);

  useEffect(() => {
    setExpanded(open);
  }, [open]);

  if (unmountOnExit && !present) return null;

  return (
    <div className={className} {...rest}>
      <Collapse
        open={expanded}
        durationClass="duration-150"
        className="motion-reduce:transition-none"
      >
        <div
          ref={surfaceRef}
          role={menu ? (menu.kind === "popup" ? "dialog" : "menu") : undefined}
          aria-label={menu?.label}
          aria-orientation={
            menu && menu.kind !== "popup" ? "vertical" : undefined
          }
          className={`w-full overflow-hidden ${UI_MENU_SURFACE}`}
        >
          {children}
        </div>
      </Collapse>
    </div>
  );
}

/** Native bar hidden; accent overlay thumb on hover/scroll (description/chapters). */
export function MenuScroll({
  className = "",
  children,
  revision,
}: {
  className?: string;
  children: ReactNode;
  revision?: string | number | boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="group isolate relative">
      <div
        ref={scrollRef}
        className={`horde-meta-scrollbar overflow-y-auto overscroll-contain ${className}`}
      >
        {children}
      </div>
      <OverlayScrollThumb scrollRef={scrollRef} revision={revision} />
    </div>
  );
}
