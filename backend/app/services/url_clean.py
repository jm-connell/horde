"""Normalize incoming URLs before handing them to yt-dlp.

The goal is to drop YouTube tracking parameters (and similar cruft from other
sites) so the stored ``source_url`` is canonical and we don't pass referral or
session identifiers along with the download request.
"""

from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

# Query params that are pure tracking / referral noise on any platform.
_TRACKING_PARAMS = {
    "si",
    "feature",
    "pp",
    "ab_channel",
    "gclid",
    "fbclid",
    "spm",
    "from",
}

_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}


def _youtube_video_id(parsed) -> str | None:
    host = parsed.netloc.lower()
    path = parsed.path
    if host == "youtu.be":
        return path.lstrip("/").split("/")[0] or None
    if path == "/watch":
        values = parse_qs(parsed.query).get("v")
        return values[0] if values else None
    for prefix in ("/shorts/", "/embed/", "/live/", "/v/"):
        if path.startswith(prefix):
            return path[len(prefix):].split("/")[0] or None
    return None


def clean_url(url: str, keep_playlist: bool = False) -> str:
    """Return a canonical URL with tracking parameters removed.

    ``keep_playlist`` preserves the ``list`` parameter for YouTube so a full
    playlist can be downloaded; otherwise it is stripped.
    """
    url = url.strip()
    if not url:
        return url

    try:
        parsed = urlparse(url)
    except ValueError:
        return url

    if not parsed.scheme or not parsed.netloc:
        return url

    host = parsed.netloc.lower()

    if host in _YOUTUBE_HOSTS:
        video_id = _youtube_video_id(parsed)
        query = parse_qs(parsed.query)
        playlist = query.get("list", [None])[0]
        if video_id:
            new_query = {"v": video_id}
            if keep_playlist and playlist:
                new_query["list"] = playlist
            return urlunparse(
                ("https", "www.youtube.com", "/watch", "", urlencode(new_query), "")
            )
        if keep_playlist and playlist:
            return urlunparse(
                ("https", "www.youtube.com", "/playlist", "", urlencode({"list": playlist}), "")
            )

    # Generic cleanup: drop known tracking params, keep everything else.
    query = parse_qs(parsed.query)
    cleaned = {
        k: v
        for k, v in query.items()
        if k not in _TRACKING_PARAMS and not k.startswith("utm_")
    }
    new_query = urlencode(cleaned, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def is_playlist_url(url: str) -> bool:
    """True if the URL points at a YouTube playlist (contains a ``list`` param)."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.netloc.lower() not in _YOUTUBE_HOSTS:
        return False
    return "list" in parse_qs(parsed.query)
