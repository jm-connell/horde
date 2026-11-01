"""Which Ask channels a question is about.

A turn is answered from channels when the question names them ("what does the car
care nut say…", "@TheCarCareNut", "CarCareNut"), from channels the chat is already
about, or from the channel of the page the user is on unless the question is
about Horde itself. "All my channels" and similar search every ready channel.
Plain text matching, no model call, so it is predictable and free.
"""

from __future__ import annotations

import re

from ...models import KbChannel
from ..follows import normalize_channel_url

_ALL = re.compile(
    r"\b(all|any|every|each) (of )?(my |the |your )?(ask )?channels?\b"
    r"|\bmy channels\b|\bacross (my |the )?channels\b",
    re.IGNORECASE,
)
_MIN_LEN = 4
# Words that make a question about the app rather than a channel's videos.
_HORDE = re.compile(
    r"\b(horde|settings?|preferences?|download(s|ed|ing)?|upload(s|ed|ing)?|"
    r"import(s|ed|ing)?|playlists?|library|queue|account|password|log ?in|"
    r"sign ?in|theme|css|subtitles? (setting|size|position)|captions? setting|"
    r"ollama|openrouter|api key|provider|server|docker|storage|disk|backup|"
    r"permissions?|admin|bug|error message|keyboard shortcut|hotkey)\b",
    re.IGNORECASE,
)


def _norm(text: str) -> str:
    text = re.sub(r"['’]s\b", "", text.casefold())
    return " ".join(re.findall(r"[^\W_]+", text))


def _handle(channel_url: str) -> str | None:
    path = normalize_channel_url(channel_url).split("/", 3)[3:]
    if path and path[0].startswith("@"):
        return path[0][1:]
    return None


def _names(channel: KbChannel) -> set[str]:
    names = set()
    for raw in (channel.channel_name or "", _handle(channel.channel_url) or ""):
        name = _norm(raw)
        if not name:
            continue
        names.add(name)
        if name.startswith("the "):
            names.add(name[4:])
    return {n for n in names if len(n.replace(" ", "")) >= _MIN_LEN}


def named_channels(message: str, channels: list[KbChannel]) -> list[KbChannel]:
    """The channels ``message`` names, in the order given."""
    text = f" {_norm(message)} "
    squashed = text.replace(" ", "")
    found = []
    for channel in channels:
        for name in _names(channel):
            if f" {name} " in text or (
                " " in name and name.replace(" ", "") in squashed
            ):
                found.append(channel)
                break
            if " " not in name and len(name) >= 6 and name in squashed:
                found.append(channel)
                break
    return found


def about_horde(message: str) -> bool:
    """True for a question about the app itself (its settings, downloads, ...)."""
    return bool(_HORDE.search(message or ""))


def asks_all_channels(message: str) -> bool:
    return bool(_ALL.search(message or ""))
