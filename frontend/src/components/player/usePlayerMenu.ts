import { useCallback, useState } from "react";

export type PlayerMenu = "speed" | "quality";

/** At most one control-bar popup (speed or quality) is open at a time. */
export function usePlayerMenu() {
  const [openMenu, setOpenMenu] = useState<PlayerMenu | null>(null);
  const toggleMenu = useCallback((menu: PlayerMenu) => {
    setOpenMenu((open) => (open === menu ? null : menu));
  }, []);
  const closeMenu = useCallback((menu: PlayerMenu) => {
    setOpenMenu((open) => (open === menu ? null : open));
  }, []);
  return { openMenu, menuOpen: openMenu !== null, toggleMenu, closeMenu };
}
