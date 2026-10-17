"""Tests for path helpers used by import / rename."""

from app.models import Video
from app.services.paths import (
    is_manual_import,
    manual_import_rel_path,
    safe_filename,
    unique_rel_path,
)


def test_safe_filename():
    assert safe_filename('a/b:c*d?"<>|e') == "a_b_c_d_____e"
    assert safe_filename("   ") == "video"
    assert safe_filename("ok title") == "ok title"


def test_safe_filename_strips_control_chars_and_trailing_dots_and_spaces():
    assert safe_filename("a\x00b\x1f\tc\n") == "abc"
    assert safe_filename("Title... ") == "Title"
    assert safe_filename("  lead and trail . ") == "lead and trail"
    assert safe_filename("name\u2028x") == "namex"


def test_safe_filename_rejects_dot_names_and_windows_reserved_names():
    for name in (".", "..", "...", " . "):
        assert safe_filename(name) == "video"
    assert safe_filename(".", default="Unknown") == "Unknown"
    for name in ("CON", "nul", "Aux", "PRN", "COM1", "lpt9", "COM\u00b2", "con.txt"):
        out = safe_filename(name)
        assert out.startswith("_"), (name, out)
    # Only the device names themselves are reserved.
    assert safe_filename("console") == "console"
    assert safe_filename("COM10") == "COM10"
    assert safe_filename("My CON video") == "My CON video"


def test_safe_filename_truncates_by_bytes_on_a_character_boundary():
    out = safe_filename("🎬" * 200, max_bytes=50)
    assert len(out.encode()) <= 50
    assert out == "🎬" * 12  # 12 x 4 bytes; no half character left behind
    out = safe_filename("é" * 300)
    assert len(out.encode()) <= 200
    out.encode("utf-8").decode("utf-8")  # valid UTF-8
    # Truncation can expose a trailing dot/space; it is stripped afterwards.
    assert safe_filename("a" * 9 + ". b", max_bytes=10) == "a" * 9


def test_manual_import_rel_path():
    assert manual_import_rel_path("Chan", "Title", "mp4") == "Chan/Title.mp4"
    assert manual_import_rel_path("Chan", "Title", ".mkv") == "Chan/Title.mkv"
    assert manual_import_rel_path(None, "Title", "webm") == "imports/Title.webm"
    assert manual_import_rel_path("  ", "Title", "mp4") == "imports/Title.mp4"


def test_is_manual_import():
    assert not is_manual_import(
        Video(title="x", file_path="a/b.mp4", source_url="https://youtu.be/x")
    )
    assert not is_manual_import(
        Video(title="x", file_path="Chan/2024/Title [dQw4w9WgXcQ].mp4")
    )
    assert is_manual_import(Video(title="x", file_path="imports/drop.mp4"))


def test_unique_rel_path_free_and_collision(tmp_dirs):
    downloads = tmp_dirs["downloads"]
    assert unique_rel_path("Chan/Title.mp4") == "Chan/Title.mp4"
    target = downloads / "Chan"
    target.mkdir()
    (target / "Title.mp4").write_bytes(b"x")
    assert unique_rel_path("Chan/Title.mp4") == "Chan/Title (2).mp4"


def test_unique_rel_path_exclude(tmp_dirs):
    downloads = tmp_dirs["downloads"]
    target = downloads / "Chan"
    target.mkdir()
    (target / "Title.mp4").write_bytes(b"x")
    assert unique_rel_path("Chan/Title.mp4", exclude="Chan/Title.mp4") == (
        "Chan/Title.mp4"
    )


def test_unique_rel_path_escape_raises(tmp_dirs):
    import pytest

    with pytest.raises(ValueError, match="escapes"):
        unique_rel_path("../outside.mp4")
