import { describe, expect, it } from "vitest";
import {
  clampOffset,
  clampZoom,
  coverScale,
  cropCoversImage,
  normalizeCrop,
  outputSize,
  panCrop,
  renderScale,
  wrapRotationDeg,
  zoomAtPoint,
  type CropInput,
} from "./imageCrop";

const landscape: CropInput = {
  imageWidth: 1920,
  imageHeight: 1080,
  viewportWidth: 640,
  viewportHeight: 360,
  zoom: 1,
  rotationDeg: 0,
  offsetX: 0,
  offsetY: 0,
};

const square: CropInput = {
  imageWidth: 1000,
  imageHeight: 1000,
  viewportWidth: 1600,
  viewportHeight: 900,
  zoom: 1,
  rotationDeg: 0,
  offsetX: 0,
  offsetY: 0,
};

describe("wrapRotationDeg", () => {
  it("wraps to (-180, 180]", () => {
    expect(wrapRotationDeg(0)).toBe(0);
    expect(wrapRotationDeg(90)).toBe(90);
    expect(wrapRotationDeg(180)).toBe(180);
    expect(wrapRotationDeg(-180)).toBe(180);
    expect(wrapRotationDeg(210)).toBe(-150);
    expect(wrapRotationDeg(-270)).toBe(90);
  });
});

describe("clampZoom", () => {
  it("keeps zoom in [1, 4]", () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(clampZoom(9)).toBe(4);
  });
});

describe("coverScale", () => {
  it("fits a matching 16:9 image exactly", () => {
    expect(
      coverScale(1920, 1080, 640, 360, 0)
    ).toBeCloseTo(640 / 1920, 6);
  });

  it("covers a square by the wider viewport side", () => {
    expect(coverScale(1000, 1000, 1600, 900, 0)).toBeCloseTo(1.6, 6);
  });

  it("swaps axes when rotated 90°", () => {
    expect(coverScale(1920, 1080, 1600, 900, 90)).toBeCloseTo(1600 / 1080, 6);
  });
});

describe("clampOffset", () => {
  it("forbids pan when the image exactly covers the frame", () => {
    const offset = clampOffset({ ...landscape, offsetX: 400, offsetY: -80 });
    expect(offset.x).toBeCloseTo(0, 5);
    expect(offset.y).toBeCloseTo(0, 5);
  });

  it("allows vertical pan on a square cover-fit", () => {
    const offset = clampOffset({ ...square, offsetY: 10_000 });
    expect(offset.x).toBeCloseTo(0, 5);
    expect(offset.y).toBeCloseTo(350, 5);
  });

  it("keeps the 16:9 window inside the image after rotate + pan", () => {
    const next = normalizeCrop({
      ...square,
      rotationDeg: 33,
      zoom: 2.2,
      offsetX: 180,
      offsetY: -90,
    });
    expect(cropCoversImage(next)).toBe(true);
    expect(next.rotationDeg).toBe(33);
    expect(next.zoom).toBe(2.2);
  });

  it("covers after a 90° rotate on a landscape source", () => {
    const next = normalizeCrop({ ...landscape, rotationDeg: 90, zoom: 1 });
    expect(cropCoversImage(next)).toBe(true);
    expect(next.offsetX).toBeCloseTo(0, 5);
    expect(next.offsetY).toBeCloseTo(0, 5);
  });
});

describe("zoomAtPoint", () => {
  it("keeps offset at 0 when zooming around the center", () => {
    const next = zoomAtPoint(landscape, 2, { x: 0, y: 0 });
    expect(next.zoom).toBe(2);
    expect(next.offsetX).toBeCloseTo(0, 6);
    expect(next.offsetY).toBeCloseTo(0, 6);
  });

  it("shifts offset so the focal viewport point stays put before clamp", () => {
    const wide: CropInput = {
      ...landscape,
      imageWidth: 4000,
      imageHeight: 3000,
      zoom: 1,
    };
    const next = zoomAtPoint(wide, 2, { x: 100, y: 0 });
    expect(next.zoom).toBe(2);
    expect(cropCoversImage(next)).toBe(true);
    expect(next.offsetX).toBeCloseTo(-100, 4);
  });
});

describe("panCrop", () => {
  it("clamps a pan that would expose empty space", () => {
    const next = panCrop(landscape, 50, 50);
    expect(next.offsetX).toBeCloseTo(0, 5);
    expect(next.offsetY).toBeCloseTo(0, 5);
  });
});

describe("renderScale", () => {
  it("multiplies cover scale by zoom", () => {
    expect(renderScale({ ...landscape, zoom: 2 })).toBeCloseTo(
      2 * (640 / 1920),
      6
    );
  });
});

describe("outputSize", () => {
  it("exports 1280×720 for a 16:9 viewport", () => {
    expect(outputSize(640, 360)).toEqual({ width: 1280, height: 720 });
  });
});
