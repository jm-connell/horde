"""SponsorBlock segments for Ask: keep sponsor reads out of answers.

SponsorBlock (https://sponsor.ajay.app) is a crowd-sourced list of the
timestamps of ad reads, self-promotion and "like and subscribe" requests. The Ask
worker asks it once per indexed video (only the public YouTube id is sent) and
stores the segments on the ``KbVideo``; retrieval then leaves out passages that
are mostly ad and cuts the ad lines out of the rest (``retrieval._pick``), and
the **Said in videos** search skips mostly-ad hits. Nothing here runs while a
question is answered.

Requests are spaced ``SPACING_SEC`` apart (``runtime.SponsorPacer`` on
``AppContext.knowledge``): one right after a video's captions are stored when
the pacer allows (YouTube fetches are 15 s apart anyway), otherwise the video
waits for the backfill (``step``), which also covers videos indexed before this
existed. Segments are often submitted days after upload, so each daily listing
of a channel makes its videos younger than ``RECENT_DAYS`` due again
(``mark_recent_due``). A failed request (timeout, 429, 5xx) leaves the video
due and pauses every request for ``FAILURE_PAUSE_SEC``; indexing never waits
on it. ``HORDE_ASK_SPONSORBLOCK=0`` turns the requests off.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import update
from sqlmodel import Session, col, select

from ... import config
from ...context import current, get_engine
from ...models import KbChannel, KbChannelStatus, KbVideo, require_id, utcnow
from . import captions
from .chunking import LINE_WINDOW_SEC, Line

logger = logging.getLogger(__name__)

API_URL = "https://sponsor.ajay.app/api/skipSegments"
# Ads, the channel's own merch or Patreon plug, "like and subscribe". Intros and
# outros are left in: a podcast's intro previews what the episode covers.
CATEGORIES = ("sponsor", "selfpromo", "interaction")
_ACTION_TYPES = ("skip", "mute")
TIMEOUT = httpx.Timeout(5.0, connect=3.0)
FAILURE_PAUSE_SEC = 600.0
RECENT_DAYS = 30
# Asked again on a listing only when the last answer is older than this (a
# channel whose listing failed is listed again within the hour).
_RECHECK_AFTER = timedelta(hours=20)
# A passage this much inside ads is left out; less, and its ad lines are cut.
MOSTLY_AD = 0.5

Segment = tuple[float, float, str]


def enabled() -> bool:
    return config.ASK_SPONSORBLOCK


def _parse_response(data: Any) -> list[Segment]:
    out: list[Segment] = []
    if not isinstance(data, list):
        return out
    for item in data:
        if not isinstance(item, dict):
            continue
        if item.get("actionType", "skip") not in _ACTION_TYPES:
            continue
        category = item.get("category")
        segment = item.get("segment")
        if category not in CATEGORIES or not isinstance(segment, list):
            continue
        try:
            start, end = float(segment[0]), float(segment[1])
        except IndexError, TypeError, ValueError:
            continue
        if 0 <= start < end:
            out.append((round(start, 2), round(end, 2), str(category)))
    out.sort()
    return out


def fetch(yt_id: str) -> list[Segment] | None:
    """The video's segments ([] when it has none), or None when the request
    failed and should be tried again later. Never raises."""
    try:
        resp = httpx.get(
            API_URL,
            params={
                "videoID": yt_id,
                "categories": json.dumps(list(CATEGORIES)),
                "actionTypes": json.dumps(list(_ACTION_TYPES)),
            },
            timeout=TIMEOUT,
            headers={"Accept": "application/json"},
        )
    except httpx.HTTPError:
        logger.warning("Ask: SponsorBlock request for %s failed", yt_id, exc_info=True)
        return None
    if resp.status_code == 404:  # no segments for this video
        return []
    if resp.status_code == 400:  # an id SponsorBlock does not accept: no segments
        logger.debug("Ask: SponsorBlock rejected %s: %s", yt_id, resp.text[:200])
        return []
    if resp.status_code != 200:
        logger.warning("Ask: SponsorBlock answered %s for %s", resp.status_code, yt_id)
        return None
    try:
        return _parse_response(resp.json())
    except ValueError:
        logger.warning(
            "Ask: SponsorBlock sent unreadable JSON for %s", yt_id, exc_info=True
        )
        return None


def store(video_id: int, segments: list[Segment]) -> None:
    with Session(get_engine()) as session:
        video = session.get(KbVideo, video_id)
        if video is None:  # its channel was removed meanwhile
            return
        video.sponsor_segments = (
            json.dumps([list(s) for s in segments]) if segments else None
        )
        video.sponsor_checked_at = utcnow()
        session.add(video)
        session.commit()


def refresh(video_id: int, yt_id: str) -> bool:
    """Ask SponsorBlock about one video when the pacer allows. Call with no
    session open: the request must not hold the database. True when it ran."""
    if not enabled():
        return False
    pacer = current().knowledge.sponsor
    if not pacer.try_reserve():
        return False
    segments = fetch(yt_id)
    if segments is None:
        pacer.pause(FAILURE_PAUSE_SEC)
        # The backfill tries the others before this one again.
        pacer.failed.add(video_id)
        return True
    pacer.failed.discard(video_id)
    store(video_id, segments)
    return True


def _due(session: Session, skip: set[int] | None = None) -> KbVideo | None:
    query = (
        select(KbVideo)
        .join(KbChannel, col(KbChannel.id) == col(KbVideo.kb_channel_id))
        .where(
            col(KbVideo.sponsor_checked_at).is_(None),
            KbVideo.fetch_status == captions.FETCHED,
            col(KbChannel.status) != KbChannelStatus.paused,
        )
        .order_by(col(KbVideo.position), col(KbVideo.id))
        .limit(1)
    )
    if skip:
        query = query.where(col(KbVideo.id).not_in(skip))
    return session.exec(query).first()


def has_due() -> bool:
    if not enabled():
        return False
    with Session(get_engine()) as session:
        return _due(session) is not None


def step() -> bool:
    """Backfill: ask about the next video that has not been asked (newest
    uploads first; ones whose request failed after the rest, so one video
    SponsorBlock keeps failing on does not stall the others). True when a
    request ran."""
    pacer = current().knowledge.sponsor
    if not enabled() or pacer.seconds_until_free() > 0:
        return False
    with Session(get_engine()) as session:
        video = _due(session, pacer.failed)
        if video is None and pacer.failed:
            pacer.failed.clear()  # every other video is asked: try them again
            video = _due(session)
        if video is None:
            return False
        video_id, yt_id = require_id(video), video.yt_id
    return refresh(video_id, yt_id)


def mark_recent_due(session: Session, channel_id: int) -> int:
    """Make the channel's videos younger than ``RECENT_DAYS`` due again (their
    stored segments stay in use until the new answer). Returns how many."""
    now = datetime.now(UTC)
    cutoff = (now - timedelta(days=RECENT_DAYS)).date().isoformat()
    result = session.execute(
        update(KbVideo)
        .where(
            col(KbVideo.kb_channel_id) == channel_id,
            col(KbVideo.fetch_status) == captions.FETCHED,
            col(KbVideo.published_at) >= cutoff,
            col(KbVideo.sponsor_checked_at) < now - _RECHECK_AFTER,
        )
        .values(sponsor_checked_at=None)
    )
    session.commit()
    return int(getattr(result, "rowcount", 0) or 0)


# --- Reading stored segments (retrieval and search) -------------------------


def parse(raw: str | None) -> list[tuple[float, float]]:
    """Stored segments as merged, sorted ``(start, end)`` spans."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
        spans = sorted((float(s[0]), float(s[1])) for s in data)
    except TypeError, ValueError, IndexError:
        logger.warning("Ask: unreadable stored SponsorBlock segments", exc_info=True)
        return []
    merged: list[tuple[float, float]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def ad_share(start: float, end: float, spans: list[tuple[float, float]]) -> float:
    """How much of ``start``–``end`` lies inside ``spans`` (0 to 1)."""
    if end <= start:
        return 0.0
    inside = sum(max(0.0, min(end, e) - max(start, s)) for s, e in spans)
    return min(1.0, inside / (end - start))


def mostly_ad(start: float, end: float, spans: list[tuple[float, float]]) -> bool:
    return bool(spans) and ad_share(start, end, spans) >= MOSTLY_AD


def lines_outside(lines: list[Line], spans: list[tuple[float, float]]) -> list[Line]:
    """``lines`` without the ones mostly inside an ad (a line lasts until the
    next one starts; the last ``LINE_WINDOW_SEC``)."""
    if not spans:
        return lines
    out: list[Line] = []
    for i, (t, text) in enumerate(lines):
        end = lines[i + 1][0] if i + 1 < len(lines) else t + LINE_WINDOW_SEC
        if not mostly_ad(t, max(end, t + 0.01), spans):
            out.append((t, text))
    return out


# Stored lines are rounded to 1/100 s, passage bounds are not.
_ROUNDING = 0.01


def without_ads(
    lines: list[Line], start: float, end: float, spans: list[tuple[float, float]]
) -> tuple[float, float, str] | None:
    """The passage ``start``–``end`` rebuilt from its caption lines without the
    ones inside an ad: ``(start, end, text)``, or None when nothing is left."""
    outside = lines_outside(lines, spans)
    kept = [
        (t, text) for t, text in outside if start - _ROUNDING <= t < end - _ROUNDING
    ]
    if not kept:
        return None
    last = kept[-1][0]
    following = [t for t, _ in lines if t > last]
    new_end = min(end, following[0]) if following else end
    return max(start, kept[0][0]), new_end, " ".join(text for _, text in kept)
