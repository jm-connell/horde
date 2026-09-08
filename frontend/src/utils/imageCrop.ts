/** 16:9 cover crop: zoom is a multiplier on the scale that just covers the frame. */

export const CROP_ASPECT = 16 / 9;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const OUTPUT_WIDTH = 1280;

export type CropTransform = {
  zoom: number;
  rotationDeg: number;
  offsetX: number;
  offsetY: number;
};

export type CropInput = CropTransform & {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type Point = { x: number; y: number };

const EPS = 1e-6;

export function wrapRotationDeg(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function rotateVec(x: number, y: number, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}

function cropCorners(viewportWidth: number, viewportHeight: number): Point[] {
  const hx = viewportWidth / 2;
  const hy = viewportHeight / 2;
  return [
    { x: hx, y: hy },
    { x: -hx, y: hy },
    { x: hx, y: -hy },
    { x: -hx, y: -hy },
  ];
}

/** Smallest scale that covers the viewport after rotation (zoom = 1). */
export function coverScale(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  rotationDeg: number
): number {
  if (imageWidth < 1 || imageHeight < 1 || viewportWidth < 1 || viewportHeight < 1) {
    return 1;
  }
  let scale = 0;
  for (const p of cropCorners(viewportWidth, viewportHeight)) {
    const q = rotateVec(p.x, p.y, -rotationDeg);
    scale = Math.max(
      scale,
      (2 * Math.abs(q.x)) / imageWidth,
      (2 * Math.abs(q.y)) / imageHeight
    );
  }
  return scale;
}

export function renderScale(input: CropInput): number {
  return (
    coverScale(
      input.imageWidth,
      input.imageHeight,
      input.viewportWidth,
      input.viewportHeight,
      input.rotationDeg
    ) * clampZoom(input.zoom)
  );
}

export function clampOffset(input: CropInput): Point {
  const scale = renderScale(input);
  const halfW = (input.imageWidth * scale) / 2;
  const halfH = (input.imageHeight * scale) / 2;
  let uMinX = -Infinity;
  let uMaxX = Infinity;
  let uMinY = -Infinity;
  let uMaxY = Infinity;
  for (const p of cropCorners(input.viewportWidth, input.viewportHeight)) {
    const r = rotateVec(p.x, p.y, -input.rotationDeg);
    uMinX = Math.max(uMinX, r.x - halfW);
    uMaxX = Math.min(uMaxX, r.x + halfW);
    uMinY = Math.max(uMinY, r.y - halfH);
    uMaxY = Math.min(uMaxY, r.y + halfH);
  }
  const u = rotateVec(input.offsetX, input.offsetY, -input.rotationDeg);
  const ux =
    uMinX > uMaxX ? (uMinX + uMaxX) / 2 : Math.min(uMaxX, Math.max(uMinX, u.x));
  const uy =
    uMinY > uMaxY ? (uMinY + uMaxY) / 2 : Math.min(uMaxY, Math.max(uMinY, u.y));
  return rotateVec(ux, uy, input.rotationDeg);
}

export function normalizeCrop(input: CropInput): CropInput {
  if (
    input.imageWidth < 1 ||
    input.imageHeight < 1 ||
    input.viewportWidth < 1 ||
    input.viewportHeight < 1
  ) {
    return {
      ...input,
      zoom: clampZoom(input.zoom),
      rotationDeg: wrapRotationDeg(input.rotationDeg),
    };
  }
  const next: CropInput = {
    ...input,
    zoom: clampZoom(input.zoom),
    rotationDeg: wrapRotationDeg(input.rotationDeg),
  };
  const offset = clampOffset(next);
  return { ...next, offsetX: offset.x, offsetY: offset.y };
}

/** Keep the image point under `focal` (viewport coords, crop-centered) stable. */
export function zoomAtPoint(
  input: CropInput,
  nextZoom: number,
  focal: Point
): CropInput {
  const zoom = clampZoom(nextZoom);
  const k = zoom / clampZoom(input.zoom);
  return normalizeCrop({
    ...input,
    zoom,
    offsetX: focal.x - k * (focal.x - input.offsetX),
    offsetY: focal.y - k * (focal.y - input.offsetY),
  });
}

export function panCrop(input: CropInput, dx: number, dy: number): CropInput {
  return normalizeCrop({
    ...input,
    offsetX: input.offsetX + dx,
    offsetY: input.offsetY + dy,
  });
}

export function outputSize(
  viewportWidth: number,
  viewportHeight: number
): { width: number; height: number } {
  const aspect =
    viewportWidth > 0 && viewportHeight > 0
      ? viewportWidth / viewportHeight
      : CROP_ASPECT;
  const width = OUTPUT_WIDTH;
  const height = Math.max(1, Math.round(width / aspect));
  return { width, height };
}

export function cropCoversImage(input: CropInput, epsilon = EPS): boolean {
  const scale = renderScale(input);
  const hx = input.imageWidth / 2;
  const hy = input.imageHeight / 2;
  for (const p of cropCorners(input.viewportWidth, input.viewportHeight)) {
    const q = rotateVec(
      p.x - input.offsetX,
      p.y - input.offsetY,
      -input.rotationDeg
    );
    if (Math.abs(q.x / scale) > hx + epsilon) return false;
    if (Math.abs(q.y / scale) > hy + epsilon) return false;
  }
  return true;
}

export function imageCssTransform(input: CropInput): string {
  const scale = renderScale(input);
  return `translate(${input.offsetX}px, ${input.offsetY}px) rotate(${input.rotationDeg}deg) scale(${scale})`;
}

export function drawCroppedImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  input: CropInput,
  outWidth: number,
  outHeight: number
): void {
  const scale = renderScale(input);
  const sx = outWidth / input.viewportWidth;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, outWidth, outHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(
    outWidth / 2 + input.offsetX * sx,
    outHeight / 2 + input.offsetY * sx
  );
  ctx.rotate((input.rotationDeg * Math.PI) / 180);
  ctx.scale(scale * sx, scale * sx);
  ctx.drawImage(image, -input.imageWidth / 2, -input.imageHeight / 2);
}

export function cropToJpegFile(
  image: CanvasImageSource,
  input: CropInput,
  filename = "cover.jpg"
): Promise<File> {
  const { width, height } = outputSize(input.viewportWidth, input.viewportHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Could not crop image"));
  drawCroppedImage(ctx, image, input, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not crop image"));
          return;
        }
        resolve(new File([blob], filename, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9
    );
  });
}
