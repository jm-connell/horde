import { useEffect, useState } from "react";

export interface VisualViewportBox {
  /** Top of the visible area, in layout-viewport (position: fixed) px. */
  top: number;
  height: number;
  /** An on-screen keyboard (or similar) is covering part of the page. */
  keyboard: boolean;
}

function read(): VisualViewportBox | null {
  const vv = window.visualViewport;
  if (!vv) return null;
  return {
    top: vv.offsetTop,
    height: vv.height,
    keyboard:
      vv.height * vv.scale < document.documentElement.clientHeight - 120,
  };
}

/**
 * The part of the page the user can see. iOS does not shrink the layout
 * viewport for the keyboard: `position: fixed` stays put behind it and Safari
 * pans the page instead, so a fixed box that must stay visible while typing
 * places itself against this. Null where `visualViewport` is missing.
 */
export function useVisualViewport(enabled = true): VisualViewportBox | null {
  const [box, setBox] = useState(() => (enabled ? read() : null));
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setBox(null);
      return;
    }
    const update = () => setBox(read());
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return box;
}
