"""What a user told recommendations, and what they were shown without watching.

``rec_feedback`` rows leave videos and channels out of every recommendation
shelf. ``rec_impressions`` counts the separate visits a recommendation was shown
on; one shown again and again without being watched sinks (``impression_penalty``).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, delete, select

from ...models import RecFeedback, RecImpression, as_utc, utcnow
from ..follows import normalize_channel_url

KINDS = frozenset({"video", "channel", "suggestion"})
#: Shows closer together than this are one visit (paging, a refresh).
VISIT_GAP = timedelta(hours=1)
#: Each earlier visit a recommendation was shown on lowers it by this much...
IMPRESSION_STEP = 0.025
#: ...up to this many visits; past it the item drops to the end of the feed.
IMPRESSION_CAP = 6
#: Impressions older than this are forgotten (a video can come back).
IMPRESSION_TTL = timedelta(days=30)


def channel_key(channel_url: str | None, channel: str | None) -> str:
    """How feedback names a channel: its normalized URL, else its name."""
    url = normalize_channel_url(channel_url or "")
    if url:
        return url
    name = (channel or "").strip().lower()
    return f"name:{name}" if name else ""


@dataclass
class Exclusions:
    """Everything one user asked not to see."""

    videos: set[str] = field(default_factory=set)
    channel_urls: set[str] = field(default_factory=set)
    channel_names: set[str] = field(default_factory=set)
    dismissed_urls: set[str] = field(default_factory=set)
    dismissed_names: set[str] = field(default_factory=set)

    def blocks_channel(self, channel_url: str | None, channel: str | None) -> bool:
        url = normalize_channel_url(channel_url or "")
        if url and url in self.channel_urls:
            return True
        name = (channel or "").strip().lower()
        return bool(name) and name in self.channel_names

    def blocks(self, key: str, channel_url: str | None, channel: str | None) -> bool:
        return key in self.videos or self.blocks_channel(channel_url, channel)

    def dismissed(self, channel_url: str | None, channel: str | None) -> bool:
        url = normalize_channel_url(channel_url or "")
        if url and url in self.dismissed_urls:
            return True
        name = (channel or "").strip().lower()
        return bool(name) and name in self.dismissed_names


def exclusions(session: Session, user_id: int) -> Exclusions:
    out = Exclusions()
    for row in session.exec(
        select(RecFeedback).where(RecFeedback.user_id == user_id)
    ).all():
        if row.kind == "video":
            out.videos.add(row.key)
            continue
        urls, names = (
            (out.channel_urls, out.channel_names)
            if row.kind == "channel"
            else (out.dismissed_urls, out.dismissed_names)
        )
        if row.key.startswith("name:"):
            names.add(row.key[5:])
        else:
            urls.add(row.key)
        # A channel blocked by URL is also blocked where only its name is known.
        if row.label:
            names.add(row.label.strip().lower())
    return out


def add(
    session: Session, user_id: int, *, kind: str, key: str, label: str | None
) -> RecFeedback:
    """Store one piece of feedback (the same one twice is one row)."""
    if kind not in KINDS:
        raise ValueError(f"unknown feedback kind {kind!r}")
    existing = session.exec(
        select(RecFeedback).where(
            RecFeedback.user_id == user_id,
            RecFeedback.kind == kind,
            RecFeedback.key == key,
        )
    ).first()
    if existing is not None:
        return existing
    row = RecFeedback(
        user_id=user_id, kind=kind, key=key, label=(label or "").strip()[:300] or None
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError:
        # Two clicks raced; the other one stored it.
        session.rollback()
        found = session.exec(
            select(RecFeedback).where(
                RecFeedback.user_id == user_id,
                RecFeedback.kind == kind,
                RecFeedback.key == key,
            )
        ).first()
        if found is None:
            raise
        return found
    session.refresh(row)
    return row


def remove(session: Session, user_id: int, feedback_id: int) -> bool:
    row = session.get(RecFeedback, feedback_id)
    if row is None or row.user_id != user_id:
        return False
    session.delete(row)
    session.commit()
    return True


def listed(session: Session, user_id: int) -> list[RecFeedback]:
    return list(
        session.exec(
            select(RecFeedback)
            .where(RecFeedback.user_id == user_id)
            .order_by(col(RecFeedback.created_at).desc(), col(RecFeedback.id).desc())
        ).all()
    )


def earlier_visits(session: Session, user_id: int) -> dict[str, int]:
    """Per key, the visits it was shown on before the current one.

    A show within ``VISIT_GAP`` belongs to the visit in progress, so paging
    through a feed does not reorder the feed under the user.
    """
    now = utcnow()
    out: dict[str, int] = {}
    for row in session.exec(
        select(RecImpression).where(
            RecImpression.user_id == user_id,
            col(RecImpression.last_shown_at) >= now - IMPRESSION_TTL,
        )
    ).all():
        current = now - as_utc(row.last_shown_at) < VISIT_GAP
        count = row.shown_count - (1 if current else 0)
        if count > 0:
            out[row.key] = count
    return out


def impression_penalty(visits: int) -> float:
    return IMPRESSION_STEP * min(visits, IMPRESSION_CAP)


def worn_out(visits: int) -> bool:
    return visits >= IMPRESSION_CAP


def record_shown(session: Session, user_id: int, keys: Iterable[str]) -> None:
    """Count one visit for each of ``keys`` (a second show within the hour is free)."""
    wanted = [k for k in dict.fromkeys(keys) if k]
    if not wanted:
        return
    now = utcnow()
    rows = {
        row.key: row
        for row in session.exec(
            select(RecImpression).where(
                RecImpression.user_id == user_id, col(RecImpression.key).in_(wanted)
            )
        ).all()
    }
    for key in wanted:
        row = rows.get(key)
        if row is None:
            session.add(
                RecImpression(
                    user_id=user_id, key=key, shown_count=1, last_shown_at=now
                )
            )
            continue
        last = as_utc(row.last_shown_at)
        if now - last >= IMPRESSION_TTL:
            row.shown_count = 1
        elif now - last >= VISIT_GAP:
            row.shown_count += 1
        row.last_shown_at = now
        session.add(row)
    try:
        session.commit()
    except IntegrityError:
        # A parallel page request inserted the same keys; its count stands.
        session.rollback()


def forget_old_impressions(session: Session) -> int:
    result = session.execute(
        delete(RecImpression).where(
            col(RecImpression.last_shown_at) < utcnow() - IMPRESSION_TTL
        )
    )
    session.commit()
    return int(getattr(result, "rowcount", 0) or 0)
