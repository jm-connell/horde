import os
from pathlib import Path


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).resolve()


DOWNLOADS_DIR: Path = _env_path("DOWNLOADS_DIR", "./downloads")
DATA_DIR: Path = _env_path("DATA_DIR", "./data")

THUMBNAILS_DIR: Path = DATA_DIR / "thumbnails"
DB_PATH: Path = DATA_DIR / "horde.db"
DATABASE_URL: str = f"sqlite:///{DB_PATH}"

# How often the fallback poller walks the downloads tree (seconds).
SCAN_INTERVAL_SEC: int = int(os.environ.get("SCAN_INTERVAL_SEC", "60"))

# Video extensions the scanner treats as importable media.
VIDEO_EXTENSIONS: set[str] = {".mp4", ".mkv", ".webm"}

# Host/port for uvicorn (entrypoint reads these too).
HOST: str = os.environ.get("HOST", "0.0.0.0")
PORT: int = int(os.environ.get("PORT", "8080"))


def ensure_dirs() -> None:
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
