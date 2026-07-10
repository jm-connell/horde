import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  createBackgroundEffect,
  setFlowingGradientPresetGetter,
} from "../effects";
import { parseHexColor, type EffectController } from "../effects/shared";
import { useSettings, type BackgroundEffect as EffectId } from "../hooks/useSettings";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export default function BackgroundEffect() {
  const [settings] = useSettings();
  const location = useLocation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<EffectController | null>(null);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [playerFullscreen, setPlayerFullscreen] = useState(false);

  const effect = settings.backgroundEffect;
  const opacity = settings.backgroundOpacity;
  const speed = settings.backgroundEffectSpeed;
  const size = settings.backgroundEffectSize;
  const colorMode = settings.backgroundEffectColorMode;
  const customColor = settings.backgroundEffectColor;
  const pauseWhileWatching = settings.pauseBackgroundWhileWatching;
  const onWatchPage = location.pathname.startsWith("/watch/");
  const shouldPause =
    playerFullscreen || (pauseWhileWatching && onWatchPage);
  const isCustom = effect === "custom-image" && !!settings.customBackgroundId;
  const active =
    effect !== "none" &&
    !reducedMotion &&
    (effect !== "custom-image" || isCustom);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const syncFullscreen = () => {
      setPlayerFullscreen(document.body.classList.contains("player-fullscreen"));
    };
    syncFullscreen();
    const observer = new MutationObserver(syncFullscreen);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setFlowingGradientPresetGetter(() => settings.flowingGradientPreset);
    return () => setFlowingGradientPresetGetter(null);
  }, [settings.flowingGradientPreset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    controllerRef.current?.stop();
    controllerRef.current = null;

    if (!canvas || !active || isCustom) return;

    const controller = createBackgroundEffect(effect as EffectId, canvas);
    if (!controller) return;

    controller.setOpacity(opacity);
    controller.setSpeed(speed);
    controller.setSize(size);
    controller.setColor(
      colorMode === "custom" ? parseHexColor(customColor) : null
    );
    controller.setPaused(shouldPause);
    controller.start();
    controllerRef.current = controller;

    return () => {
      controller.stop();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, effect, isCustom, settings.flowingGradientPreset]);

  useEffect(() => {
    controllerRef.current?.setOpacity(opacity);
  }, [opacity]);

  useEffect(() => {
    controllerRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    controllerRef.current?.setSize(size);
  }, [size]);

  useEffect(() => {
    controllerRef.current?.setColor(
      colorMode === "custom" ? parseHexColor(customColor) : null
    );
  }, [colorMode, customColor]);

  useEffect(() => {
    controllerRef.current?.setPaused(shouldPause);
  }, [shouldPause]);

  if (!active) return null;

  if (isCustom && settings.customBackgroundId) {
    const url = `/api/backgrounds/${settings.customBackgroundId}`;
    const mime = settings.customBackgroundMime || "";
    const isVideo = mime.includes("webm") || mime.includes("video");
    const blur = settings.customBackgroundBlur;
    const tintOpacity = settings.customBackgroundTintOpacity;
    const tintRgb = hexToRgb(settings.customBackgroundTint);
    return (
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        style={{ opacity }}
      >
        {isVideo ? (
          <video
            key={url}
            src={url}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              filter: blur > 0 ? `blur(${blur}px)` : undefined,
              transform: "scale(1.05)",
            }}
          />
        ) : (
          <img
            key={url}
            src={url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              filter: blur > 0 ? `blur(${blur}px)` : undefined,
              transform: "scale(1.05)",
            }}
          />
        )}
        <div
          className="absolute inset-0"
          style={{ backgroundColor: `rgb(${tintRgb} / ${tintOpacity})` }}
        />
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  );
}
