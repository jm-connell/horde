"""Proxy YouTube live DASH/HLS manifests so in-app playback can seek the DVR window.

VOD preview builds a static SegmentBase MPD. A livestream manifest is dynamic:
segment URLs change, and the seekable range is the manifest's DVR window.
Shaka plays that manifest when every media URL is rewritten through Horde
(the browser cannot send YouTube's required headers).
"""

from __future__ import annotations

import re
import secrets
import threading
import time
from typing import Any, Optional
from urllib.parse import quote, urljoin, urlparse
from xml.etree import ElementTree as ET

import httpx

_SESSION_TTL_SEC = 6 * 3600
_URL_ATTRS = ("media", "initialization", "sourceURL")
_PLACEHOLDER = re.compile(
    r"\$(?:Number|Time|RepresentationID|Bandwidth|SubNumber)(?:%0\d+d)?\$"
)
_URI_ATTR = re.compile(r'URI="([^"]*)"')
_ALLOWED_HOST_SUFFIXES = (
    "googlevideo.com",
    "youtube.com",
    "youtu.be",
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
)
_DROP_HEADERS = {"host", "accept-encoding", "content-length", "connection"}

_lock = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}
_token_by_source: dict[str, str] = {}


class ManifestFetchError(RuntimeError):
    """Upstream live manifest could not be fetched."""

    def __init__(self, message: str, *, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


def reset_for_tests() -> None:
    with _lock:
        _sessions.clear()
        _token_by_source.clear()


def info_is_live(info: dict[str, Any]) -> bool:
    """True only for a stream that is on the air right now."""
    status = str(info.get("live_status") or "").strip().lower()
    if status == "is_live":
        return True
    if status in {"was_live", "is_upcoming", "not_live", "post_live"}:
        return False
    return info.get("is_live") is True


def allowed_upstream(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return False
    return any(host == suffix or host.endswith("." + suffix) for suffix in _ALLOWED_HOST_SUFFIXES)


def encode_upstream(url: str) -> str:
    """Percent-encode a media URL but leave DASH `$Number$` / `$Time$` tokens intact.

    Shaka substitutes those tokens after it parses the manifest. Encoding them
    would freeze the template and every segment would 404.
    """
    parts = _PLACEHOLDER.split(url)
    holders = _PLACEHOLDER.findall(url)
    out: list[str] = []
    for i, part in enumerate(parts):
        out.append(quote(part, safe=""))
        if i < len(holders):
            out.append(holders[i])
    return "".join(out)


def proxy_media_url(token: str, upstream: str, *, playlist: bool = False) -> str:
    kind = "&kind=playlist" if playlist else ""
    return (
        f"/api/preview/live-media?token={quote(token, safe='')}"
        f"{kind}&u={encode_upstream(upstream)}"
    )


def _headers(fmt: dict[str, Any], info: dict[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for source in (info.get("http_headers"), fmt.get("http_headers")):
        if isinstance(source, dict):
            headers.update({str(k): str(v) for k, v in source.items() if v})
    cookie = fmt.get("cookies") or info.get("cookies")
    if cookie and "Cookie" not in headers:
        headers["Cookie"] = str(cookie)
    return {k: v for k, v in headers.items() if k.lower() not in _DROP_HEADERS}


def _manifest_candidate(fmt: dict[str, Any]) -> str:
    manifest = str(fmt.get("manifest_url") or "").strip()
    if manifest:
        return manifest
    return str(fmt.get("url") or "").strip()


def pick_live_manifest(info: dict[str, Any]) -> tuple[str, str, dict[str, str]]:
    """Choose a DASH manifest when YouTube offers one, otherwise HLS.

    DASH `timeShiftBufferDepth` is the DVR window the player seeks inside.
    A single-rendition HLS playlist is only a fallback.
    """
    formats = [f for f in (info.get("formats") or []) if isinstance(f, dict)]

    for fmt in formats:
        if str(fmt.get("format_id") or "") != "dash":
            continue
        candidate = _manifest_candidate(fmt)
        if candidate:
            return candidate, "dash", _headers(fmt, info)

    for fmt in formats:
        candidate = _manifest_candidate(fmt)
        proto = str(fmt.get("protocol") or "")
        if not candidate:
            continue
        if (
            "dash" in proto
            or "manifest/dash" in candidate
            or candidate.split("?", 1)[0].endswith(".mpd")
        ):
            return candidate, "dash", _headers(fmt, info)

    hls: list[dict[str, Any]] = []
    for fmt in formats:
        candidate = _manifest_candidate(fmt)
        proto = str(fmt.get("protocol") or "")
        if not candidate:
            continue
        if (
            "m3u8" in proto
            or ".m3u8" in candidate
            or str(fmt.get("format_id") or "") in {"hls", "hls-manifest"}
        ):
            hls.append(fmt)
    if hls:
        hls.sort(
            key=lambda fmt: (
                0 if str(fmt.get("format_id") or "") in {"hls", "hls-manifest"} else 1,
                0 if not fmt.get("height") else 1,
            )
        )
        fmt = hls[0]
        return _manifest_candidate(fmt), "hls", _headers(fmt, info)

    top = info.get("manifest_url")
    if isinstance(top, str) and top.strip():
        kind = "hls" if ".m3u8" in top or "mpegurl" in top else "dash"
        return top.strip(), kind, _headers({}, info)
    raise ValueError("No live manifest URL in extract")


def _local(tag: str) -> str:
    if tag.startswith("{"):
        return tag.rsplit("}", 1)[-1]
    return tag


def _rewrite_element(elem: ET.Element, inherited: list[str], token: str) -> None:
    resolved = list(inherited)
    baseurl_nodes: list[tuple[ET.Element, str]] = []
    parent_base = inherited[-1] if inherited else ""
    for child in list(elem):
        if _local(child.tag) != "BaseURL":
            continue
        raw = (child.text or "").strip()
        if not raw:
            continue
        abs_url = urljoin(parent_base, raw)
        baseurl_nodes.append((child, abs_url))
        resolved.append(abs_url)
    base = resolved[-1] if resolved else parent_base
    for attr in _URL_ATTRS:
        raw = elem.attrib.get(attr)
        if not raw:
            continue
        elem.set(attr, proxy_media_url(token, urljoin(base, raw)))
    if _local(elem.tag) == "Location" and (elem.text or "").strip():
        elem.text = proxy_media_url(token, urljoin(parent_base, elem.text.strip()))
    for node, abs_url in baseurl_nodes:
        node.text = proxy_media_url(token, abs_url)
    for child in list(elem):
        if _local(child.tag) == "BaseURL":
            continue
        _rewrite_element(child, resolved, token)


def rewrite_dash(body: bytes, manifest_url: str, token: str) -> bytes:
    if body.startswith(b"\xef\xbb\xbf"):
        body = body[3:]
    ET.register_namespace("", "urn:mpeg:dash:schema:mpd:2011")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise ValueError(f"Live DASH manifest was not XML: {exc}") from exc
    # ServiceDescription tells Shaka to chase the live edge, which undoes a
    # backward seek. The DVR window itself still comes from the segment list.
    for elem in list(root.iter()):
        for child in list(elem):
            if _local(child.tag) == "ServiceDescription":
                elem.remove(child)
    _rewrite_element(root, [manifest_url], token)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def is_playlist_url(url: str) -> bool:
    lowered = url.lower()
    path = urlparse(lowered).path
    return path.endswith(".m3u8") or "m3u8" in path


def rewrite_hls(text: str, manifest_url: str, token: str) -> str:
    lines: list[str] = []
    for line in text.splitlines():
        if line.startswith("#"):
            def _repl(match: re.Match[str], base: str = manifest_url) -> str:
                target = urljoin(base, match.group(1).strip())
                wrapped = proxy_media_url(
                    token, target, playlist=is_playlist_url(target)
                )
                return f'URI="{wrapped}"'

            lines.append(_URI_ATTR.sub(_repl, line))
            continue
        stripped = line.strip()
        if not stripped:
            lines.append(line)
            continue
        target = urljoin(manifest_url, stripped)
        lines.append(
            proxy_media_url(token, target, playlist=is_playlist_url(target))
        )
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def _sniff_kind(body: bytes, hinted: str) -> str:
    head = body.lstrip()[:32]
    if head.startswith(b"#EXTM3U"):
        return "hls"
    if head.startswith(b"<?xml") or head.startswith(b"<MPD") or b"<MPD" in body[:400]:
        return "dash"
    return hinted


def _touch_session(
    source_url: str,
    manifest_url: str,
    kind: str,
    headers: dict[str, str],
) -> str:
    now = time.time()
    with _lock:
        token = _token_by_source.get(source_url)
        row = _sessions.get(token) if token else None
        if row is None or float(row.get("expires") or 0) <= now:
            token = secrets.token_urlsafe(18)
            _token_by_source[source_url] = token
            row = {"token": token, "source_url": source_url}
            _sessions[token] = row
        row["manifest_url"] = manifest_url
        row["kind"] = kind
        row["headers"] = dict(headers)
        row["expires"] = now + _SESSION_TTL_SEC
        return str(token)


def resolve_upstream(token: str, upstream: str) -> dict[str, Any]:
    """Return the YouTube URL and headers for a rewritten live media request."""
    if not token.strip():
        raise KeyError("missing live session")
    with _lock:
        row = _sessions.get(token)
        if row is None or float(row.get("expires") or 0) <= time.time():
            raise KeyError("live session expired")
        headers = dict(row.get("headers") or {})
    upstream = (upstream or "").strip()
    if not allowed_upstream(upstream):
        raise ValueError("upstream host is not allowed")
    return {
        "direct_url": upstream,
        "http_headers": headers,
        "content_type": "application/octet-stream",
    }


def _fetch_manifest(url: str, headers: dict[str, str]) -> tuple[bytes, str]:
    if not allowed_upstream(url):
        raise ManifestFetchError("live manifest host is not allowed")
    try:
        with httpx.Client(timeout=20.0, follow_redirects=True) as client:
            resp = client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise ManifestFetchError(str(exc)) from exc
    final = str(resp.url)
    if not allowed_upstream(final):
        raise ManifestFetchError("live manifest redirected to a disallowed host")
    if resp.status_code >= 400:
        raise ManifestFetchError(
            f"live manifest returned {resp.status_code}",
            status_code=resp.status_code,
        )
    return resp.content, final


def render(info: dict[str, Any], *, source_url: str) -> tuple[bytes, str]:
    """Fetch and rewrite the live manifest described by a yt-dlp info dict."""
    manifest_url, kind, headers = pick_live_manifest(info)
    token = _touch_session(source_url, manifest_url, kind, headers)
    body, final_url = _fetch_manifest(manifest_url, headers)
    kind = _sniff_kind(body, kind)
    if kind == "hls":
        text = rewrite_hls(body.decode("utf-8", "replace"), final_url, token)
        return text.encode("utf-8"), "application/vnd.apple.mpegurl"
    return rewrite_dash(body, final_url, token), "application/dash+xml"
