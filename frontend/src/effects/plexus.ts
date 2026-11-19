import { BLACK, WHITE, mixRgb } from "./palette";
import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";
import { createSpriteCache } from "./sprites";

/**
 * A cloud of linked nodes turning slowly in 3D. Near nodes and links are
 * larger and brighter than far ones, and now and then a signal runs along a
 * link and on through the network.
 */

interface Node {
  hx: number;
  hy: number;
  hz: number;
  amp: number;
  fx: number;
  fy: number;
  fz: number;
  phase: number;
  /** World position this frame. */
  x: number;
  y: number;
  z: number;
  /** Screen position and perspective scale this frame. */
  sx: number;
  sy: number;
  depth: number;
  flash: number;
  links: number[];
}

interface Link {
  a: number;
  b: number;
}

interface Signal {
  link: number;
  forward: boolean;
  t: number;
  duration: number;
}

/** Alpha steps links are drawn in; one path per step. */
const LINK_STEPS = 6;

export function createPlexusEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let nodes: Node[] = [];
  let links: Link[] = [];
  let reach = 0;
  let signals: Signal[] = [];
  let nextSignal = 1;
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  let angle = 0;
  // Segment coordinates per alpha step, reused every frame.
  const segments = Array.from({ length: LINK_STEPS }, () => [] as number[]);
  const sprite = createSpriteCache();

  const rebuild = (w: number, h: number, size: number) => {
    const W = w * 0.62;
    const H = h * 0.6;
    const D = Math.max(W, H) * 0.7;
    const area = (w * h) / (1440 * 900);
    const count = Math.round(
      Math.min(200, Math.max(60, 120 * Math.pow(area, 0.8)))
    );
    // Link distance for about four neighbours each at this density.
    const volume = 8 * W * H * D;
    reach =
      Math.cbrt((4 * 3 * volume) / (4 * Math.PI * count)) *
      (0.85 + 0.15 * size);
    const spacing = reach * 0.42;
    nodes = [];
    for (let i = 0; i < count; i++) {
      let hx = 0;
      let hy = 0;
      let hz = 0;
      // Spread nodes out: a few tries for a spot not crowding another.
      for (let tries = 0; tries < 20; tries++) {
        hx = rand(-W, W);
        hy = rand(-H, H);
        hz = rand(-D, D);
        if (
          !nodes.some(
            (n) => Math.hypot(n.hx - hx, n.hy - hy, n.hz - hz) < spacing
          )
        ) {
          break;
        }
      }
      nodes.push({
        hx,
        hy,
        hz,
        amp: reach * rand(0.08, 0.2),
        fx: rand(0.05, 0.14),
        fy: rand(0.05, 0.14),
        fz: rand(0.05, 0.14),
        phase: Math.random() * Math.PI * 2,
        x: hx,
        y: hy,
        z: hz,
        sx: 0,
        sy: 0,
        depth: 0,
        flash: 0,
        links: [],
      });
    }
    links = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (Math.hypot(a.hx - b.hx, a.hy - b.hy, a.hz - b.hz) < reach * 1.15) {
          a.links.push(links.length);
          b.links.push(links.length);
          links.push({ a: i, b: j });
        }
      }
    }
    signals = [];
  };

  const send = (link: number, from: number) => {
    if (signals.length >= 8) return;
    signals.push({
      link,
      forward: links[link].a === from,
      t: 0,
      duration: rand(0.9, 1.6),
    });
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, dt, size, isLight }) => {
      if (
        width !== lastW ||
        height !== lastH ||
        Math.abs(size - lastSize) > 0.05
      ) {
        lastW = width;
        lastH = height;
        lastSize = size;
        rebuild(width, height, size);
      }
      ctx.clearRect(0, 0, width, height);

      angle += dt * 0.045;
      const tiltX = 0.3 + 0.08 * Math.sin(time * 0.05);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cosB = Math.cos(tiltX);
      const sinB = Math.sin(tiltX);
      const D = Math.max(width * 0.62, height * 0.6) * 0.7;
      const camZ = D * 2.6;
      const focal = camZ * 0.92;
      const span = Math.hypot(width * 0.62, D);
      const near = focal / (camZ - span);
      const far = focal / (camZ + span);
      const cx = width / 2;
      const cy = height / 2;

      for (const n of nodes) {
        n.x = n.hx + n.amp * Math.sin(time * n.fx + n.phase);
        n.y = n.hy + n.amp * Math.sin(time * n.fy + n.phase * 1.7);
        n.z = n.hz + n.amp * Math.sin(time * n.fz + n.phase * 2.3);
        const x1 = n.x * cosA + n.z * sinA;
        const z1 = -n.x * sinA + n.z * cosA;
        const y2 = n.y * cosB - z1 * sinB;
        const z2 = n.y * sinB + z1 * cosB;
        const scale = focal / (camZ + z2);
        n.sx = cx + x1 * scale;
        n.sy = cy + y2 * scale;
        n.depth = Math.min(1, Math.max(0, (scale - far) / (near - far)));
        n.flash = Math.max(0, n.flash - dt * 1.6);
      }

      const line = isLight ? mixRgb(accent, BLACK, 0.25) : accent;
      const glow = isLight
        ? mixRgb(accent, BLACK, 0.1)
        : mixRgb(accent, WHITE, 0.5);
      const strength = isLight ? 0.75 : 1;

      for (const s of segments) s.length = 0;
      for (const l of links) {
        const a = nodes[l.a];
        const b = nodes[l.b];
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d >= reach) continue;
        const fade =
          Math.pow(1 - d / reach, 1.3) *
          (0.25 + 0.75 * (a.depth + b.depth) * 0.5);
        const step = Math.min(LINK_STEPS - 1, Math.floor(fade * LINK_STEPS));
        if (step <= 0 && fade < 0.05) continue;
        segments[step].push(a.sx, a.sy, b.sx, b.sy);
      }
      ctx.lineWidth = 1;
      for (let s = 0; s < LINK_STEPS; s++) {
        const seg = segments[s];
        if (!seg.length) continue;
        ctx.strokeStyle = rgba(
          line,
          ((s + 0.6) / LINK_STEPS) * 0.72 * strength
        );
        ctx.beginPath();
        for (let i = 0; i < seg.length; i += 4) {
          ctx.moveTo(seg[i], seg[i + 1]);
          ctx.lineTo(seg[i + 2], seg[i + 3]);
        }
        ctx.stroke();
      }

      ctx.fillStyle = rgba(line, 1);
      for (const n of nodes) {
        ctx.globalAlpha = Math.min(
          1,
          (0.3 + 0.7 * n.depth + n.flash * 0.6) * strength
        );
        const r = (1 + 2 * n.depth) * Math.sqrt(size);
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Signals: start one now and then, pass each on when it arrives.
      nextSignal -= dt;
      if (nextSignal <= 0 && links.length) {
        nextSignal = rand(0.5, 1.2);
        const link = Math.floor(Math.random() * links.length);
        send(link, links[link].a);
      }
      ctx.globalCompositeOperation = isLight ? "source-over" : "lighter";
      const glowSprite = sprite(glow, "core");
      const passedOn: [link: number, from: number][] = [];
      signals = signals.filter((sig) => {
        sig.t += dt / sig.duration;
        const l = links[sig.link];
        const from = nodes[sig.forward ? l.a : l.b];
        const to = nodes[sig.forward ? l.b : l.a];
        if (sig.t >= 1) {
          to.flash = 1;
          if (Math.random() < 0.6 && to.links.length) {
            const next = to.links[Math.floor(Math.random() * to.links.length)];
            if (next !== sig.link)
              passedOn.push([next, sig.forward ? l.b : l.a]);
          }
          return false;
        }
        // Ease in and out along the link.
        const e = sig.t * sig.t * (3 - 2 * sig.t);
        const x = from.sx + (to.sx - from.sx) * e;
        const y = from.sy + (to.sy - from.sy) * e;
        const depth = from.depth + (to.depth - from.depth) * e;
        const r = (5 + 7 * depth) * Math.sqrt(size);
        ctx.globalAlpha =
          (0.35 + 0.6 * depth) * Math.sin(Math.PI * sig.t) * strength;
        ctx.drawImage(glowSprite, x - r, y - r, r * 2, r * 2);
        return true;
      });
      for (const [link, from] of passedOn) send(link, from);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  );
}
