"""Compare the deployed git SHA to the latest commit on GitHub (cached)."""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from ..config import HORDE_GITHUB_REPO, resolve_git_sha, short_git_sha

CACHE_TTL_SEC = 24 * 60 * 60
_GITHUB_TIMEOUT = 5.0

_lock = threading.Lock()
_cache: Optional[dict[str, Any]] = None
_cache_at: float = 0.0


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _sha_equal(a: str, b: str) -> bool:
    left = (a or "").strip().lower()
    right = (b or "").strip().lower()
    if not left or not right or left == "unknown" or right == "unknown":
        return False
    return left == right or left.startswith(right) or right.startswith(left)


def _fetch_latest(repo: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Return (sha, html_url, error)."""
    url = f"https://api.github.com/repos/{repo}/commits/main"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "Horde-UpdateCheck",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        with httpx.Client(timeout=_GITHUB_TIMEOUT) as client:
            response = client.get(url, headers=headers)
        if response.status_code == 403:
            return None, None, "GitHub rate limit or forbidden"
        if response.status_code == 404:
            return None, None, f"Repository not found: {repo}"
        if not response.is_success:
            return None, None, f"GitHub HTTP {response.status_code}"
        data = response.json()
        sha = (data.get("sha") or "").strip() or None
        html_url = (data.get("html_url") or "").strip() or None
        if not sha:
            return None, None, "GitHub response missing commit SHA"
        if not html_url:
            html_url = f"https://github.com/{repo}/commit/{sha}"
        return sha, html_url, None
    except Exception as exc:  # noqa: BLE001
        return None, None, str(exc) or "GitHub request failed"


def check_for_updates(*, refresh: bool = False) -> dict[str, Any]:
    """Return update status. Soft-fails so the UI can stay quiet offline."""
    global _cache, _cache_at

    current = resolve_git_sha()
    repo = HORDE_GITHUB_REPO
    now = time.monotonic()

    with _lock:
        if (
            not refresh
            and _cache is not None
            and (now - _cache_at) < CACHE_TTL_SEC
        ):
            # Re-resolve current SHA in case env changed without restart (dev).
            cached = dict(_cache)
            cached["current_sha"] = current
            cached["current_short"] = short_git_sha(current)
            latest = cached.get("latest_sha")
            known = (
                current.lower() != "unknown"
                and isinstance(latest, str)
                and latest.lower() != "unknown"
            )
            cached["update_available"] = bool(
                known and not _sha_equal(current, latest) and not cached.get("error")
            )
            return cached

    latest_sha, latest_url, error = _fetch_latest(repo)
    known = (
        current.lower() != "unknown"
        and bool(latest_sha)
        and latest_sha.lower() != "unknown"
        and not error
    )
    payload: dict[str, Any] = {
        "repo": repo,
        "current_sha": current,
        "current_short": short_git_sha(current),
        "latest_sha": latest_sha,
        "latest_short": short_git_sha(latest_sha) if latest_sha else None,
        "latest_html_url": latest_url,
        "update_available": bool(
            known and latest_sha and not _sha_equal(current, latest_sha)
        ),
        "checked_at": _utcnow_iso(),
        "error": error,
    }

    with _lock:
        _cache = dict(payload)
        _cache_at = time.monotonic()

    return payload
