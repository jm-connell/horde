"""Ask about Horde as an assistant: the settings catalog, the model it runs on
and the user's own data it may read."""

from __future__ import annotations

import json
import re
from datetime import timedelta
from pathlib import Path

import pytest
from sqlmodel import Session, select

from app.api.app_settings import AiSettingsUpdate, AppSettingsUpdate
from app.models import (
    DownloadJob,
    DownloadRequester,
    JobStatus,
    Playlist,
    PlaylistItem,
    PlaylistVisibility,
    User,
    UserVideoState,
    utcnow,
)
from app.services import app_settings
from app.services.ai import help_catalog, help_data, help_model
from app.services.ai.provider import Connection
from app.services.auth.accounts import AuthUser

_REPO = Path(__file__).resolve().parents[2]
_FRONTEND = _REPO / "frontend" / "src"
_CATALOG = Path(help_catalog.__file__).with_name("help_catalog.json")


def _raw() -> dict:
    return json.loads(_CATALOG.read_text(encoding="utf-8"))


def _user(*, admin: bool = False, perms: tuple[str, ...] = ()) -> AuthUser:
    return AuthUser(
        id=1 if admin else 2,
        username="admin" if admin else "member",
        is_admin=admin,
        permissions=frozenset(perms),
    )


# --- the catalog -----------------------------------------------------------


def test_the_shipped_catalog_is_valid():
    catalog = help_catalog.parse(_raw())
    assert len(catalog.settings) > 50
    assert any(s.chat == "link" for s in catalog.settings)


def _frontend_text() -> str:
    return "\n".join(
        p.read_text(encoding="utf-8")
        for p in [*_FRONTEND.rglob("*.tsx"), *_FRONTEND.rglob("*.ts")]
        if ".test." not in p.name
    )


def test_every_anchor_is_on_its_page():
    """A link that flashes nothing would leave the user hunting."""
    text = _frontend_text()
    catalog = help_catalog.parse(_raw())
    for setting in catalog.settings:
        anchor = setting.anchor or setting.id
        assert re.search(rf'(anchor|data-setting)="{re.escape(anchor)}"', text), (
            f"{setting.id}: no element marked {anchor!r}"
        )


def test_changeable_keys_exist_where_they_are_saved():
    types = (_FRONTEND / "hooks" / "settings" / "types.ts").read_text()
    personal = re.search(r"export interface Settings \{(.*?)\n\}", types, re.S)
    assert personal is not None
    catalog = help_catalog.parse(_raw())
    for s in catalog.settings:
        if s.chat != "change":
            continue
        assert s.key is not None
        if s.scope == "personal":
            for key in [s.key, *(s.implies or {})]:
                top = key.split(".")[0]
                assert re.search(rf"\n  {top}: ", personal.group(1)), s.id
        elif s.scope == "server":
            assert s.key in AppSettingsUpdate.model_fields, s.id
        else:
            assert s.key in AiSettingsUpdate.model_fields, s.id


def test_enum_values_are_ones_the_app_knows():
    """Each personal enum value appears in the frontend source as a literal."""
    text = _frontend_text()
    for s in help_catalog.parse(_raw()).settings:
        if s.type != "enum" or s.scope != "personal":
            continue
        for option in s.options or []:
            if isinstance(option.value, str):
                assert f'"{option.value}"' in text, (s.id, option.value)


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"chat": "link", "key": "theme"}, "link-only entry has no key"),
        ({"chat": "change", "key": None}, "needs scope, key and type"),
        ({"scope": "server", "access": None}, "for administrators"),
        ({"options": None}, "an enum needs options"),
    ],
)
def test_the_catalog_rejects_unsafe_entries(patch, message):
    raw = _raw()
    theme = next(s for s in raw["settings"] if s["id"] == "theme")
    theme.update(patch)
    with pytest.raises(ValueError, match=message):
        help_catalog.parse(raw)


def test_duplicate_ids_are_refused():
    raw = _raw()
    raw["settings"].append(dict(raw["settings"][0]))
    with pytest.raises(ValueError, match="duplicate"):
        help_catalog.parse(raw)


