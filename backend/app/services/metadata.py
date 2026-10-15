import json
import logging
import subprocess
import threading
from pathlib import Path

from .ffmpeg_bin import ffmpeg_bin, ffprobe_bin
from .ffmpeg_progress import FfmpegCancelled, run_ffmpeg

logger = logging.getLogger(__name__)


def probe_duration(path: Path) -> float | None:
    """Return media duration in seconds via ffprobe, or None on failure."""
    try:
        result = subprocess.run(
            [
                ffprobe_bin(),
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        duration = data.get("format", {}).get("duration")
        return float(duration) if duration is not None else None
    except (subprocess.SubprocessError, ValueError, OSError):
        logger.debug("ffprobe duration failed", exc_info=True)
        return None


def probe_is_playable(path: Path) -> bool:
    """Return True when ffprobe finds a decodable video stream with duration."""
    if not path.exists() or path.stat().st_size <= 0:
        return False
    try:
        result = subprocess.run(
            [
                ffprobe_bin(),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_type,width,height",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return False
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        if not streams:
            return False
        stream = streams[0]
        if stream.get("codec_type") != "video":
            return False
        width = stream.get("width")
        height = stream.get("height")
        if not width or not height or int(width) <= 0 or int(height) <= 0:
            return False
        duration = data.get("format", {}).get("duration")
        if duration is None:
            return False
        return float(duration) > 0
    except (subprocess.SubprocessError, ValueError, OSError):
        logger.debug("ffprobe playability check failed", exc_info=True)
        return False


def probe_dimensions(path: Path) -> tuple[int, int] | None:
    """Return (width, height) in pixels of the first video stream via ffprobe."""
    try:
        result = subprocess.run(
            [
                ffprobe_bin(),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        streams = json.loads(result.stdout).get("streams", [])
        if not streams:
            return None
        width = streams[0].get("width")
        height = streams[0].get("height")
        if width and height:
            return int(width), int(height)
        return None
    except (subprocess.SubprocessError, ValueError, OSError):
        logger.debug("ffprobe dimensions failed", exc_info=True)
        return None


def probe_frame_rate(path: Path) -> float | None:
    """Return the frame rate of the first video stream via ffprobe, or None."""
    try:
        result = subprocess.run(
            [
                ffprobe_bin(),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=r_frame_rate",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        streams = json.loads(result.stdout).get("streams", [])
        if not streams:
            return None
        raw = streams[0].get("r_frame_rate", "")
        # r_frame_rate is a fraction like "60000/1001" or "30/1"
        if "/" in raw:
            num, den = raw.split("/", 1)
            if int(den):
                return round(int(num) / int(den), 3)
        return None
    except (subprocess.SubprocessError, ValueError, OSError, ZeroDivisionError):
        logger.debug("ffprobe frame rate failed", exc_info=True)
        return None


def _run_ffmpeg_tracked(
    cmd: list[str], *, timeout: float, cancel_event: threading.Event | None
) -> bool:
    """Run a long ffmpeg through ``run_ffmpeg`` (own session, registered for shutdown).

    True when it exits 0. A cancel, timeout or failure is False, with the reason
    in the debug log.
    """
    try:
        run_ffmpeg(cmd, timeout=timeout, cancel_event=cancel_event)
    except FfmpegCancelled:
        logger.debug("ffmpeg cancelled: %s", cmd[-1])
        return False
    except (subprocess.SubprocessError, OSError):
        logger.debug("ffmpeg failed: %s", cmd[-1], exc_info=True)
        return False
    return True


def grab_frame(
    video_path: Path,
    output_path: Path,
    at_seconds: float = 5.0,
    *,
    scale_width: int = 640,
    cancel_event: threading.Event | None = None,
) -> bool:
    """Extract a single frame as a JPEG thumbnail. Returns True on success."""
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.debug("cannot create %s", output_path.parent, exc_info=True)
        return False
    ok = _run_ffmpeg_tracked(
        [
            ffmpeg_bin(),
            "-y",
            "-ss",
            str(at_seconds),
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-vf",
            f"scale={scale_width}:-1",
            str(output_path),
        ],
        timeout=60,
        cancel_event=cancel_event,
    )
    return ok and output_path.exists()


def candidate_timestamps(duration: float, count: int = 8) -> list[float]:
    """Pick distinct timestamps across the video (biased away from very start/end)."""
    import random

    if duration <= 0 or count <= 0:
        return []
    # Keep a small margin so we avoid black frames / end cards when possible.
    lo = max(0.5, duration * 0.05)
    hi = max(lo + 0.1, duration * 0.95)
    if count == 1:
        return [round((lo + hi) / 2, 3)]
    # Mix evenly spaced anchors with a little jitter for variety.
    stamps: list[float] = []
    for i in range(count):
        t = lo + (hi - lo) * (i + 0.5) / count
        jitter = (hi - lo) / (count * 4)
        offset = random.uniform(-jitter, jitter)  # noqa: S311 - sample-time jitter
        t = min(hi, max(lo, t + offset))
        stamps.append(round(t, 3))
    # Deduplicate while preserving order.
    seen: set[float] = set()
    out: list[float] = []
    for t in stamps:
        key = round(t, 1)
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def candidate_thumb_path(thumbnails_dir: Path, video_id: int, index: int) -> Path:
    return thumbnails_dir / f"{video_id}_cand_{index}.jpg"


def clear_thumbnail_candidates(thumbnails_dir: Path, video_id: int) -> None:
    for path in thumbnails_dir.glob(f"{video_id}_cand_*.jpg"):
        path.unlink(missing_ok=True)


def generate_thumbnail_candidates(
    video_path: Path,
    thumbnails_dir: Path,
    video_id: int,
    *,
    count: int = 8,
    duration: float | None = None,
) -> list[dict]:
    """Write candidate JPEGs and return [{index, at_seconds}, ...]."""
    dur = duration if duration is not None else probe_duration(video_path)
    if not dur or dur <= 0:
        return []
    clear_thumbnail_candidates(thumbnails_dir, video_id)
    stamps = candidate_timestamps(dur, count)
    results: list[dict] = []
    for i, at in enumerate(stamps):
        dest = candidate_thumb_path(thumbnails_dir, video_id, i)
        if grab_frame(video_path, dest, at_seconds=at):
            results.append({"index": i, "at_seconds": at})
    return results


SPRITE_TILE_WIDTH = 160
SPRITE_COLUMNS = 10


def sprite_image_path(sprites_dir: Path, video_id: int) -> Path:
    return sprites_dir / f"{video_id}.jpg"


def sprite_meta_path(sprites_dir: Path, video_id: int) -> Path:
    return sprites_dir / f"{video_id}.json"


def sprite_interval_sec(duration: float) -> int:
    """Seconds between tiles; denser on short videos, capped for long ones."""
    return max(5, min(20, round(duration / 100) or 5))


def sprites_exist(sprites_dir: Path, video_id: int) -> bool:
    return (
        sprite_image_path(sprites_dir, video_id).is_file()
        and sprite_meta_path(sprites_dir, video_id).is_file()
    )


def load_sprite_meta(sprites_dir: Path, video_id: int) -> dict | None:
    path = sprite_meta_path(sprites_dir, video_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        logger.debug("sprite metadata unreadable", exc_info=True)
        return None


def delete_sprite_files(sprites_dir: Path, video_id: int) -> None:
    sprite_image_path(sprites_dir, video_id).unlink(missing_ok=True)
    sprite_meta_path(sprites_dir, video_id).unlink(missing_ok=True)


def _write_sprite_meta(
    meta_path: Path,
    *,
    interval_sec: int,
    tile_width: int,
    tile_height: int,
    columns: int,
    count: int,
    duration_sec: float,
) -> dict:
    meta = {
        "interval_sec": interval_sec,
        "tile_width": tile_width,
        "tile_height": tile_height,
        "columns": columns,
        "count": count,
        "duration_sec": duration_sec,
    }
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return meta


def _sprite_via_ffmpeg_tile(
    video_path: Path,
    image_path: Path,
    *,
    interval: int,
    columns: int,
    rows: int,
    cancel_event: threading.Event | None = None,
) -> bool:
    try:
        image_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.debug("cannot create %s", image_path.parent, exc_info=True)
        return False
    ok = _run_ffmpeg_tracked(
        [
            ffmpeg_bin(),
            "-y",
            "-i",
            str(video_path),
            "-vf",
            f"fps=1/{interval},scale={SPRITE_TILE_WIDTH}:-1,tile={columns}x{rows}",
            "-frames:v",
            "1",
            "-q:v",
            "3",
            str(image_path),
        ],
        timeout=600,
        cancel_event=cancel_event,
    )
    return ok and image_path.is_file()


def _sprite_via_frame_montage(
    video_path: Path,
    image_path: Path,
    sprites_dir: Path,
    video_id: int,
    *,
    interval: int,
    count: int,
    columns: int,
    rows: int,
    cancel_event: threading.Event | None = None,
) -> bool:
    """Fallback: grab individual frames and stitch with Pillow."""
    try:
        from PIL import Image
    except ImportError:
        logger.debug("Pillow is not available; skipping the frame-montage sprite")
        return False

    tmp_dir = sprites_dir / f".{video_id}_sprite_tmp"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        frames: list[Path] = []
        for i in range(count):
            at = i * interval + interval / 2
            dest = tmp_dir / f"{i:04d}.jpg"
            if cancel_event is not None and cancel_event.is_set():
                return False
            if not grab_frame(
                video_path,
                dest,
                at_seconds=at,
                scale_width=SPRITE_TILE_WIDTH,
                cancel_event=cancel_event,
            ):
                continue
            frames.append(dest)
        if not frames:
            return False

        with Image.open(frames[0]) as first:
            tile_w, tile_h = first.size
        sheet = Image.new("RGB", (columns * tile_w, rows * tile_h), (0, 0, 0))
        for i, frame_path in enumerate(frames):
            col = i % columns
            row = i // columns
            with Image.open(frame_path) as im:
                if im.size != (tile_w, tile_h):
                    im = im.resize((tile_w, tile_h))
                sheet.paste(im, (col * tile_w, row * tile_h))
        image_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(image_path, format="JPEG", quality=85)
        return image_path.is_file()
    except (OSError, ValueError):
        logger.debug("frame-montage sprite failed", exc_info=True)
        return False
    finally:
        if tmp_dir.exists():
            for p in tmp_dir.glob("*"):
                p.unlink(missing_ok=True)
            tmp_dir.rmdir()


def generate_sprite_sheet(
    video_path: Path,
    sprites_dir: Path,
    video_id: int,
    *,
    duration: float | None = None,
    cancel_event: threading.Event | None = None,
) -> str | None:
    """Build a seek-preview sprite sheet + JSON sidecar. Returns image path or None.

    ``cancel_event`` stops any running ffmpeg and skips the fallback (shutdown).
    """
    dur = duration if duration is not None else probe_duration(video_path)
    if not dur or dur <= 0:
        return None

    interval = sprite_interval_sec(dur)
    count = max(1, int(dur // interval))
    columns = SPRITE_COLUMNS
    rows = max(1, (count + columns - 1) // columns)

    sprites_dir.mkdir(parents=True, exist_ok=True)
    image_path = sprite_image_path(sprites_dir, video_id)
    meta_path = sprite_meta_path(sprites_dir, video_id)

    ok = _sprite_via_ffmpeg_tile(
        video_path,
        image_path,
        interval=interval,
        columns=columns,
        rows=rows,
        cancel_event=cancel_event,
    )
    if not ok and cancel_event is not None and cancel_event.is_set():
        delete_sprite_files(sprites_dir, video_id)
        return None
    if not ok:
        image_path.unlink(missing_ok=True)
        ok = _sprite_via_frame_montage(
            video_path,
            image_path,
            sprites_dir,
            video_id,
            interval=interval,
            count=count,
            columns=columns,
            rows=rows,
            cancel_event=cancel_event,
        )
    if not ok or not image_path.is_file():
        delete_sprite_files(sprites_dir, video_id)
        return None

    tile_width = SPRITE_TILE_WIDTH
    tile_height = SPRITE_TILE_WIDTH
    try:
        from PIL import Image

        with Image.open(image_path) as im:
            sheet_w, sheet_h = im.size
            if columns > 0 and rows > 0:
                tile_width = max(1, sheet_w // columns)
                tile_height = max(1, sheet_h // rows)
    except (OSError, ImportError, ValueError):
        logger.debug("could not measure the sprite sheet image", exc_info=True)

    _write_sprite_meta(
        meta_path,
        interval_sec=interval,
        tile_width=tile_width,
        tile_height=tile_height,
        columns=columns,
        count=count,
        duration_sec=float(dur),
    )
    return str(image_path)
