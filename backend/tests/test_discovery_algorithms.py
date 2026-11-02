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


def test_unsharing_or_deleting_leaves_others_on_their_own_copy(client, member_client):
    shared = _save(client, "Weekend", shared=True, freshness=90)
    member_client.put("/api/discover/tuning", json={"active": f"algo:{shared['id']}"})
    client.patch(f"/api/discover/algorithms/{shared['id']}", json={"shared": False})
    state = member_client.get("/api/discover/tuning").json()
    assert state["active"] == "custom" and state["values"]["freshness"] == 90
    # The owner keeps ranking with it.
    assert client.get("/api/discover/tuning").json()["active"] == f"algo:{shared['id']}"

    client.patch(f"/api/discover/algorithms/{shared['id']}", json={"shared": True})
    member_client.put("/api/discover/tuning", json={"active": f"algo:{shared['id']}"})
    assert client.delete(f"/api/discover/algorithms/{shared['id']}").status_code == 200
    for c in (client, member_client):
        state = c.get("/api/discover/tuning").json()
        assert state["active"] == "custom" and state["values"]["freshness"] == 90
    assert client.get("/api/discover/algorithms").json()["items"] == []


def test_an_owner_who_is_gone_leaves_the_last_values(
    client, member_client, session, admin_user
):
    from app.models import RecAlgorithm

    shared = _save(client, "Weekend", shared=True, freshness=90)
    member_client.put("/api/discover/tuning", json={"active": f"algo:{shared['id']}"})
    member_client.get("/api/discover/tuning")
    # As when the owner's account is deleted (the rows cascade away).
    row = session.get(RecAlgorithm, shared["id"])
    session.delete(row)
    session.commit()
    state = member_client.get("/api/discover/tuning").json()
    assert state["active"] == "custom" and state["values"]["freshness"] == 90


def test_algorithm_names_are_validated(client):
    for name in ["", "   ", "x" * 61]:
        resp = client.post(
            "/api/discover/algorithms", json={"name": name, "values": _values(client)}
        )
        assert resp.status_code == 422, name
