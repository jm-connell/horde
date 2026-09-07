import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  overlayThumbLayout,
  type OverlayThumbLayout,
} from "./overlayThumbLayout";

type ScrollRef = { readonly current: HTMLElement | null };

const HIDE_MS = 800;
const EDGE_PX = 24;

function pageScrollLocked() {
  if (document.fullscreenElement) return true;
  if (document.body.classList.contains("player-fullscreen")) return true;
  return document.body.style.overflow === "hidden";
}

function viewportMetrics(): OverlayThumbLayout | null {
  if (pageScrollLocked()) return null;
  const el = document.documentElement;
  return overlayThumbLayout(window.scrollY, el.scrollHeight, el.clientHeight);
}

/**
 * Overlay thumb (no native track or GTK stepper triangles). Hidden until the
 * scroll parent is hovered / focused, or while scrolling. Viewport mode
 * overlays the document scroller the same way.
 */
export default function OverlayScrollThumb({
  scrollRef,
  revision,
  viewport = false,
}: {
  scrollRef?: ScrollRef;
  revision?: string | number | boolean;
  viewport?: boolean;
}) {
  const [thumb, setThumb] = useState<OverlayThumbLayout | null>(null);
  const [scrolling, setScrolling] = useState(false);
  const [edgeHover, setEdgeHover] = useState(false);

  useLayoutEffect(() => {
    let hideTimer = 0;
    const bumpReveal = () => {
      setScrolling(true);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setScrolling(false), HIDE_MS);
    };

    const apply = (next: OverlayThumbLayout | null) => {
      setThumb((prev) => {
        if (prev === next) return prev;
        if (prev && next && prev.top === next.top && prev.height === next.height) {
          return prev;
        }
        return next;
      });
    };

    if (viewport) {
      const update = () => apply(viewportMetrics());
      const onScroll = () => {
        update();
        bumpReveal();
      };
      let lastEdge = false;
      const onPointerMove = (e: PointerEvent) => {
        const next = e.clientX >= window.innerWidth - EDGE_PX;
        if (next === lastEdge) return;
        lastEdge = next;
        setEdgeHover(next);
      };
      const onPointerLeave = () => {
        lastEdge = false;
        setEdgeHover(false);
      };

      update();
      const scrollOpts: AddEventListenerOptions = { passive: true, capture: true };
      window.addEventListener("scroll", onScroll, scrollOpts);
      document.addEventListener("scroll", onScroll, scrollOpts);
      document.documentElement.addEventListener("scroll", onScroll, scrollOpts);
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("resize", update);
      window.addEventListener("load", update);
      document.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("pointerleave", onPointerLeave);
      document.addEventListener("fullscreenchange", update);
      // html/body/#root are height:100%, so their box never grows. Watch the
      // min-h-full shell (and later route trees) whose scrollHeight does.
      const ro = new ResizeObserver(update);
      const observed = new Set<Element>();
      const observe = (el: Element | null | undefined) => {
        if (!el || observed.has(el)) return;
        observed.add(el);
        ro.observe(el);
      };
      const observeGrowingTree = () => {
        observe(document.documentElement);
        observe(document.body);
        const root = document.getElementById("root");
        observe(root);
        let node = root?.firstElementChild ?? null;
        while (node) {
          observe(node);
          node = node.firstElementChild;
        }
        document
          .querySelectorAll("[data-horde='main'], [data-horde='nav']")
          .forEach(observe);
      };
      observeGrowingTree();
      const mo = new MutationObserver(() => {
        observeGrowingTree();
        update();
      });
      mo.observe(document.body, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
      const root = document.getElementById("root");
      if (root) mo.observe(root, { childList: true, subtree: true });
      let frames = 0;
      let raf = 0;
      const pump = () => {
        update();
        if (++frames < 10) raf = window.requestAnimationFrame(pump);
      };
      raf = window.requestAnimationFrame(pump);
      return () => {
        window.clearTimeout(hideTimer);
        window.cancelAnimationFrame(raf);
        window.removeEventListener("scroll", onScroll, true);
        document.removeEventListener("scroll", onScroll, true);
        document.documentElement.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("resize", update);
        window.removeEventListener("load", update);
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerleave", onPointerLeave);
        document.removeEventListener("fullscreenchange", update);
        ro.disconnect();
        mo.disconnect();
      };
    }

    const el = scrollRef?.current;
    if (!el) {
      apply(null);
      return;
    }

    const update = () =>
      apply(overlayThumbLayout(el.scrollTop, el.scrollHeight, el.clientHeight));
    const onScroll = () => {
      update();
      bumpReveal();
    };

    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => {
      window.clearTimeout(hideTimer);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scrollRef, revision, viewport]);

  if (!thumb) return null;

  const revealed = scrolling || (viewport && edgeHover);

  const node = (
    <div
      aria-hidden
      data-horde={viewport ? "page-scroll" : undefined}
      data-active={revealed ? "true" : undefined}
      className={`horde-overlay-scroll-thumb pointer-events-none w-1.5 rounded-full bg-accent transition-opacity duration-150 ${
        viewport ? "fixed right-[3px] z-[45]" : "absolute right-[3px] z-[1]"
      } ${
        revealed
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      }`}
      style={{ top: thumb.top, height: thumb.height }}
    />
  );
  if (viewport) return createPortal(node, document.body);
  return node;
}
