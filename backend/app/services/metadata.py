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
