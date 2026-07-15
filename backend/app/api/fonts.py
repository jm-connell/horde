"""Custom UI font file uploads (stored under DATA_DIR/fonts)."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import FONTS_DIR, ensure_dirs

router = APIRouter(prefix="/api/fonts", tags=["fonts"])

ALLOWED_EXT = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}
MAX_BYTES = 8 * 1024 * 1024  # 8 MB


def _safe_id(raw: str) -> str:
    cleaned = "".join(c for c in raw if c.isalnum() or c in "-_")
    if not cleaned or ".." in raw:
        raise HTTPException(status_code=400, detail="Invalid font id")
    return cleaned


def _meta_path(font_id: str) -> Path:
    return FONTS_DIR / f"{font_id}.json"


def _read_meta(font_id: str) -> dict[str, Any]:
    path = _meta_path(font_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _write_meta(font_id: str, meta: dict[str, Any]) -> None:
    _meta_path(font_id).write_text(json.dumps(meta), encoding="utf-8")


def _find_file(font_id: str) -> Optional[Path]:
    ensure_dirs()
    for path in FONTS_DIR.iterdir():
        if path.is_file() and path.stem == font_id and path.suffix.lower() in ALLOWED_EXT:
            return path
    return None


def _entry_for(path: Path) -> dict[str, Any]:
    font_id = path.stem
    mime = ALLOWED_EXT.get(path.suffix.lower(), "application/octet-stream")
    meta = _read_meta(font_id)
    return {
        "id": font_id,
        "url": f"/api/fonts/{font_id}",
        "mime": mime,
        "filename": meta.get("filename") or path.name,
    }


@router.get("")
def list_fonts():
    ensure_dirs()
    items: list[dict[str, Any]] = []
    for path in sorted(FONTS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if path.is_file() and path.suffix.lower() in ALLOWED_EXT:
            items.append(_entry_for(path))
    return {"items": items}


@router.post("")
async def upload_font(file: UploadFile = File(...)):
    ensure_dirs()
    name = file.filename or "font.bin"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail="Unsupported type. Use woff2, woff, ttf, or otf.",
        )
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 8 MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    font_id = uuid.uuid4().hex
    dest = FONTS_DIR / f"{font_id}{ext}"
    dest.write_bytes(data)
    _write_meta(font_id, {"filename": Path(name).name})
    return {
        "id": font_id,
        "url": f"/api/fonts/{font_id}",
        "mime": ALLOWED_EXT[ext],
        "filename": Path(name).name,
    }


@router.get("/{font_id}")
def get_font(font_id: str):
    path = _find_file(_safe_id(font_id))
    if path is None:
        raise HTTPException(status_code=404, detail="Font not found")
    mime = ALLOWED_EXT.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(
        path,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.delete("/{font_id}")
def delete_font(font_id: str):
    safe = _safe_id(font_id)
    path = _find_file(safe)
    if path is None:
        raise HTTPException(status_code=404, detail="Font not found")
    try:
        path.unlink()
        meta = _meta_path(safe)
        if meta.is_file():
            meta.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"ok": True}
