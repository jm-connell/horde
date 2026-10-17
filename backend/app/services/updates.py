"""Tell the user when a newer Horde is available (cached, soft-failing).

Two sources, in order of preference:

1. **Releases.** When the image has a release version baked in
   (``HORDE_VERSION``), compare it with ``/releases/latest``.
2. **Commits on main.** Otherwise, or when the repository has no releases yet,
   use the GitHub compare API from the deployed commit to ``main`` and ignore
   what cannot change a running install: commits authored by
   ``github-actions[bot]`` (the daily clone-stats bot) and documentation-only
   changes.
"""

from __future__ import annotations

import os
import re
import threading
import time
from datetime import UTC, datetime
from typing import Any

import httpx

from ..config import HORDE_GITHUB_REPO, resolve_git_sha, short_git_sha

CACHE_TTL_SEC = 24 * 60 * 60
_GITHUB_TIMEOUT = 5.0
_BOT_LOGINS = {"github-actions[bot]"}
_DOCS_ONLY_PREFIXES = ("docs/", ".github/")
_DOCS_ONLY_FILES = {"mkdocs.yml", "LICENSE", ".gitignore", ".dockerignore"}
_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")

_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cache_at: float = 0.0
_cache_key: tuple[str, str, str] | None = None


class _GitHubError(Exception):
    """A GitHub request failed in a way worth showing in the UI."""


def _utcnow_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def _sha_equal(a: str, b: str) -> bool:
    left = (a or "").strip().lower()
    right = (b or "").strip().lower()
    if not left or not right or left == "unknown" or right == "unknown":
        return False
    return left == right or left.startswith(right) or right.startswith(left)


def _parse_version(value: str | None) -> tuple[int, int, int] | None:
    match = _VERSION_RE.match((value or "").strip())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def _baked_version() -> str:
    """Release version baked into the image; empty for dev/unknown builds."""
    raw = os.environ.get("HORDE_VERSION", "").strip()
    return raw.removeprefix("v") if _parse_version(raw) else ""


def _is_bot(commit: dict[str, Any]) -> bool:
    login = ((commit.get("author") or {}).get("login") or "").lower()
    if login in _BOT_LOGINS:
        return True
    email = (
        ((commit.get("commit") or {}).get("author") or {}).get("email") or ""
    ).lower()
    return email.endswith("[bot]@users.noreply.github.com")


def _is_docs_only(path: str) -> bool:
    return (
        path.startswith(_DOCS_ONLY_PREFIXES)
        or path in _DOCS_ONLY_FILES
        or path.lower().endswith(".md")
    )


