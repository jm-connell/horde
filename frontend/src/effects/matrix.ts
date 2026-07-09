import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Column {
  x: number;
  y: number;
  speed: number;
  chars: string[];
  trail: number;
}

const GLYPHS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEF<>{}[]/*+#";

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
}

export function createMatrixEffect(canvas: HTMLCanvasElement): EffectController {
  let columns: Column[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  const baseFont = 14;

  const rebuild = (w: number, h: number, size: number) => {
    const step = Math.max(10, baseFont / Math.sqrt(size));
    const count = Math.floor(w / step);
    columns = Array.from({ length: count }, (_, i) => {
      const trail = Math.floor(rand(8, 22) * size);
      return {
        x: i * step,
        y: rand(-h, 0),
        speed: rand(40, 120),
        chars: Array.from({ length: Math.max(4, trail) }, randomGlyph),
        trail: Math.max(4, trail),
      };
    });
  };

  return createCanvasLoop(canvas, ({ ctx, width, height, accent, dt, size }) => {
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
    const fs = baseFont * Math.sqrt(size);
    ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "top";

    for (const col of columns) {
      col.y += col.speed * dt;
      if (col.y - col.trail * fs > height) {
        col.y = rand(-height * 0.3, 0);
        col.speed = rand(40, 120);
        col.chars = Array.from({ length: col.trail }, randomGlyph);
      }

      for (let i = 0; i < col.chars.length; i++) {
        if (Math.random() < 0.02) col.chars[i] = randomGlyph();
        const gy = col.y - i * fs;
        if (gy < -fs || gy > height) continue;
        const head = i === 0;
        ctx.fillStyle = rgba(
          accent,
          head ? 0.85 : Math.max(0.08, 0.45 - i * 0.03)
        );
        ctx.fillText(col.chars[i], col.x, gy);
      }
    }
  });
}
