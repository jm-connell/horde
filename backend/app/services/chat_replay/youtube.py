"""The network side of chat replay: YouTube's watch page, chat page and chunks.

Opening reads the watch page (whether the video has a chat replay, its
``live_status``, the innertube config) and the chat replay page (the first
chunk and its tokens). A chunk after that is one POST to
``live_chat/get_live_chat_replay``: with the seek token to jump to a position,
or the replay token for the stretch after the last one. This is the request
loop yt-dlp's ``YoutubeLiveChatFD`` runs from the start of a chat; reading from
any position instead is what keeps a viewer's cost to what they watch. Pages are
read with yt-dlp's helpers so its cookie handling, consent and client headers
apply. Nothing here holds state; ``service`` keeps it on the context.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from ..comments.fetch import FAILED, LATER, RETRY, UNAVAILABLE
from ..downloads.subtitles import SubtitleYtdlpLogger
from ..ytdlp_common import (
    ERROR_KIND_BOT,
    ERROR_KIND_COOKIES,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_POT,
    ERROR_KIND_RATE_LIMIT,
    ERROR_KIND_UNAVAILABLE,
    apply_cookie_opts,
    classify_ytdlp_error,
    cookie_configured,
    is_network_error,
    remember_cookie_required,
    should_retry_with_cookies,
    url_cookie_required,
    youtube_extractor_args,
)
from .parse import (
    ChatItem,
    chat_continuation,
    continuation_tokens,
    live_status_from_player_response,
    parse_actions,
)

logger = logging.getLogger(__name__)

WATCH_URL = "https://www.youtube.com/watch?v={}"
CHAT_PAGE_URL = "https://www.youtube.com/live_chat_replay?continuation={}"
REPLAY_API_URL = (
    "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key={}"
)

_RETRY_KINDS = frozenset({ERROR_KIND_RATE_LIMIT, ERROR_KIND_BOT, ERROR_KIND_POT})


@dataclass
class Chunk:
    items: list[ChatItem]
    #: The stretch after this one (``liveChatReplayContinuationData``).
    replay_token: str | None
    #: A jump to any position (``playerSeekContinuationData``).
    seek_token: str | None
    #: The last message's offset, dropped kinds included; None when empty.
    end_ms: int | None


@dataclass
class ChatHandle:
    """What a chunk request needs once a video's chat is open."""

    yt_id: str
    api_key: str
    context: dict[str, Any]
    headers: dict[str, str]
    cookies: bool
    #: The newest seek token seen (each chunk carries a fresh one).
    seek_token: str | None = None


@dataclass
class Opened:
    live_status: str | None
    #: None when the video has no chat replay.
    handle: ChatHandle | None
    first: Chunk | None = field(default=None)


class ChatReplayError(Exception):
    """A failed read: ``status`` is ``RETRY``, ``LATER``, ``UNAVAILABLE`` or ``FAILED``."""

    def __init__(self, status: str, message: str | None = None) -> None:
        super().__init__(message or status)
        self.status = status


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def chunk_from(lcc: dict[str, Any]) -> Chunk:
    """A ``liveChatContinuation`` as a ``Chunk``."""
    actions = lcc.get("actions") if isinstance(lcc.get("actions"), list) else []
    offsets: list[int] = []
    for raw in actions or []:
        value = _dict(_dict(raw).get("replayChatItemAction")).get("videoOffsetTimeMsec")
        if not isinstance(value, str | int) or isinstance(value, bool):
            continue
        try:
            offsets.append(int(value))
        except ValueError:
            continue
    replay, seek = continuation_tokens(lcc)
    return Chunk(
        items=parse_actions(actions or []),
        replay_token=replay,
        seek_token=seek,
        end_ms=max(offsets) if offsets else None,
    )


@contextmanager
def _extractor(with_cookies: bool) -> Iterator[Any]:
    import yt_dlp
    from yt_dlp.extractor.youtube import YoutubeBaseInfoExtractor

    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "extractor_args": youtube_extractor_args(),
        "logger": SubtitleYtdlpLogger(),
    }
    with yt_dlp.YoutubeDL(apply_cookie_opts(opts) if with_cookies else opts) as ydl:
        yield YoutubeBaseInfoExtractor(ydl)


