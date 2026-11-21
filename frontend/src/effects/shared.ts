export type Rgb = [number, number, number];

/** One frame's state, whatever the canvas draws with. */
export interface EffectFrame {
  width: number;
  height: number;
  dpr: number;
  /** Resolved effect color (custom or theme accent). */
  accent: Rgb;
  isLight: boolean;
  /** Animation-clock seconds (speed-scaled). */
  time: number;
  /** Scaled delta time (includes speed multiplier). */
  dt: number;
  /** Unscaled delta time. */
  rawDt: number;
  speed: number;
  /** Particle density / scale multiplier (0.5–2). */
  size: number;
  /** The effect's own slider values, by key (see `controls.ts`). */
  options: Record<string, number>;
}

export interface EffectContext extends EffectFrame {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export interface EffectController {
  start: () => void;
  stop: () => void;
  setPaused: (paused: boolean) => void;
  setOpacity: (opacity: number) => void;
  setSpeed: (speed: number) => void;
  setColor: (color: Rgb | null) => void;
  setSize: (size: number) => void;
  setOptions: (options: Record<string, number>) => void;
}

export function readAccent(): Rgb {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0], parts[1], parts[2]];
  }
  return [34, 211, 238];
}

export function parseHexColor(hex: string): Rgb | null {
  const raw = hex.replace("#", "").trim();
  const value =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

const LIGHT_THEMES = new Set(["light", "earthy", "frozen", "mocha"]);

export function isLightTheme(): boolean {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme !== null && LIGHT_THEMES.has(theme);
}

export function rgba(rgb: Rgb, a: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Grow or shrink a particle list to `count` in place, keeping the particles
 * it has, so dragging a slider thins or fills the screen instead of
 * reshuffling it.
 */
export function resizePool<T>(list: T[], count: number, make: () => T): void {
  if (list.length > count) list.length = count;
  while (list.length < count) list.push(make());
}

const noopController: EffectController = {
  start: () => undefined,
  stop: () => undefined,
  setPaused: () => undefined,
  setOpacity: () => undefined,
  setSpeed: () => undefined,
  setColor: () => undefined,
  setSize: () => undefined,
  setOptions: () => undefined,
};

/**
 * Decorative effects do not need display-rate animation; 30 fps halves the
 * CPU/GPU cost and battery drain. Pass `maxFps` to override per effect.
 */
export const DEFAULT_EFFECT_FPS = 30;

export interface LoopOptions {
  maxDpr?: number;
  maxFps?: number;
}

/** What the loop needs from a canvas's drawing context (2D or WebGL). */
export interface EffectSurface {
  /** Size the backing store for a window of `width`×`height` CSS pixels. */
  resize: (width: number, height: number, dpr: number) => void;
  draw: (frame: EffectFrame) => void;
  clear: () => void;
  /** Free what the surface holds once the effect stops for good. */
  dispose?: () => void;
}

export function createCanvasLoop(
  canvas: HTMLCanvasElement,
  draw: (ctx: EffectContext) => void,
  options?: LoopOptions
): EffectController {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return noopController;
  return createEffectLoop(
    canvas,
    {
      resize(width, height, dpr) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      },
      draw: (frame) => draw({ ...frame, canvas, ctx }),
      clear: () => ctx.clearRect(0, 0, canvas.width, canvas.height),
    },
    options
  );
}

/**
 * The frame loop behind every canvas effect: window sizing, the fps budget,
 * pausing (hidden tab, playback), and the opacity, speed, size, color and
 * per-effect options the settings push to it.
 */
export function createEffectLoop(
  canvas: HTMLCanvasElement,
  surface: EffectSurface,
  options?: LoopOptions
): EffectController {
  const maxDpr = options?.maxDpr ?? 1.5;
  const minFrameMs = 1000 / (options?.maxFps ?? DEFAULT_EFFECT_FPS);

  let raf = 0;
  let running = false;
  let paused = false;
  let opacity = 1;
  let speed = 1;
  let effectSize = 1;
  let effectOptions: Record<string, number> = {};
  let customColor: Rgb | null = null;
  let cachedAccent = readAccent();
  let last = performance.now();
  let width = 0;
  let height = 0;
  let dpr = 1;
  let animTime = 0;
  let resizeTimer = 0;
  let themeObserver: MutationObserver | null = null;

  const applySize = () => {
    const nextDpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const nextW = window.innerWidth;
    const nextH = window.innerHeight;
    // Ignore sub-pixel / 1px chrome jitter that would clear the canvas.
    if (
      Math.abs(nextW - width) < 2 &&
      Math.abs(nextH - height) < 2 &&
      nextDpr === dpr
    ) {
      return;
    }
    dpr = nextDpr;
    width = nextW;
    height = nextH;
    surface.resize(width, height, dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  };

  const onResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(applySize, 120);
  };

  const refreshAccent = () => {
    if (!customColor) cachedAccent = readAccent();
  };

  const onVisibility = () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (running && !paused) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };

  const frame = (now: number) => {
    if (!running || paused || document.hidden) return;
    // Wait for the next display frame once we are ahead of the fps budget; the
    // 1 ms slack stops a 60 Hz display from landing just under 33 ms and
    // alternately drawing and skipping.
    if (now - last < minFrameMs - 1) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const rawDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // Skip pathological stalls (tab resume, GC) so particles don't jump.
    if (rawDt <= 0) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const scaledDt = rawDt * speed;
    animTime += scaledDt;
    surface.draw({
      width,
      height,
      dpr,
      accent: customColor ?? cachedAccent,
      isLight: isLightTheme(),
      time: animTime,
      dt: scaledDt,
      rawDt,
      speed,
      size: effectSize,
      options: effectOptions,
    });
    raf = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      applySize();
      canvas.style.opacity = String(opacity);
      refreshAccent();
      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisibility);
      themeObserver = new MutationObserver(refreshAccent);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "style"],
      });
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      themeObserver?.disconnect();
      themeObserver = null;
      surface.clear();
      surface.dispose?.();
    },
    setPaused(next: boolean) {
      paused = next;
      if (!running) return;
      if (paused) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    setOpacity(next: number) {
      opacity = clamp(next, 0, 1);
      canvas.style.opacity = String(opacity);
    },
    setSpeed(next: number) {
      speed = clamp(next, 0.1, 4);
    },
    setSize(next: number) {
      effectSize = clamp(next, 0.5, 2);
    },
    setOptions(next: Record<string, number>) {
      effectOptions = next;
    },
    setColor(color: Rgb | null) {
      customColor = color;
      if (!color) cachedAccent = readAccent();
    },
  };
}
