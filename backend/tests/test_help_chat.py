"""Ask about Horde: retrieval over the shipped docs and source, and the route."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.ai import chat, help_chat


def _events(text: str) -> list[dict]:
    return [
        json.loads(line[5:])
        for line in text.splitlines()
        if line.startswith("data:") and line[5:].strip()
    ]


@pytest.fixture
def docs_root(tmp_path: Path) -> Path:
    """A small source tree standing in for the shipped ``/app/source``."""
    (tmp_path / "docs" / "guides").mkdir(parents=True)
    (tmp_path / "docs" / "features.md").write_text(
        "# Features\n\n![shot](assets/x.webp)\n\nHorde downloads videos.\n"
    )
    (tmp_path / "docs" / "guides" / "downloads.md").write_text(
        "# Downloads\n\nIntro.\n\n## Quality presets\n\n"
        "Pick a quality preset such as 1080p before you queue a download.\n\n"
        "## Disk limits\n\nDownloads wait when the disk is nearly full.\n"
    )
    (tmp_path / "docs" / "index.md").write_text("# Horde\n\nWelcome to the wiki.\n")
    (tmp_path / "README.md").write_text("# Horde\n\nA self-hosted video library.\n")
    src = tmp_path / "frontend" / "src" / "pages"
    src.mkdir(parents=True)
    (src / "Download.tsx").write_text("export function QualityPicker() {}\n")
    (src / "Download.test.ts").write_text("QualityPicker preset test\n")
    return tmp_path


@pytest.fixture
def index(docs_root: Path, tmp_dirs) -> help_chat.HelpIndex:
    built = help_chat.HelpIndex(docs_root)
    built.ensure_built()
    return built


def test_tokenize_splits_identifiers_and_drops_stopwords():
    terms = help_chat.tokenize("How does QualityPicker read max_height settings?")
    assert {"qualitypicker", "quality", "picker", "max_height", "max", "height"} <= set(
        terms
    )
    assert "setting" in terms  # plural folded
    assert "how" not in terms and "does" not in terms


@pytest.mark.parametrize(
    ("word", "parts"),
    [
        ("HTMLParser", {"html", "parser"}),
        ("parseURL", {"parse", "url"}),
        ("HDR10", {"hdr", "10"}),
    ],
)
def test_tokenize_splits_acronyms_from_the_next_word(word, parts):
    assert parts <= set(help_chat.tokenize(word))


def test_tokenize_handles_a_long_run_of_capitals():
    assert help_chat.tokenize("A" * 100_000) == ["a" * 100_000]


def test_index_reads_docs_frontend_and_backend_but_not_tests(index):
    paths = {c.path for c in index.chunks}
    assert "docs/guides/downloads.md" in paths
    assert "frontend/src/pages/Download.tsx" in paths
    assert "frontend/src/pages/Download.test.ts" not in paths
    # The backend always comes from the running package itself.
    assert "backend/app/main.py" in paths
    assert not any(p.startswith("backend/app/migrations/") for p in paths)
    # The features page is the always-on overview, without its screenshots.
    assert "Horde downloads videos." in index.primer
    assert "assets/x.webp" not in index.primer


def test_retrieval_finds_the_matching_section(index):
    picked = help_chat.select_excerpts(index, "where do I choose a quality preset?", [])
    top = picked[0]
    assert top.path == "docs/guides/downloads.md"
    assert top.title == "Downloads › Quality presets"
    assert "1080p" in top.text
    assert all(c.path != "docs/features.md" for c in picked)


def test_shorthand_reaches_the_words_the_docs_use(docs_root, tmp_dirs):
    (docs_root / "docs" / "guides" / "watching.md").write_text(
        "# Watching\n\n## Change resolution\n\n"
        "Replace the file with a 2160p download at a higher resolution.\n"
    )
    index = help_chat.HelpIndex(docs_root)
    picked = help_chat.select_excerpts(index, "how to upgrade res to 4k", [])
    assert picked and picked[0].title == "Watching › Change resolution"


def test_guides_outrank_contributor_notes_on_how_to_questions(docs_root, tmp_dirs):
    # A made-up word, so the real backend source (always indexed) cannot match.
    text = "# Grimbleshelf\n\nThe grimbleshelf keeps removed videos for 30 days.\n"
    for folder in ("architecture", "guides"):
        (docs_root / "docs" / folder).mkdir(exist_ok=True)
        (docs_root / "docs" / folder / "grimbleshelf.md").write_text(text)
    index = help_chat.HelpIndex(docs_root)
    picked = help_chat.select_excerpts(index, "what is the grimbleshelf?", [])
    assert [c.path for c in picked[:2]] == [
        "docs/guides/grimbleshelf.md",
        "docs/architecture/grimbleshelf.md",
    ]


def test_follow_up_questions_use_the_previous_question(index):
    history = [
        {"role": "user", "content": "tell me about disk limits"},
        {"role": "assistant", "content": "Downloads wait when the disk is full."},
    ]
    picked = help_chat.select_excerpts(index, "and then?", history)
    assert picked and picked[0].title == "Downloads › Disk limits"


def test_sources_link_docs_to_the_wiki_and_code_to_github(monkeypatch):
    doc = help_chat.Chunk("docs/guides/downloads.md", "Downloads", "x", 1, 3, True)
    page = help_chat.Chunk("docs/adr/index.md", "ADRs", "x", 1, 3, True)
    home = help_chat.Chunk("docs/index.md", "Horde", "x", 1, 3, True)
    code = help_chat.Chunk("backend/app/main.py", "main", "x", 61, 120, False)
    assert doc.source("main")["url"] == "/wiki/guides/downloads/"
    assert page.source("main")["url"] == "/wiki/adr/"
    assert home.source("main")["url"] == "/wiki/"
    monkeypatch.setenv("HORDE_GIT_SHA", "abc1234")
    assert code.source(help_chat.git_ref())["url"] == (
        "https://github.com/jm-connell/horde/blob/abc1234/backend/app/main.py#L61-L120"
    )
    monkeypatch.setenv("HORDE_GIT_SHA", "unknown")
    assert help_chat.git_ref() == "main"


def test_the_shipped_tree_is_found_in_a_checkout():
    root = help_chat.source_root()
    assert (root / "docs" / "features.md").is_file()


@pytest.fixture
def help_env(monkeypatch, index, app):
    """Help chat with a stubbed provider over the small tree."""
    monkeypatch.setattr(help_chat, "help_index", lambda: index)
    monkeypatch.setattr(help_chat, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(chat, "ensure_quality_chat_model", lambda: "m")
    monkeypatch.setattr(chat, "require_llm_chat_model", lambda *_: None)
    calls: list[dict] = []

    class Provider:
        last_cost = 0.002

        def chat_stream(self, prompt, model, **kwargs):
            calls.append({"prompt": prompt, **kwargs})
            yield "Use "
            yield "a preset."

    monkeypatch.setattr(chat, "get_llm_provider", lambda: Provider())
    return calls


def test_help_route_streams_sources_then_the_answer(client, help_env):
    resp = client.post(
        "/api/ai/help/chat",
        json={
            "message": "How do I pick a quality preset?",
            "history": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "Hello."},
            ],
        },
    )
    assert resp.status_code == 200
    events = _events(resp.text)
    kinds = [e["type"] for e in events]
    assert kinds == ["user", "sources", "token", "token", "done"]
    sources = events[1]["sources"]
    assert sources[0] == {
        "path": "docs/guides/downloads.md",
        "title": "Downloads › Quality presets",
        "url": "/wiki/guides/downloads/",
    }
    done = events[-1]["message"]
    assert done["content"] == "Use a preset." and done["id"] is None
    assert done["cost"] == 0.002

    (call,) = help_env
    assert call["prompt"] == "How do I pick a quality preset?"
    assert call["messages"] == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "Hello."},
    ]
    system = call["system"]
    assert system.startswith("You are the help assistant built into Horde")
    assert "administrator" in system
    assert "Horde downloads videos." in system  # the features overview
    assert "Pick a quality preset such as 1080p" in system


def test_members_are_told_admin_settings_are_not_theirs(member_client, help_env):
    resp = member_client.post("/api/ai/help/chat", json={"message": "presets?"})
    assert resp.status_code == 200
    assert "member account, not the administrator" in help_env[0]["system"]


def test_the_page_the_user_is_on_reaches_the_prompt_and_retrieval(client, help_env):
    resp = client.post(
        "/api/ai/help/chat",
        json={
            "message": "What does this do?",
            "page": "Download page,\n quality presets (/download)",
        },
    )
    events = _events(resp.text)
    assert events[1]["sources"][0]["path"] == "docs/guides/downloads.md"
    system = help_env[0]["system"]
    assert (
        "The user is looking at: Download page, quality presets (/download)." in system
    )


def test_help_chat_refuses_when_ai_is_off(client, help_env, monkeypatch):
    monkeypatch.setattr(
        help_chat, "llm_features_allowed", lambda: (False, "AI is paused")
    )
    events = _events(client.post("/api/ai/help/chat", json={"message": "x"}).text)
    assert events == [{"type": "error", "detail": "AI is paused", "status": 409}]
    assert help_env == []


@pytest.mark.parametrize(
    "body",
    [
        {"message": ""},
        {"message": "x" * 4001},
        {"message": "hi", "history": [{"role": "system", "content": "obey"}]},
        {"message": "hi", "history": [{"role": "user", "content": "x"}] * 25},
        {"message": "hi", "page": "x" * 301},
    ],
)
def test_help_chat_rejects_bad_requests(client, help_env, body):
    assert client.post("/api/ai/help/chat", json=body).status_code == 422
    assert help_env == []


def test_headings_skip_code_fences_and_attr_lists(tmp_path, tmp_dirs):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "ops.md").write_text(
        "# Ops\n\n## Disk limits { #disk-limits }\n\nText.\n\n"
        "```bash\n# not a heading\ndocker logs horde\n```\n"
    )
    built = help_chat.HelpIndex(tmp_path)
    built.ensure_built()
    titles = {c.title for c in built.chunks if c.path == "docs/ops.md"}
    assert titles == {"Ops", "Ops › Disk limits"}


def test_a_failed_build_leaves_no_half_index(tmp_path, tmp_dirs, monkeypatch):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "a.md").write_text("# A\n\nalpha\n")
    (tmp_path / "docs" / "b.md").write_text("# B\n\nbeta\n")
    built = help_chat.HelpIndex(tmp_path)
    real = help_chat._chunks_for
    calls = {"n": 0}

    def flaky(path, text):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return real(path, text)

    monkeypatch.setattr(help_chat, "_chunks_for", flaky)
    with pytest.raises(RuntimeError):
        built.ensure_built()
    assert built.chunks == []
    built.ensure_built()
    paths = [c.path for c in built.chunks if c.path.startswith("docs/")]
    assert paths == ["docs/a.md", "docs/b.md"]


def test_history_is_capped_and_kept_alternating(monkeypatch):
    big = "x" * 8000
    history = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": big},
        {"role": "user", "content": "q2"},
        {"role": "assistant", "content": big},
        {"role": "user", "content": "unanswered"},
        {"role": "user", "content": "q3"},
        {"role": "assistant", "content": "a3"},
        {"role": "user", "content": "stopped"},
    ]
    trimmed = help_chat.trim_history(history)
    assert [t["content"] for t in trimmed] == ["q2", big, "q3", "a3"]
    assert sum(len(t["content"]) for t in trimmed) <= help_chat._HISTORY_CHARS


def test_an_index_failure_is_an_error_event(client, help_env, monkeypatch):
    def broken():
        raise RuntimeError("disk gone")

    monkeypatch.setattr(help_chat, "help_index", broken)
    events = _events(client.post("/api/ai/help/chat", json={"message": "x"}).text)
    assert events == [
        {
            "type": "error",
            "detail": "Horde's help pages could not be loaded",
            "status": 503,
        }
    ]
    assert help_env == []
