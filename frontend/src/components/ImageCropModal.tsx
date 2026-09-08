import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent } from "react";
import LoadingIndicator from "./LoadingIndicator";
import {
  clampZoom,
  cropToJpegFile,
  imageCssTransform,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeCrop,
  panCrop,
  wrapRotationDeg,
  zoomAtPoint,
  type CropInput,
  type CropTransform,
} from "../utils/imageCrop";

const INITIAL_TRANSFORM: CropTransform = {
  zoom: 1,
  rotationDeg: 0,
  offsetX: 0,
  offsetY: 0,
};

function transformOf(value: CropTransform): CropTransform {
  return {
    zoom: value.zoom,
    rotationDeg: value.rotationDeg,
    offsetX: value.offsetX,
    offsetY: value.offsetY,
  };
}

const ZOOM_STEP = 1.15;

const controlButtonClass =
  "ui-interactive inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-600 text-gray-300 hover:border-accent hover:text-accent disabled:opacity-50";

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="5.25" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M7 9h4M16.25 16.25l-3.1-3.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="5.25" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9 6.75v4.5M6.75 9h4.5M16.25 16.25l-3.1-3.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RotateLeftIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
      <path
        d="M7.5 4.25 5 6.75l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.25 6.75h5.6a4.4 4.4 0 1 1 0 8.8H6.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RotateRightIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
      <path
        d="M12.5 4.25 15 6.75l-2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.75 6.75h-5.6a4.4 4.4 0 1 0 0 8.8H13.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function viewportPoint(
  el: HTMLElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return {
    x: clientX - (rect.left + rect.width / 2),
    y: clientY - (rect.top + rect.height / 2),
  };
}

