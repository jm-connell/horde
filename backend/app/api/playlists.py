from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, update as sa_update
from sqlmodel import Session, select

from ..database import get_session
from ..models import Playlist, PlaylistItem, PlaylistSource, Video
from ..schemas import (
    BulkPlaylistAdd,
    DownloadCreate,
    PlaylistCreate,
    PlaylistDetail,
    PlaylistImport,
    PlaylistItemAdd,
    PlaylistListReorder,
    PlaylistPreview,
    PlaylistRead,
    PlaylistReorder,
    PlaylistSizeEstimate,
    PlaylistSizeEstimateRequest,
    PlaylistUpdate,
)
from ..services import downloader, library
from ..services.playlist_sync import (
    find_subscribed_by_url,
    start_playlist_sync,
)
from ..services.thumbnails import (
    unlink_playlist_cover,
    write_playlist_cover,
)
from ..services.url_clean import clean_url, youtube_video_id
from .videos import _to_read

router = APIRouter(prefix="/api/playlists", tags=["playlists"])


def _item_count(session: Session, playlist_id: int) -> int:
    return (
        session.scalar(
            select(func.count(PlaylistItem.id)).where(
                PlaylistItem.playlist_id == playlist_id
            )
        )
        or 0
    )


def _library_video_id_for_url(session: Session, raw_url: str) -> int | None:
    cleaned = clean_url(raw_url, keep_playlist=False) or raw_url.strip()
    yt_id = youtube_video_id(cleaned) or youtube_video_id(raw_url)
    if yt_id:
        existing = library.find_video_by_youtube_id(session, yt_id)
        if existing is not None and existing.id is not None:
            return existing.id
    candidates = [value for value in (cleaned, raw_url.strip()) if value]
    if not candidates:
        return None
    row = session.exec(select(Video).where(Video.source_url.in_(candidates))).first()
    if row is not None and row.id is not None:
        return row.id
    return None


def _playlist_items(session: Session, playlist_id: int) -> list[PlaylistItem]:
    return list(
        session.exec(
            select(PlaylistItem)
            .where(PlaylistItem.playlist_id == playlist_id)
            .order_by(PlaylistItem.position)
        ).all()
    )


def _thumb_ok(session: Session, video_ids: list[int]) -> dict[int, bool]:
    unique = list(dict.fromkeys(vid for vid in video_ids if vid is not None))
    if not unique:
        return {}
    videos = session.exec(select(Video).where(Video.id.in_(unique))).all()
    found = {video.id: video for video in videos}
    out: dict[int, bool] = {}
    for vid in unique:
        video = found.get(vid)
        out[vid] = bool(
            video is not None
            and video.thumbnail_path
            and Path(video.thumbnail_path).is_file()
        )
    return out


def _member_video_ids(session: Session, items: list[PlaylistItem]) -> list[int]:
    ordered = [item.video_id for item in items]
    if not ordered:
        return []
    existing = {
        video.id
        for video in session.exec(select(Video).where(Video.id.in_(ordered))).all()
    }
    return [vid for vid in ordered if vid in existing]


def _to_playlist_read(
    session: Session,
    playlist: Playlist,
    *,
    items: list[PlaylistItem] | None = None,
    members: list[int] | None = None,
    thumbs: dict[int, bool] | None = None,
) -> PlaylistRead:
    if items is None:
        items = _playlist_items(session, playlist.id)
    if members is None:
        members = _member_video_ids(session, items)
    if thumbs is None:
        needed = list(members)
        if playlist.cover_video_id:
            needed.append(playlist.cover_video_id)
        thumbs = _thumb_ok(session, needed)
    member_set = set(members)
    first_id = members[0] if members else None
    has_custom = bool(playlist.cover_path and Path(playlist.cover_path).is_file())
    pinned = (
        playlist.cover_video_id if playlist.cover_video_id in member_set else None
    )
    thumb_video = None if has_custom else (pinned if pinned is not None else first_id)
    has_thumb = has_custom or (
        thumb_video is not None and thumbs.get(thumb_video, False)
    )
    return PlaylistRead(
        id=playlist.id,
        name=playlist.name,
        description=playlist.description,
        source_type=playlist.source_type,
        source_url=playlist.source_url,
        subscribed=bool(playlist.subscribed),
        quality_preset=playlist.quality_preset,
        last_synced_at=playlist.last_synced_at,
        sync_error=playlist.sync_error,
        created_at=playlist.created_at,
        item_count=len(items),
        position=int(playlist.position or 0),
        cover_video_id=pinned,
        has_custom_cover=has_custom,
        thumbnail_video_id=thumb_video,
        has_thumbnail=has_thumb,
    )


