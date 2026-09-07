"""Factory reset: keep vs erase media, and settings restore."""

from app.models import Playlist, PlaylistItem
from app.services import app_settings as settings_svc


def test_reset_keep_media(client, add_video, session, tmp_dirs):
    video = add_video(write_file=True)
    playlist = Playlist(name="Keep me")
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    session.add(PlaylistItem(playlist_id=playlist.id, video_id=video.id, position=0))
    session.commit()
    media = tmp_dirs["downloads"] / video.file_path
    assert media.exists()

    settings_svc.save(
        {"ui": {"theme": "oled"}, "ai": {"enabled": False}, "setup_completed": True}
    )

    resp = client.post("/api/setup/reset", json={"erase_media": False})
    assert resp.status_code == 200
    body = resp.json()
    assert body["setup_completed"] is False
    assert body["erased_media"] is False
    assert body["library_video_count"] == 1
    assert media.exists()

    settings = client.get("/api/settings").json()
    assert settings["setup_completed"] is False
    assert settings["ui"] == {}
    assert settings["ai"]["enabled"] is True

    videos = client.get("/api/videos").json()
    assert len(videos) == 1
    playlists = client.get("/api/playlists").json()
    assert len(playlists) == 1


def test_reset_erase_media(client, add_video, session, tmp_dirs):
    video = add_video(write_file=True)
    playlist = Playlist(name="Gone")
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    session.add(PlaylistItem(playlist_id=playlist.id, video_id=video.id, position=0))
    session.commit()

    media = tmp_dirs["downloads"] / video.file_path
    leftovers = tmp_dirs["downloads"] / "imports"
    leftovers.mkdir()
    (leftovers / "drop.mp4").write_bytes(b"x" * 32)
    fonts = tmp_dirs["data"] / "fonts"
    fonts.mkdir(parents=True, exist_ok=True)
    (fonts / "custom.woff2").write_bytes(b"font")

    settings_svc.save({"ui": {"theme": "oled"}, "setup_completed": True})

    resp = client.post("/api/setup/reset", json={"erase_media": True})
    assert resp.status_code == 200
    body = resp.json()
    assert body["erased_media"] is True
    assert body["library_video_count"] == 0
    assert not media.exists()
    assert not leftovers.exists()
    assert list(fonts.iterdir()) == []

    settings = client.get("/api/settings").json()
    assert settings["setup_completed"] is False
    assert settings["ui"] == {}
    assert client.get("/api/videos").json() == []
    assert client.get("/api/playlists").json() == []
