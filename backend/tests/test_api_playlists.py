"""HTTP regression: user playlists (no YouTube import)."""


def test_playlist_crud_and_items(client, add_video):
    v1 = add_video(title="First")
    v2 = add_video(title="Second")
    v3 = add_video(title="Third")

    empty = client.get("/api/playlists")
    assert empty.status_code == 200
    assert empty.json() == []

    created = client.post("/api/playlists", json={"name": "  Mix  ", "description": "d"})
    assert created.status_code == 200
    playlist = created.json()
    assert playlist["name"] == "Mix"
    assert playlist["item_count"] == 0
    pid = playlist["id"]

    blank = client.post("/api/playlists", json={"name": "   "})
    assert blank.status_code == 400

    listed = client.get("/api/playlists").json()
    assert len(listed) == 1

    added = client.post(f"/api/playlists/{pid}/items", json={"video_id": v1.id})
    assert added.status_code == 200
    assert [v["id"] for v in added.json()["videos"]] == [v1.id]

    # Duplicate add is idempotent.
    again = client.post(f"/api/playlists/{pid}/items", json={"video_id": v1.id})
    assert again.status_code == 200
    assert len(again.json()["videos"]) == 1

    bulk = client.post(
        f"/api/playlists/{pid}/items/bulk", json={"video_ids": [v2.id, v3.id, 99999]}
    )
    assert bulk.status_code == 204
    detail = client.get(f"/api/playlists/{pid}").json()
    assert [v["id"] for v in detail["videos"]] == [v1.id, v2.id, v3.id]
    assert detail["item_count"] == 3

    reordered = client.patch(
        f"/api/playlists/{pid}/reorder",
        json={"video_ids": [v3.id, v1.id, v2.id]},
    )
    assert reordered.status_code == 200
    assert [v["id"] for v in reordered.json()["videos"]] == [v3.id, v1.id, v2.id]

    removed = client.delete(f"/api/playlists/{pid}/items/{v1.id}")
    assert removed.status_code == 204
    leftover = client.get(f"/api/playlists/{pid}").json()
    assert [v["id"] for v in leftover["videos"]] == [v3.id, v2.id]

    renamed = client.patch(
        f"/api/playlists/{pid}", json={"name": "Renamed", "description": "new"}
    )
    assert renamed.json()["name"] == "Renamed"

    deleted = client.delete(f"/api/playlists/{pid}")
    assert deleted.status_code == 204
    assert client.get(f"/api/playlists/{pid}").status_code == 404
    assert client.get("/api/playlists").json() == []


def test_playlist_404s(client):
    assert client.get("/api/playlists/1").status_code == 404
    assert client.post("/api/playlists/1/items", json={"video_id": 1}).status_code == 404
    assert client.patch("/api/playlists/1", json={"name": "x"}).status_code == 404
    assert client.delete("/api/playlists/1").status_code == 404