def _shift_playlists_down(session: Session) -> None:
    session.execute(sa_update(Playlist).values(position=Playlist.position + 1))


def _clear_custom_cover(playlist: Playlist) -> None:
    unlink_playlist_cover(playlist.id, playlist.cover_path)
    playlist.cover_path = None


def _resolved_cover_file(session: Session, playlist: Playlist) -> Path | None:
    if playlist.cover_path:
        custom = Path(playlist.cover_path)
        if custom.is_file():
            return custom
    items = _playlist_items(session, playlist.id)
    members = _member_video_ids(session, items)
    pinned = (
        playlist.cover_video_id if playlist.cover_video_id in set(members) else None
    )
    video_id = pinned if pinned is not None else (members[0] if members else None)
    if video_id is None:
        return None
    video = session.get(Video, video_id)
    if video is None or not video.thumbnail_path:
        return None
    path = Path(video.thumbnail_path)
    return path if path.is_file() else None


def _ordered_videos(session: Session, playlist_id: int) -> list[Video]:
    items = session.exec(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == playlist_id)
        .order_by(PlaylistItem.position)
    ).all()
    videos: list[Video] = []
    for item in items:
        video = session.get(Video, item.video_id)
        if video is not None:
            videos.append(video)
    return videos


@router.get("/preview", response_model=PlaylistPreview)
def preview_playlist(url: str):
    if not url.strip():
        raise HTTPException(status_code=400, detail="URL is required")
    try:
        data = downloader.extract_playlist_entries(clean_url(url, keep_playlist=True))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read playlist: {exc}")
    return PlaylistPreview(**data)


@router.post("/estimate", response_model=PlaylistSizeEstimate)
def estimate_playlist_sizes(payload: PlaylistSizeEstimateRequest):
    if not payload.urls:
        return PlaylistSizeEstimate(sizes={})
    sizes = downloader.estimate_playlist_sizes(payload.urls)
    return PlaylistSizeEstimate(sizes=sizes)


@router.get("", response_model=list[PlaylistRead])
def list_playlists(session: Session = Depends(get_session)):
    playlists = session.exec(
        select(Playlist).order_by(Playlist.position, Playlist.created_at.desc())
    ).all()
    if not playlists:
        return []
    ids = [p.id for p in playlists if p.id is not None]
    grouped: dict[int, list[PlaylistItem]] = {pid: [] for pid in ids}
    items = session.exec(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id.in_(ids))
        .order_by(PlaylistItem.playlist_id, PlaylistItem.position)
    ).all()
    for item in items:
        grouped.setdefault(item.playlist_id, []).append(item)
    video_ids = [item.video_id for item in items]
    video_ids.extend(
        p.cover_video_id for p in playlists if p.cover_video_id is not None
    )
    thumbs = _thumb_ok(session, video_ids)
    existing = {
        video.id
        for video in session.exec(
            select(Video).where(Video.id.in_(list(dict.fromkeys(video_ids))))
        ).all()
    } if video_ids else set()
    out: list[PlaylistRead] = []
    for playlist in playlists:
        plist = grouped.get(playlist.id, [])
        members = [item.video_id for item in plist if item.video_id in existing]
        out.append(
            _to_playlist_read(
                session,
                playlist,
                items=plist,
                members=members,
                thumbs=thumbs,
            )
        )
    return out


