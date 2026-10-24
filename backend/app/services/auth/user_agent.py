"""A short, human label for a browser's ``User-Agent`` ("Safari on iPhone").

Deliberately small: a handful of rules over the browsers and systems people
actually use, no third-party parser. Anything it does not recognise is
"Unknown device". An installed PWA sends its browser's User-Agent, so it cannot
be told apart from a tab here.
"""

from __future__ import annotations

UNKNOWN_DEVICE = "Unknown device"

# Order matters: most browsers also claim to be Chrome and Safari.
_BROWSERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Edge", ("Edg/", "EdgA/", "EdgiOS/", "Edge/")),
    ("Opera", ("OPR/", "OPiOS/")),
    ("Samsung Internet", ("SamsungBrowser/",)),
    ("Firefox", ("Firefox/", "FxiOS/")),
    ("Chrome", ("Chrome/", "CriOS/", "Chromium/")),
    ("Safari", ("Safari/",)),
)

# Order matters here too: iOS and Android UAs also contain "Mac OS X" / "Linux".
_SYSTEMS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("iPhone", ("iPhone", "iPod")),
    ("iPad", ("iPad",)),
    ("Android", ("Android",)),
    ("Windows", ("Windows",)),
    ("ChromeOS", ("CrOS",)),
    ("macOS", ("Macintosh", "Mac OS X")),
    ("Linux", ("Linux", "X11")),
)


def _first(
    user_agent: str, table: tuple[tuple[str, tuple[str, ...]], ...]
) -> str | None:
    for name, markers in table:
        if any(marker in user_agent for marker in markers):
            return name
    return None


def describe(user_agent: str | None) -> str:
    """``"<browser> on <system>"``, or whichever half is known, or "Unknown device"."""
    ua = user_agent or ""
    browser = _first(ua, _BROWSERS)
    system = _first(ua, _SYSTEMS)
    if browser and system:
        return f"{browser} on {system}"
    return browser or system or UNKNOWN_DEVICE
