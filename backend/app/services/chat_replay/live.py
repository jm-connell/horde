"""The network side of live chat: a broadcast that is live now.

Opening reads the watch page and the ``live_chat`` page (about the last 75
messages and a continuation token); each poll is one POST to
``live_chat/get_live_chat`` with that token, answering the messages since and
the next token with how long to wait (``timeoutMs``). No token means the
broadcast ended. Messages carry their send time (``timestampUsec``), which is
kept as the item's ``offset_ms`` (epoch milliseconds) so the page can follow
the viewer's position in the DVR window. The poll loop is ``live_runtime``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .parse import ChatItem, _dict, _first_dict_key, _item, _list
from .youtube import (
    WATCH_URL,
    ChatHandle,
    open_page,
    post_innertube,
    with_cookie_retry,
)

LIVE_CHAT_PAGE_URL = "https://www.youtube.com/live_chat?continuation={}"
LIVE_API_URL = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key={}"


@dataclass
class LivePoll:
    items: list[ChatItem]
    #: Ids of messages YouTube deleted.
    removed: list[str]
    #: The next poll's token; None when the broadcast ended.
    token: str | None
    #: How long YouTube asks to wait before the next poll.
    timeout_ms: int


def _send_ms(renderer: dict[str, Any]) -> int | None:
    raw = renderer.get("timestampUsec")
    try:
        sent = int(raw) // 1000 if isinstance(raw, str | int) else None
    except ValueError:
        return None
    return sent if sent is not None and sent > 0 else None


def parse_live_actions(actions: list[Any]) -> tuple[list[ChatItem], list[str]]:
    """Messages (in send order, each once) and the ids YouTube deleted (by the
    author, or by a moderator)."""
    items: list[ChatItem] = []
    removed: list[str] = []
    seen: set[str] = set()
    for raw in _list(actions):
        action = _dict(raw)
        key = _first_dict_key(action)
        if key in ("removeChatItemAction", "markChatItemAsDeletedAction"):
            target = _dict(action[key]).get("targetItemId")
            if isinstance(target, str) and target:
                removed.append(target)
            continue
        if key != "addChatItemAction":
            continue
        wrapped = _dict(_dict(action[key]).get("item"))
        renderer_key = _first_dict_key(wrapped)
        if renderer_key is None:
            continue
        renderer = wrapped[renderer_key]
        sent = _send_ms(renderer)
        if sent is None:
            continue
        item = _item(renderer_key, renderer, sent)
        if item is not None and item.id not in seen:
            seen.add(item.id)
            items.append(item)
    items.sort(key=lambda i: i.offset_ms)
    return items, removed


def poll_from(lcc: dict[str, Any]) -> LivePoll:
    """A ``liveChatContinuation`` as a ``LivePoll``."""
    items, removed = parse_live_actions(_list(lcc.get("actions")))
    token: str | None = None
    timeout_ms = 10_000
    for raw in _list(lcc.get("continuations")):
        cont = _dict(raw)
        data = _dict(
            cont.get("invalidationContinuationData")
            or cont.get("timedContinuationData")
            or cont.get("reloadContinuationData")
        )
        value = data.get("continuation")
        if isinstance(value, str) and value:
            token = value
            timeout = data.get("timeoutMs")
            if isinstance(timeout, int) and not isinstance(timeout, bool):
                timeout_ms = timeout
            break
    return LivePoll(items, removed, token, timeout_ms)


def open_live_chat(
    yt_id: str,
) -> tuple[ChatHandle | None, LivePoll | None, str | None]:
    """The chat of a live broadcast: its handle and first messages (None, None
    when it has no chat), and the watch page's ``live_status``. Raises
    ``ChatReplayError``."""
    url = WATCH_URL.format(yt_id)
    live_status, handle, lcc = with_cookie_retry(
        url, lambda cookies: open_page(yt_id, url, cookies, LIVE_CHAT_PAGE_URL)
    )
    if handle is None:
        return None, None, live_status
    return handle, poll_from(lcc), live_status


def poll_live_chat(handle: ChatHandle, token: str, offset_ms: int) -> LivePoll:
    """The messages since ``token``. Raises ``ChatReplayError``."""
    return poll_from(post_innertube(handle, LIVE_API_URL, token, offset_ms))
