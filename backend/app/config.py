import os
import subprocess
from pathlib import Path
from typing import Optional


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).resolve()


def _optional_env_path(name: str) -> Optional[Path]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


DOWNLOADS_DIR: Path = _env_path("DOWNLOADS_DIR", "./downloads")
DATA_DIR: Path = _env_path("DATA_DIR", "./data")

THUMBNAILS_DIR: Path = DATA_DIR / "thumbnails"
SPRITES_DIR: Path = DATA_DIR / "sprites"
BACKGROUNDS_DIR: Path = DATA_DIR / "backgrounds"
FONTS_DIR: Path = DATA_DIR / "fonts"
DB_PATH: Path = DATA_DIR / "horde.db"
DATABASE_URL: str = f"sqlite:///{DB_PATH}"

# How often the fallback poller walks the downloads tree (seconds).
SCAN_INTERVAL_SEC: int = int(os.environ.get("SCAN_INTERVAL_SEC", "60"))

# Video extensions the scanner treats as importable media.
VIDEO_EXTENSIONS: set[str] = {".mp4", ".mkv", ".webm"}

# Host/port for uvicorn (entrypoint reads these too).
HOST: str = os.environ.get("HOST", "0.0.0.0")
PORT: int = int(os.environ.get("PORT", "8080"))

# Max simultaneous download workers (FIFO queue).
MAX_DOWNLOAD_CONCURRENCY: int = int(os.environ.get("MAX_DOWNLOAD_CONCURRENCY", "2"))

# YouTube bot checks — bgutil POT sidecar (default in Docker) or cookie fallback.
# See https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
YTDLP_POT_BASE_URL: str = os.environ.get("YTDLP_POT_BASE_URL", "").strip()
YTDLP_COOKIE_FILE: Optional[Path] = _optional_env_path("YTDLP_COOKIE_FILE")
YTDLP_COOKIES_FROM_BROWSER: str = os.environ.get(
    "YTDLP_COOKIES_FROM_BROWSER", ""
).strip()

# Ollama base URL. Empty = auto-discover (compose service, then host.docker.internal).
OLLAMA_BASE_URL: str = os.environ.get("OLLAMA_BASE_URL", "").strip()

# Update checks — baked at Docker build time; falls back to local git in dev.
HORDE_GITHUB_REPO: str = os.environ.get(
    "HORDE_GITHUB_REPO", "jm-connell/horde"
).strip() or "jm-connell/horde"


def resolve_git_sha() -> str:
    """Deployed commit SHA: env → local git → unknown."""
    env = os.environ.get("HORDE_GIT_SHA", "").strip()
    if env and env.lower() != "unknown":
        return env
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        sha = (result.stdout or "").strip()
        if result.returncode == 0 and sha:
            return sha
    except Exception:  # noqa: BLE001
        pass
    return "unknown"


def short_git_sha(sha: Optional[str] = None) -> str:
    value = (sha if sha is not None else resolve_git_sha()).strip()
    if not value or value.lower() == "unknown":
        return "unknown"
    return value[:7]


def ensure_dirs() -> None:
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    SPRITES_DIR.mkdir(parents=True, exist_ok=True)
    BACKGROUNDS_DIR.mkdir(parents=True, exist_ok=True)
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
