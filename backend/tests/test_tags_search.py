"""Tag index, FTS5 keyword search and the indexed YouTube id."""

from __future__ import annotations

import json

from sqlalchemy import text

from app.models import Video, VideoAiMeta
from app.services import library


def test_tag_filter_is_case_insensitive_and_exact(session, add_video):
    cat = add_video(title="One", tags=["Cats", "funny"])
    add_video(title="Two", tags=["category"])
    add_video(title="Three", tags=["cat"])
    ids = {v.id for v in library.query_videos(session, tag="cats")}
    assert ids == {cat.id}


def test_tag_filter_treats_wildcards_literally(session, add_video):
    plain = add_video(title="Plain", tags=["100pct"])
    literal = add_video(title="Literal", tags=["100%", "snake_case"])
    assert [v.id for v in library.query_videos(session, tag="100%")] == [literal.id]
    assert [v.id for v in library.query_videos(session, tag="snake_case")] == [
        literal.id
    ]
    assert library.query_videos(session, tag="%") == []
    assert library.query_videos(session, tag="snake_cas_") == []
    assert plain.id not in {v.id for v in library.query_videos(session, tag="1%")}


def test_tag_stats_and_all_tags_come_from_the_index(session, add_video):
    add_video(title="A", channel="X", tags=["Alpha", "beta"])
    add_video(title="B", channel="X", tags=["beta"])
    add_video(title="C", channel="Y", tags=["beta", "gamma"])
    add_video(title="Review", channel="Y", tags=["hidden"], needs_review=True)
    assert library.tag_stats(session) == [("beta", 3), ("Alpha", 1), ("gamma", 1)]
    assert library.tag_stats(session, channel="X") == [("beta", 2), ("Alpha", 1)]
    assert library.all_tags(session) == ["Alpha", "beta", "gamma", "hidden"]


def test_editing_tags_updates_the_filter(session, add_video):
    video = add_video(title="Edit me", tags=["old"])
    video.tags = json.dumps(["new"])
    session.add(video)
    session.commit()
    assert library.query_videos(session, tag="old") == []
    assert [v.id for v in library.query_videos(session, tag="new")] == [video.id]


def test_tag_provenance_is_recorded(session, add_video):
    video = add_video(title="Mixed", tags=["from-platform", "from-ai", "from-me"])
    session.add(
        VideoAiMeta(
            video_id=video.id,
            ai_tags=json.dumps(["from-ai"]),
            user_tags=json.dumps(["from-me"]),
        )
    )
    session.commit()
    rows = session.connection().execute(
        text("SELECT tag, source FROM video_tags ORDER BY tag")
    )
    assert rows.fetchall() == [
        ("from-ai", "ai"),
        ("from-me", "user"),
        ("from-platform", "source"),
    ]


def test_keyword_search_uses_fts_for_every_field(session, add_video):
    video = add_video(
        title="Quiet harbour",
        channel="Northwind",
        description="Dawn over the water",
        notes="Remember the lighthouse",
        tags=["seascape"],
    )
    add_video(title="Unrelated")
    assert library.has_fts(session)
    for word in ("harbour", "northwind", "dawn", "lighthouse", "seascape"):
        assert [v.id for v in library.query_videos(session, q=word)] == [video.id]
    # AND across tokens, and across fields.
    assert [v.id for v in library.query_videos(session, q="harbour dawn")] == [video.id]
    assert library.query_videos(session, q="harbour mountain") == []
    # Inflections still match; substrings do not.
    assert [v.id for v in library.query_videos(session, q="harbours")] == [video.id]
    assert library.query_videos(session, q="harb") == []


def test_keyword_search_follows_edits_and_deletes(session, add_video):
    video = add_video(title="Before")
    video.title = "After"
    session.add(video)
    session.commit()
    assert library.query_videos(session, q="before") == []
    assert [v.id for v in library.query_videos(session, q="after")] == [video.id]
    session.delete(video)
    session.commit()
    assert library.query_videos(session, q="after") == []


def test_search_input_is_never_parsed_as_fts_syntax(session, add_video):
    video = add_video(title='He said "hello" and left', description="a:b NEAR c")
    for hostile in ('"', '"hello', "hello*", "NOT hello", "title:hello", "(", "hello)"):
        library.query_videos(session, q=hostile)  # must not raise
    assert [v.id for v in library.query_videos(session, q='"hello"')] == [video.id]
    assert [v.id for v in library.query_videos(session, q="NEAR")] == [video.id]


def test_search_wildcards_are_literal(session, add_video):
    percent = add_video(title="Sale 100% off")
    add_video(title="Sale 1000 off")
    assert [v.id for v in library.query_videos(session, q="100%")] == [percent.id]
    underscore = add_video(title="my_file")
    add_video(title="myxfile")
    assert [v.id for v in library.query_videos(session, q="my_file")] == [underscore.id]
    # No word characters at all: literal scan, % is not "match anything".
    assert library.query_videos(session, q="%") == []
    pct = add_video(title="100 % sure")
    assert [v.id for v in library.query_videos(session, q="%")] == [pct.id]


