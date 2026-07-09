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
  const fontSize = 14;

  const rebuild = (w: number, h: number) => {
    const count = Math.floor(w / fontSize);
    columns = Array.from({ length: count }, (_, i) => {
      const trail = Math.floor(rand(8, 22));
      return {
        x: i * fontSize,
        y: rand(-h, 0),
        speed: rand(40, 120),
        chars: Array.from({ length: trail }, randomGlyph),
        trail,
      };
    });
  };

  return createCanvasLoop(canvas, ({ ctx, width, height, accent, dt }) => {
    if (width !== lastW || height !== lastH) {
      lastW = width;
      lastH = height;
      rebuild(width, height);
    }

    ctx.clearRect(0, 0, width, height);
    ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "top";

    for (const col of columns) {
      col.y += col.speed * dt;
      if (col.y - col.trail * fontSize > height) {
        col.y = rand(-height * 0.3, 0);
        col.speed = rand(40, 120);
        col.chars = Array.from({ length: col.trail }, randomGlyph);
      }

      for (let i = 0; i < col.chars.length; i++) {
        if (Math.random() < 0.02) col.chars[i] = randomGlyph();
        const gy = col.y - i * fontSize;
        if (gy < -fontSize || gy > height) continue;
        const head = i === 0;
        ctx.fillStyle = rgba(accent, head ? 0.85 : Math.max(0.08, 0.45 - i * 0.03));
        ctx.fillText(col.chars[i], col.x, gy);
      }
    }
  });
}