@router.post("", response_model=PlaylistRead)
def create_playlist(payload: PlaylistCreate, session: Session = Depends(get_session)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    _shift_playlists_down(session)
    playlist = Playlist(
        name=name,
        description=payload.description,
        source_type=PlaylistSource.user,
        position=0,
    )
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    return _to_playlist_read(session, playlist)


@router.patch("/reorder", response_model=list[PlaylistRead])
def reorder_playlists(
    payload: PlaylistListReorder,
    session: Session = Depends(get_session),
):
    position = {pid: idx for idx, pid in enumerate(payload.playlist_ids)}
    playlists = session.exec(select(Playlist)).all()
    for playlist in playlists:
        if playlist.id in position:
            playlist.position = position[playlist.id]
            session.add(playlist)
    session.commit()
    return list_playlists(session)


@router.get("/{playlist_id}", response_model=PlaylistDetail)
def get_playlist(playlist_id: int, session: Session = Depends(get_session)):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    videos = _ordered_videos(session, playlist_id)
    base = _to_playlist_read(session, playlist)
    return PlaylistDetail(**base.model_dump(), videos=[_to_read(v, session) for v in videos])


@router.patch("/{playlist_id}", response_model=PlaylistRead)
def update_playlist(
    playlist_id: int,
    payload: PlaylistUpdate,
    session: Session = Depends(get_session),
):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")
        playlist.name = name
    if "description" in data:
        playlist.description = data["description"]
    if "quality_preset" in data:
        preset = (data["quality_preset"] or "").strip() or None
        playlist.quality_preset = preset
    enable_sub = data.get("subscribed")
    if enable_sub is True:
        if playlist.source_type != PlaylistSource.youtube or not playlist.source_url:
            raise HTTPException(
                status_code=400,
                detail="Only YouTube playlists can be subscribed",
            )
        other = find_subscribed_by_url(
            session, playlist.source_url, exclude_id=playlist.id
        )
        if other is not None:
            raise HTTPException(
                status_code=409,
                detail="Already subscribed to this YouTube playlist",
            )
        playlist.subscribed = True
        if not playlist.quality_preset:
            playlist.quality_preset = "best"
    elif enable_sub is False:
        playlist.subscribed = False
        playlist.sync_error = None
    if "cover_video_id" in data:
        cover_id = data["cover_video_id"]
        if cover_id is not None:
            members = set(_member_video_ids(session, _playlist_items(session, playlist.id)))
            if cover_id not in members:
                raise HTTPException(
                    status_code=400, detail="Video is not in this playlist"
                )
        _clear_custom_cover(playlist)
        playlist.cover_video_id = cover_id
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    if enable_sub is True:
        start_playlist_sync(playlist.id)
    return _to_playlist_read(session, playlist)


@router.delete("/{playlist_id}", status_code=204)
def delete_playlist(playlist_id: int, session: Session = Depends(get_session)):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    items = session.exec(
        select(PlaylistItem).where(PlaylistItem.playlist_id == playlist_id)
    ).all()
    for item in items:
        session.delete(item)
    unlink_playlist_cover(playlist.id, playlist.cover_path)
    session.delete(playlist)
    session.commit()
    return Response(status_code=204)


@router.post("/{playlist_id}/items", response_model=PlaylistDetail)
def add_item(
    playlist_id: int,
    payload: PlaylistItemAdd,
    session: Session = Depends(get_session),
):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")

    video_id = payload.video_id
    raw_url = (payload.url or "").strip()
    if video_id is None and not raw_url:
        raise HTTPException(status_code=400, detail="video_id or url is required")

    if video_id is None and raw_url:
        video_id = _library_video_id_for_url(session, raw_url)
        if video_id is None:
            from .downloads import create_download

            quality = (playlist.quality_preset or "").strip() or "best"
            create_download(
                DownloadCreate(
                    url=raw_url,
                    quality_preset=quality,
                    playlist_id=playlist_id,
                ),
                session,
            )
            return get_playlist(playlist_id, session)

    if session.get(Video, video_id) is None:
        raise HTTPException(status_code=404, detail="Video not found")

    existing = session.exec(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.video_id == video_id,
        )
    ).first()
    if existing is None:
        next_pos = _item_count(session, playlist_id)
        session.add(
            PlaylistItem(
                playlist_id=playlist_id,
                video_id=video_id,
                position=next_pos,
            )
        )
        session.commit()

    return get_playlist(playlist_id, session)


