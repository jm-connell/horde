"""What Ask about Horde is told about Ask's channels, when a question needs it.

A question about indexing ("which channels are indexed?") or about what a
channel says that reached Horde (so no indexed channel answered it) gets the
Ask channels and their progress, and a word on each channel it names that is
in the library but not indexed. Anyone signed in can list Ask's channels, so
that part needs no consent; the library's videos of a channel do.
"""

from __future__ import annotations

from sqlmodel import Session, col, func, select

from ...models import KbChannel, Video
from ..ai import help_catalog
from ..auth.accounts import AuthUser
from . import channels as kb_channels
from . import routing

_MAX_VIDEOS = 8
_TITLE_CHARS = 90


def _progress(channel: KbChannel, counts: kb_channels.ChannelCounts) -> str:
    name = channel.channel_name or channel.channel_url
    done = counts.fetched + counts.no_captions + counts.unavailable
    return (
        f"- {name}: {channel.status.value}, {done} of {counts.videos} videos "
        f"checked, {counts.fetched} with captions"
    )


def _library_channels(session: Session) -> list[tuple[str, str | None, int]]:
    rows = session.exec(
        select(Video.channel, func.max(Video.channel_url), func.count())
        .where(col(Video.channel).is_not(None), col(Video.needs_review).is_(False))
        .group_by(col(Video.channel))
    ).all()
    return [(name, url, n) for name, url, n in rows if name]


def _videos_of(session: Session, channel: str) -> list[str]:
    rows = session.exec(
        select(Video)
        .where(Video.channel == channel, col(Video.needs_review).is_(False))
        .order_by(col(Video.added_at).desc())
        .limit(_MAX_VIDEOS)
    ).all()
    return [f'  #{v.id} "{(v.title or "")[:_TITLE_CHARS]}"' for v in rows]


def for_question(
    session: Session, question: str, user: AuthUser, *, use_data: bool
) -> str | None:
    """The note on Ask's channels this question needs, or None."""
    about_ask = routing.about_ask_channels(question)
    said = routing.asks_what_said(question)
    if not (about_ask or said):
        return None
    kb = kb_channels.list_channels(session)
    unindexed = [
        (name, n)
        for name, url, n in _library_channels(session)
        if routing.names_channel(question, name, url, initials=True)
        and not any(
            routing.names_channel(name, c.channel_name, c.channel_url) for c in kb
        )
    ]
    named_kb = routing.named_channels(question, kb)
    if not about_ask and not unindexed and not named_kb:
        return None  # "what does he say…": nothing here to add

    manage = help_catalog.can_see(user, "manage_ask")
    where = (
        "Settings → Library → Channels Ask can answer from ([[setting:ask-channels]])"
        if manage
        else "added by an administrator"
    )
    lines = ["Ask's channels (Ask answers what a channel says only from these):"]
    if kb:
        counts = kb_channels.counts(session)
        lines += [
            _progress(c, counts.get(c.id or 0, kb_channels.ChannelCounts())) for c in kb
        ]
    else:
        lines.append("- none: no channel is indexed yet")
    for name, n in unindexed:
        if use_data:
            lines.append(
                f"{name} is not indexed for Ask; the library has {n} of its videos "
                "(Chat on one answers from that video):"
            )
            lines += _videos_of(session, name)
        else:
            lines.append(f"{name} is not indexed for Ask.")
    lines.append(
        f"Channels are indexed in {where}. When the user asks what a channel "
        "says and it is not ready here, say it is not indexed (or still "
        "indexing), how to index it, and offer the library videos above if "
        "any; never offer to download or search something else instead."
    )
    return "\n".join(lines)
