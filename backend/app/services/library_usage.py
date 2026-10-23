"""How much disk the library takes: the one number the Storage panel and the size limit share."""

from dataclasses import dataclass

from sqlmodel import Session, col, func, select

from ..context import get_paths
from ..models import Video


@dataclass(frozen=True)
class LibraryUsage:
    #: Everything the library keeps on disk. Add new kinds of stored files here so
    #: the Storage panel and the download size limit both count them.
    total_bytes: int
    video_bytes: int
    compat_bytes: int
    thumbnail_bytes: int
    video_count: int


def library_usage(session: Session) -> LibraryUsage:
    """Sizes of the videos shown in the library, their H.264 copies and thumbnails."""
    video_bytes = session.exec(
        select(func.coalesce(func.sum(col(Video.file_size)), 0)).where(
            Video.needs_review == False  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    ).one()
    video_count = session.exec(
        select(func.count(col(Video.id))).where(col(Video.needs_review) == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).one()
    compat_bytes = session.exec(
        select(func.coalesce(func.sum(Video.compat_size), 0)).where(
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            Video.compat_path != None,  # noqa: E711 - SQL column comparison, not a Python truth test
        )
    ).one()
    thumbnail_bytes = 0
    thumbnails = get_paths().thumbnails
    if thumbnails.exists():
        thumbnail_bytes = sum(
            f.stat().st_size for f in thumbnails.glob("*") if f.is_file()
        )
    return LibraryUsage(
        total_bytes=int(video_bytes or 0) + int(compat_bytes or 0) + thumbnail_bytes,
        video_bytes=int(video_bytes or 0),
        compat_bytes=int(compat_bytes or 0),
        thumbnail_bytes=thumbnail_bytes,
        video_count=int(video_count or 0),
    )
