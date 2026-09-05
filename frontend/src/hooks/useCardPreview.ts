import { useCallback, useEffect, useId, useRef, useState } from "react";
import { loadSettings } from "./useSettings";
import {
  PREVIEW_CENTER_DELAY_MS,
  PREVIEW_HOVER_DELAY_MS,
  pickCenteredPreview,
  resolvePreviewMode,
  type PreviewMode,
} from "../utils/cardPreview";

const SETTINGS_EVENT = "horde:settings-changed";
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type CardEntry = {
  id: string;
  el: HTMLElement;
  blocked: boolean;
  setActive: (active: boolean) => void;
  detachHover?: () => void;
};

const cards = new Map<string, CardEntry>();
let activeId: string | null = null;
let mode: PreviewMode = "off";
let hoverTimer: number | null = null;
let centerTimer: number | null = null;
let pendingCenterId: string | null = null;
let raf = 0;
let envReady = false;
let hoverMq: MediaQueryList | null = null;
let motionMq: MediaQueryList | null = null;
let observer: IntersectionObserver | null = null;

function clearHoverTimer() {
  if (hoverTimer == null) return;
  window.clearTimeout(hoverTimer);
  hoverTimer = null;
}

function clearCenterTimer() {
  if (centerTimer != null) {
    window.clearTimeout(centerTimer);
    centerTimer = null;
  }
  pendingCenterId = null;
}

function setActive(id: string | null) {
  if (activeId === id) return;
  if (activeId) cards.get(activeId)?.setActive(false);
  activeId = id;
  if (id) cards.get(id)?.setActive(true);
}

function requestHover(id: string) {
  if (mode !== "hover") return;
  clearHoverTimer();
  hoverTimer = window.setTimeout(() => {
    hoverTimer = null;
    const card = cards.get(id);
    if (!card || card.blocked) return;
    setActive(id);
  }, PREVIEW_HOVER_DELAY_MS);
}

function releaseHover(id: string) {
  clearHoverTimer();
  if (activeId === id) setActive(null);
}

