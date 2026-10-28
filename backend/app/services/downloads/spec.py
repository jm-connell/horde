"""The job fields one run of the download pipeline works from."""

from dataclasses import dataclass

from sqlmodel import Session

from ...context import get_engine
from ...models import DownloadDestination, DownloadJob
from ..ytdlp_formats import normalize_video_codec


@dataclass(frozen=True)
class JobSpec:
    """What a job asks for, read from its row once when a run starts.

    The runner and the postprocess stage both work from this snapshot, so a
    change to the row mid-run cannot make the two stages disagree.
    """

    job_id: int
    url: str
    quality_preset: str
    title_override: str | None = None
    channel_override: str | None = None
    title: str | None = None
    channel: str | None = None
    normalize_volume: bool = False
    replace_video_id: int | None = None
    notes_pending: str | None = None
    destination: str = DownloadDestination.library.value
    video_codec: str = "av1"
    clip_start_sec: float | None = None
    clip_end_sec: float | None = None

    @property
    def clip(self) -> tuple[float, float] | None:
        """``(start, end)`` in seconds when only part of the video is wanted."""
        if self.clip_start_sec is None or self.clip_end_sec is None:
            return None
        return self.clip_start_sec, self.clip_end_sec

    @property
    def is_device(self) -> bool:
        return self.destination == DownloadDestination.device.value

    @property
    def codec(self) -> str:
        """The playback-compatibility codec mode, normalised."""
        return normalize_video_codec(self.video_codec)

    @classmethod
    def load(cls, job_id: int) -> JobSpec | None:
        with Session(get_engine()) as session:
            job = session.get(DownloadJob, job_id)
            if job is None:
                return None
            destination = job.destination or DownloadDestination.library.value
            device = destination == DownloadDestination.device.value
            return cls(
                job_id=job_id,
                url=job.url,
                quality_preset=job.quality_preset,
                title_override=job.title_override,
                channel_override=job.channel_override,
                title=job.title,
                channel=job.channel,
                normalize_volume=job.normalize_volume,
                # Never overwrite a library row from an ephemeral device job.
                replace_video_id=None if device else job.replace_video_id,
                notes_pending=job.notes_pending,
                destination=destination,
                video_codec=job.video_codec or "av1",
                clip_start_sec=job.clip_start_sec,
                clip_end_sec=job.clip_end_sec,
            )