def test_members_only_see_what_they_can_open(app):
    member = help_catalog.for_user(_user())
    ids = {s.id for s in member.settings}
    assert "theme" in ids
    assert "ai-provider" not in ids and "trash" not in ids
    assert "download" not in {p.id for p in member.pages}
    downloader = help_catalog.for_user(_user(perms=("download", "delete_videos")))
    assert "trash" in {s.id for s in downloader.settings}
    assert "download" in {p.id for p in downloader.pages}


def test_best_settings_match_what_the_user_asked(app):
    catalog = help_catalog.load()
    picked = help_catalog.best_settings(
        catalog, {"background": 1.0, "animation": 1.0}, limit=3
    )
    assert picked[0].id == "background-effect"


def test_setting_lines_say_what_may_change():
    catalog = help_catalog.parse(_raw())
    by_id = {s.id: s for s in catalog.settings}
    assert "[change: true|false]" in help_catalog.setting_line(by_id["sponsorblock"])
    assert "link only" in help_catalog.setting_line(by_id["reset"])
    assert "from 0.25 to 16" in help_catalog.setting_line(by_id["hold-speed"])
    assert "|1.5|" in help_catalog.setting_line(by_id["playback-speed"])


def test_catalog_route_is_filtered_per_user(client, member_client):
    admin = client.get("/api/ai/help/catalog").json()
    member = member_client.get("/api/ai/help/catalog").json()
    assert "ai-models" in {s["id"] for s in admin["settings"]}
    assert "ai-models" not in {s["id"] for s in member["settings"]}
    assert {"id", "label", "path", "about"} <= set(admin["pages"][0])


# --- the model -------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "tier"),
    [
        ("llama3.2:3b", "small"),
        ("llama3.2:1b", "small"),
        ("qwen2.5:14b", "medium"),
        ("meta-llama/llama-3.3-70b-instruct", "large"),
        ("qwen/qwen3-235b-a22b", "large"),
        ("google/gemini-2.5-flash-lite", "medium"),
        ("google/gemini-2.5-flash", "large"),
        ("openai/gpt-4.1-nano", "small"),
        ("openai/gpt-4.1-mini", "medium"),
        ("anthropic/claude-sonnet-4.5", "large"),
        ("something-unknown", "medium"),
        ("tinyllama", "small"),
        ("smollm2", "small"),
        ("deepseek-r1", "medium"),  # Ollama's default tag is 7B
        ("deepseek/deepseek-v4-flash", "large"),
    ],
)
def test_model_tier_from_the_name(model, tier):
    assert help_model.tier(model) == tier


@pytest.mark.parametrize(
    ("url", "local"),
    [
        ("http://localhost:11434/v1", True),
        ("http://127.0.0.1:11434/v1", True),
        ("http://192.168.1.20:11434/v1", True),
        ("http://ollama:11434/v1", True),
        ("http://gpu-box.lan:1234/v1", True),
        ("https://openrouter.ai/api/v1", False),
        ("https://api.openai.com/v1", False),
        ("http://8.8.8.8/v1", False),
    ],
)
def test_local_providers_are_recognized(url, local):
    assert help_model.is_local(Connection(url)) is local


@pytest.mark.parametrize(
    ("model", "local"),
    [
        ("llama3.2:3b", True),
        ("wordcloud:7b", True),
        ("gpt-oss:120b-cloud", False),
        ("glm-4.6:cloud", False),
    ],
)
def test_ollama_cloud_models_do_not_stay_local(model, local):
    conn = Connection("http://localhost:11434/v1")
    assert help_model.stays_local(conn, model) is local
    label = help_model.provider_label(conn, is_admin=False, model=model)
    assert ("cloud" in label) is not local


def test_members_never_see_the_provider_address():
    conn = Connection("https://llm.example.com/v1")
    assert (
        help_model.provider_label(conn, is_admin=True)
        == "llm.example.com, an outside AI service"
    )
    assert help_model.provider_label(conn, is_admin=False) == "an outside AI service"