def test_search_falls_back_without_fts(session, add_video):
    video = add_video(title="Quiet harbour", tags=["seascape"])
    add_video(title="Other")
    conn = session.connection()
    for trigger in ("insert", "update", "delete"):
        conn.execute(text(f"DROP TRIGGER trg_videos_fts_{trigger}"))
    conn.execute(text("DROP TABLE videos_fts"))
    assert not library.has_fts(session)
    assert [v.id for v in library.query_videos(session, q="harbour")] == [video.id]
    assert [v.id for v in library.query_videos(session, q="seascape")] == [video.id]
    assert library.query_videos(session, q="harb") == []


def test_youtube_id_is_derived_and_indexed(session, add_video):
    by_path = add_video(title="Path", yt_id="dQw4w9WgXcQ")
    by_url = add_video(
        title="URL",
        file_path="Other/NoId.mp4",
        source_url="https://youtu.be/xxxxxxxxxxx?si=abc",
    )
    add_video(
        title="Elsewhere",
        file_path="Other/Else.mp4",
        source_url="https://example.com/watch?v=yyyyyyyyyyy",
    )
    assert by_path.youtube_id == "dQw4w9WgXcQ"
    assert by_url.youtube_id == "xxxxxxxxxxx"
    assert library.find_video_by_youtube_id(session, "xxxxxxxxxxx").id == by_url.id
    assert library.find_video_by_youtube_id(session, "yyyyyyyyyyy") is None
    assert library.find_video_by_youtube_id(session, "") is None

    plan = session.connection().exec_driver_sql(
        "EXPLAIN QUERY PLAN SELECT * FROM videos WHERE youtube_id = 'x'"
    )
    assert any("ix_videos_youtube_id" in row[3] for row in plan.fetchall())

    # Re-pointing the source changes the id.
    by_url.source_url = "https://www.youtube.com/watch?v=zzzzzzzzzzz"
    session.add(by_url)
    session.commit()
    assert library.find_video_by_youtube_id(session, "xxxxxxxxxxx") is None
    assert library.find_video_by_youtube_id(session, "zzzzzzzzzzz").id == by_url.id
    assert library.youtube_library_map(session)["zzzzzzzzzzz"][0] == by_url.id


def test_related_videos_rank_by_shared_tags(session, add_video):
    source = add_video(title="Source", channel="Solo", tags=["a", "b", "c"])
    two = add_video(title="Two shared", channel="Else", tags=["A", "b"])
    one = add_video(title="One shared", channel="Else", tags=["c"])
    add_video(title="None shared", channel="Else", tags=["z"])
    hidden = add_video(title="Hidden", channel="Else", tags=["a", "b", "c"])
    hidden.needs_review = True
    session.add(hidden)
    session.commit()
    picked = library.related_videos(session, source.id, limit=2)
    assert [v.id for v in picked] == [two.id, one.id]


def test_video_model_keeps_youtube_id_without_session_helpers():
    video = Video(title="x", file_path="a/b [abcdefghijk].mp4")
    assert video.youtube_id is None  # filled by the flush listener, not __init__


def test_accented_and_non_latin_titles_are_searchable(session, add_video):
    cafe = add_video(title="Café Müller tour")
    naive = add_video(title="Naïve art")
    strasse = add_video(title="Straße walk")
    tokyo = add_video(title="東京 旅行 vlog")
    russian = add_video(title="Привет мир")
    add_video(title="Plain clip")

    def ids(q):
        return [v.id for v in library.query_videos(session, q=q)]

    # Typed with or without the accents: FTS5 folds diacritics like unicode61.
    for q in ("café", "cafe", "CAFÉ", "müller", "muller"):
        assert ids(q) == [cafe.id], q
    assert ids("naïve") == ids("naive") == [naive.id]
    # unicode61 keeps ß as a letter (it does not fold it to ss); the literal works.
    assert ids("straße") == [strasse.id]
    assert ids("東京") == [tokyo.id]
    assert ids("привет мир") == [russian.id]
    # Whole words only: a prefix of an accented word is not a match.
    assert ids("caf") == []
    assert ids("stra") == []


def test_ai_meta_updates_and_deletes_reclassify_the_tag_source(session, add_video):
    video = add_video(title="Provenance", tags=["alpha", "beta"])
    session.add(VideoAiMeta(video_id=video.id, ai_tags='["alpha"]', user_tags="[]"))
    session.commit()

    def sources():
        return dict(
            session.connection()
            .execute(text("SELECT tag, source FROM video_tags"))
            .fetchall()
        )

    assert sources() == {"alpha": "ai", "beta": "source"}
    session.connection().execute(
        text("UPDATE video_ai_meta SET user_tags = '[\"beta\"]', ai_tags = '[]'")
    )
    assert sources() == {"alpha": "source", "beta": "user"}
    session.connection().execute(text("DELETE FROM video_ai_meta"))
    assert sources() == {"alpha": "source", "beta": "source"}


def test_malformed_tags_json_at_runtime_yields_no_rows_and_does_not_raise(
    session, add_video
):
    video = add_video(title="Fragile", tags=["fine"])
    conn = session.connection()
    for bad in ("not json", '{"a": 1}', "[1, null, {}]", ""):
        conn.execute(
            text("UPDATE videos SET tags = :t WHERE id = :i"), {"t": bad, "i": video.id}
        )
        assert conn.execute(text("SELECT count(*) FROM video_tags")).scalar() == 0
    assert [v.id for v in library.query_videos(session, q="fragile")] == [video.id]
