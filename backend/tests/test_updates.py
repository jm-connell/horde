"""GET /api/updates: release-first, bot/docs-aware commit fallback, soft failure."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import current_user
from app.context import get_ctx
from app.main import updates as updates_route
from app.services import updates
from app.services.auth.accounts import AuthUser
from app.services.auth.permissions import ALL_PERMISSIONS

REPO = "jm-connell/horde"
DEPLOYED = "a" * 40
BOT = {"login": "github-actions[bot]"}
HUMAN = {"login": "jm-connell"}


def _commit(sha: str, author: dict) -> dict:
    return {
        "sha": sha * 40,
        "html_url": f"https://github.com/{REPO}/commit/{sha * 40}",
        "author": author,
        "commit": {"author": {"email": f"{author['login']}@example.com"}},
    }


class FakeGitHub:
    """Routes api.github.com requests to canned JSON and records the paths."""

    def __init__(self) -> None:
        self.routes: dict[str, httpx.Response] = {}
        self.requests: list[str] = []
        self.offline = False

    def reply(self, path: str, status: int = 200, json=None) -> None:
        self.routes[path] = httpx.Response(status, json=json)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.offline:
            raise httpx.ConnectError("offline", request=request)
        path = request.url.path
        if request.url.query:
            path += "?" + request.url.query.decode()
        self.requests.append(path)
        return self.routes.get(path, httpx.Response(404, json={"message": "Not Found"}))


@pytest.fixture
def client():
    app = FastAPI()
    app.add_api_route("/api/updates", updates_route, methods=["GET"])
    # The route alone has no middleware; stand in for a signed-in administrator
    # (forcing a check is admin-only, tests/test_permissions.py covers refusal).
    app.dependency_overrides[current_user] = lambda: AuthUser(
        id=1, username="admin", is_admin=True, permissions=ALL_PERMISSIONS
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    real_client = httpx.Client
    monkeypatch.setattr(
        updates.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(fake), **kw),
    )
    monkeypatch.setattr(updates, "_cache", None)
    monkeypatch.setattr(updates, "_cache_key", None)
    monkeypatch.setattr(updates, "HORDE_GITHUB_REPO", REPO)
    monkeypatch.delenv("HORDE_E2E", raising=False)
    monkeypatch.setenv("HORDE_GIT_SHA", DEPLOYED)
    monkeypatch.delenv("HORDE_VERSION", raising=False)
    return fake


def _check(client, **params) -> dict:
    response = client.get("/api/updates", params={"refresh": "true", **params})
    assert response.status_code == 200
    return response.json()


def _compare(
    github: FakeGitHub, commits: list[dict], files: list[str], status="ahead"
) -> None:
    github.reply(
        f"/repos/{REPO}/compare/{DEPLOYED}...main",
        json={
            "status": status,
            "commits": commits,
            "files": [{"filename": name} for name in files],
        },
    )


def test_release_build_prefers_latest_release(client, github, monkeypatch):
    monkeypatch.setenv("HORDE_VERSION", "1.2.0")
    github.reply(
        f"/repos/{REPO}/releases/latest",
        json={
            "tag_name": "v1.3.0",
            "html_url": f"https://github.com/{REPO}/releases/tag/v1.3.0",
        },
    )

    body = _check(client)

    assert body["source"] == "release"
    assert body["update_available"] is True
    assert body["current_short"] == "1.2.0"
    assert body["latest_short"] == "1.3.0"
    assert body["latest_sha"] == "v1.3.0", (
        "the Settings UI keys its notice on latest_sha"
    )
    assert body["latest_html_url"].endswith("/releases/tag/v1.3.0")
    assert github.requests == [f"/repos/{REPO}/releases/latest"], (
        "must not look at commits"
    )


def test_release_build_at_or_past_latest_has_no_update(client, github, monkeypatch):
    github.reply(
        f"/repos/{REPO}/releases/latest", json={"tag_name": "v1.2.0", "html_url": "u"}
    )
    for baked in ("1.2.0", "1.2.0-5-gabc1234", "1.10.0"):
        monkeypatch.setenv("HORDE_VERSION", baked)
        assert _check(client)["update_available"] is False, baked


def test_release_build_without_releases_falls_back_to_commits(
    client, github, monkeypatch
):
    monkeypatch.setenv("HORDE_VERSION", "1.2.0")
    _compare(github, [_commit("b", HUMAN)], ["backend/app/main.py"])

    body = _check(client)

    assert body["source"] == "commits"
    assert body["update_available"] is True
    assert github.requests[0] == f"/repos/{REPO}/releases/latest"


def test_dev_build_never_asks_for_releases(client, github, monkeypatch):
    monkeypatch.setenv("HORDE_VERSION", "dev")
    _compare(github, [_commit("b", HUMAN)], ["backend/app/main.py"])

    assert _check(client)["update_available"] is True
    assert all("releases" not in path for path in github.requests)


def test_commits_only_by_the_stats_bot_are_not_an_update(client, github):
    _compare(
        github,
        [_commit("b", BOT), _commit("c", BOT)],
        ["docs/assets/github-clones.json"],
    )

    body = _check(client)

    assert body["update_available"] is False
    assert body["error"] is None


def test_docs_only_changes_are_not_an_update(client, github):
    _compare(
        github,
        [_commit("b", HUMAN)],
        [
            "docs/getting-started/updating.md",
            "README.md",
            "mkdocs.yml",
            ".github/workflows/ci.yml",
        ],
    )
    assert _check(client)["update_available"] is False


def test_code_change_after_bot_commits_is_an_update_and_points_at_the_human_commit(
    client, github
):
    _compare(
        github,
        [_commit("b", HUMAN), _commit("c", BOT)],
        ["frontend/src/App.tsx", "docs/assets/github-clones.json"],
    )

    body = _check(client)

    assert body["update_available"] is True
    assert body["latest_sha"] == "b" * 40
    assert body["latest_short"] == "bbbbbbb"


def test_current_commit_already_on_main_is_not_an_update(client, github):
    _compare(github, [], [], status="identical")
    assert _check(client)["update_available"] is False


def test_unknown_deployed_commit_falls_back_to_newest_human_commit(client, github):
    github.reply(f"/repos/{REPO}/compare/{DEPLOYED}...main", status=404)
    github.reply(
        f"/repos/{REPO}/commits?sha=main&per_page=30",
        json=[_commit("c", BOT), _commit("b", HUMAN)],
    )

    body = _check(client)

    assert body["update_available"] is True
    assert body["latest_sha"] == "b" * 40


def test_dev_checkout_without_sha_never_nags(client, github, monkeypatch):
    monkeypatch.setenv("HORDE_GIT_SHA", "unknown")
    monkeypatch.setattr("app.config.resolve_git_sha", lambda: "unknown")
    monkeypatch.setattr(updates, "resolve_git_sha", lambda: "unknown")
    github.reply(
        f"/repos/{REPO}/commits?sha=main&per_page=30", json=[_commit("b", HUMAN)]
    )

    assert _check(client)["update_available"] is False


@pytest.mark.parametrize("status", [403, 500])
def test_github_errors_soft_fail(client, github, status):
    github.reply(f"/repos/{REPO}/compare/{DEPLOYED}...main", status=status)

    body = _check(client)

    assert body["update_available"] is False
    assert body["error"]


def test_network_failure_soft_fails(client, github):
    github.offline = True

    body = _check(client)

    assert body["update_available"] is False
    assert "offline" in body["error"]


def test_result_is_cached_for_a_day_unless_refreshed(client, github):
    _compare(github, [_commit("b", HUMAN)], ["backend/app/main.py"])

    first = client.get("/api/updates", params={"refresh": "true"}).json()
    calls = len(github.requests)
    second = client.get("/api/updates").json()

    assert second == first
    assert len(github.requests) == calls
    client.get("/api/updates", params={"refresh": "true"})
    assert len(github.requests) > calls


def test_cache_is_dropped_when_the_deployed_version_changes(
    client, github, monkeypatch
):
    _compare(github, [_commit("b", HUMAN)], ["backend/app/main.py"])
    client.get("/api/updates", params={"refresh": "true"})
    calls = len(github.requests)

    monkeypatch.setenv("HORDE_VERSION", "2.0.0")
    github.reply(
        f"/repos/{REPO}/releases/latest", json={"tag_name": "v2.0.0", "html_url": "u"}
    )
    body = client.get("/api/updates").json()

    assert body["source"] == "release"
    assert len(github.requests) > calls


def test_browser_e2e_mode_stays_offline(client, github, monkeypatch):
    client.app.dependency_overrides[get_ctx] = lambda: SimpleNamespace(e2e=True)

    body = client.get("/api/updates", params={"refresh": "true"}).json()

    assert body["update_available"] is False
    assert github.requests == []
