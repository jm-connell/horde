"""Import the signed-in user's YouTube data from Google Takeout (``services/takeout``).

Everything here is the caller's own: the history is stored under their account,
subscriptions become their follows and playlists their private playlists.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Query, UploadFile
from sqlmodel import Session, col, select

from ..auth import current_user
from ..context import get_session
from ..errors import CodedHTTPException
from ..models import ChannelCatalogVideo
from ..schemas import (
    ChannelFeedEntry,
    RewatchedPage,
    RewatchedVideo,
    TakeoutApplyRequest,
    TakeoutApplyResult,
    TakeoutClearResult,
    TakeoutHistorySummary,
    TakeoutImportResult,
    TakeoutPlaylistRead,
    TakeoutSubscription,
)
from ..services.auth.accounts import AuthUser
from ..services.pagination import InvalidCursor, offset_cursor, parse_cursor
from ..services.takeout import apply, history
from ..services.takeout.parse import (
    Subscription,
    TakeoutError,
    TakeoutPlaylist,
    read_export,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/takeout", tags=["takeout"])

#: Most files in one import (a big export comes in several .zip parts).
MAX_FILES = 20


def _summary(session: Session, user_id: int) -> TakeoutHistorySummary:
    found = history.summary(session, user_id)
    return TakeoutHistorySummary(
        total_views=found.total_views,
        distinct_videos=found.distinct_videos,
        first_watched_at=found.first_watched_at,
        last_watched_at=found.last_watched_at,
        last_imported_at=found.last_imported_at,
    )


@router.get("/history", response_model=TakeoutHistorySummary)
def takeout_history(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> TakeoutHistorySummary:
    return _summary(session, user.id)


@router.delete("/history", response_model=TakeoutClearResult)
def clear_takeout_history(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> TakeoutClearResult:
    """Forget the imported views (follows and playlists made from them stay)."""
    return TakeoutClearResult(removed_views=history.clear(session, user.id))


@router.post("/import", response_model=TakeoutImportResult)
def import_takeout(
    files: list[UploadFile] = File(...),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> TakeoutImportResult:
    """Read a Takeout export: store its watch history, list its subscriptions and playlists.

    The views are stored at once (a view imported before is skipped). The
    subscriptions and playlists are only listed; ``/apply`` imports the ones
    the user picks. Blocking (reads the spooled uploads), so a plain ``def``.
    """
    if len(files) > MAX_FILES:
        raise CodedHTTPException(
            400, f"Choose at most {MAX_FILES} files", "takeout_too_many_files"
        )
    try:
        data = read_export([(f.filename or "upload", f.file) for f in files])
    except TakeoutError as exc:
        raise CodedHTTPException(400, str(exc), "takeout_unreadable") from exc
    if not (data.found_history or data.subscriptions or data.playlists):
        raise CodedHTTPException(
            400,
            "No YouTube watch history, subscriptions or playlists found. "
            "Choose the .zip from Google Takeout with YouTube data in it.",
            "takeout_empty",
        )
    stored = history.store_views(session, user.id, data.views)
    states = apply.subscription_states(session, user.id, data.subscriptions)
    playlists: list[TakeoutPlaylistRead] = []
    for playlist in data.playlists:
        existing = apply.find_playlist(session, user.id, playlist)
        have = (
            apply.existing_ids(session, existing.id)
            if existing is not None and existing.id is not None
            else set()
        )
        playlists.append(
            TakeoutPlaylistRead(
                title=playlist.title,
                playlist_id=playlist.playlist_id,
                visibility=playlist.visibility,
                video_ids=playlist.video_ids,
                existing_playlist_id=existing.id if existing is not None else None,
                new_videos=sum(1 for v in playlist.video_ids if v not in have),
            )
        )
    return TakeoutImportResult(
        found_history=data.found_history,
        views_in_file=stored.views_in_file,
        new_views=stored.new_views,
        history=_summary(session, user.id),
        subscriptions=[
            TakeoutSubscription(
                channel_url=s.channel_url,
                channel_name=s.channel_name,
                status=states.get(s.channel_url, "new"),
            )
            for s in data.subscriptions
        ],
        playlists=playlists,
    )


@router.post("/apply", response_model=TakeoutApplyResult)
def apply_takeout(
    payload: TakeoutApplyRequest,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> TakeoutApplyResult:
    """Follow the chosen subscriptions and import the chosen playlists."""
    followed = apply.follow_channels(
        session,
        user.id,
        [Subscription(s.channel_url, s.channel_name) for s in payload.subscriptions],
    )
    created = updated = added = 0
    for choice in payload.playlists:
        result = apply.import_playlist(
            session,
            user.id,
            TakeoutPlaylist(
                title=choice.title.strip() or "YouTube playlist",
                playlist_id=(choice.playlist_id or "").strip() or None,
                video_ids=list(dict.fromkeys(choice.video_ids)),
            ),
        )
        added += result.added
        if result.created:
            created += 1
        elif result.added:
            updated += 1
    return TakeoutApplyResult(
        followed=followed,
        playlists_created=created,
        playlists_updated=updated,
        videos_added=added,
    )


@router.get("/rewatched", response_model=RewatchedPage)
def rewatched(
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(12, ge=1, le=60),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> RewatchedPage:
    """Videos the user watched several times on YouTube that are not in the library."""
    try:
        page = parse_cursor(
            cursor, limit=limit, sort="views", order="desc", kind="offset"
        )
    except InvalidCursor as exc:
        raise CodedHTTPException(400, str(exc), "invalid_cursor") from exc
    rows, more = history.rewatched_page(
        session, user.id, offset=page.offset, limit=limit
    )
    catalog = {
        row.yt_id: row
        for row in session.exec(
            select(ChannelCatalogVideo).where(
                col(ChannelCatalogVideo.yt_id).in_([r.yt_id for r in rows])
            )
        ).all()
    }
    items = []
    for row in rows:
        known = catalog.get(row.yt_id)
        items.append(
            RewatchedVideo(
                entry=ChannelFeedEntry(
                    id=row.yt_id,
                    url=f"https://www.youtube.com/watch?v={row.yt_id}",
                    title=row.title or (known.title if known else None),
                    duration=known.duration if known else None,
                    thumbnail_url=known.thumbnail_url if known else None,
                    view_count=known.view_count if known else None,
                    published_at=known.published_at if known else None,
                    channel=row.channel,
                    channel_url=row.channel_url,
                    youtube_watched=True,
                ),
                views=row.views,
                last_watched_at=row.last_watched_at,
            )
        )
    return RewatchedPage(
        items=items,
        next_cursor=offset_cursor(
            sort="views", order="desc", offset=page.offset + limit
        )
        if more
        else None,
    )