def _classified(exc: BaseException, url: str) -> ChatReplayError:
    if is_network_error(exc):
        logger.info("Chat replay for %s: YouTube unreachable", url, exc_info=True)
        return ChatReplayError(LATER)
    kind, message = classify_ytdlp_error(exc, url=url)
    logger.info("Chat replay for %s failed (%s)", url, kind, exc_info=True)
    if kind in (ERROR_KIND_MEMBERS, ERROR_KIND_UNAVAILABLE):
        return ChatReplayError(UNAVAILABLE, message)
    if kind == ERROR_KIND_COOKIES and not cookie_configured():
        return ChatReplayError(UNAVAILABLE, message)
    if kind in _RETRY_KINDS:
        return ChatReplayError(RETRY, message)
    return ChatReplayError(FAILED, message)


def _open(yt_id: str, url: str, with_cookies: bool) -> Opened:
    with _extractor(with_cookies) as ie:
        page = ie._download_webpage(url, yt_id, note=False)
        initial = ie.extract_yt_initial_data(yt_id, page, fatal=False) or {}
        player = ie._search_json(
            ie._YT_INITIAL_PLAYER_RESPONSE_RE,
            page,
            "initial player response",
            yt_id,
            default={},
        )
        live_status = live_status_from_player_response(_dict(player))
        token = chat_continuation(_dict(initial))
        if token is None:
            return Opened(live_status, None, None)
        ytcfg = _dict(ie.extract_ytcfg(yt_id, page))
        api_key = ytcfg.get("INNERTUBE_API_KEY")
        context = ytcfg.get("INNERTUBE_CONTEXT")
        if not isinstance(api_key, str) or not isinstance(context, dict):
            raise ChatReplayError(FAILED, "The watch page has no innertube config")
        visitor = _dict(context.get("client")).get("visitorData")
        headers = dict(ie.generate_api_headers(ytcfg=ytcfg, visitor_data=visitor))
        headers["content-type"] = "application/json"
        chat_page = ie._download_webpage(CHAT_PAGE_URL.format(token), yt_id, note=False)
        data = _dict(ie.extract_yt_initial_data(yt_id, chat_page, fatal=False))
        lcc = _dict(data.get("continuationContents")).get("liveChatContinuation")
        if not isinstance(lcc, dict):
            # YouTube changed the page (or served a consent page): an error the
            # viewer can retry, not a chat that stays empty.
            raise ChatReplayError(FAILED, "The chat replay page holds no chat")
        first = chunk_from(lcc)
    handle = ChatHandle(
        yt_id=yt_id,
        api_key=api_key,
        context=context,
        headers=headers,
        cookies=with_cookies,
        seek_token=first.seek_token,
    )
    return Opened(live_status, handle, first)


def open_chat(yt_id: str) -> Opened:
    """Read the watch page and the first chunk. Raises ``ChatReplayError``."""
    url = WATCH_URL.format(yt_id)
    with_cookies = url_cookie_required(url)
    try:
        return _open(yt_id, url, with_cookies)
    except ChatReplayError:
        raise
    except Exception as exc:
        if with_cookies or not should_retry_with_cookies({}, exc):
            raise _classified(exc, url) from exc
        logger.debug("Chat replay for %s: retrying with cookies", url, exc_info=True)
    try:
        opened = _open(yt_id, url, True)
    except ChatReplayError:
        raise
    except Exception as exc:
        raise _classified(exc, url) from exc
    remember_cookie_required(url)
    return opened


def fetch_chunk(handle: ChatHandle, token: str, offset_ms: int) -> Chunk:
    """One chunk at ``offset_ms`` with ``token``. Raises ``ChatReplayError``."""
    body = {
        "context": handle.context,
        "continuation": token,
        "currentPlayerState": {"playerOffsetMs": str(offset_ms)},
    }
    try:
        with _extractor(handle.cookies) as ie:
            raw = ie._download_json(
                REPLAY_API_URL.format(handle.api_key),
                handle.yt_id,
                note=False,
                data=json.dumps(body).encode(),
                headers=handle.headers,
            )
    except Exception as exc:
        raise _classified(exc, WATCH_URL.format(handle.yt_id)) from exc
    return chunk_from(
        _dict(_dict(_dict(raw).get("continuationContents")).get("liveChatContinuation"))
    )
