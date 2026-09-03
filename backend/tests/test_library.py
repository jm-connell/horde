"""Library query helpers: filter, sort, continue-watching, tags, channels."""

from datetime import datetime, timedelta, timezone

from app.services import library


def _ago(days: int = 0, hours: int = 0) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days, hours=hours)


def test_query_excludes_review_when_flagged(session, add_video):
    ready = add_video(title="Ready", needs_review=False)
    add_video(
        title="Pending",
        needs_review=True,
        channel=None,
        file_path="imports/pending.mp4",
    )
    rows = library.query_videos(session, needs_review=False)
    ids = {v.id for v in rows}
    assert ready.id in ids
    assert all(not v.needs_review for v in rows)


def test_query_review_only(session, add_video):
    add_video(title="Ready", needs_review=False)
    pending = add_video(
        title="Pending",
        needs_review=True,
        channel=None,
        file_path="imports/pending.mp4",
    )
    rows = library.query_videos(session, needs_review=True)
    assert [v.id for v in rows] == [pending.id]


def test_query_channel_and_tag_and_text(session, add_video):
    match = add_video(
        title="Cat compilation",
        channel="Pets",
        tags=["cats", "funny"],
        description="wholesome",
    )
    add_video(title="Dog vlog", channel="Pets", tags=["dogs"])
    add_video(title="Unrelated", channel="Other", tags=["cats"])

    by_channel = library.query_videos(session, channel="Pets", needs_review=False)
    assert {v.title for v in by_channel} == {"Cat compilation", "Dog vlog"}

    by_tag = library.query_videos(session, tag="cats", needs_review=False)
    assert {v.title for v in by_tag} == {"Cat compilation", "Unrelated"}

    by_q = library.query_videos(session, q="wholesome", needs_review=False)
    assert [v.id for v in by_q] == [match.id]


def test_query_token_and_matches_split_title_terms(session, add_video):
    hit = add_video(title="I painted his House to Fix his WiFi", channel="LTT")
    add_video(title="I painted a mural", channel="LTT")
    add_video(title="How to fix a router", channel="LTT")
    rows = library.query_videos(session, q="paint fix", needs_review=False)
    assert [v.id for v in rows] == [hit.id]


def test_query_whole_word_not_substring(session, add_video):
    car = add_video(title="I bought a cheap used car", channel="LTT")
    add_video(title="The RTX 4090 graphics card", channel="LTT")
    add_video(
        title="Upgrade your home WiFi",
        channel="LTT",
        description="Switch carriers and save on your phone plan.",
    )
    rows = library.query_videos(session, q="car", needs_review=False)
    assert [v.id for v in rows] == [car.id]


def test_query_sort_title_and_file_size(session, add_video):
    add_video(title="B", file_size=10)
    add_video(title="A", file_size=30)
    add_video(title="C", file_size=20)

    titles = [
        v.title
        for v in library.query_videos(
            session, sort="title", order="asc", needs_review=False
        )
    ]
    assert titles == ["A", "B", "C"]

    sizes = [
        v.file_size
        for v in library.query_videos(
            session, sort="file_size", order="desc", needs_review=False
        )
    ]
    assert sizes == [30, 20, 10]


def test_continue_watching_skips_short_and_finished(session, add_video):
    now = datetime.now(timezone.utc)
    in_row = add_video(
        title="Midway",
        duration_sec=100.0,
        last_position_sec=40.0,
        last_watched_at=now,
    )
    add_video(
        title="Just opened",
        duration_sec=100.0,
        last_position_sec=10.0,
        last_watched_at=now,
    )
    add_video(
        title="Finished",
        duration_sec=100.0,
        last_position_sec=95.0,
        last_watched_at=now,
    )
    add_video(
        title="Stale",
        duration_sec=100.0,
        last_position_sec=40.0,
        last_watched_at=_ago(days=30),
    )
    rows = library.query_videos(session, continue_watching=True)
    assert [v.id for v in rows] == [in_row.id]


def test_expire_stale_progress(session, add_video):
    stale = add_video(
        title="Old",
        last_position_sec=50.0,
        last_watched_at=_ago(days=30),
    )
    fresh = add_video(
        title="New",
        last_position_sec=50.0,
        last_watched_at=datetime.now(timezone.utc),
    )
    library.expire_stale_progress(session)
    session.refresh(stale)
    session.refresh(fresh)
    assert stale.last_position_sec == 0.0
    assert fresh.last_position_sec == 50.0


def test_channel_stats_skips_review_and_sorts(session, add_video):
    older = _ago(days=2)
    newer = _ago(hours=1)
    add_video(title="A1", channel="Alpha", added_at=older)
    add_video(title="A2", channel="Alpha", added_at=newer)
    add_video(title="B1", channel="Beta", added_at=older)
    add_video(
        title="Review junk",
        channel="Alpha",
        needs_review=True,
        added_at=datetime.now(timezone.utc),
        file_path="imports/junk.mp4",
    )
    rows = library.channel_stats(session, sort="video_count", order="desc")
    by_name = {r.channel: r for r in rows}
    assert by_name["Alpha"].count == 2
    assert by_name["Beta"].count == 1
    alpha_first = library.channel_stats(session, sort="recent_download", order="desc")
    assert alpha_first[0].channel == "Alpha"


def test_find_video_by_youtube_id_path_and_url(session, add_video):
    by_path = add_video(title="Path", yt_id="dQw4w9WgXcQ")
    by_url = add_video(
        title="URL only",
        file_path="Other/2024/NoId.mp4",
        source_url="https://www.youtube.com/watch?v=xxxxxxxxxxx",
    )
    assert library.find_video_by_youtube_id(session, "dQw4w9WgXcQ").id == by_path.id
    assert library.find_video_by_youtube_id(session, "xxxxxxxxxxx").id == by_url.id
    assert library.find_video_by_youtube_id(session, "no-such-id") is None


def test_all_tags_and_parse_dump(session, add_video):
    add_video(title="One", tags=["Alpha", "beta"])
    add_video(title="Two", tags=["beta", "gamma"])
    assert library.all_tags(session) == ["Alpha", "beta", "gamma"]
    assert library.parse_tags("not json") == []
    assert library.dump_tags(["  x ", "", "y"]) == '["x", "y"]'


def test_rename_channel(session, add_video):
    add_video(title="A", channel="Old")
    add_video(title="B", channel="Old")
    add_video(title="C", channel="Keep")
    assert library.rename_channel(session, "Old", "New") == 2
    names = {
        v.channel
        for v in library.query_videos(session, needs_review=False)
    }
    assert names == {"New", "Keep"}
