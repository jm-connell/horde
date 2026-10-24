"""Settings → System → Security checklist: the rules, and the endpoint that gathers the facts."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.services import updates
from app.services.auth.runtime import AuthConfig
from app.services.security_checklist import Facts, evaluate


def _status(facts: Facts) -> dict[str, str]:
    return {item.id: item.status for item in evaluate(facts).items}


def test_a_lan_install_is_not_exposed_and_warns_about_what_an_exposed_one_needs():
    result = evaluate(Facts(update_available=False))
    assert result.exposed is False
    status = {i.id: i.status for i in result.items}
    assert status["https"] == "warn"
    assert status["two_factor_required"] == "warn"
    assert status["hosts"] == status["auth_enabled"] == status["private_urls"] == "ok"


def test_a_public_host_name_means_exposed():
    assert evaluate(Facts(public_hosts=("horde.example.com",))).exposed
    assert evaluate(Facts(any_host=True)).exposed


def test_a_well_set_up_server_passes_everything():
    facts = Facts(
        https=True,
        trust_proxy=True,
        proxied=True,
        public_hosts=("horde.example.com",),
        require_two_factor="everyone",
        update_available=False,
    )
    assert set(_status(facts).values()) == {"ok"}


def test_each_risky_setting_is_a_warning():
    base = Facts(
        https=True,
        trust_proxy=True,
        require_two_factor="everyone",
        update_available=False,
    )
    assert set(_status(base).values()) == {"ok"}
    cases = {
        "https": Facts(**{**base.__dict__, "https": False}),
        "proxy": Facts(**{**base.__dict__, "trust_proxy": False, "proxied": True}),
        "hosts": Facts(**{**base.__dict__, "any_host": True}),
        "two_factor_required": Facts(
            **{**base.__dict__, "require_two_factor": "admins"}
        ),
        "admins_two_factor": Facts(
            **{**base.__dict__, "admins_without_two_factor": ("jon",)}
        ),
        "auth_enabled": Facts(**{**base.__dict__, "auth_disabled": True}),
        "private_urls": Facts(**{**base.__dict__, "allow_private_urls": True}),
        "updates": Facts(**{**base.__dict__, "update_available": True}),
    }
    for item, facts in cases.items():
        assert _status(facts)[item] == "warn", item
        assert [k for k, v in _status(facts).items() if v == "warn"] == [item]
    # An unknown update state is a warning too (the check could not be made).
    assert (
        _status(Facts(**{**base.__dict__, "update_available": None}))["updates"]
        == "warn"
    )


def test_a_proxy_that_is_trusted_or_absent_is_fine():
    assert _status(Facts(trust_proxy=True, proxied=True))["proxy"] == "ok"
    assert _status(Facts(trust_proxy=False, proxied=False))["proxy"] == "ok"


def test_the_admin_names_are_listed_but_capped():
    names = tuple(f"admin{i}" for i in range(8))
    item = next(
        i
        for i in evaluate(Facts(admins_without_two_factor=names)).items
        if i.id == "admins_two_factor"
    )
    assert "admin0" in item.detail and "and 3 more" in item.detail
    assert "admin7" not in item.detail


def test_every_item_points_at_the_exposure_guide():
    for item in evaluate(Facts()).items:
        assert item.docs.startswith("ops/internet-exposure/#")


# --- the endpoint -------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_update_lookup(monkeypatch):
    monkeypatch.setattr(
        updates,
        "check_for_updates",
        lambda **kw: {"update_available": False, "latest_sha": "abc", "error": None},
    )


def _by_id(client) -> dict[str, dict]:
    res = client.get("/api/system/security-checklist")
    assert res.status_code == 200, res.text
    return {i["id"]: i for i in res.json()["items"]}


def test_it_is_for_administrators_only(member_client, anon_client):
    assert member_client.get("/api/system/security-checklist").status_code == 403
    assert anon_client.get("/api/system/security-checklist").status_code == 401


def test_the_endpoint_reports_the_facts_it_can_see(client, member_user):
    items = _by_id(client)
    assert items["https"]["status"] == "warn"
    assert items["auth_enabled"]["status"] == "ok"
    assert items["admins_two_factor"]["status"] == "warn"
    assert "admin" in items["admins_two_factor"]["detail"]
    assert items["updates"]["status"] == "ok"
    assert items["two_factor_required"]["status"] == "warn"


def test_https_proxy_hosts_and_the_environment_show_up(
    app, admin_user, init_db, monkeypatch
):
    from app.security import HostPolicy
    from tests.conftest import _client, _session_cookie

    app.state.host_policy = HostPolicy.from_env("horde.example.com")
    app.state.auth.config = AuthConfig(trust_proxy=True)
    monkeypatch.setenv("HORDE_ALLOW_PRIVATE_URLS", "1")
    with _client(app, cookies=_session_cookie(init_db, admin_user)) as c:
        res = c.get(
            "/api/system/security-checklist",
            headers={
                "X-Forwarded-Proto": "https",
                "X-Forwarded-For": "198.51.100.4",
            },
        )
    body = res.json()
    items = {i["id"]: i for i in body["items"]}
    assert body["exposed"] is True
    assert items["https"]["status"] == "ok"
    assert items["proxy"]["status"] == "ok"
    assert items["hosts"]["detail"] == (
        "Only the names in HORDE_ALLOWED_HOSTS (and local names) are accepted: "
        "horde.example.com"
    )
    assert items["private_urls"]["status"] == "warn"


def test_a_proxy_without_trust_and_disabled_auth_are_flagged(app, admin_user, init_db):
    from tests.conftest import _client, _session_cookie

    with _client(app, cookies=_session_cookie(init_db, admin_user)) as c:
        res = c.get(
            "/api/system/security-checklist",
            headers={"X-Forwarded-For": "198.51.100.4"},
        )
        assert {i["id"]: i["status"] for i in res.json()["items"]}["proxy"] == "warn"

    app.state.auth.config = AuthConfig(disabled=True)
    with TestClient(app, headers={"X-Horde-Request": "1"}) as c:
        items = {
            i["id"]: i for i in c.get("/api/system/security-checklist").json()["items"]
        }
    assert items["auth_enabled"]["status"] == "warn"


def test_an_update_check_that_failed_is_a_warning_not_a_crash(client, monkeypatch):
    monkeypatch.setattr(
        updates,
        "check_for_updates",
        lambda **kw: {
            "update_available": False,
            "latest_sha": None,
            "error": "offline",
        },
    )
    assert _by_id(client)["updates"]["status"] == "warn"


# --- accounts that have not enrolled yet -----------------------------------------------


def test_accounts_that_have_not_enrolled_are_listed_once_everyone_must():
    required = Facts(require_two_factor="everyone", members_without_two_factor=("kid",))
    item = next(i for i in evaluate(required).items if i.id == "members_two_factor")
    assert item.status == "warn"
    assert "kid" in item.detail
    assert "before you open the port" in item.detail
    enrolled = Facts(require_two_factor="everyone")
    assert _status(enrolled)["members_two_factor"] == "ok"


def test_the_member_line_only_appears_when_everyone_must_use_it():
    ids = {i.id for i in evaluate(Facts(require_two_factor="admins")).items}
    assert "members_two_factor" not in ids
    assert "members_two_factor" in {
        i.id for i in evaluate(Facts(require_two_factor="everyone")).items
    }


def test_the_endpoint_names_the_members_who_have_not_enrolled(
    client, member_user, init_db
):
    from sqlmodel import Session

    from app.models import utcnow
    from app.services import app_settings
    from app.services.auth import accounts

    with Session(init_db["engine"]) as s:  # the admin has enrolled; the member has not
        admin = accounts.get_by_username(s, "admin")
        admin.totp_secret = "A" * 32
        admin.totp_enabled_at = utcnow()
        s.add(admin)
        s.commit()
    app_settings.save({"require_two_factor": "everyone"})
    item = _by_id(client)["members_two_factor"]
    assert item["status"] == "warn"
    assert "member" in item["detail"]
