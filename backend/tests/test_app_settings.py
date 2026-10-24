"""Tests for settings clamps, merge, load/save, and API key masking."""

import json
import threading

import pytest

from app.services import app_settings as settings_svc
from app.services.ai.provider import mask_api_key


def test_clamp_category_min_score():
    assert settings_svc.clamp_category_min_score(0.55) == 0.55
    assert settings_svc.clamp_category_min_score(0.0) == 0.20
    assert settings_svc.clamp_category_min_score(1.0) == 0.90
    assert settings_svc.clamp_category_min_score("nope") == 0.55


def test_clamp_tag_rescan_days():
    assert settings_svc.clamp_tag_rescan_days(90) == 90
    assert settings_svc.clamp_tag_rescan_days(1) == 7
    assert settings_svc.clamp_tag_rescan_days(9999) == 365
    assert settings_svc.clamp_tag_rescan_days("x") == 90


def test_clamp_vram_gb():
    assert settings_svc.clamp_vram_gb(None) is None
    assert settings_svc.clamp_vram_gb("") is None
    assert settings_svc.clamp_vram_gb(0) is None
    assert settings_svc.clamp_vram_gb("bad") is None
    assert settings_svc.clamp_vram_gb(8) == 8.0
    assert settings_svc.clamp_vram_gb(0.1) == 0.5
    assert settings_svc.clamp_vram_gb(9999) == 256.0


def test_clamp_weekly_budget_usd():
    assert settings_svc.clamp_weekly_budget_usd(None) is None
    assert settings_svc.clamp_weekly_budget_usd(0) is None
    assert settings_svc.clamp_weekly_budget_usd(float("nan")) is None
    assert settings_svc.clamp_weekly_budget_usd(5) == 5.0
    assert settings_svc.clamp_weekly_budget_usd(0.001) == 0.01


def test_clamp_catalog_max_videos():
    assert settings_svc.clamp_catalog_max_videos(1000) == 1000
    assert settings_svc.clamp_catalog_max_videos(1) == 100
    assert settings_svc.clamp_catalog_max_videos(99999) == 5000


def test_direct_youtube_search_effective():
    assert settings_svc.direct_youtube_search_effective(None, True) is True
    assert settings_svc.direct_youtube_search_effective(None, False) is False
    assert settings_svc.direct_youtube_search_effective(True, False) is True
    assert settings_svc.direct_youtube_search_effective(False, True) is False
    assert settings_svc.direct_youtube_search_effective(0, True) is False
    assert settings_svc.direct_youtube_search_effective(1, False) is True


def test_youtube_video_search_system(tmp_dirs):
    assert settings_svc.youtube_video_search_system() is True
    settings_svc.save({"youtube_video_search": False})
    assert settings_svc.youtube_video_search_system() is False


def test_normalize_helpers():
    assert settings_svc.normalize_summary_length("long") == "long"
    assert settings_svc.normalize_summary_length("nope") == "short"
    assert settings_svc.normalize_ai_chapters_mode("on_watch") == "on_watch"
    assert settings_svc.normalize_ai_chapters_mode("nope") == "on_download"

    normalize = settings_svc.normalize_base_url
    assert normalize("") == ""
    assert normalize("  http://192.168.1.50:11434/ ") == "http://192.168.1.50:11434/v1"
    assert normalize("https://openrouter.ai/api/v1/") == "https://openrouter.ai/api/v1"
    assert (
        normalize("https://api.groq.com/openai/v1") == "https://api.groq.com/openai/v1"
    )


def test_merge_ai_drops_unknown_and_clamps():
    merged = settings_svc._merge_ai(
        {"category_min_score": 0.01, "unknown_key": 1, "enabled": False}
    )
    assert "unknown_key" not in merged
    assert merged["category_min_score"] == 0.20
    assert merged["enabled"] is False


def test_load_missing_file_returns_defaults(tmp_dirs):
    data = settings_svc.load()
    assert data["progress_expiry_days"] == 14
    assert data["setup_completed"] is False
    assert data["ai"]["embed_model"] == settings_svc.AI_DEFAULTS["embed_model"]


