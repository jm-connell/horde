import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** How long the accent ring stays on the found setting. */
const RING_MS = 1600;
/** How long to wait for a lazy tab or server data to render the anchor. */
const WAIT_MS = 4000;

/** Scroll `el` to the middle of the screen, move focus there and ring it. */
export function flashSetting(el: HTMLElement) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  el.classList.add("setting-flash");
  window.setTimeout(() => el.classList.remove("setting-flash"), RING_MS);
}

/**
 * `?find=<anchor>` (from a link or Ask about Horde): once the page has drawn
 * the element marked `data-setting="<anchor>"`, scroll to it and ring it,
 * then drop the parameter. `onMissing` gets the text when nothing on the page
 * carries that anchor (Settings searches for it instead).
 */
export function useSettingFind(onMissing?: (text: string) => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const missingRef = useRef(onMissing);
  missingRef.current = onMissing;

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const find = params.get("find")?.trim();
    if (!find) return;
    let frame = 0;
    const started = performance.now();
    const done = () => {
      params.delete("find");
      const search = params.toString();
      navigate(
        { pathname: location.pathname, search: search ? `?${search}` : "" },
        { replace: true }
      );
    };
    const look = () => {
      const el = document.querySelector(`[data-setting="${CSS.escape(find)}"]`);
      if (el instanceof HTMLElement) {
        flashSetting(el);
        done();
      } else if (performance.now() - started > WAIT_MS) {
        missingRef.current?.(find);
        done();
      } else {
        frame = requestAnimationFrame(look);
      }
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per navigation (location.key), so the same link clicked twice rings again
  }, [location.key]);
}
