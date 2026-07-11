import json
import subprocess
from pathlib import Path
from typing import Optional


def probe_duration(path: Path) -> Optional[float]:
    """Return media duration in seconds via ffprobe, or None on failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
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
        return None


def probe_is_playable(path: Path) -> bool:
    """Return True when ffprobe finds a decodable video stream with duration."""
    if not path.exists() or path.stat().st_size <= 0:
        return False
    try:
        result = subprocess.run(
            [
                "ffprobe",
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
        return False


def probe_dimensions(path: Path) -> Optional[tuple[int, int]]:
    """Return (width, height) in pixels of the first video stream via ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
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
        return None


def probe_frame_rate(path: Path) -> Optional[float]:
    """Return the frame rate of the first video stream via ffprobe, or None."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
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
        return None


def grab_frame(video_path: Path, output_path: Path, at_seconds: float = 5.0) -> bool:
    """Extract a single frame as a JPEG thumbnail. Returns True on success."""
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-ss",
                str(at_seconds),
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-1",
                str(output_path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return result.returncode == 0 and output_path.exists()
    except (subprocess.SubprocessError, OSError):
        return False


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
        t = min(hi, max(lo, t + random.uniform(-jitter, jitter)))
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
