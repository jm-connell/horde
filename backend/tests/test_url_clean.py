"""Tests for URL normalization."""

from app.services.url_clean import clean_url, is_playlist_url, youtube_video_id


def test_youtu_be_to_watch():
    assert clean_url("https://youtu.be/dQw4w9WgXcQ") == (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )


def test_shorts_and_embed():
    assert clean_url("https://www.youtube.com/shorts/dQw4w9WgXcQ") == (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )
    assert clean_url("https://www.youtube.com/embed/dQw4w9WgXcQ") == (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )


def test_strips_tracking_params():
    url = (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&feature=share"
        "&utm_source=twitter"
    )
    assert clean_url(url) == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def test_keep_playlist():
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest&si=x"
    assert clean_url(url, keep_playlist=True) == (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest"
    )
    assert clean_url(url, keep_playlist=False) == (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )


def test_playlist_only_url():
    url = "https://www.youtube.com/playlist?list=PLtest&si=noise"
    assert clean_url(url, keep_playlist=True) == (
        "https://www.youtube.com/playlist?list=PLtest"
    )


def test_youtube_video_id():
    assert youtube_video_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert youtube_video_id("https://vimeo.com/123") is None


def test_is_playlist_url():
    assert is_playlist_url("https://www.youtube.com/watch?v=x&list=PLtest")
    assert not is_playlist_url("https://www.youtube.com/watch?v=x")
    assert not is_playlist_url("https://example.com/?list=x")


def test_empty_and_schemeless_unchanged():
    assert clean_url("") == ""
    assert clean_url("   ") == ""
    assert clean_url("not-a-url") == "not-a-url"
