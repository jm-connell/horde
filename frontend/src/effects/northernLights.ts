import { BLACK, coolTurn, mixRgb, rgbToHsl, shiftHue, unit } from "./palette";
import { createShaderEffect } from "./webgl";

/**
 * Curtains of light hanging across the upper screen: each has a crisp lower
 * edge that fades upward into rays, drifts sideways and brightens in
 * wandering stretches. Three curtains at different depths, with faint stars
 * behind them on dark themes.
 */
const FRAGMENT = `
uniform vec3 uLow;
uniform vec3 uHigh;
uniform float uHeight;

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float x = uv.x * (uRes.x / uRes.y) / uSize;
  float t = uTime;
  float glow = 0.0;
  vec3 tint = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float lx = x * (0.8 + fi * 0.45) + fi * 13.7;
    float drift = t * (0.018 + fi * 0.006);
    // Where the curtain's lower edge hangs: long S-curves across the sky.
    float edge = uHeight + fi * 0.08
      + 0.11 * sin(lx * 1.3 + drift * 2.0 + fi * 2.1)
      + 0.06 * sin(lx * 2.9 - drift * 1.3 + fi)
      + 0.12 * (fbm(vec2(lx * 0.5 + drift, fi * 4.1)) - 0.5);
    float d = uv.y - edge;
    // A sharp, bright hem, and the curtain fading upward from it.
    float hem = exp(-d * d * 900.0);
    float curtain = (d < 0.0 ? exp(d * 45.0) : 1.0) * exp(-max(d, 0.0) * (3.6 + fi));
    // Rays: thin streaks gathered in bundles, drifting along the curtain.
    float streak = noise(vec2(lx * 38.0 + drift * 8.0, fi * 3.3 + t * 0.02));
    float bundle = noise(vec2(lx * 9.0 - drift * 4.0, fi * 7.7));
    float rays = streak * streak * (0.35 + 0.95 * bundle);
    // Bright stretches that wander along it.
    float stretch = smoothstep(0.3, 0.75,
      fbm(vec2(lx * 0.65 - drift * 0.5, 9.1 + fi * 2.3)));
    float k = (0.55 * hem + curtain * (0.3 + 1.4 * rays)) * stretch
      * (1.0 - fi * 0.26);
    glow += k;
    tint += mix(uLow, uHigh, smoothstep(0.0, 0.3, d)) * k;
  }
  vec3 col = tint / max(glow, 1e-4);
  glow = clamp(glow * 1.15, 0.0, 1.0);

  if (uLight > 0.5) {
    float a = glow * 0.6;
    gl_FragColor = vec4(col * a + dither(), a);
    return;
  }
  // Faint stars in the clear sky above and between the curtains.
  vec2 cell = floor(gl_FragCoord.xy);
  float star = step(0.9978, hash12(cell));
  star *= 0.35 + 0.65 * (0.5 + 0.5 * sin(t * 1.7 + hash12(cell + 7.0) * 40.0));
  star *= smoothstep(uHeight - 0.2, uHeight + 0.45, uv.y) * (1.0 - glow) * 0.55;
  float a = max(glow * 0.92, star);
  gl_FragColor = vec4(col * glow + vec3(star) + dither(), a);
}
`;

export function createNorthernLightsEffect(
  canvas: HTMLCanvasElement
): ReturnType<typeof createShaderEffect> {
  return createShaderEffect(canvas, {
    fragment: FRAGMENT,
    scale: 0.5,
    uniforms(gl, location, { accent, isLight, options }) {
      const [, s, l] = rgbToHsl(accent);
      // The lower edge glows in the accent; the rays fade into a cooler hue.
      const low = shiftHue(
        accent,
        0,
        Math.max(s, 0.55),
        Math.min(0.62, Math.max(l, 0.5))
      );
      const high = shiftHue(
        accent,
        62 * coolTurn(accent),
        Math.max(s, 0.5),
        0.5
      );
      const [lr, lg, lb] = unit(isLight ? mixRgb(low, BLACK, 0.3) : low);
      const [hr, hg, hb] = unit(isLight ? mixRgb(high, BLACK, 0.3) : high);
      gl.uniform1f(location("uHeight"), options.height);
      gl.uniform3f(location("uLow"), lr, lg, lb);
      gl.uniform3f(location("uHigh"), hr, hg, hb);
    },
  });
}