def _get(client: httpx.Client, url: str) -> httpx.Response:
    response = client.get(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "Horde-UpdateCheck",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    if response.status_code == 403:
        raise _GitHubError("GitHub rate limit or forbidden")
    return response


def _check_release(
    client: httpx.Client, repo: str, version: str
) -> dict[str, Any] | None:
    """Result for the release path, or None when the repo has no releases."""
    response = _get(client, f"https://api.github.com/repos/{repo}/releases/latest")
    if response.status_code == 404:
        return None
    if not response.is_success:
        raise _GitHubError(f"GitHub HTTP {response.status_code}")
    data = response.json()
    tag = (data.get("tag_name") or "").strip()
    latest = _parse_version(tag)
    if latest is None:
        raise _GitHubError("GitHub release has no version tag")
    current = _parse_version(version)
    return {
        "source": "release",
        # The Settings page shows the notice and remembers a dismissal by
        # ``latest_sha``, so a release is identified by its tag there.
        "latest_sha": tag,
        "latest_version": tag.removeprefix("v"),
        "latest_html_url": (data.get("html_url") or "").strip()
        or f"https://github.com/{repo}/releases/tag/{tag}",
        "update_available": bool(current and latest > current),
    }


def _check_commits(client: httpx.Client, repo: str, current_sha: str) -> dict[str, Any]:
    """Compare the deployed commit with main, ignoring bot and docs-only changes."""
    if current_sha.lower() == "unknown":
        # Nothing to compare against (dev checkout): show the latest, never nag.
        return _check_latest_human_commit(client, repo, current_sha)
    response = _get(
        client, f"https://api.github.com/repos/{repo}/compare/{current_sha}...main"
    )
    if response.status_code in (404, 422):
        # The deployed commit is not on GitHub (local build, force push), or the
        # repository does not exist (the fallback reports that).
        return _check_latest_human_commit(client, repo, current_sha)
    if not response.is_success:
        raise _GitHubError(f"GitHub HTTP {response.status_code}")
    data = response.json()
    commits = data.get("commits") or []
    human = [c for c in commits if not _is_bot(c)]
    files = [f.get("filename") or "" for f in data.get("files") or []]
    # The compare API lists at most 300 files; a truncated list may hide code changes.
    code_changed = len(files) >= 300 or any(not _is_docs_only(name) for name in files)
    ahead = data.get("status") in {"ahead", "diverged"}
    newest = (human or commits or [{}])[-1]
    sha = (newest.get("sha") or "").strip()
    return {
        "source": "commits",
        "latest_sha": sha or None,
        "latest_html_url": (newest.get("html_url") or "").strip()
        or (f"https://github.com/{repo}/commit/{sha}" if sha else None),
        "update_available": bool(ahead and human and code_changed),
    }


def _check_latest_human_commit(
    client: httpx.Client, repo: str, current_sha: str
) -> dict[str, Any]:
    response = _get(
        client, f"https://api.github.com/repos/{repo}/commits?sha=main&per_page=30"
    )
    if not response.is_success:
        raise _GitHubError(f"GitHub HTTP {response.status_code}")
    commits = response.json() or []
    newest = next((c for c in commits if not _is_bot(c)), None)
    if newest is None:
        raise _GitHubError("GitHub response missing commit SHA")
    sha = (newest.get("sha") or "").strip()
    return {
        "source": "commits",
        "latest_sha": sha or None,
        "latest_html_url": (newest.get("html_url") or "").strip()
        or f"https://github.com/{repo}/commit/{sha}",
        "update_available": bool(
            current_sha.lower() != "unknown"
            and sha
            and not _sha_equal(current_sha, sha)
        ),
    }


def _fetch_latest(repo: str, current_sha: str, version: str) -> dict[str, Any]:
    """Run the check; raises ``_GitHubError`` for failures worth showing."""
    try:
        with httpx.Client(timeout=_GITHUB_TIMEOUT) as client:
            if version:
                result = _check_release(client, repo, version)
                if result is not None:
                    return result
            return _check_commits(client, repo, current_sha)
    except (httpx.HTTPError, ValueError) as exc:
        # Offline, DNS, TLS or a malformed body: soft-fail so the UI stays quiet.
        raise _GitHubError(str(exc) or "GitHub request failed") from exc


def _payload(
    repo: str, current: str, version: str, result: dict[str, Any], error: str | None
) -> dict[str, Any]:
    latest_sha = result.get("latest_sha")
    latest_version = result.get("latest_version")
    on_release = result.get("source") == "release"
    return {
        "repo": repo,
        "source": result.get("source"),
        "current_sha": current,
        "current_short": version if on_release else short_git_sha(current),
        "current_version": version or None,
        "latest_sha": latest_sha,
        "latest_short": latest_version
        if on_release
        else (short_git_sha(latest_sha) if latest_sha else None),
        "latest_version": latest_version,
        "latest_html_url": result.get("latest_html_url"),
        "update_available": bool(result.get("update_available")) and not error,
        "checked_at": _utcnow_iso(),
        "error": error,
    }


def check_for_updates(
    *, refresh: bool = False, offline: bool = False
) -> dict[str, Any]:
    """Return update status. Soft-fails so the UI can stay quiet offline.

    ``offline`` skips the GitHub lookup (the browser-test process).
    """
    global _cache, _cache_at, _cache_key

    current = resolve_git_sha()
    version = _baked_version()
    repo = HORDE_GITHUB_REPO
    if offline:
        return _payload(repo, current, version, {}, None)

    key = (repo, current, version)
    now = time.monotonic()
    with _lock:
        if (
            not refresh
            and _cache is not None
            and _cache_key == key
            and (now - _cache_at) < CACHE_TTL_SEC
        ):
            return dict(_cache)

    try:
        result, error = _fetch_latest(repo, current, version), None
    except _GitHubError as exc:
        result, error = {}, str(exc)
    payload = _payload(repo, current, version, result, error)

    with _lock:
        _cache = dict(payload)
        _cache_at = time.monotonic()
        _cache_key = key
    return payload
