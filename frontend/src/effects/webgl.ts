import {
  createEffectLoop,
  type EffectController,
  type EffectFrame,
} from "./shared";

/**
 * Shared GLSL for every shader effect: precision, the common uniforms, a
 * sine-free hash, value noise and fbm. `uRes` is the backing store in
 * pixels, `uAccent` the effect color (0–1), `uLight` 1 on light themes.
 */
const HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uAccent;
uniform float uLight;
uniform float uSize;

// After Dave Hoskins' "Hash without Sine" (MIT): stable on every GPU, where
// sin-based hashes band at large inputs.
float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * noise(p);
    p = OCTAVE * p + 17.3;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

// Half a step of 8-bit noise breaks up banding in long, dark gradients.
float dither() {
  return (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export interface ShaderEffect {
  /** `void main()` and any helpers; the HEADER above is prepended. */
  fragment: string;
  /**
   * Backing-store pixels per CSS pixel. Soft fields render well below 1 and
   * the browser's upscale blurs them for free.
   */
  scale: number;
  /** Set the effect's own uniforms for this frame. */
  uniforms?: (
    gl: WebGLRenderingContext,
    location: (name: string) => WebGLUniformLocation | null,
    frame: EffectFrame
  ) => void;
  maxFps?: number;
}

interface Program {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  locations: Map<string, WebGLUniformLocation | null>;
}

function compile(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn(
      "Background shader failed to compile",
      gl.getShaderInfoLog(shader)
    );
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGLRenderingContext, fragment: string): Program | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, HEADER + fragment);
  const program = vs && fs ? gl.createProgram() : null;
  const buffer = program ? gl.createBuffer() : null;
  if (!vs || !fs || !program || !buffer) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(program);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(
      "Background shader failed to link",
      gl.getProgramInfoLog(program)
    );
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    return null;
  }
  gl.useProgram(program);
  // One triangle that covers the whole viewport.
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  return { program, buffer, locations: new Map() };
}

/**
 * WebGL took the canvas but the shader could not start. The canvas can never
 * give a 2D context now, so a fallback needs a fresh one.
 */
export const SHADER_FAILED = "shader-failed";

/**
 * Run a fragment shader over the whole canvas on the shared frame loop.
 * Returns null when there is no hardware WebGL here (the canvas is then
 * untouched and free for a 2D effect), or SHADER_FAILED when WebGL took the
 * canvas and then could not run the shader.
 */
export function createShaderEffect(
  canvas: HTMLCanvasElement,
  effect: ShaderEffect
): EffectController | null | typeof SHADER_FAILED {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
    // Software rendering (a VM, a remote desktop) would run a screen of
    // noise on the CPU 30 times a second: take the 2D stand-in instead.
    // A hint only; not every browser reports its software renderer.
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) return null;
  let current = gl.isContextLost() ? null : link(gl, effect.fragment);
  if (!current) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return SHADER_FAILED;
  }
  let lost = false;

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    current = link(gl, effect.fragment);
    lost = !current;
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const location = (name: string): WebGLUniformLocation | null => {
    if (!current) return null;
    const { locations, program } = current;
    if (!locations.has(name)) {
      locations.set(name, gl.getUniformLocation(program, name));
    }
    return locations.get(name) ?? null;
  };

  return createEffectLoop(
    canvas,
    {
      resize(width, height, dpr) {
        canvas.width = Math.max(1, Math.round(width * dpr * effect.scale));
        canvas.height = Math.max(1, Math.round(height * dpr * effect.scale));
        gl.viewport(0, 0, canvas.width, canvas.height);
      },
      draw(frame) {
        if (lost || !current) return;
        gl.uniform2f(location("uRes"), canvas.width, canvas.height);
        gl.uniform1f(location("uTime"), frame.time);
        gl.uniform3f(
          location("uAccent"),
          frame.accent[0] / 255,
          frame.accent[1] / 255,
          frame.accent[2] / 255
        );
        gl.uniform1f(location("uLight"), frame.isLight ? 1 : 0);
        gl.uniform1f(location("uSize"), frame.size);
        effect.uniforms?.(gl, location, frame);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      clear() {
        if (lost) return;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      dispose() {
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
        if (current && !lost) {
          gl.deleteBuffer(current.buffer);
          gl.deleteProgram(current.program);
        }
        current = null;
        // Hand the GPU context back now rather than whenever the canvas is
        // collected (browsers cap how many can be alive at once), but only
        // once the canvas has left the page: React may start a new effect on
        // the same canvas straight away, and a lost context never returns.
        window.setTimeout(() => {
          if (!canvas.isConnected) {
            gl.getExtension("WEBGL_lose_context")?.loseContext();
          }
        }, 0);
      },
    },
    // The scale above already sets the pixel budget; high-DPI screens would
    // only multiply it for a field that is soft anyway.
    { maxDpr: 1, maxFps: effect.maxFps }
  );
}
