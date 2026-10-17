import { useEffect, useState } from "react";
import type { Settings } from "../../hooks/useSettings";

const NARROW_BELOW_PX = 1100;

/**
 * The channel rail: collapsed or expanded on wide screens, an overlay opened
 * from the rail's toggle on narrow ones.
 */
export function useSidebar(
  settings: Settings,
  update: (patch: Partial<Settings>) => void
) {
  const [narrowViewport, setNarrowViewport] = useState(
    () => typeof window !== "undefined" && window.innerWidth < NARROW_BELOW_PX
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 0
  );
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [sidebarOverlayVisible, setSidebarOverlayVisible] = useState(false);

  useEffect(() => {
    const onResize = () => {
      const width = window.innerWidth;
      const narrow = width < NARROW_BELOW_PX;
      setViewportWidth(width);
      setNarrowViewport(narrow);
      if (!narrow) {
        setSidebarOverlayOpen(false);
        setSidebarOverlayVisible(false);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // On narrow viewports, keep the rail collapsed; expand opens as overlay.
  useEffect(() => {
    if (narrowViewport && !settings.sidebarCollapsed && !sidebarOverlayOpen) {
      update({ sidebarCollapsed: true });
    }
  }, [narrowViewport]); // eslint-disable-line react-hooks/exhaustive-deps -- collapse only when the viewport becomes narrow; later setting changes must not re-collapse the rail

  const openSidebar = () => {
    if (narrowViewport) {
      setSidebarOverlayVisible(true);
      // Next frame so the enter transition runs from the closed state.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSidebarOverlayOpen(true));
      });
    } else {
      update({ sidebarCollapsed: false });
    }
  };

  const closeSidebar = () => {
    setSidebarOverlayOpen(false);
    update({ sidebarCollapsed: true });
  };

  // Unmount overlay after exit transition completes.
  useEffect(() => {
    if (sidebarOverlayOpen) {
      setSidebarOverlayVisible(true);
      return;
    }
    if (!sidebarOverlayVisible) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setSidebarOverlayVisible(false);
      return;
    }
    const t = window.setTimeout(() => setSidebarOverlayVisible(false), 320);
    return () => window.clearTimeout(t);
  }, [sidebarOverlayOpen, sidebarOverlayVisible]);

  useEffect(() => {
    if (!narrowViewport) {
      setSidebarOverlayOpen(false);
      setSidebarOverlayVisible(false);
    }
  }, [narrowViewport]);

  return {
    narrowViewport,
    viewportWidth,
    sidebarOverlayOpen,
    sidebarOverlayVisible,
    openSidebar,
    closeSidebar,
  };
}
