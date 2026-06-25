from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import func
from sqlmodel import Session, select

from ..database import get_session
from ..models import Playlist, PlaylistItem, PlaylistSource, Video
from ..schemas import (
    PlaylistCreate,
    PlaylistDetail,
    PlaylistImport,
    PlaylistItemAdd,
    PlaylistRead,
    PlaylistReorder,
    PlaylistUpdate,
)
from ..services import downloader
from ..services.url_clean import clean_url
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


def _to_playlist_read(session: Session, playlist: Playlist) -> PlaylistRead:
    return PlaylistRead(
        id=playlist.id,
        name=playlist.name,
        description=playlist.description,
        source_type=playlist.source_type,
        source_url=playlist.source_url,
        created_at=playlist.created_at,
        item_count=_item_count(session, playlist.id),
    )


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


@router.get("", response_model=list[PlaylistRead])
def list_playlists(session: Session = Depends(get_session)):
    playlists = session.exec(
        select(Playlist).order_by(Playlist.created_at.desc())
    ).all()
    return [_to_playlist_read(session, p) for p in playlists]


@router.post("", response_model=PlaylistRead)
def create_playlist(payload: PlaylistCreate, session: Session = Depends(get_session)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    playlist = Playlist(
        name=name,
        description=payload.description,
        source_type=PlaylistSource.user,
    )
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    return _to_playlist_read(session, playlist)


@router.get("/{playlist_id}", response_model=PlaylistDetail)
def get_playlist(playlist_id: int, session: Session = Depends(get_session)):
    playlist = session.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    videos = _ordered_videos(session, playlist_id)
    base = _to_playlist_read(session, playlist)
    return PlaylistDetail(**base.model_dump(), videos=[_to_read(v) for v in videos])


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
    for key, value in data.items():
        setattr(playlist, key, value)
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
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
    if session.get(Video, payload.video_id) is None:
        raise HTTPException(status_code=404, detail="Video not found")

    existing = session.exec(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.video_id == payload.video_id,
        )
    ).first()
    if existing is None:
        next_pos = _item_count(session, playlist_id)
        session.add(
            PlaylistItem(
                playlist_id=playlist_id,
                video_id=payload.video_id,
                position=next_pos,
            )
        )
        session.commit()

    return get_playlist(playlist_id, session)


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


@router.post("/import", response_model=PlaylistRead)
def import_playlist(payload: PlaylistImport, session: Session = Depends(get_session)):
    url = clean_url(payload.url, keep_playlist=True)
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    try:
        title, entries = downloader.extract_playlist(url)
    except Exception as exc:  # noqa: BLE001 - surface extraction failures
        raise HTTPException(status_code=400, detail=f"Could not read playlist: {exc}")
    if not entries:
        raise HTTPException(status_code=400, detail="No videos found in playlist")

    playlist = Playlist(
        name=title,
        source_type=PlaylistSource.youtube,
        source_url=url,
    )
    session.add(playlist)
    session.commit()
    session.refresh(playlist)

    downloader.start_playlist_import(playlist.id, entries, payload.quality_preset)
    return _to_playlist_read(session, playlist)
