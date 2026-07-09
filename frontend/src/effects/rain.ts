import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
  width: number;
  alpha: number;
  wind: number;
}

export function createRainEffect(canvas: HTMLCanvasElement): EffectController {
  let drops: Drop[] = [];
  let lastW = 0;
  let lastH = 0;

  const spawn = (w: number, h: number, anywhere: boolean): Drop => ({
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : -rand(0, h * 0.35),
    len: rand(12, 28),
    speed: rand(380, 720),
    width: rand(1, 1.8),
    alpha: rand(0.2, 0.55),
    wind: rand(20, 55),
  });

  const rebuild = (w: number, h: number) => {
    const count = Math.floor((w * h) / 9000);
    drops = Array.from({ length: Math.max(40, count) }, () =>
      spawn(w, h, true)
    );
  };

  return createCanvasLoop(canvas, ({ ctx, width, height, accent, dt }) => {
    // Only rebuild on meaningful size changes (avoids "loop restart" hitch).
    if (Math.abs(width - lastW) > 8 || Math.abs(height - lastH) > 8) {
      lastW = width;
      lastH = height;
      rebuild(width, height);
    }
    if (width <= 0 || height <= 0) return;

    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";

    const span = height + 60;
    for (const d of drops) {
      d.y += d.speed * dt;
      d.x += d.wind * dt;

      // Continuous wrap — no random teleport that looks like a loop cut.
      if (d.y > span) {
        d.y -= span + d.len;
      }
      if (d.x > width + 10) d.x -= width + 20;
      if (d.x < -10) d.x += width + 20;

      ctx.strokeStyle = rgba(accent, d.alpha);
      ctx.lineWidth = d.width;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.wind * 0.04, d.y + d.len);
      ctx.stroke();
    }
  });
}
