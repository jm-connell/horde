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
    r"permissions?|admin|bug|error message|keyboard shortcut|hotkey|"
    r"is (my |the )?ai (working|on|off|broken|down)|"
    r"my ai (provider|model|settings?|features?)|spent on ai|"
    r"ai (costs?|spend(ing)?|budget))\b",
    re.IGNORECASE,
)
# Things only the app has: asking how to do something with one, or to do it,
# is about Horde ("make subtitles bigger", "turn off autoplay", "how to change
# the background"). Kept to phrases a video's subject rarely shares: no bare
# "font", "offline", "quality", "css" or "notifications", which tutorials use.
_APP_THING = re.compile(
    r"\b(autoplay|subtitles?|captions?|themes?|dark mode|light mode|"
    r"accent colou?r|background( image| animation| effect| colou?r)?(?! noise| music| sound)|"
    r"font size|(change|bigger|smaller|larger) (the )?fonts?|fonts? (bigger|smaller|larger)|"
    r"sponsor ?block|skip (sponsors?|intros?|outros?)|hotkeys?|keyboard shortcuts?|"
    r"video quality|download quality|playback speed|loudness|hover previews?|"
    r"tab bar|nav ?bar|watch history|subscribe to (a|this|the|that) channel|"
    r"watch (videos )?offline|offline mode)\b",
    re.IGNORECASE,
)
# An instruction: "turn off autoplay", "hey, make subtitles bigger".
_INSTRUCTION = (
    r"^\W*((hey|hi|ok|okay|please|pls|can you|could you)\W+)*"
    r"(make|turn|switch|change|set|enable|disable|hide|increase|decrease|reset|"
    r"download)\b"
)
# Asking for something to be done: "how do I…", "how to…" or an instruction.
_DO = re.compile(rf"\bhow (do|can) i\b|\bhow to\b|{_INSTRUCTION}", re.IGNORECASE)
# The thing is somewhere else or on screen: "in photoshop", "on my tv",
# "like that". ("turn on autoplay" is not "on" a place.)
_ELSEWHERE = re.compile(
    r"\blike (that|this|his|hers?|theirs|them|him)\b"
    r"|(?<!turn )(?<!switch )\b(in|on|for|with|using) "
    r"(?!horde\b|here\b|this app\b|the app\b)\w",
    re.IGNORECASE,
)


# What a channel says or thinks: "what does LTT say about…".
_SAYS = re.compile(
    r"\b(what|how) (does|do|did|would|will) .{2,60}? (say|think|recommend|feel|"
    r"cover|talk|review|rate)\b|\baccording to\b",
    re.IGNORECASE,
)
# Ask's channels and their indexing.
_ABOUT_ASK = re.compile(
    r"\b(index(ed|ing|es)?|ask channels?|channels? (ask|you) can (answer|search))\b",
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
    r"\b(how (do|can|should|would) i|how to|(can|could|should) i|where (do|can) i"
    rf"|i (want|need|would like) to|help me|my)\b|{_INSTRUCTION}",
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


def _names(name: str | None, url: str | None) -> set[str]:
    names = set()
    for raw in (name or "", _handle(url) if url else ""):
        norm = _norm(raw or "")
        if not norm:
            continue
        names.add(norm)
        if norm.startswith("the "):
            names.add(norm[4:])
    return {n for n in names if len(n.replace(" ", "")) >= _MIN_LEN}


def _initials(name: str | None) -> str | None:
    """ "Linus Tech Tips" -> "ltt": three or more words' first letters."""
    words = [w for w in _norm(name or "").split() if w != "the"]
    return "".join(w[0] for w in words) if len(words) >= 3 else None


def names_channel(
    message: str, name: str | None, url: str | None, *, initials: bool = False
) -> bool:
    """Whether ``message`` names this channel (by its initials too, if allowed)."""
    text = f" {_norm(message)} "
    squashed = text.replace(" ", "")
    for n in _names(name, url):
        if f" {n} " in text or (" " in n and n.replace(" ", "") in squashed):
            return True
        if " " not in n and len(n) >= 6 and n in squashed:
            return True
    short = _initials(name) if initials else None
    return bool(short and f" {short} " in text)


def named_channels(message: str, channels: list[KbChannel]) -> list[KbChannel]:
    """The channels ``message`` names, in the order given.

    Initials ("ltt") count only in a question about what a channel says, where
    they cannot be an ordinary word.
    """
    initials = asks_what_said(message)
    return [
        c
        for c in channels
        if names_channel(message, c.channel_name, c.channel_url, initials=initials)
    ]


def asks_what_said(message: str) -> bool:
    """ "What does LTT say about…", "according to MKBHD": a channel's views."""
    return bool(_SAYS.search(message or ""))


def about_ask_channels(message: str) -> bool:
    """ "Which channels are indexed?", "is LTT indexed for ask?"."""
    return bool(_ABOUT_ASK.search(message or ""))


def about_horde(message: str) -> bool:
    """True for a question about the app itself (its settings, downloads, ...)."""
    text = message or ""
    return bool(
        _HORDE.search(text)
        or (
            _DO.search(text) and _APP_THING.search(text) and not _ELSEWHERE.search(text)
        )
    )


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
