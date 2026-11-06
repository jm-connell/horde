import type { FlowingGradientPreset } from "./flowingGradient";
import { BLACK, WHITE, hslToRgb, mixRgb, rgbToHsl } from "./palette";
import type { Rgb } from "./shared";
import { createShaderEffect } from "./webgl";

/**
 * Five colors pinned to slowly wandering points and blended across the
 * whole screen, like a designer's mesh gradient. Drawn per pixel with
 * dithering, so the long dark ramps do not band, and without the CSS blur
 * Flowing gradient needs.
 */
const FRAGMENT = `
uniform vec3 uColors[5];
uniform vec2 uPoints[5];

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = vec2(uv.x * (uRes.x / uRes.y), uv.y);
  // A gentle ripple, so the borders between colors are never straight.
  p += 0.05 * vec2(sin(p.y * 3.1 + uTime * 0.21), cos(p.x * 2.6 - uTime * 0.17));
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 d = p - uPoints[i];
    float w = 1.0 / (pow(dot(d, d), 1.6) + 0.004);
    sum += uColors[i] * w;
    total += w;
  }
  vec3 col = sum / total;
  float a = uLight > 0.5 ? 0.4 : 0.52;
  gl_FragColor = vec4(col * a + dither(), a);
}
`;

/** Hues each preset blends (theme and mono turn from the accent). */
const PRESET_HUES: Record<FlowingGradientPreset, number[]> = {
  theme: [0, -38, 42, 84],
  rgb: [0, 120, 240, 60],
  cool: [192, 222, 254, 286],
  warm: [6, 28, 344, 46],
  mono: [0, 10, -10, 0],
};

export function meshPalette(
  accent: Rgb,
  preset: FlowingGradientPreset,
  isLight: boolean,
  time: number
): Rgb[] {
  const [h, s, l] = rgbToHsl(accent);
  const relative = preset === "theme" || preset === "mono";
  // The RGB wave slowly turns the whole wheel; the others hold still.
  const drift = preset === "rgb" ? time * 4 : 0;
  const colors = PRESET_HUES[preset].map((hue, i) => {
    const sat = preset === "mono" ? Math.max(0.3, s) : Math.max(0.55, s * 0.9);
    const light =
      preset === "mono" ? [0.34, 0.46, 0.26, 0.4][i] : 0.42 + i * 0.03;
    const c = hslToRgb([(relative ? h : 0) + hue + drift, sat, light]);
    return preset === "theme" ? mixRgb(c, accent, 0.3) : c;
  });
  // A deep anchor keeps the field from turning into one bright wash.
  colors.push(
    mixRgb(hslToRgb([h, Math.min(s, 0.5), l]), isLight ? WHITE : BLACK, 0.6)
  );
  return isLight ? colors.map((c) => mixRgb(c, WHITE, 0.35)) : colors;
}

const ORBITS = [
  { x: 0.25, y: 0.3, ax: 0.22, ay: 0.18, fx: 0.071, fy: 0.053, p: 0.4 },
  { x: 0.78, y: 0.28, ax: 0.2, ay: 0.2, fx: 0.059, fy: 0.067, p: 2.1 },
  { x: 0.7, y: 0.8, ax: 0.24, ay: 0.16, fx: 0.047, fy: 0.061, p: 3.7 },
  { x: 0.22, y: 0.76, ax: 0.18, ay: 0.2, fx: 0.063, fy: 0.049, p: 5.2 },
  { x: 0.5, y: 0.52, ax: 0.28, ay: 0.22, fx: 0.039, fy: 0.043, p: 1.3 },
];

export function createMeshGradientEffect(
  canvas: HTMLCanvasElement,
  getPreset: () => FlowingGradientPreset
): ReturnType<typeof createShaderEffect> {
  const points = new Float32Array(ORBITS.length * 2);
  const colors = new Float32Array(ORBITS.length * 3);
  return createShaderEffect(canvas, {
    fragment: FRAGMENT,
    scale: 0.5,
    uniforms(gl, location, { accent, isLight, time, width, height, size }) {
      const aspect = width / Math.max(1, height);
      ORBITS.forEach((o, i) => {
        // Size widens the paths the colors travel.
        const reach = 0.7 + 0.3 * size;
        points[i * 2] =
          (o.x + Math.sin(time * o.fx + o.p) * o.ax * reach) * aspect;
        points[i * 2 + 1] =
          o.y + Math.cos(time * o.fy + o.p * 1.3) * o.ay * reach;
      });
      meshPalette(accent, getPreset(), isLight, time).forEach((c, i) => {
        colors[i * 3] = c[0] / 255;
        colors[i * 3 + 1] = c[1] / 255;
        colors[i * 3 + 2] = c[2] / 255;
      });
      gl.uniform2fv(location("uPoints"), points);
      gl.uniform3fv(location("uColors"), colors);
    },
  });
}
