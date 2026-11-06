"""Which Ask channels, or whether the video, a question is about.

A turn is answered from channels when the question names them ("what does the car
care nut say…", "@TheCarCareNut", "CarCareNut"), from channels the chat is already
about, or from the channel of the page the user is on unless the question is
about Horde itself. "All my channels" and similar search every ready channel.
With a video, the words that send a question to Horde count only when the
question is not about the video ("he", "they", "this video"). Plain text
matching, no model call, so it is predictable and free.
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


# Horde by name: never about a video.
_NAMES_HORDE = re.compile(r"\b(horde|this app|the app)\b", re.IGNORECASE)
# Someone or something in the video: the question is about what it shows.
_ABOUT_VIDEO = re.compile(
    r"\b(he|she|they|him|them|his|her|hers|their|theirs"
    r"|the (video|host|creator|speaker|presenter|narrator|author|youtuber)"
    r"|this (video|one|clip)|in (it|the video|this video))\b",
    re.IGNORECASE,
)
# The user setting something up or doing something: a how-to.
_HOW_TO = re.compile(
    r"\b(how (do|can|should|would) i|(can|could|should) i|where (do|can) i"
    r"|i (want|need|would like) to|help me|my)\b",
    re.IGNORECASE,
)
# Words that make a question about a channel's other videos, not the one on screen.
_WHOLE_CHANNEL = re.compile(
    r"\b(this|the|his|her|their|whole|entire) channel\b"
    r"|\b(other|older|earlier|previous|past|newer|later|more|another|any) "
    r"(of (his|her|their) )?(videos?|episodes?|uploads?)\b"
    r"|\b(all|any) (of )?(his|her|their) (videos|episodes|uploads)\b"
    r"|\bacross (his|her|their|the) (videos|channel)\b"
    r"|\b(ever|usually|always|before) (said|say|says|mentioned|mention|talked|talk|"
    r"covered|cover|recommended|recommend)\b",
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


def names_horde(message: str) -> bool:
    """True when the question says Horde (or "this app") outright."""
    return bool(_NAMES_HORDE.search(message or ""))


def about_video(message: str) -> bool:
    """True for a question about someone or something in the video."""
    return bool(_ABOUT_VIDEO.search(message or ""))


def asks_how_to(message: str) -> bool:
    """True for "how do I…", "can I…", "my …": the user doing something."""
    return bool(_HOW_TO.search(message or ""))


def about_channel(message: str) -> bool:
    """True for a question about a channel as a whole ("in his other videos")."""
    return bool(_WHOLE_CHANNEL.search(message or ""))


def asks_all_channels(message: str) -> bool:
    return bool(_ALL.search(message or ""))
