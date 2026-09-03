"""Tests for yt-dlp error classification and members-only helpers."""

from app.services.ytdlp_common import (
    ERROR_KIND_BOT,
    ERROR_KIND_COOKIES,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_POSTPROCESS,
    ERROR_KIND_POT,
    ERROR_KIND_RATE_LIMIT,
    ERROR_KIND_UNAVAILABLE,
    ERROR_KIND_UNKNOWN,
    MembersOnlyError,
    classify_ytdlp_error,
    http_detail_for_error,
    is_members_only_entry,
    is_members_only_message,
    youtube_extractor_args,
)


def test_members_only_message_and_error():
    assert is_members_only_message("Join this channel to get access to members-only content")
    assert not is_members_only_message("normal failure")
    kind, msg = classify_ytdlp_error(MembersOnlyError("locked"))
    assert kind == ERROR_KIND_MEMBERS
    assert "Members-only" in msg


def test_classify_bot_pot_cookies(monkeypatch):
    monkeypatch.setattr(
        "app.services.ytdlp_common.cookie_configured", lambda: False
    )
    monkeypatch.setattr(
        "app.services.ytdlp_common.pot_provider_configured", lambda: False
    )
    kind, _ = classify_ytdlp_error("Sign in to confirm you’re not a bot")
    assert kind == ERROR_KIND_BOT
    kind, _ = classify_ytdlp_error("PO Token required for this player")
    assert kind == ERROR_KIND_POT
    kind, msg = classify_ytdlp_error("HTTP Error 403: Forbidden")
    assert kind == ERROR_KIND_POT
    assert "403" in msg
    kind, _ = classify_ytdlp_error("Login required / age-restricted")
    assert kind == ERROR_KIND_COOKIES


def test_classify_rate_unavailable_postprocess():
    kind, _ = classify_ytdlp_error("HTTP Error 429: Too Many Requests")
    assert kind == ERROR_KIND_RATE_LIMIT
    kind, msg = classify_ytdlp_error("Video unavailable")
    assert kind == ERROR_KIND_UNAVAILABLE
    assert "unavailable" in msg.lower()
    kind, _ = classify_ytdlp_error("ERROR: Postprocessing: Error merging")
    assert kind == ERROR_KIND_POSTPROCESS


def test_classify_empty_unknown():
    kind, msg = classify_ytdlp_error("")
    assert kind == ERROR_KIND_UNKNOWN
    assert msg == "Download failed"
    kind, msg = classify_ytdlp_error("some obscure extractor bug")
    assert kind == ERROR_KIND_UNKNOWN
    assert "obscure" in msg


def test_classify_ansi_stripped_bot(monkeypatch):
    monkeypatch.setattr(
        "app.services.ytdlp_common.cookie_configured", lambda: True
    )
    kind, msg = classify_ytdlp_error(
        "\x1b[31mSign in to confirm you’re not a bot\x1b[0m"
    )
    assert kind == ERROR_KIND_BOT
    assert "cookies are configured" in msg


def test_http_detail_for_error_shape(monkeypatch):
    monkeypatch.setattr(
        "app.services.ytdlp_common.pot_provider_configured", lambda: True
    )
    detail = http_detail_for_error("PO token missing", prefix="Preview failed")
    assert detail["error_kind"] == ERROR_KIND_POT
    assert detail["message"].startswith("Preview failed:")


def test_is_members_only_entry():
    assert is_members_only_entry({"availability": "subscriber_only"})
    assert is_members_only_entry({"title": "[Members only] Hangout"})
    assert not is_members_only_entry({"title": "Public video", "availability": "public"})
    assert not is_members_only_entry(None)


def test_youtube_extractor_args_excludes_android_vr(monkeypatch):
    monkeypatch.setattr("app.services.ytdlp_common.YTDLP_POT_BASE_URL", "")
    args = youtube_extractor_args()
    clients = args["youtube"]["player_client"]
    assert "default" in clients
    assert "-android_vr" in clients
    assert "android_vr" not in clients
    assert args["youtubetab"]["approximate_date"] == ["true"]
    assert "youtubepot-bgutilhttp" not in args


def test_youtube_extractor_args_includes_bgutil(monkeypatch):
    monkeypatch.setattr(
        "app.services.ytdlp_common.YTDLP_POT_BASE_URL",
        "http://bgutil-pot:4416",
    )
    args = youtube_extractor_args()
    assert args["youtubepot-bgutilhttp"]["base_url"] == ["http://bgutil-pot:4416"]
