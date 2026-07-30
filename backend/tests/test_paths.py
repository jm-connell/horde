"""Tests for path helpers used by import / rename."""

from pathlib import Path

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
