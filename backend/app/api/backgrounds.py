"""Custom background image uploads and palette extraction."""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..auth import require_admin
from ..context import get_paths
from ..openapi_responses import BACKGROUND_FILE, RAW
from ..response_schemas import (
    BackgroundList,
    BackgroundPalette,
    BackgroundRead,
    OkResponse,
)
from ..services import uploads

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backgrounds", tags=["backgrounds"])

ALLOWED_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".webm": "video/webm",
}
# Hard ceiling is uploads.BACKGROUND_MAX_BYTES; the frontend warns above 10MB.
_IMAGE_FORMATS = {
    ".jpg": ("JPEG",),
    ".jpeg": ("JPEG",),
    ".png": ("PNG",),
    ".webp": ("WEBP",),
    ".gif": ("GIF",),
}


def _safe_id(raw: str) -> str:
    cleaned = "".join(c for c in raw if c.isalnum() or c in "-_")
    if not cleaned or ".." in raw:
        raise HTTPException(status_code=400, detail="Invalid background id")
    return cleaned


def _meta_path(bg_id: str) -> Path:
    return get_paths().backgrounds / f"{bg_id}.json"


def _read_meta(bg_id: str) -> dict[str, Any]:
    path = _meta_path(bg_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        logger.debug("background metadata unreadable", exc_info=True)
        return {}


def _write_meta(bg_id: str, meta: dict[str, Any]) -> None:
    _meta_path(bg_id).write_text(json.dumps(meta), encoding="utf-8")


def _find_file(bg_id: str) -> Path | None:
    get_paths().ensure()
    for path in get_paths().backgrounds.iterdir():
        if path.is_file() and path.stem == bg_id and path.suffix.lower() in ALLOWED_EXT:
            return path
    return None


def _entry_for(path: Path) -> dict[str, Any]:
    bg_id = path.stem
    mime = ALLOWED_EXT.get(path.suffix.lower(), "application/octet-stream")
    meta = _read_meta(bg_id)
    return {
        "id": bg_id,
        "url": f"/api/backgrounds/{bg_id}",
        "mime": mime,
        "animated": mime in ("image/gif", "video/webm"),
        "filename": meta.get("filename") or path.name,
    }


@router.get("", response_model=BackgroundList)
def list_backgrounds():
    get_paths().ensure()
    items: list[dict[str, Any]] = []
    for path in sorted(
        get_paths().backgrounds.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True
    ):
        if path.is_file() and path.suffix.lower() in ALLOWED_EXT:
            items.append(_entry_for(path))
    return {"items": items}


@router.post("", response_model=BackgroundRead, dependencies=[Depends(require_admin)])
def upload_background(file: UploadFile = File(...)):
    get_paths().ensure()
    name = file.filename or "upload.bin"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail="Unsupported type. Use jpg, png, webp, gif, or webm.",
        )
    if (
        uploads.count_files(get_paths().backgrounds, set(ALLOWED_EXT))
        >= uploads.MAX_STORED_BACKGROUNDS
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Too many backgrounds (max {uploads.MAX_STORED_BACKGROUNDS}). "
                "Delete one first."
            ),
        )

    bg_id = uuid.uuid4().hex
    dest = get_paths().backgrounds / f"{bg_id}{ext}"
    size = uploads.save_upload(file, dest, max_bytes=uploads.BACKGROUND_MAX_BYTES)
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty file")
    if ext == ".webm":
        with dest.open("rb") as fh:
            valid = uploads.is_webm(fh.read(4))
    else:
        valid = uploads.verify_image_file(dest, _IMAGE_FORMATS[ext])
    if not valid:
        dest.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400, detail=f"Not a valid {ext.lstrip('.')} file"
        )
    _write_meta(bg_id, {"filename": Path(name).name})
    mime = ALLOWED_EXT[ext]
    animated = mime in ("image/gif", "video/webm")
    return {
        "id": bg_id,
        "url": f"/api/backgrounds/{bg_id}",
        "mime": mime,
        "animated": animated,
        "filename": Path(name).name,
    }


@router.get("/{bg_id}", response_class=RAW, responses=BACKGROUND_FILE)
def get_background(bg_id: str):
    path = _find_file(_safe_id(bg_id))
    if path is None:
        raise HTTPException(status_code=404, detail="Background not found")
    mime = ALLOWED_EXT.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=mime)


@router.delete(
    "/{bg_id}", response_model=OkResponse, dependencies=[Depends(require_admin)]
)
def delete_background(bg_id: str):
    safe = _safe_id(bg_id)
    path = _find_file(safe)
    if path is None:
        raise HTTPException(status_code=404, detail="Background not found")
    try:
        path.unlink()
        meta = _meta_path(safe)
        if meta.is_file():
            meta.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"ok": True}


@router.post(
    "/{bg_id}/palette",
    response_model=BackgroundPalette,
    dependencies=[Depends(require_admin)],
)
def extract_palette(bg_id: str):
    path = _find_file(_safe_id(bg_id))
    if path is None:
        raise HTTPException(status_code=404, detail="Background not found")
    if path.suffix.lower() == ".webm":
        return {"colors": []}
    try:
        from PIL import Image  # type: ignore

        img = Image.open(path)
        img = img.convert("RGB")
        img.thumbnail((160, 160))
        quantized = img.quantize(colors=8, method=Image.Quantize.MEDIANCUT)
        palette = quantized.getpalette() or []
        counts = quantized.getcolors() or []
        ranked: list[tuple[int, str]] = []
        for count, idx in counts:
            if not isinstance(idx, int):
                continue
            r, g, b = palette[idx * 3 : idx * 3 + 3]
            luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
            if luma < 18 or luma > 240:
                continue
            ranked.append((count, f"#{r:02x}{g:02x}{b:02x}"))
        ranked.sort(key=lambda x: x[0], reverse=True)
        colors = [c for _, c in ranked[:6]]
        return {"colors": colors}
    except Exception:
        logger.warning("palette extraction failed", exc_info=True)
        return {"colors": []}
