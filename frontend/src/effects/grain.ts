import { createCanvasLoop, type EffectController } from "./shared";

export function createGrainEffect(canvas: HTMLCanvasElement): EffectController {
  let pattern: ImageData | null = null;
  let offscreen: HTMLCanvasElement | null = null;
  let offCtx: CanvasRenderingContext2D | null = null;
  let lastW = 0;
  let lastH = 0;
  let tick = 0;

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, isLight }) => {
      const nw = Math.max(1, Math.floor(width / 2));
      const nh = Math.max(1, Math.floor(height / 2));
      if (!pattern || !offscreen || !offCtx || nw !== lastW || nh !== lastH) {
        lastW = nw;
        lastH = nh;
        pattern = ctx.createImageData(nw, nh);
        offscreen = document.createElement("canvas");
        offscreen.width = nw;
        offscreen.height = nh;
        offCtx = offscreen.getContext("2d");
      }

      tick += 1;
      // Refresh grain every other frame
      if (tick % 2 === 1 && pattern && offCtx && offscreen) {
        const data = pattern.data;
        const base = isLight ? 180 : 40;
        for (let i = 0; i < data.length; i += 4) {
          const v = base + (Math.random() * 70 - 35);
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = isLight ? 28 : 36;
        }
        offCtx.putImageData(pattern, 0, 0);
      }

      if (offscreen) {
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(offscreen, 0, 0, width, height);
      }
    },
    { maxDpr: 1 }
  );
}
