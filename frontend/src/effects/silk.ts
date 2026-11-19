import { BLACK, WHITE, mixRgb, rgbToHsl, shiftHue, unit } from "./palette";
import { createShaderEffect } from "./webgl";

/**
 * Soft folds of satin: diagonal ridges bent by a slow warp, shaded from a
 * deep tone through the accent to a bright sheen along each crest.
 */
const FRAGMENT = `
uniform vec3 uDeep;
uniform vec3 uBody;
uniform vec3 uSheen;

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 q = p / uSize;
  float t = uTime * 0.06;
  // The slow warp is what makes the cloth drift and billow.
  vec2 w = vec2(
    fbm(q * 0.9 + vec2(0.0, t)),
    fbm(q * 0.9 + vec2(5.2, 1.3) - vec2(t * 0.7, 0.0))
  );
  q += 0.7 * (w - 0.5);
  float ang = 0.62 + 0.18 * sin(t * 0.5);
  vec2 dir = vec2(cos(ang), sin(ang));
  float s = dot(q, dir) * 3.1 + 1.9 * fbm(q * 1.3 - vec2(t * 0.45, -t * 0.2));
  float fold = 0.5 + 0.5 * sin(s * 3.14159265);
  float crest = pow(fold, 9.0);
  float shade = smoothstep(0.05, 0.95, fold);
  vec3 col = mix(uDeep, uBody, shade) + uSheen * crest * 0.6;
  // Darker towards the corners, so the middle of the page carries the light.
  float vignette = 1.0 - smoothstep(0.3, 1.05, length(p * vec2(0.8, 1.1)));
  float a = (0.16 + 0.5 * shade + 0.34 * crest) * (0.5 + 0.5 * vignette);
  if (uLight > 0.5) a *= 0.55;
  gl_FragColor = vec4(col * a + dither(), a);
}
`;

export function createSilkEffect(
  canvas: HTMLCanvasElement
): ReturnType<typeof createShaderEffect> {
  return createShaderEffect(canvas, {
    fragment: FRAGMENT,
    scale: 0.4,
    uniforms(gl, location, { accent, isLight }) {
      const [, s] = rgbToHsl(accent);
      // A neighbour hue in the shadows keeps the folds from looking flat.
      const deep = isLight
        ? mixRgb(shiftHue(accent, -24), WHITE, 0.35)
        : mixRgb(shiftHue(accent, -24, Math.max(s, 0.4)), BLACK, 0.72);
      const body = isLight
        ? mixRgb(accent, WHITE, 0.15)
        : mixRgb(accent, BLACK, 0.28);
      const sheen = isLight
        ? mixRgb(accent, WHITE, 0.6)
        : mixRgb(accent, WHITE, 0.55);
      gl.uniform3f(location("uDeep"), ...unit(deep));
      gl.uniform3f(location("uBody"), ...unit(body));
      gl.uniform3f(location("uSheen"), ...unit(sheen));
    },
  });
}