def test_load_grandfathers_missing_setup_completed(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text(json.dumps({"progress_expiry_days": 21, "ui": {"theme": "oled"}}))
    data = settings_svc.load()
    assert data["setup_completed"] is True
    assert data["progress_expiry_days"] == 21
    assert data["ui"]["theme"] == "oled"


def test_save_persists_grandfathered_setup_completed(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text(json.dumps({"progress_expiry_days": 21}))
    settings_svc.save({"progress_expiry_days": 22})
    raw = json.loads(path.read_text())
    assert raw["setup_completed"] is True
    assert raw["progress_expiry_days"] == 22


def test_reset_to_defaults_empties_ui_and_ai(tmp_dirs):
    settings_svc.save(
        {
            "ui": {"theme": "oled", "fontSize": "large"},
            "ai": {"enabled": False, "api_key": "sk-or-secret"},
            "setup_completed": True,
        }
    )
    out = settings_svc.reset_to_defaults()
    assert out["setup_completed"] is False
    assert out["ui"] == {}
    assert out["ai"]["enabled"] is True
    assert out["ai"]["api_key"] == ""
    raw = json.loads((tmp_dirs["data"] / "app_settings.json").read_text())
    assert raw["ui"] == {}
    assert "theme" not in raw["ui"]
    assert raw["setup_completed"] is False
    assert raw["ai"]["enabled"] is True


def test_load_corrupt_file_without_backup_keeps_setup_completed(tmp_dirs, caplog):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text("{not json")
    with caplog.at_level("ERROR"):
        data = settings_svc.load()
    assert data["ai"]["chat_model"] == settings_svc.AI_DEFAULTS["chat_model"]
    # A corrupt file must not bounce an installed app into the setup wizard.
    assert data["setup_completed"] is True
    assert "corrupt" in caplog.text
    assert path.read_text() == "{not json"
    copies = list(tmp_dirs["data"].glob("app_settings.json.corrupt-*"))
    assert len(copies) == 1
    assert copies[0].read_text() == "{not json"
    # Repeated loads do not litter further copies.
    settings_svc.load()
    assert len(list(tmp_dirs["data"].glob("app_settings.json.corrupt-*"))) == 1


def test_save_refuses_to_overwrite_unparseable_file(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text('{"ai": {"api_key": "sk-or-secret"')  # truncated
    before = path.read_bytes()
    with pytest.raises(settings_svc.SettingsCorruptError, match="refusing"):
        settings_svc.save({"ui": {"theme": "oled"}})
    assert path.read_bytes() == before


def test_corrupt_file_is_recovered_from_backup(tmp_dirs, caplog):
    path = tmp_dirs["data"] / "app_settings.json"
    settings_svc.save({"setup_completed": True, "ai": {"api_key": "k1"}})
    settings_svc.save({"progress_expiry_days": 30})  # first good file -> .bak
    bak = path.with_name("app_settings.json.bak")
    assert json.loads(bak.read_text())["ai"]["api_key"] == "k1"
    path.write_text("\x00\x00 garbage")
    with caplog.at_level("ERROR"):
        data = settings_svc.load()
    assert data["ai"]["api_key"] == "k1"
    assert data["setup_completed"] is True
    assert json.loads(path.read_text())["ai"]["api_key"] == "k1"
    corrupt = list(tmp_dirs["data"].glob("app_settings.json.corrupt-*"))
    assert len(corrupt) == 1
    assert corrupt[0].read_text() == "\x00\x00 garbage"
    assert "restored" in caplog.text


def test_save_after_corruption_with_backup_keeps_data(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    settings_svc.save({"setup_completed": True, "ai": {"api_key": "k1"}})
    settings_svc.save({"ui": {"theme": "oled"}})
    settings_svc.save({"progress_expiry_days": 19})  # .bak now holds the theme
    path.write_text("{")
    out = settings_svc.save({"progress_expiry_days": 20})
    assert out["ai"]["api_key"] == "k1"
    assert out["ui"]["theme"] == "oled"
    on_disk = json.loads(path.read_text())
    assert on_disk["ai"]["api_key"] == "k1"
    assert on_disk["progress_expiry_days"] == 20


_EVIL_CSS = "@import url(http://evil.example/x.css); body{color:red}"


def test_startup_css_cleanup_leaves_no_unsanitised_backup(tmp_dirs):
    """The .bak is what a corrupt file is restored from, so it must be clean too."""
    path = tmp_dirs["data"] / "app_settings.json"
    bak = path.with_name("app_settings.json.bak")
    settings_svc.save({"ui": {"customCss": _EVIL_CSS}})
    settings_svc.save({"progress_expiry_days": 19})  # .bak holds the CSS too

    assert settings_svc.sanitize_stored_ui() is True

    assert "evil.example" not in path.read_text()
    assert "evil.example" not in bak.read_text()
    path.write_text("{")  # corrupt: load() restores the .bak
    assert settings_svc.load()["ui"]["customCss"] == " body{color:red}"


def test_startup_css_cleanup_also_cleans_a_backup_left_dirty(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    bak = path.with_name("app_settings.json.bak")
    settings_svc.save({"ui": {"theme": "oled"}})
    bak.write_text(json.dumps({"ui": {"themes": [{"custom_css": _EVIL_CSS}]}}))

    settings_svc.sanitize_stored_ui()

    assert json.loads(bak.read_text()) == {
        "ui": {"themes": [{"custom_css": " body{color:red}"}]}
    }
    assert json.loads(path.read_text())["ui"] == {"theme": "oled"}


def test_reset_is_the_way_out_of_unrecoverable_corruption(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    path.write_text("{")
    settings_svc.reset_to_defaults()
    assert json.loads(path.read_text())["setup_completed"] is False
    settings_svc.save({"ui": {"theme": "oled"}})


def test_write_is_atomic_private_and_keeps_one_backup(tmp_dirs):
    path = tmp_dirs["data"] / "app_settings.json"
    settings_svc.save({"progress_expiry_days": 20})
    settings_svc.save({"progress_expiry_days": 21})
    settings_svc.save({"progress_expiry_days": 22})
    assert path.stat().st_mode & 0o777 == 0o600
    bak = path.with_name("app_settings.json.bak")
    assert bak.stat().st_mode & 0o777 == 0o600
    assert json.loads(bak.read_text())["progress_expiry_days"] == 21
    assert [p.name for p in tmp_dirs["data"].iterdir() if p.name.endswith(".tmp")] == []


def test_io_error_never_reports_setup_incomplete(tmp_dirs, monkeypatch):
    settings_svc.save({"setup_completed": True})
    path = tmp_dirs["data"] / "app_settings.json"
    real_read_bytes = type(path).read_bytes

    def boom(self):
        if self.name == "app_settings.json":
            raise OSError(5, "Input/output error")
        return real_read_bytes(self)

    # Cached last-known value is served and flagged, never replaced by defaults.
    settings_svc.save({"progress_expiry_days": 33})
    path.write_text(path.read_text() + " ")  # invalidate the cache signature
    monkeypatch.setattr(type(path), "read_bytes", boom)
    data = settings_svc.load()
    assert data["setup_completed"] is True
    assert data["progress_expiry_days"] == 33
    with pytest.raises(settings_svc.SettingsUnavailableError):
        settings_svc._store._cache.clear()
        settings_svc.load()


def test_load_uses_cache_until_file_changes(tmp_dirs, monkeypatch):
    path = tmp_dirs["data"] / "app_settings.json"
    settings_svc.save({"progress_expiry_days": 25})
    reads = {"n": 0}
    real_read_bytes = type(path).read_bytes

    def counting(self):
        if self.name == "app_settings.json":
            reads["n"] += 1
        return real_read_bytes(self)

    monkeypatch.setattr(type(path), "read_bytes", counting)
    for _ in range(5):
        assert settings_svc.load()["progress_expiry_days"] == 25
    assert reads["n"] == 0
    # An external edit (different size) is noticed.
    path.write_text(json.dumps({"setup_completed": True, "progress_expiry_days": 100}))
    assert settings_svc.load()["progress_expiry_days"] == 100
    assert reads["n"] == 1


def test_load_returns_independent_copies(tmp_dirs):
    settings_svc.save({"ui": {"theme": "oled"}})
    first = settings_svc.load()
    first["ui"]["theme"] = "mutated"
    assert settings_svc.load()["ui"]["theme"] == "oled"


def test_concurrent_readers_and_writers_never_see_defaults(tmp_dirs):
    """Hammer save/load from many threads: no reader may observe defaults."""
    settings_svc.save({"setup_completed": True, "ai": {"api_key": "sk-or-secret"}})
    stop = threading.Event()
    failures: list[str] = []

    def reader():
        while not stop.is_set():
            try:
                data = settings_svc.load()
            except Exception as exc:  # noqa: BLE001 - the thread reports any failure for the test to assert on
                failures.append(f"load raised {exc!r}")
                return
            if data["setup_completed"] is not True:
                failures.append("setup_completed flipped to False")
            if data["ai"]["api_key"] != "sk-or-secret":
                failures.append("api key lost")

    def writer(n):
        for i in range(60):
            settings_svc.save({"ui": {f"k{n}": i}, "progress_expiry_days": 7 + i})

    readers = [threading.Thread(target=reader) for _ in range(6)]
    writers = [threading.Thread(target=writer, args=(n,)) for n in range(3)]
    for t in readers + writers:
        t.start()
    for t in writers:
        t.join(timeout=60)
    stop.set()
    for t in readers:
        t.join(timeout=10)
    assert not failures, failures[:3]
    final = settings_svc.load()
    assert final["ai"]["api_key"] == "sk-or-secret"
    assert {f"k{n}" for n in range(3)} <= set(final["ui"])
    assert not list(tmp_dirs["data"].glob("app_settings.json.corrupt-*"))


def test_save_merges_ui_and_ai(tmp_dirs):
    settings_svc.save({"ui": {"theme": "oled"}, "ai": {"enabled": False}})
    settings_svc.save({"ui": {"fontSize": "large"}})
    data = settings_svc.load()
    assert data["ui"]["theme"] == "oled"
    assert data["ui"]["fontSize"] == "large"
    assert data["ai"]["enabled"] is False
    raw = json.loads((tmp_dirs["data"] / "app_settings.json").read_text())
    assert raw["ui"]["theme"] == "oled"


def test_show_costs_defaults_false():
    merged = settings_svc._merge_ai({})
    assert merged["show_costs"] is False
    on = settings_svc._merge_ai({"show_costs": True, "connection_version": 2})
    assert on["show_costs"] is True


def test_ai_chapters_mode_defaults_on_download():
    merged = settings_svc._merge_ai({})
    assert merged["ai_chapters_mode"] == "on_download"
    watch = settings_svc._merge_ai({"ai_chapters_mode": "on_watch"})
    assert watch["ai_chapters_mode"] == "on_watch"


def test_mask_api_key():
    assert mask_api_key("") == ""
    assert mask_api_key("abcd") == "••••"
    assert mask_api_key("sk-or-v1-abcdefgh") == "••••efgh"


def test_reset_leaves_no_copy_of_the_secrets(tmp_dirs):
    secret = "sk-or-very-secret-key"
    path = tmp_dirs["data"] / "app_settings.json"
    settings_svc.save({"setup_completed": True, "ai": {"api_key": secret}})
    settings_svc.save({"progress_expiry_days": 20})  # creates the .bak
    path.with_name(path.name + ".corrupt-20200101T000000").write_text(secret)
    assert path.with_name(path.name + ".bak").exists()

    settings_svc.reset_to_defaults()

    assert not path.with_name(path.name + ".bak").exists()
    assert not list(tmp_dirs["data"].glob("app_settings.json.corrupt-*"))
    for f in tmp_dirs["data"].rglob("*"):
        if f.is_file():
            assert secret.encode() not in f.read_bytes(), f


def test_settings_degraded_is_exposed(client, tmp_dirs):
    assert client.get("/api/settings").json()["settings_degraded"] is False
    (tmp_dirs["data"] / "app_settings.json").write_text("{broken")
    assert client.get("/api/settings").json()["settings_degraded"] is True
