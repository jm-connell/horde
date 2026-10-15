"""A fake yt-dlp that writes the same files the real one does.

``FakeYtdlp`` stands in for ``yt_dlp.YoutubeDL`` and for the metadata fetch in
the downloader. It renders file names with the *real* yt-dlp (``prepare_filename``
with the options the downloader passes), so output-template, byte-length and
sanitisation behaviour is exercised for real, then writes per-format
``.fNNN`` fragments / ``.part`` files and the merged media on disk. Tests drive
whole jobs through ``DownloadQueue``/``_run_download`` and assert on files + DB.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yt_dlp
from yt_dlp.utils import prepend_extension

RealYoutubeDL = yt_dlp.YoutubeDL


def make_info(
    yt_id: str = "dQw4w9WgXcQ",
    title: str = "A Title",
    *,
    uploader: str | None = "Chan",
    upload_date: str | None = "20240102",
    **extra: Any,
) -> dict[str, Any]:
    info: dict[str, Any] = {
        "id": yt_id,
        "title": title,
        "ext": "mp4",
        "webpage_url": f"https://www.youtube.com/watch?v={yt_id}",
        "duration": 600,
        "width": 1280,
        "height": 720,
        "extractor_key": "Youtube",
    }
    if uploader is not None:
        info["uploader"] = uploader
        info["channel"] = uploader
    if upload_date is not None:
        info["upload_date"] = upload_date
    info.update(extra)
    return info


class FakeYtdlp:
    def __init__(self) -> None:
        self.infos: dict[str, dict[str, Any]] = {}
        self.downloads: list[dict[str, Any]] = []
        self.written: list[Path] = []
        self.merged_bytes = 4096
        # Called after the fragments are on disk and before the merge:
        # raise to simulate a failure, or block on an event to simulate a cancel.
        self.before_merge: Callable[[Path, dict[str, Any]], None] | None = None
        # Raised by the metadata fetch (the gate in front of every download).
        self.fetch_error: Exception | None = None
        # Raised after the merged file is on disk, like a yt-dlp postprocessor
        # that fails once the media already exists.
        self.fail_after_merge: Exception | None = None

    def add(self, url: str, info: dict[str, Any]) -> dict[str, Any]:
        self.infos[url] = info
        return info

    def fetch(self, url: str, *_a: Any, **_k: Any) -> dict[str, Any]:
        if self.fetch_error is not None:
            raise self.fetch_error
        return dict(self.infos[url])

    def install(self, monkeypatch, downloader) -> None:
        fake = self

        class FakeYDL:
            def __init__(self, opts: dict[str, Any] | None = None, *_a, **_k) -> None:
                self.opts = dict(opts or {})
                self.params = self.opts
                self._real = RealYoutubeDL(
                    {
                        "quiet": True,
                        "outtmpl": self.opts.get("outtmpl", "%(title)s.%(ext)s"),
                        "windowsfilenames": self.opts.get("windowsfilenames"),
                    }
                )

            def __enter__(self):
                return self

            def __exit__(self, *_exc) -> None:
                self._real.close()

            def close(self) -> None:
                self._real.close()

            def prepare_filename(self, info: dict[str, Any], **kwargs: Any) -> str:
                return self._real.prepare_filename(info, **kwargs)

            def extract_info(self, url: str, download: bool = True, **_k: Any):
                info = dict(fake.infos[url])
                if not download:
                    return info
                path = Path(self._real.prepare_filename(info))
                fake.downloads.append({"url": url, "path": path, "opts": self.opts})
                path.parent.mkdir(parents=True, exist_ok=True)
                hooks = self.opts.get("progress_hooks") or []
                video_frag = Path(
                    prepend_extension(str(path.with_suffix(".mp4")), "f137", "mp4")
                )
                audio_frag = Path(
                    prepend_extension(str(path.with_suffix(".m4a")), "f140", "m4a")
                )
                for frag, size in ((video_frag, 3000), (audio_frag, 1000)):
                    part = frag.with_name(frag.name + ".part")
                    part.write_bytes(b"\x00" * (size // 2))
                    fake.written.append(part)
                    for hook in hooks:
                        hook(
                            {
                                "status": "downloading",
                                "filename": str(part),
                                "downloaded_bytes": size // 2,
                                "total_bytes": size,
                                "info_dict": info,
                            }
                        )
                    part.replace(frag)
                    frag.write_bytes(b"\x00" * size)
                    fake.written.append(frag)
                    for hook in hooks:
                        hook(
                            {
                                "status": "finished",
                                "filename": str(frag),
                                "downloaded_bytes": size,
                                "info_dict": info,
                            }
                        )
                if fake.before_merge is not None:
                    fake.before_merge(path, info)
                merged = path.with_suffix(".mp4")
                merged.write_bytes(b"\x00" * fake.merged_bytes)
                fake.written.append(merged)
                video_frag.unlink()
                audio_frag.unlink()
                if fake.fail_after_merge is not None:
                    raise fake.fail_after_merge
                for hook in hooks:
                    hook(
                        {
                            "status": "finished",
                            "filename": str(merged),
                            "downloaded_bytes": fake.merged_bytes,
                            "info_dict": info,
                        }
                    )
                return {**info, "ext": "mp4", "filepath": str(merged)}

        monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
        monkeypatch.setattr(downloader, "extract_info_gated", fake.fetch)


def stub_media_probes(monkeypatch, downloader, *, playable: bool = True) -> None:
    """The fake media is zero bytes: stub everything that would run ffprobe/ffmpeg."""
    monkeypatch.setattr(downloader, "_validate_playable", lambda _p: playable)
    monkeypatch.setattr(downloader, "probe_duration", lambda _p: 12.0)
    monkeypatch.setattr(downloader, "probe_dimensions", lambda _p: (1280, 720))
    monkeypatch.setattr(downloader, "probe_stream_info", lambda _p: None)
    monkeypatch.setattr(downloader, "probe_media", lambda _p: None)
    monkeypatch.setattr(downloader, "ensure_safari_mp4", lambda p, **_k: p)
    monkeypatch.setattr(downloader, "_finalize_in_background", lambda *a, **k: None)
    monkeypatch.setattr("app.services.ai.enqueue_for_video", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.services.channel_catalog.enqueue_channel", lambda *a, **k: None
    )


def run_job_inline(
    downloader, job_id: int, cancel_event: threading.Event | None = None
) -> None:
    """Run the download stage, then the ffmpeg/finish stage, on this thread."""

    def enqueue(task) -> None:
        downloader.download_queue.claim_ffmpeg(task.job_id)
        downloader.ffmpeg_queue._worker(task)

    original = downloader.ffmpeg_queue.enqueue
    downloader.ffmpeg_queue.enqueue = enqueue  # type: ignore[method-assign]
    try:
        downloader._run_download(job_id, cancel_event=cancel_event or threading.Event())
    finally:
        downloader.ffmpeg_queue.enqueue = original  # type: ignore[method-assign]
