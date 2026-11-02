"""Saved and shared Recommended+ algorithms."""

from __future__ import annotations


def _values(client, **changes):
    values = client.get("/api/discover/tuning").json()["defaults"]
    values.update(changes)
    return values


def _save(client, name, *, shared=False, **changes):
    resp = client.post(
        "/api/discover/algorithms",
        json={"name": name, "shared": shared, "values": _values(client, **changes)},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_save_as_names_the_values_and_ranks_with_them(client):
    algo = _save(client, "  Weeknight ", freshness=80)
    assert algo["name"] == "Weeknight" and algo["mine"] is True
    assert algo["owner"] == "admin" and algo["shared"] is False
    state = client.get("/api/discover/tuning").json()
    assert state["active"] == f"algo:{algo['id']}"
    assert state["algorithm"]["name"] == "Weeknight"
    assert state["values"]["freshness"] == 80
    assert client.get("/api/discover/feed").status_code == 200
    # Names are unique per owner.
    resp = client.post(
        "/api/discover/algorithms",
        json={"name": "weeknight ", "values": _values(client)},
    )
    assert resp.status_code == 409 and resp.json()["code"] == "name_taken"
    resp = client.post(
        "/api/discover/algorithms",
        json={"name": "Weeknight", "values": _values(client)},
    )
    assert resp.status_code == 409 and resp.json()["code"] == "name_taken"


def test_moving_a_slider_on_your_algorithm_can_be_saved_back(client):
    algo = _save(client, "Mine", freshness=80)
    state = client.put(
        "/api/discover/tuning",
        json={"active": "custom", "custom": _values(client, freshness=20)},
    ).json()
    assert state["active"] == "custom" and state["based_on"]["id"] == algo["id"]
    resp = client.patch(
        f"/api/discover/algorithms/{algo['id']}",
        json={"values": _values(client, freshness=20)},
    )
    assert resp.status_code == 200 and resp.json()["values"]["freshness"] == 20
    state = client.get("/api/discover/tuning").json()
    assert state["active"] == f"algo:{algo['id']}"
    assert state["values"]["freshness"] == 20
    # A preset forgets where the own values came from.
    state = client.put("/api/discover/tuning", json={"active": "balanced"}).json()
    assert state["based_on"] is None


def test_shared_algorithms_are_offered_to_everyone_and_follow_their_owner(
    client, member_client
):
    private = _save(client, "Private", freshness=10)
    shared = _save(client, "Weekend", shared=True, freshness=90)
    listed = member_client.get("/api/discover/algorithms").json()["items"]
    assert [(a["name"], a["owner"], a["mine"]) for a in listed] == [
        ("Weekend", "admin", False)
    ]
    resp = member_client.put(
        "/api/discover/tuning", json={"active": f"algo:{private['id']}"}
    )
    assert resp.status_code == 404
    state = member_client.put(
        "/api/discover/tuning", json={"active": f"algo:{shared['id']}"}
    ).json()
    assert state["values"]["freshness"] == 90 and state["algorithm"]["mine"] is False
    # The owner improves it: the member ranks with the new values.
    client.patch(
        f"/api/discover/algorithms/{shared['id']}",
        json={"values": _values(client, freshness=70)},
    )
    assert member_client.get("/api/discover/tuning").json()["values"]["freshness"] == 70
    # The member cannot change or delete it; moving a slider is their own copy.
    assert (
        member_client.patch(
            f"/api/discover/algorithms/{shared['id']}", json={"name": "Mine now"}
        ).status_code
        == 404
    )
    assert (
        member_client.delete(f"/api/discover/algorithms/{shared['id']}").status_code
        == 404
    )
    state = member_client.put(
        "/api/discover/tuning",
        json={"active": "custom", "custom": _values(member_client, freshness=5)},
    ).json()
    assert state["active"] == "custom" and state["based_on"] is None
    assert client.get("/api/discover/tuning").json()["values"]["freshness"] == 70


def test_unsharing_or_deleting_gives_others_a_private_copy(client, member_client):
    shared = _save(client, "Weekend", shared=True, freshness=90)
    # The member had own values before picking it: they stay.
    member_client.put(
        "/api/discover/tuning",
        json={"active": "custom", "custom": _values(member_client, freshness=11)},
    )
    member_client.put("/api/discover/tuning", json={"active": f"algo:{shared['id']}"})
    # Unsharing while changing it: the member keeps what was shared.
    client.patch(
        f"/api/discover/algorithms/{shared['id']}",
        json={"shared": False, "values": _values(client, freshness=3)},
    )
    state = member_client.get("/api/discover/tuning").json()
    assert state["algorithm"]["name"] == "Weekend (from admin)"
    assert state["algorithm"]["mine"] is True and state["algorithm"]["shared"] is False
    assert state["values"]["freshness"] == 90
    assert state["custom"]["freshness"] == 11
    # The owner keeps ranking with theirs.
    assert client.get("/api/discover/tuning").json()["active"] == f"algo:{shared['id']}"

    client.patch(f"/api/discover/algorithms/{shared['id']}", json={"shared": True})
    member_client.put("/api/discover/tuning", json={"active": f"algo:{shared['id']}"})
    assert client.delete(f"/api/discover/algorithms/{shared['id']}").status_code == 200
    state = member_client.get("/api/discover/tuning").json()
    assert state["algorithm"]["name"] == "Weekend (from admin) 2"
    assert state["values"]["freshness"] == 3
    owner = client.get("/api/discover/tuning").json()
    assert owner["active"] == "custom" and owner["values"]["freshness"] == 3
    assert client.get("/api/discover/algorithms").json()["items"] == []


def test_an_owner_who_is_deleted_leaves_copies(
    client, member_client, session, admin_user, member_user
):
    from app.services.auth import accounts

    shared = _save(member_client, "Weekend", shared=True, freshness=90)
    client.put("/api/discover/tuning", json={"active": f"algo:{shared['id']}"})
    accounts.delete_user(session, member_user.id, successor_id=admin_user.id)
    session.commit()
    state = client.get("/api/discover/tuning").json()
    assert state["algorithm"]["name"] == "Weekend (from member)"
    assert state["values"]["freshness"] == 90


def test_reading_settings_writes_nothing(client, member_client, session, member_user):
    from app.models import UserSettings

    shared = _save(client, "Weekend", shared=True, freshness=90)
    member_client.put("/api/discover/tuning", json={"active": f"algo:{shared['id']}"})
    row = session.get(UserSettings, member_user.id)
    assert row is not None
    before = row.rec_tuning_json
    client.patch(
        f"/api/discover/algorithms/{shared['id']}",
        json={"values": _values(client, freshness=70)},
    )
    assert member_client.get("/api/discover/tuning").json()["values"]["freshness"] == 70
    assert member_client.get("/api/discover/feed").status_code == 200
    session.expire_all()
    row = session.get(UserSettings, member_user.id)
    assert row is not None and row.rec_tuning_json == before


def test_deleting_the_algorithm_values_came_from_forgets_it(
    client, session, admin_user
):
    from app.models import UserSettings

    algo = _save(client, "Mine", freshness=80)
    client.put(
        "/api/discover/tuning",
        json={"active": "custom", "custom": _values(client, freshness=20)},
    )
    client.delete(f"/api/discover/algorithms/{algo['id']}")
    session.expire_all()
    row = session.get(UserSettings, admin_user.id)
    assert row is not None and '"based_on":null' in (row.rec_tuning_json or "")


def test_odd_algorithm_ids_are_refused(client):
    for active in ["algo:²", "algo:" + "9" * 30, "algo:-1", "algo:"]:
        resp = client.put("/api/discover/tuning", json={"active": active})
        assert resp.status_code in (400, 404), (active, resp.status_code)


def test_algorithm_names_are_validated(client):
    for name in ["", "   ", "x" * 61]:
        resp = client.post(
            "/api/discover/algorithms", json={"name": name, "values": _values(client)}
        )
        assert resp.status_code == 422, name
