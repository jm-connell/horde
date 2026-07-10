import {
  createCanvasLoop,
  rgba,
  type EffectController,
  type Rgb,
} from "./shared";

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export type FlowingGradientPreset =
  | "theme"
  | "rgb"
  | "cool"
  | "warm"
  | "mono";

/** Hue offsets for the 4 soft blobs. */
export const FLOWING_PRESET_OFFSETS: Record<FlowingGradientPreset, number[]> = {
  theme: [0, 85, 170, 265],
  rgb: [0, 120, 240, 60],
  cool: [180, 210, 250, 300],
  warm: [10, 35, 55, 320],
  mono: [0, 8, -8, 16],
};

export const FLOWING_PRESET_OPTIONS: {
  value: FlowingGradientPreset;
  label: string;
}[] = [
  { value: "theme", label: "Theme default" },
  { value: "rgb", label: "RGB wave" },
  { value: "cool", label: "Cool" },
  { value: "warm", label: "Warm" },
  { value: "mono", label: "Mono accent" },
];

interface Blob {
  hueOffset: number;
  speed: number;
  phaseX: number;
  phaseY: number;
  orbitX: number;
  orbitY: number;
  radius: number;
  lightness: number;
  sat: number;
}

const BLOB_BASE: Omit<Blob, "hueOffset">[] = [
  {
    speed: 0.16,
    phaseX: 0.2,
    phaseY: 1.1,
    orbitX: 0.24,
    orbitY: 0.2,
    radius: 0.78,
    lightness: 0.46,
    sat: 0.78,
  },
  {
    speed: 0.13,
    phaseX: 1.7,
    phaseY: 2.4,
    orbitX: 0.3,
    orbitY: 0.22,
    radius: 0.9,
    lightness: 0.42,
    sat: 0.72,
  },
  {
    speed: 0.11,
    phaseX: 3.2,
    phaseY: 0.5,
    orbitX: 0.22,
    orbitY: 0.28,
    radius: 0.82,
    lightness: 0.4,
    sat: 0.7,
  },
  {
    speed: 0.09,
    phaseX: 4.8,
    phaseY: 3.6,
    orbitX: 0.26,
    orbitY: 0.18,
    radius: 0.88,
    lightness: 0.44,
    sat: 0.68,
  },
];

export function createFlowingGradientEffect(
  canvas: HTMLCanvasElement,
  getPreset?: () => FlowingGradientPreset
): EffectController {
  canvas.style.filter = "blur(18px)";
  canvas.style.transform = "scale(1.06)";
  canvas.style.transformOrigin = "center";

  const controller = createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, isLight, size }) => {
      ctx.clearRect(0, 0, width, height);

      const preset = getPreset?.() ?? "theme";
      const offsets = FLOWING_PRESET_OFFSETS[preset] ?? FLOWING_PRESET_OFFSETS.theme;

      const baseHue =
        (Math.atan2(accent[1] - accent[0], accent[2] - accent[0]) * 180) /
          Math.PI +
        180;
      const maxDim = Math.max(width, height);
      const alpha = isLight ? 0.22 : 0.32;

      for (let i = 0; i < BLOB_BASE.length; i++) {
        const base = BLOB_BASE[i];
        const hueOffset = offsets[i] ?? offsets[0] ?? 0;
        const cx =
          width *
          (0.5 + Math.sin(time * base.speed + base.phaseX) * base.orbitX * size);
        const cy =
          height *
          (0.5 +
            Math.cos(time * base.speed * 0.85 + base.phaseY) *
              base.orbitY *
              size);
        const radius = maxDim * base.radius * (0.75 + 0.35 * size);
        const wave = Math.sin(time * 0.35 + hueOffset * 0.02) * 18;
        const color = mix(
          accent,
          hslToRgb(
            baseHue + hueOffset + time * 10 + wave,
            base.sat,
            isLight ? base.lightness + 0.12 : base.lightness
          ),
          preset === "mono" ? 0.25 : 0.55
        );

        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        g.addColorStop(0, rgba(color, alpha));
        g.addColorStop(0.4, rgba(color, alpha * 0.5));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }
    }
  );

  return {
    start: () => controller.start(),
    stop() {
      canvas.style.filter = "";
      canvas.style.transform = "";
      controller.stop();
    },
    setOpacity: (v: number) => controller.setOpacity(v),
    setSpeed: (v: number) => controller.setSpeed(v),
    setSize: (v: number) => controller.setSize(v),
    setColor: (c: Rgb | null) => controller.setColor(c),
    setPaused: (p: boolean) => controller.setPaused(p),
  };
}