def test_small_models_are_told_to_recommend_better_for_css(monkeypatch):
    monkeypatch.setattr(
        help_model,
        "chat_connection",
        lambda: Connection("https://openrouter.ai/api/v1"),
    )
    note = help_model.prompt_note("llama3.2:3b", is_admin=True)
    assert "small model" in note and "google/gemini-2.5-flash" in note
    assert "[[setting:ai-models]]" in note
    member = help_model.prompt_note("llama3.2:3b", is_admin=False)
    assert "llama" not in member and "[[setting:" not in member
    assert "Small models" not in help_model.prompt_note("x-large", is_admin=True)


def test_the_assistant_model_wins_over_the_chat_model(app, monkeypatch):
    from app.services.ai import workload

    monkeypatch.setattr(workload, "ensure_quality_chat_model", lambda: "chat-m")
    assert help_model.assistant_model() == "chat-m"
    app_settings.save({"ai": {"help_model": "  strong-m "}})
    assert help_model.assistant_model() == "strong-m"


def test_info_route_hides_the_model_from_members(client, member_client, monkeypatch):
    from app.services.ai import workload

    def no_side_effects():
        raise AssertionError("a GET must not save settings or pull models")

    monkeypatch.setattr(workload, "ensure_quality_chat_model", no_side_effects)
    monkeypatch.setattr(help_model, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(
        help_model,
        "chat_connection",
        lambda: Connection("https://openrouter.ai/api/v1"),
    )
    app_settings.save({"ai": {"chat_model": "x", "help_model": "openai/gpt-4.1-mini"}})
    admin = client.get("/api/ai/help/info").json()
    member = member_client.get("/api/ai/help/info").json()
    assert admin["model"] == "openai/gpt-4.1-mini" and admin["tier"] == "medium"
    assert member["model"] is None and member["tier"] == "medium"
    assert member["local"] is False and "OpenRouter" in member["provider_label"]
    assert admin["available"] is True


# --- the user's data -------------------------------------------------------


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("Why did my download fail?", {"downloads"}),
        ("find that cooking video in my library", {"search", "library"}),
        ("what have I watched recently", {"history"}),
        ("what did I watch this week?", {"history"}),
        ("what should I watch tonight?", {"suggest"}),
        ("how many channels are in my library", {"library"}),
        ("make me a playlist of space videos", {"playlists", "search"}),
        (
            "Make a playlist of my unwatched recent downloads",
            {"playlists", "downloads", "suggest"},
        ),
        ("what's going on with my stuff", set()),
    ],
)
def test_topics_follow_the_question(question, expected):
    assert help_data.topics(question) == expected


@pytest.mark.parametrize(
    "question",
    [
        "How do I change the theme?",
        "How do I change my password?",
        "How do I set up my AI provider?",
        "Where do I find the AI settings?",
        "How many accounts can I have?",
        "Should I use Ollama or OpenRouter?",
        "How does Recommended+ pick videos?",
        "How do I download a playlist?",
        "find that cooking video",
    ],
)
def test_how_to_questions_need_no_data(question):
    assert help_data.topics(question) == set()


def test_follow_ups_keep_the_topic_and_the_page_counts():
    assert help_data.topics("and mine?", previous="any failed downloads?") == {
        "downloads"
    }
    assert help_data.topics("what is my status", page="Download page (/download)") >= {
        "downloads"
    }


def test_search_terms_drop_the_question_words():
    assert help_data.search_terms("Find that cooking video I watched last month") == (
        "cooking"
    )
    assert help_data.search_terms("find the video") == ""
    assert help_data.search_terms("make me a playlist of space videos") == "space"