@router.post("/{playlist_id}/items/bulk", status_code=204)
def bulk_add_items(
    playlist_id: int,
    payload: BulkPlaylistAdd,
    session: Session = Depends(get_session),
):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    base_pos = _item_count(session, playlist_id)
    offset = 0
    for video_id in payload.video_ids:
        if session.get(Video, video_id) is None:
            continue
        existing = session.exec(
            select(PlaylistItem).where(
                PlaylistItem.playlist_id == playlist_id,
                PlaylistItem.video_id == video_id,
            )
        ).first()
        if existing is None:
            session.add(
                PlaylistItem(
                    playlist_id=playlist_id,
                    video_id=video_id,
                    position=base_pos + offset,
                )
            )
            offset += 1
    session.commit()
    return Response(status_code=204)


@router.delete("/{playlist_id}/items/{video_id}", status_code=204)
def remove_item(
    playlist_id: int, video_id: int, session: Session = Depends(get_session)
):
    item = session.exec(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.video_id == video_id,
        )
    ).first()
    if item is not None:
        session.delete(item)
        session.commit()
    return Response(status_code=204)


@router.patch("/{playlist_id}/reorder", response_model=PlaylistDetail)
def reorder_items(
    playlist_id: int,
    payload: PlaylistReorder,
    session: Session = Depends(get_session),
):
    if session.get(Playlist, playlist_id) is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    position = {vid: idx for idx, vid in enumerate(payload.video_ids)}
    items = session.exec(
        select(PlaylistItem).where(PlaylistItem.playlist_id == playlist_id)
    ).all()
    for item in items:
        if item.video_id in position:
            item.position = position[item.video_id]
            session.add(item)
    session.commit()
    return get_playlist(playlist_id, session)


@router.get("/{playlist_id}/thumbnail")
def get_playlist_thumbnail(
    playlist_id: int, session: Session = Depends(get_session)
):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    path = _resolved_cover_file(session, playlist)
    if path is None:
        raise HTTPException(status_code=404, detail="No thumbnail")
    return FileResponse(path, media_type="image/jpeg")


@router.post("/{playlist_id}/thumbnail", response_model=PlaylistRead)
async def upload_playlist_thumbnail(
    playlist_id: int,
    file: UploadFile,
    session: Session = Depends(get_session),
):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        dest = write_playlist_cover(playlist_id, data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Could not read image") from exc
    playlist.cover_path = dest
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    return _to_playlist_read(session, playlist)


@router.post("/{playlist_id}/sync", response_model=PlaylistRead)
def sync_playlist(playlist_id: int, session: Session = Depends(get_session)):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if not playlist.subscribed:
        raise HTTPException(
            status_code=400, detail="Playlist is not a YouTube subscription"
        )
    start_playlist_sync(playlist_id)
    return _to_playlist_read(session, playlist)


@router.post("/import", response_model=PlaylistRead)
def import_playlist(payload: PlaylistImport, session: Session = Depends(get_session)):
    url = clean_url(payload.url, keep_playlist=True)
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")

    if payload.subscribe:
        other = find_subscribed_by_url(session, url)
        if other is not None:
            raise HTTPException(
                status_code=409,
                detail="Already subscribed to this YouTube playlist",
            )

    selected_entries = [e.strip() for e in payload.entries if e.strip()]
    if selected_entries:
        title = (payload.name or "").strip()
        if not title:
            try:
                preview = downloader.extract_playlist_entries(url)
                title = preview.get("title") or "Imported playlist"
            except Exception:  # noqa: BLE001
                title = "Imported playlist"
        entries = selected_entries
    else:
        try:
            title, entries = downloader.extract_playlist(url)
        except Exception as exc:  # noqa: BLE001 - surface extraction failures
            raise HTTPException(status_code=400, detail=f"Could not read playlist: {exc}")
        if payload.name and payload.name.strip():
            title = payload.name.strip()

    if not entries:
        raise HTTPException(status_code=400, detail="No videos found in playlist")

    quality = (payload.quality_preset or "best").strip() or "best"
    _shift_playlists_down(session)
    playlist = Playlist(
        name=title,
        source_type=PlaylistSource.youtube,
        source_url=url,
        subscribed=bool(payload.subscribe),
        quality_preset=quality,
        position=0,
    )
    session.add(playlist)
    session.commit()
    session.refresh(playlist)

    downloader.start_playlist_import(playlist.id, entries, quality)
    return _to_playlist_read(session, playlist)
