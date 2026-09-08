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
    describe_extract_target,
    get_last_extract_failure,
    http_detail_for_error,
    is_members_only_entry,
    is_members_only_message,
    record_extract_failure,
    youtube_extractor_args,
)


def test_members_only_message_and_error():
    assert is_members_only_message("Join this channel to get access to members-only content")
    assert not is_members_only_message("normal failure")
    kind, msg = classify_ytdlp_error(MembersOnlyError("locked"))
    assert kind == ERROR_KIND_MEMBERS
    assert "Members-only" in msg
    assert "anonymously" in msg


def test_describe_extract_target():
    assert (
        describe_extract_target(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title="Never Gonna Give You Up",
            channel="Rick Astley",
        )
        == '"Never Gonna Give You Up" · Rick Astley'
    )
    assert (
        describe_extract_target("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        == "youtube.com/watch?v=dQw4w9WgXcQ"
    )
    assert (
        describe_extract_target("https://www.youtube.com/@LinusTechTips")
        == "@LinusTechTips"
    )
    assert (
        describe_extract_target("ytsearch40:t480 mod")
        == 'YouTube search "t480 mod"'
    )
    assert (
        describe_extract_target(
            "https://www.youtube.com/@LinusTechTips/search?query=paint"
        )
        == '@LinusTechTips search "paint"'
    )


def test_classify_cookies_explains_anonymous_and_names_target(monkeypatch):
    monkeypatch.setattr(
        "app.services.ytdlp_common.cookie_configured", lambda: False
    )
    kind, msg = classify_ytdlp_error(
        "Login required / age-restricted",
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title="Secret Video",
        channel="Some Channel",
    )
    assert kind == ERROR_KIND_COOKIES
    assert "anonymously" in msg
    assert "public" in msg.lower()
    assert "Secret Video" in msg
    assert "Some Channel" in msg
    assert "On:" in msg


def test_record_extract_failure_stores_target():
    record_extract_failure(
        ERROR_KIND_COOKIES,
        "gated",
        url="https://www.youtube.com/@LinusTechTips",
    )
    last = get_last_extract_failure()
    assert last is not None
    assert last["target"] == "@LinusTechTips"
    assert last["kind"] == ERROR_KIND_COOKIES
    assert last["url"] == "https://www.youtube.com/@LinusTechTips"

    record_extract_failure(
        ERROR_KIND_COOKIES,
        "gated",
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title="Secret Video",
        channel="Some Channel",
    )
    last = get_last_extract_failure()
    assert last is not None
    assert last["target"] == '"Secret Video" · Some Channel'


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
    kind, msg = classify_ytdlp_error("Login required / age-restricted")
    assert kind == ERROR_KIND_COOKIES
    assert "anonymously" in msg


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
        "app.services.ytdlp_common.pot_provider_configured", lambda: True
    )
    kind, msg = classify_ytdlp_error(
        "\x1b[31mSign in to confirm you’re not a bot\x1b[0m"
    )
    assert kind == ERROR_KIND_BOT
    assert "po token" in msg.lower()
    assert "does not send cookies" in msg.lower()


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


def test_is_age_restricted_entry():
    from app.services.ytdlp_common import is_age_restricted_entry

    assert is_age_restricted_entry({"availability": "age_restricted"})
    assert is_age_restricted_entry({"age_limit": 18})
    assert not is_age_restricted_entry({"availability": "public", "age_limit": 0})
    assert not is_age_restricted_entry({"title": "Public video"})
    assert not is_age_restricted_entry(None)


def test_catalog_skip_message_names_target():
    from app.services.ytdlp_common import ERROR_KIND_COOKIES, catalog_skip_message

    msg = catalog_skip_message(
        ERROR_KIND_COOKIES,
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title="Secret Video",
        channel="karrigan",
    )
    assert msg.startswith("Age-restricted / private:")
    assert "skipped" in msg
    assert "continued indexing" in msg
    assert "Secret Video" in msg
    assert "karrigan" in msg


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