@pytest.fixture
def library_data(session: Session, add_video, admin_user, member_user):
    soup = add_video(title="Tomato soup in ten minutes", channel="Kitchen")
    rocket = add_video(title="Rocket engines explained", channel="Space")
    other = add_video(title="Private watching", channel="Space")
    now = utcnow()
    session.add(
        UserVideoState(
            user_id=member_user.id,
            video_id=soup.id,
            last_watched_at=now,
            finished_at=now,
        )
    )
    session.add(
        UserVideoState(user_id=admin_user.id, video_id=other.id, last_watched_at=now)
    )
    failed = DownloadJob(
        url="https://youtu.be/x",
        title="Broken one",
        status=JobStatus.error,
        error="Sign in to confirm you're not a bot",
        error_kind="bot_check",
    )
    secret = DownloadJob(
        url="https://youtu.be/y",
        title="Admin's device copy",
        status=JobStatus.error,
        error="x",
        destination="device",
    )
    session.add(failed)
    session.add(secret)
    session.add(
        Playlist(
            name="Cooking",
            owner_user_id=member_user.id,
            visibility=PlaylistVisibility.private,
        )
    )
    session.add(
        Playlist(
            name="Admin only",
            owner_user_id=admin_user.id,
            visibility=PlaylistVisibility.private,
        )
    )
    session.commit()
    admin_row = session.get(User, admin_user.id)
    assert admin_row is not None
    admin_row.share_downloads = False
    session.add(admin_row)
    session.add(DownloadRequester(job_id=secret.id, user_id=admin_user.id))
    session.commit()
    playlist = session.exec(select(Playlist).where(Playlist.name == "Cooking")).one()
    session.add(PlaylistItem(playlist_id=playlist.id, video_id=soup.id))
    session.commit()
    return {"soup": soup, "rocket": rocket, "member": AuthUser.of(member_user)}


def test_gather_reads_only_what_the_user_may_see(session, library_data):
    member = library_data["member"]
    text = help_data.gather(session, member, "what did I watch, and my downloads?")
    assert "Library:" not in text  # only what was asked
    assert f'#{library_data["soup"].id} "Tomato soup in ten minutes"' in text
    assert "finished" in text
    assert "Private watching" not in text  # the administrator's history
    assert "FAILED" in text and "bot_check" in text and "not a bot" in text
    assert "Admin's device copy" not in text  # a private device download

    lists = help_data.gather(session, member, "show my playlists")
    assert '"Cooking", 1 videos, yours, private' in lists
    soup = library_data["soup"].id
    assert f'#{soup} "Tomato soup in ten minutes"' in lists  # what is in it
    assert "Admin only" not in lists


def test_gather_searches_the_library(session, library_data, monkeypatch):
    from app.services.ai import embeddings

    monkeypatch.setattr(embeddings, "get_embed_provider", lambda: None)
    text = help_data.gather(
        session, library_data["member"], "find the rocket video in my library"
    )
    assert 'matching "rocket"' in text and "Rocket engines explained" in text
    assert "not watched" in text
    assert "Tomato" not in text


def test_how_to_questions_send_no_data(session, library_data):
    assert (
        help_data.gather(session, library_data["member"], "How do I add a theme?") == ""
    )


def test_recent_failures_only(session, library_data):
    old = DownloadJob(
        url="https://youtu.be/z",
        title="Ancient failure",
        status=JobStatus.error,
        created_at=utcnow() - timedelta(days=40),
    )
    session.add(old)
    session.commit()
    text = help_data.gather(session, library_data["member"], "my failed downloads")
    assert "Ancient failure" not in text


def test_a_missing_assistant_model_is_downloaded(app, monkeypatch):
    """The model asked for is pulled, not only the configured chat model."""
    from types import SimpleNamespace

    from app.services.ai import provider

    class Admin:
        base_url = "http://ollama:11434"

        def has_model(self, model: str) -> bool:
            return False

    pulled: list[str] = []
    monkeypatch.setattr(provider, "ollama_admin", lambda conn: Admin())
    monkeypatch.setattr(provider, "ensure_models", lambda: (True, True))
    monkeypatch.setattr(provider, "_start_pull", lambda admin, m: pulled.append(m))
    target = SimpleNamespace(connection=Connection("http://ollama:11434/v1"))
    message = provider.require_llm_chat_model(target, "help-only-model:14b")  # type: ignore[arg-type]  # a stand-in provider
    assert message is not None and "download started" in message
    assert pulled == ["help-only-model:14b"]
