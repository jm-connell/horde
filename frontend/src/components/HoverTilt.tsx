import { useEffect } from "react";
import { useSettings } from "../hooks/useSettings";

/** The cards that lean: video cards, feed cards and the Settings sample. */
const TILT_CARDS =
  '.ui-card:is([data-horde="video-card"], .video-card--feed, [data-horde="card-sample"])';
/** Degrees a card leans at its very edge. */
const MAX_TILT_X = 4;
const MAX_TILT_Y = 6;

/**
 * Hover motion "Tilt" (new, preview): the video card under a mouse leans
 * toward it, a little forward, with a sheen over its picture where the
 * pointer is (index.css draws the sheen). Only a mouse on a device that
 * really hovers; nothing at all for the other hover motions or under
 * reduced motion, which turns hover motion off.
 */
export default function HoverTilt() {
  const [settings] = useSettings();
  const on = settings.hoverMotion === "tilt";

  useEffect(() => {
    if (!on) return;
    const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    // Phone-width layouts turn feed cards into flat rows: no lean there.
    const narrow = window.matchMedia("(max-width: 639px)");
    let card: HTMLElement | null = null;
    let media: HTMLElement | null = null;
    let rect: DOMRect | null = null;
    let x = 0;
    let y = 0;
    let frame = 0;

    const release = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!card) return;
      card.style.removeProperty("transform");
      card.removeAttribute("data-tilting");
      media?.style.removeProperty("--horde-sheen-x");
      media?.style.removeProperty("--horde-sheen-y");
      card = null;
      media = null;
      rect = null;
    };

    const paint = () => {
      frame = 0;
      if (!card || !rect) return;
      // -0.5 … 0.5 across the card.
      const nx = Math.min(
        0.5,
        Math.max(-0.5, (x - rect.left) / rect.width - 0.5)
      );
      const ny = Math.min(
        0.5,
        Math.max(-0.5, (y - rect.top) / rect.height - 0.5)
      );
      card.style.transform = `perspective(60rem) rotateX(${(-ny * 2 * MAX_TILT_X).toFixed(2)}deg) rotateY(${(nx * 2 * MAX_TILT_Y).toFixed(2)}deg) scale(1.03)`;
      media?.style.setProperty(
        "--horde-sheen-x",
        `${((nx + 0.5) * 100).toFixed(1)}%`
      );
      media?.style.setProperty(
        "--horde-sheen-y",
        `${((ny + 0.5) * 100).toFixed(1)}%`
      );
    };

    const onMove = (e: PointerEvent) => {
      if (
        e.pointerType !== "mouse" ||
        // Held down: leave the press feedback alone.
        e.buttons !== 0 ||
        !pointer.matches ||
        document.documentElement.dataset.hoverMotion !== "tilt"
      ) {
        release();
        return;
      }
      const target =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>(TILT_CARDS)
          : null;
      if (target !== card) {
        release();
        if (
          !target ||
          target.hasAttribute("data-preview-scrubbing") ||
          (narrow.matches && target.classList.contains("video-card--feed"))
        ) {
          return;
        }
        card = target;
        media = target.querySelector<HTMLElement>(".ui-card-media");
        // Measured before it leans, so the lean does not feed back into it.
        rect = target.getBoundingClientRect();
        card.setAttribute("data-tilting", "");
      }
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    // A press settles the card so the press feedback shows; scrolling moves
    // the card out from under a measured pointer.
    document.addEventListener("pointerdown", release, true);
    window.addEventListener("scroll", release, {
      capture: true,
      passive: true,
    });
    document.documentElement.addEventListener("pointerleave", release);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", release, true);
      window.removeEventListener("scroll", release, { capture: true });
      document.documentElement.removeEventListener("pointerleave", release);
      release();
    };
  }, [on]);

  return null;
}
