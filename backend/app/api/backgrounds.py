"""Custom background image uploads and palette extraction."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import BACKGROUNDS_DIR, ensure_dirs

router = APIRouter(prefix="/api/backgrounds", tags=["backgrounds"])

ALLOWED_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".webm": "video/webm",
}
# Soft abuse ceiling only — frontend warns above 10MB.
MAX_BYTES = 100 * 1024 * 1024  # 100 MB


def _safe_id(raw: str) -> str:
    cleaned = "".join(c for c in raw if c.isalnum() or c in "-_")
    if not cleaned or ".." in raw:
        raise HTTPException(status_code=400, detail="Invalid background id")
    return cleaned


def _meta_path(bg_id: str) -> Path:
    return BACKGROUNDS_DIR / f"{bg_id}.json"


def _read_meta(bg_id: str) -> dict[str, Any]:
    path = _meta_path(bg_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _write_meta(bg_id: str, meta: dict[str, Any]) -> None:
    _meta_path(bg_id).write_text(json.dumps(meta), encoding="utf-8")


def _find_file(bg_id: str) -> Optional[Path]:
    ensure_dirs()
    for path in BACKGROUNDS_DIR.iterdir():
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


@router.get("")
def list_backgrounds():
    ensure_dirs()
    items: list[dict[str, Any]] = []
    for path in sorted(BACKGROUNDS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if path.is_file() and path.suffix.lower() in ALLOWED_EXT:
            items.append(_entry_for(path))
    return {"items": items}


@router.post("")
async def upload_background(file: UploadFile = File(...)):
    ensure_dirs()
    name = file.filename or "upload.bin"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail="Unsupported type. Use jpg, png, webp, gif, or webm.",
        )
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 100 MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    bg_id = uuid.uuid4().hex
    dest = BACKGROUNDS_DIR / f"{bg_id}{ext}"
    dest.write_bytes(data)
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


@router.get("/{bg_id}")
def get_background(bg_id: str):
    path = _find_file(_safe_id(bg_id))
    if path is None:
        raise HTTPException(status_code=404, detail="Background not found")
    mime = ALLOWED_EXT.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=mime)


@router.delete("/{bg_id}")
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


@router.post("/{bg_id}/palette")
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
    except Exception:  # noqa: BLE001
        return {"colors": []}
