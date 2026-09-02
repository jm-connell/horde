import { useLayoutEffect, useState } from "react";

type ScrollRef = { readonly current: HTMLElement | null };

/**
 * Hover-only overlay thumb. Native CSS/GTK scrollbars on Linux draw stepper
 * triangles that cannot be hidden while the real bar is visible, so callers
 * hide the native bar (.horde-meta-scrollbar) and render this instead.
 */
export default function OverlayScrollThumb({
  scrollRef,
  revision,
}: {
  scrollRef: ScrollRef;
  revision?: string | number | boolean;
}) {
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(
    null
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      setThumb(null);
      return;
    }

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight + 1) {
        setThumb(null);
        return;
      }
      const inset = 4;
      const track = Math.max(0, clientHeight - inset * 2);
      const height = Math.max(16, (clientHeight / scrollHeight) * track);
      const maxTop = Math.max(0, track - height);
      const range = scrollHeight - clientHeight;
      const top = inset + (range <= 0 ? 0 : (scrollTop / range) * maxTop);
      setThumb({ top, height });
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollRef, revision]);

  if (!thumb) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-[3px] z-[1] w-1.5 rounded-full bg-accent/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      style={{ top: thumb.top, height: thumb.height }}
    />
  );
}
