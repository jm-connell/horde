"""YouTube's chat replay JSON into small, bounded chat items.

A chunk (``liveChatContinuation``) holds ``replayChatItemAction`` entries, each
with the message's position in the video (``videoOffsetTimeMsec``) and YouTube's
live chat renderers inside. Only what the watch page shows is kept: text
messages, Super Chats, Super Stickers, memberships and membership gifts.
Placeholders, engagement notices, the ticker, banners, polls and anything
unknown are dropped. Nothing here raises on odd input: YouTube's layout changes
without notice, and a broken message is skipped, not fatal.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

#: Characters of message text kept per item (text runs together).
MAX_TEXT = 2000
#: Characters of an author name.
MAX_AUTHOR = 200
#: Hosts custom emoji, sticker and badge images may come from.
IMAGE_HOSTS = frozenset({"yt3.ggpht.com", "yt3.googleusercontent.com"})

_BADGE_ICONS = {"OWNER": "owner", "MODERATOR": "moderator", "VERIFIED": "verified"}
_KINDS = {
    "liveChatTextMessageRenderer": "text",
    "liveChatPaidMessageRenderer": "paid",
    "liveChatPaidStickerRenderer": "sticker",
    "liveChatMembershipItemRenderer": "membership",
    "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer": "gift",
}


@dataclass
class ChatRun:
    """A piece of a message: text, or a custom emoji image with its shortcut."""

    text: str | None = None
    emoji_url: str | None = None
    emoji_alt: str | None = None


@dataclass
class ChatItem:
    id: str
    offset_ms: int
    #: ``text`` | ``paid`` | ``sticker`` | ``membership`` | ``gift``
    kind: str
    author: str | None
    #: ``owner`` | ``moderator`` | ``member`` | ``verified``
    badges: list[str] = field(default_factory=list)
    runs: list[ChatRun] = field(default_factory=list)
    #: Super Chat / Super Sticker amount as YouTube shows it ("$5.00").
    amount: str | None = None
    #: YouTube's tier colour, ``#rrggbb``.
    color: str | None = None
    sticker_url: str | None = None
    sticker_alt: str | None = None
    #: Membership or gift line ("Member for 6 months", "Gifted 5 memberships").
    header: str | None = None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _first_dict_key(value: dict[str, Any]) -> str | None:
    """The first key holding a dict (actions also carry plain-string keys)."""
    return next((k for k, v in value.items() if isinstance(v, dict)), None)


def _plain(text: Any) -> str | None:
    """``{"simpleText": ...}`` or ``{"runs": [{"text": ...}]}`` as one string."""
    obj = _dict(text)
    simple = obj.get("simpleText")
    if isinstance(simple, str):
        return simple.strip() or None
    joined = "".join(
        r["text"]
        for r in _list(obj.get("runs"))
        if isinstance(_dict(r).get("text"), str)
    )
    return joined.strip() or None


def _safe_image(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw:
        return None
    url: str = "https:" + raw if raw.startswith("//") else raw
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in IMAGE_HOSTS:
        return None
    return url


def _largest_image(thumbnails: Any) -> str | None:
    """The last (largest) thumbnail on an allowed host."""
    for thumb in reversed(_list(_dict(thumbnails).get("thumbnails"))):
        url = _safe_image(_dict(thumb).get("url"))
        if url:
            return url
    return None


def _color(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return f"#{value & 0xFFFFFF:06x}"


def _badges(renderer: dict[str, Any]) -> list[str]:
    found: list[str] = []
    for raw in _list(renderer.get("authorBadges")):
        badge = _dict(_dict(raw).get("liveChatAuthorBadgeRenderer"))
        icon = _dict(badge.get("icon")).get("iconType")
        name = _BADGE_ICONS.get(icon) if isinstance(icon, str) else None
        if name is None and badge.get("customThumbnail"):
            name = "member"
        if name and name not in found:
            found.append(name)
    return found


def _runs(message: Any) -> list[ChatRun]:
    runs: list[ChatRun] = []
    budget = MAX_TEXT
    for raw in _list(_dict(message).get("runs")):
        run = _dict(raw)
        text = run.get("text")
        if isinstance(text, str):
            if budget > 0 and text:
                runs.append(ChatRun(text=text[:budget]))
                budget -= len(runs[-1].text or "")
            continue
        emoji = _dict(run.get("emoji"))
        if not emoji:
            continue
        shortcuts = [s for s in _list(emoji.get("shortcuts")) if isinstance(s, str)]
        emoji_id = emoji.get("emojiId") if isinstance(emoji.get("emojiId"), str) else ""
        if emoji.get("isCustomEmoji") is True:
            alt = shortcuts[0] if shortcuts else emoji_id
            url = _largest_image(emoji.get("image"))
            runs.append(
                ChatRun(emoji_url=url, emoji_alt=alt) if url else ChatRun(text=alt)
            )
        elif emoji_id:
            runs.append(ChatRun(text=emoji_id))
    return runs


def _author(renderer: dict[str, Any]) -> str | None:
    name = _plain(renderer.get("authorName"))
    return name[:MAX_AUTHOR] if name else None


def _item(
    renderer_key: str, renderer: dict[str, Any], offset_ms: int
) -> ChatItem | None:
    kind = _KINDS.get(renderer_key)
    item_id = renderer.get("id")
    if kind is None or not isinstance(item_id, str) or not item_id:
        return None
    if kind == "gift":
        header = _dict(
            _dict(renderer.get("header")).get("liveChatSponsorshipsHeaderRenderer")
        )
        return ChatItem(
            id=item_id,
            offset_ms=offset_ms,
            kind=kind,
            author=_author(header),
            badges=_badges(header),
            header=_plain(header.get("primaryText")),
        )
    item = ChatItem(
        id=item_id,
        offset_ms=offset_ms,
        kind=kind,
        author=_author(renderer),
        badges=_badges(renderer),
        runs=_runs(renderer.get("message")),
    )
    if kind in ("paid", "sticker"):
        item.amount = _plain(renderer.get("purchaseAmountText"))
    if kind == "paid":
        item.color = _color(renderer.get("bodyBackgroundColor"))
    elif kind == "sticker":
        sticker = _dict(renderer.get("sticker"))
        item.sticker_url = _largest_image(sticker)
        label = _dict(_dict(sticker.get("accessibility")).get("accessibilityData"))
        item.sticker_alt = (
            label.get("label") if isinstance(label.get("label"), str) else None
        )
        item.color = _color(
            renderer.get("moneyChipBackgroundColor", renderer.get("backgroundColor"))
        )
    elif kind == "membership":
        item.header = _plain(renderer.get("headerPrimaryText")) or _plain(
            renderer.get("headerSubtext")
        )
    return item


def _offset(value: Any) -> int | None:
    try:
        offset = int(value)
    except TypeError, ValueError:
        return None
    return offset if offset >= 0 else None


def parse_actions(actions: list[Any]) -> list[ChatItem]:
    """Chat items in ``actions``, in offset order, each id once."""
    items: list[ChatItem] = []
    seen: set[str] = set()
    for raw in _list(actions):
        replay = _dict(_dict(raw).get("replayChatItemAction"))
        offset = _offset(replay.get("videoOffsetTimeMsec"))
        if offset is None:
            continue
        for inner_raw in _list(replay.get("actions")):
            inner = _dict(inner_raw)
            key = _first_dict_key(inner)
            if key != "addChatItemAction":
                continue
            wrapped = _dict(_dict(inner[key]).get("item"))
            renderer_key = _first_dict_key(wrapped)
            if renderer_key is None:
                continue
            item = _item(renderer_key, wrapped[renderer_key], offset)
            if item is not None and item.id not in seen:
                seen.add(item.id)
                items.append(item)
    items.sort(key=lambda i: i.offset_ms)
    return items


def continuation_tokens(lcc: dict[str, Any]) -> tuple[str | None, str | None]:
    """``(replay token, seek token)`` of a chunk: the next chunk, and a jump."""
    replay = seek = None
    for raw in _list(_dict(lcc).get("continuations")):
        cont = _dict(raw)
        token = _dict(cont.get("liveChatReplayContinuationData")).get("continuation")
        if isinstance(token, str) and token:
            replay = token
        token = _dict(cont.get("playerSeekContinuationData")).get("continuation")
        if isinstance(token, str) and token:
            seek = token
    return replay, seek


def chat_continuation(initial_data: dict[str, Any]) -> str | None:
    """The watch page's chat token; None when the video has no chat replay."""
    renderer = _dict(
        _dict(
            _dict(
                _dict(_dict(initial_data).get("contents")).get(
                    "twoColumnWatchNextResults"
                )
            ).get("conversationBar")
        ).get("liveChatRenderer")
    )
    for raw in _list(renderer.get("continuations")):
        token = _dict(_dict(raw).get("reloadContinuationData")).get("continuation")
        if isinstance(token, str) and token:
            return token
    return None


def live_status_from_player_response(pr: dict[str, Any]) -> str | None:
    """yt-dlp's ``live_status`` rule, from the watch page's ``videoDetails``."""
    details = _dict(_dict(pr).get("videoDetails"))
    if details.get("isPostLiveDvr") is True:
        return "post_live"
    if details.get("isLive") is True:
        return "is_live"
    if details.get("isUpcoming") is True:
        return "is_upcoming"
    live_content = details.get("isLiveContent")
    if live_content is True:
        return "was_live"
    if details.get("isLive") is False or live_content is False:
        return "not_live"
    return None
