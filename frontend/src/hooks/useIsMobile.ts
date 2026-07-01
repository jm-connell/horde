import { useEffect, useState } from "react";

const QUERY =
  "(max-width: 768px), (orientation: landscape) and (max-height: 500px)";

// True on narrow viewports and short landscape phones. Used to swap in
// touch-friendly player controls and layouts.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