function evaluateCenter() {
  if (mode !== "center" || document.hidden) {
    if (document.hidden) setActive(null);
    return;
  }

  const candidates = [];
  for (const [id, card] of cards) {
    if (card.blocked) continue;
    const r = card.el.getBoundingClientRect();
    candidates.push({
      id,
      top: r.top,
      left: r.left,
      width: r.width,
      height: r.height,
    });
  }
  const winner = pickCenteredPreview(candidates, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  if (winner === activeId) {
    clearCenterTimer();
    return;
  }
  if (winner === pendingCenterId) return;
  clearCenterTimer();
  if (winner == null) {
    setActive(null);
    return;
  }
  pendingCenterId = winner;
  centerTimer = window.setTimeout(() => {
    centerTimer = null;
    pendingCenterId = null;
    if (mode !== "center" || document.hidden) return;
    const card = cards.get(winner);
    if (!card || card.blocked) {
      setActive(null);
      return;
    }
    setActive(winner);
  }, PREVIEW_CENTER_DELAY_MS);
}

function scheduleCenterEval() {
  if (mode !== "center") return;
  if (raf) return;
  raf = window.requestAnimationFrame(() => {
    raf = 0;
    evaluateCenter();
  });
}

function detachHover(card: CardEntry) {
  card.detachHover?.();
  card.detachHover = undefined;
}

function attachHover(card: CardEntry) {
  detachHover(card);
  if (mode !== "hover") return;
  const onEnter = () => requestHover(card.id);
  const onLeave = () => releaseHover(card.id);
  card.el.addEventListener("mouseenter", onEnter);
  card.el.addEventListener("mouseleave", onLeave);
  card.detachHover = () => {
    card.el.removeEventListener("mouseenter", onEnter);
    card.el.removeEventListener("mouseleave", onLeave);
  };
}

function ensureObserver() {
  if (observer || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(() => scheduleCenterEval(), {
    root: null,
    rootMargin: "-35% 0px -35% 0px",
    threshold: [0, 0.25, 0.5, 0.75, 1],
  });
}

function syncObserver() {
  observer?.disconnect();
  if (mode !== "center") return;
  ensureObserver();
  if (!observer) {
    scheduleCenterEval();
    return;
  }
  for (const card of cards.values()) observer.observe(card.el);
  scheduleCenterEval();
}

function applyMode(next: PreviewMode) {
  const changed = mode !== next;
  mode = next;
  if (!changed) {
    if (next === "center") scheduleCenterEval();
    return;
  }
  clearHoverTimer();
  clearCenterTimer();
  for (const card of cards.values()) {
    if (next === "hover") attachHover(card);
    else detachHover(card);
  }
  if (next === "center") {
    setActive(null);
    syncObserver();
    return;
  }
  observer?.disconnect();
  setActive(null);
}

function computeMode(): PreviewMode {
  if (typeof window === "undefined") return "off";
  const settings = loadSettings();
  return resolvePreviewMode({
    previewOnHover: settings.previewOnHover,
    previewWhenCentered: settings.previewWhenCentered,
    hoverCapable: window.matchMedia(HOVER_QUERY).matches,
    reducedMotion: window.matchMedia(MOTION_QUERY).matches,
  });
}

function onEnvChange() {
  applyMode(computeMode());
}

function onVisibility() {
  if (document.hidden) {
    clearHoverTimer();
    clearCenterTimer();
    setActive(null);
    return;
  }
  if (mode === "center") scheduleCenterEval();
}

function ensureEnv() {
  if (envReady || typeof window === "undefined") return;
  envReady = true;
  window.addEventListener(SETTINGS_EVENT, onEnvChange);
  window.addEventListener("storage", onEnvChange);
  hoverMq = window.matchMedia(HOVER_QUERY);
  motionMq = window.matchMedia(MOTION_QUERY);
  hoverMq.addEventListener("change", onEnvChange);
  motionMq.addEventListener("change", onEnvChange);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("scroll", scheduleCenterEval, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", scheduleCenterEval, { passive: true });
  applyMode(computeMode());
}

function teardownEnvIfIdle() {
  if (cards.size > 0 || !envReady) return;
  envReady = false;
  window.removeEventListener(SETTINGS_EVENT, onEnvChange);
  window.removeEventListener("storage", onEnvChange);
  hoverMq?.removeEventListener("change", onEnvChange);
  motionMq?.removeEventListener("change", onEnvChange);
  hoverMq = null;
  motionMq = null;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("scroll", scheduleCenterEval, true);
  window.removeEventListener("resize", scheduleCenterEval);
  observer?.disconnect();
  observer = null;
  clearHoverTimer();
  clearCenterTimer();
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  setActive(null);
  mode = "off";
}

function registerPreviewCard(entry: Omit<CardEntry, "detachHover">) {
  ensureEnv();
  const existing = cards.get(entry.id);
  if (existing) {
    const elChanged = existing.el !== entry.el;
    existing.blocked = entry.blocked;
    existing.setActive = entry.setActive;
    if (elChanged) {
      detachHover(existing);
      observer?.unobserve(existing.el);
      existing.el = entry.el;
      if (mode === "hover") attachHover(existing);
      if (mode === "center") observer?.observe(existing.el);
    }
    if (existing.blocked && activeId === existing.id) setActive(null);
    if (mode === "center") scheduleCenterEval();
    return;
  }
  const card: CardEntry = { ...entry };
  cards.set(card.id, card);
  if (mode === "hover") attachHover(card);
  if (mode === "center") observer?.observe(card.el);
  if (card.blocked && activeId === card.id) setActive(null);
  if (mode === "center") scheduleCenterEval();
}

function unregisterPreviewCard(id: string) {
  const card = cards.get(id);
  if (!card) return;
  detachHover(card);
  observer?.unobserve(card.el);
  cards.delete(id);
  if (activeId === id) setActive(null);
  if (pendingCenterId === id) clearCenterTimer();
  if (mode === "center") scheduleCenterEval();
  teardownEnvIfIdle();
}

function updatePreviewBlocked(id: string, blocked: boolean) {
  const card = cards.get(id);
  if (!card) return;
  card.blocked = blocked;
  if (blocked && activeId === id) setActive(null);
  if (mode === "center") scheduleCenterEval();
}

export function useCardPreview({
  enabled,
  blocked,
}: {
  enabled: boolean;
  blocked: boolean;
}): { ref: (node: HTMLElement | null) => void; active: boolean } {
  const reactId = useId();
  const [active, setActive] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const setActiveRef = useRef(setActive);
  setActiveRef.current = setActive;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  const ref = useCallback((node: HTMLElement | null) => {
    setEl(node);
  }, []);

  useEffect(() => {
    if (!el || !enabled) {
      unregisterPreviewCard(reactId);
      setActive(false);
      return;
    }
    registerPreviewCard({
      id: reactId,
      el,
      blocked: blockedRef.current,
      setActive: (next) => setActiveRef.current(next),
    });
    return () => unregisterPreviewCard(reactId);
  }, [reactId, enabled, el]);

  useEffect(() => {
    updatePreviewBlocked(reactId, blocked);
  }, [reactId, blocked]);

  return { ref, active };
}