export default function ImageCropModal({
  file,
  title = "Edit cover",
  confirmLabel = "Use cover",
  onCancel,
  onConfirm,
}: {
  file: File;
  title?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (file: File) => void | Promise<void>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageElRef = useRef<HTMLImageElement>(null);
  const lastSizeRef = useRef({ width: 0, height: 0 });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const cropRef = useRef<CropTransform>(INITIAL_TRANSFORM);
  const naturalRef = useRef({ width: 0, height: 0 });
  const mountedRef = useRef(true);

  const [src, setSrc] = useState<string | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [crop, setCropState] = useState<CropTransform>(INITIAL_TRANSFORM);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  cropRef.current = crop;
  naturalRef.current = natural;
  const ready =
    natural.width > 0 &&
    natural.height > 0 &&
    viewport.width > 1 &&
    viewport.height > 1 &&
    !loadError;

  const cropInput = useCallback(
    (transform: CropTransform = cropRef.current): CropInput => ({
      imageWidth: natural.width,
      imageHeight: natural.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      ...transformOf(transform),
    }),
    [natural.height, natural.width, viewport.height, viewport.width]
  );

  const setCrop = useCallback(
    (next: CropTransform | ((prev: CropTransform) => CropTransform)) => {
      setCropState((prev) => {
        const raw = typeof next === "function" ? next(prev) : next;
        return transformOf(normalizeCrop(cropInput(raw)));
      });
    },
    [cropInput]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setNatural({ width: 0, height: 0 });
    setCropState(INITIAL_TRANSFORM);
    setLoadError(null);
    setActionError(null);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    lastSizeRef.current = { width: 0, height: 0 };

    const applySize = (width: number, height: number) => {
      if (width < 1 || height < 1) return;
      const prev = lastSizeRef.current;
      lastSizeRef.current = { width, height };
      setViewport({ width, height });
      const k = prev.width > 0 ? width / prev.width : 1;
      const { width: imageWidth, height: imageHeight } = naturalRef.current;
      setCropState((cropPrev) =>
        transformOf(
          normalizeCrop({
            imageWidth,
            imageHeight,
            viewportWidth: width,
            viewportHeight: height,
            zoom: cropPrev.zoom,
            rotationDeg: cropPrev.rotationDeg,
            offsetX: cropPrev.offsetX * k,
            offsetY: cropPrev.offsetY * k,
          })
        )
      );
    };

    const read = () => {
      const rect = el.getBoundingClientRect();
      applySize(rect.width, rect.height);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [src]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !ready) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const focal = viewportPoint(el, event.clientX, event.clientY);
      setCrop((prev) =>
        zoomAtPoint(
          cropInput(prev),
          prev.zoom * Math.exp(-event.deltaY * 0.0015),
          focal
        )
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [cropInput, ready, setCrop]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!ready || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size === 1) {
      dragRef.current = { x: event.clientX, y: event.clientY };
      setDragging(true);
    } else if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      pinchRef.current = {
        distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        zoom: cropRef.current.zoom,
      };
      dragRef.current = null;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const el = viewportRef.current;
    if (!el) return;

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()];
      const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (distance < 1 || pinchRef.current.distance < 1) return;
      const focal = viewportPoint(
        el,
        (pts[0].x + pts[1].x) / 2,
        (pts[0].y + pts[1].y) / 2
      );
      const nextZoom =
        pinchRef.current.zoom * (distance / pinchRef.current.distance);
      setCrop((prev) => zoomAtPoint(cropInput(prev), nextZoom, focal));
      return;
    }

    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    dragRef.current = { x: event.clientX, y: event.clientY };
    setCrop((prev) => panCrop(cropInput(prev), dx, dy));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      dragRef.current = null;
      setDragging(false);
    } else if (pointersRef.current.size === 1) {
      const remaining = [...pointersRef.current.values()][0];
      dragRef.current = { x: remaining.x, y: remaining.y };
    }
  };

  const confirm = async () => {
    const image = imageElRef.current;
    if (!image || !ready || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const next = await cropToJpegFile(image, cropInput(), "cover.jpg");
      await onConfirm(next);
    } catch (err) {
      if (!mountedRef.current) return;
      setActionError(
        err instanceof Error ? err.message : "Could not save cover"
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={() => {
        if (!busy) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="image-crop-title"
    >
      <div
        className="ui-panel ui-panel-legible max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl ring-1 ring-ink-700 sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2
              id="image-crop-title"
              className="text-lg font-semibold text-gray-100"
            >
              {title}
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              Drag to reposition. Crop stays 16:9.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-gray-500 hover:text-gray-300 disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          ref={viewportRef}
          className={`relative aspect-video w-full overflow-hidden rounded-lg bg-ink-950 ring-1 ring-ink-700 ${
            ready ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
          }`}
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {src && !loadError ? (
            <img
              ref={imageElRef}
              src={src}
              alt=""
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onLoad={(event) => {
                const img = event.currentTarget;
                setNatural({
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                });
              }}
              onError={() => setLoadError("Could not read image")}
              className="absolute left-1/2 top-1/2 max-w-none cursor-inherit select-none"
              style={{
                width: natural.width || undefined,
                height: natural.height || undefined,
                marginLeft: natural.width ? -natural.width / 2 : undefined,
                marginTop: natural.height ? -natural.height / 2 : undefined,
                transformOrigin: "center center",
                transform: ready ? imageCssTransform(cropInput()) : undefined,
                visibility: ready ? "visible" : "hidden",
              }}
            />
          ) : null}
          {ready ? (
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-y-0 left-1/3 w-px bg-white/20" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-white/20" />
              <div className="absolute inset-x-0 top-1/3 h-px bg-white/20" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-white/20" />
              <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/25" />
            </div>
          ) : null}
          {!ready && !loadError ? (
            <LoadingIndicator className="absolute inset-0 py-0" />
          ) : null}
        </div>

        {loadError ? (
          <p className="mt-3 text-sm text-red-400">{loadError}</p>
        ) : null}
        {actionError ? (
          <p className="mt-3 text-sm text-red-400">{actionError}</p>
        ) : null}

        <div className="mt-4 space-y-3">
          <div>
            <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
              <span>Zoom</span>
              <span className="tabular-nums text-gray-500">
                {crop.zoom.toFixed(2)}×
              </span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!ready || busy || crop.zoom <= MIN_ZOOM}
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() =>
                  setCrop((prev) =>
                    zoomAtPoint(
                      cropInput(prev),
                      prev.zoom / ZOOM_STEP,
                      { x: 0, y: 0 }
                    )
                  )
                }
                className={controlButtonClass}
              >
                <ZoomOutIcon />
              </button>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={crop.zoom}
                disabled={!ready || busy}
                aria-label="Zoom"
                onChange={(event) => {
                  const nextZoom = clampZoom(Number(event.target.value));
                  setCrop((prev) =>
                    zoomAtPoint(cropInput(prev), nextZoom, { x: 0, y: 0 })
                  );
                }}
                className="accent-scrubber min-w-0 flex-1"
              />
              <button
                type="button"
                disabled={!ready || busy || crop.zoom >= MAX_ZOOM}
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() =>
                  setCrop((prev) =>
                    zoomAtPoint(
                      cropInput(prev),
                      prev.zoom * ZOOM_STEP,
                      { x: 0, y: 0 }
                    )
                  )
                }
                className={controlButtonClass}
              >
                <ZoomInIcon />
              </button>
            </div>
          </div>

          <div>
            <span className="mb-2 flex items-center justify-between text-sm text-gray-300">
              <span>Rotate</span>
              <span className="tabular-nums text-gray-500">
                {Math.round(crop.rotationDeg)}°
              </span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!ready || busy}
                aria-label="Rotate left"
                title="Rotate left"
                onClick={() =>
                  setCrop((prev) => ({
                    ...prev,
                    rotationDeg: wrapRotationDeg(prev.rotationDeg - 90),
                  }))
                }
                className={controlButtonClass}
              >
                <RotateLeftIcon />
              </button>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={crop.rotationDeg}
                disabled={!ready || busy}
                aria-label="Rotation"
                onChange={(event) =>
                  setCrop((prev) => ({
                    ...prev,
                    rotationDeg: Number(event.target.value),
                  }))
                }
                className="accent-scrubber min-w-0 flex-1"
              />
              <button
                type="button"
                disabled={!ready || busy}
                aria-label="Rotate right"
                title="Rotate right"
                onClick={() =>
                  setCrop((prev) => ({
                    ...prev,
                    rotationDeg: wrapRotationDeg(prev.rotationDeg + 90),
                  }))
                }
                className={controlButtonClass}
              >
                <RotateRightIcon />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => void confirm()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
          >
            {busy ? "Saving…" : confirmLabel}
          </button>
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => setCrop(INITIAL_TRANSFORM)}
            className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-gray-300 hover:border-accent hover:text-accent disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
