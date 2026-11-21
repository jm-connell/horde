"""Chapter parsing, yt-dlp normalize, timed VTT, skip gate, snap/validate."""

from pathlib import Path

from app.models import VideoAiMeta
from app.services import chapters as chapters_svc
from app.services import library


def _write_vtt(tmp_dirs, video, body: str, *, lang: str = "en"):
    rel = Path(video.file_path).with_suffix(f".{lang}.vtt")
    dest = tmp_dirs["downloads"] / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(body, encoding="utf-8")
    video.subtitles = library.dump_subtitles(
        [{"lang": lang, "path": rel.as_posix(), "auto": False}]
    )
    return video


def test_parse_chapters_matches_frontend_cases():
    desc = "Intro\n0:00 Start\n1:00 Middle\n2:30 End\n"
    parsed = chapters_svc.parse_chapters(desc)
    assert len(parsed) == 3
    assert parsed[0] == {"start_sec": 0.0, "title": "Start"}
    assert parsed[1]["start_sec"] == 60.0
    assert parsed[2]["title"] == "End"

    assert chapters_svc.parse_chapters("only one\n0:00 Intro\n") == []
    assert chapters_svc.parse_chapters("0:00 A\n0:00 B\n1:00 C") == []
    hour = chapters_svc.parse_chapters("0:00 Open\n1:00:00 Close")
    assert hour[1]["start_sec"] == 3600.0
    wrapped = chapters_svc.parse_chapters("0:00 (Hello)\n1:00 Next")
    assert wrapped[0]["title"] == "Hello"


def test_normalize_ytdlp_chapters():
    raw = [
        {"start_time": 0, "title": "Intro"},
        {"start_time": 45.5, "title": "Main"},
        {"start_time": 45.5, "title": "dup"},
        {"start_time": 120, "title": "Outro"},
    ]
    out = chapters_svc.normalize_ytdlp_chapters(raw)
    assert [c["title"] for c in out] == ["Intro", "Main", "Outro"]
    assert out[1]["start_sec"] == 45.5
    assert (
        chapters_svc.normalize_ytdlp_chapters([{"start_time": 0, "title": "Only"}])
        == []
    )


def test_apply_source_chapters(add_video, session):
    video = add_video()
    chapters_svc.apply_source_chapters(
        video,
        {
            "chapters": [
                {"start_time": 0.0, "title": "One"},
                {"start_time": 30.0, "title": "Two"},
            ]
        },
    )
    session.add(video)
    session.commit()
    session.refresh(video)
    stored = chapters_svc.source_chapters_for(video)
    assert len(stored) == 2
    assert stored[0]["title"] == "One"


def test_resolve_priority_description_over_source_and_ai(add_video, session):
    video = add_video(description="0:00 Alpha\n1:00 Beta")
    chapters_svc.apply_source_chapters(
        video,
        {
            "chapters": [
                {"start_time": 0, "title": "Src A"},
                {"start_time": 40, "title": "Src B"},
            ]
        },
    )
    meta = VideoAiMeta(
        video_id=video.id,
        chapters=chapters_svc.dump_chapter_list(
            [{"start_sec": 0, "title": "AI A"}, {"start_sec": 90, "title": "AI B"}]
        ),
    )
    session.add(video)
    session.add(meta)
    session.commit()
    resolved, source = chapters_svc.resolve_chapters(video, meta)
    assert source == "description"
    assert resolved[0]["title"] == "Alpha"

    video.description = "no timestamps here"
    session.add(video)
    session.commit()
    resolved, source = chapters_svc.resolve_chapters(video, meta)
    assert source == "source"
    assert resolved[0]["title"] == "Src A"

    video.source_chapters = "[]"
    session.add(video)
    session.commit()
    resolved, source = chapters_svc.resolve_chapters(video, meta)
    assert source == "ai"
    assert resolved[0]["title"] == "AI A"


def _spoken_cues(count: int) -> list[tuple[float, str]]:
    return [(float(i * 12), f"section{i} unique words here") for i in range(count)]


def test_short_transcript_is_one_section_with_every_line():
    sections = chapters_svc.transcript_sections(_spoken_cues(40), max_chars=32_000)
    assert len(sections) == 1
    text = chapters_svc.render_transcript(sections[0])
    assert text.startswith("[0:00] section0 unique words here")
    assert "[7:48] section39 unique words here" in text
    assert text.count("[") == 40


def test_long_transcript_is_split_into_sections_not_thinned():
    """A transcript over the cap used to lose words from every line (down to one
    word each); now it is read in sections and every word reaches the model."""
    sections = chapters_svc.transcript_sections(_spoken_cues(200), max_chars=1500)
    assert len(sections) > 1
    rendered = [chapters_svc.render_transcript(s) for s in sections]
    joined = "\n".join(rendered)
    for i in range(200):
        assert f"section{i} unique words here" in joined
    assert all(len(text) <= 1600 for text in rendered)
    # Evenly sized: no stub of a few lines at the end.
    sizes = [len(text) for text in rendered]
    assert min(sizes) >= 0.9 * max(sizes)
    # In order, without overlap.
    starts = [line[0] for section in sections for line in section]
    assert starts == sorted(set(starts))


def test_skip_too_short_and_description(add_video):
    video = add_video(duration_sec=120, description="plain")
    assert (
        chapters_svc.skip_reason(video, None, force=False, cues=[(0.0, "hi")])
        == "too_short"
    )
    assert chapters_svc.skip_reason(video, None, force=True, cues=[(0.0, "hi")]) is None

    mid = add_video(duration_sec=200, description="plain", file_path="talks/mid.mp4")
    assert chapters_svc.skip_reason(mid, None, force=False, cues=[(0.0, "hi")]) is None

    video = add_video(duration_sec=1200, description="0:00 A\n2:00 B")
    assert chapters_svc.skip_reason(video, None) == "description_chapters"


def test_too_short_skip_is_not_sticky(add_video):
    video = add_video(duration_sec=200, description="plain")
    meta = VideoAiMeta(video_id=video.id, chapters_skip_reason="too_short")
    assert (
        chapters_svc.skip_reason(video, meta, force=False, cues=[(0.0, "hi")]) is None
    )


def test_skip_music_like_and_source(add_video):
    video = add_video(duration_sec=1200)
    chapters_svc.apply_source_chapters(
        video,
        {
            "chapters": [
                {"start_time": 0, "title": "A"},
                {"start_time": 60, "title": "B"},
            ]
        },
    )
    assert chapters_svc.skip_reason(video, None) == "source_chapters"

    video2 = add_video(duration_sec=1200, file_path="music/track.mp4")
    cues = []
    for i in range(20):
        cues.append((float(i * 15), "la la chorus" if i % 2 == 0 else "oh oh verse"))
    assert chapters_svc.is_music_like(cues)
    assert chapters_svc.skip_reason(video2, None, cues=cues) == "music_like"
    assert chapters_svc.skip_reason(video2, None, force=True, cues=cues) is None


def test_skip_no_subtitles(add_video):
    video = add_video(duration_sec=1200)
    assert chapters_svc.skip_reason(video, None) == "no_subtitles"


def test_snap_and_validate_rejects_and_snaps():
    cues = [(0.0, "a"), (30.0, "b"), (90.0, "c"), (200.0, "d"), (400.0, "e")]
    raw = [
        {"start_sec": 2, "title": "Open"},
        {"start_sec": 88, "title": "Middle"},
        {"start_sec": 395, "title": "End"},
    ]
    out = chapters_svc.snap_and_validate(raw, cues, 500)
    assert out[0]["start_sec"] == 0.0
    assert out[1]["start_sec"] == 90.0
    assert out[2]["start_sec"] == 400.0

    descending = [
        {"start_sec": 90, "title": "Later"},
        {"start_sec": 0, "title": "First"},
    ]
    # After sort + snap this becomes valid.
    snapped = chapters_svc.snap_and_validate(descending, cues, 500)
    assert snapped[0]["start_sec"] == 0.0
    assert snapped[1]["start_sec"] == 90.0


def test_start_stays_on_the_line_the_model_picked():
    """A start used to be walked back to an earlier caption sharing a word with
    the title. Measured against creators' own chapters that made it worse."""
    cues = [
        (0.0, "welcome back to the channel"),
        (95.0, "let's talk about the case for this sff build"),
        (110.0, "the case is tiny so airflow matters"),
        (134.0, "choosing the right chassis for small form factor"),
        (200.0, "now we install the gpu"),
        (400.0, "wrap up"),
    ]
    out = chapters_svc.snap_and_validate(
        [
            {"part": "Intro", "start": "0:00"},
            {"part": "Choosing the chassis", "start": "2:14"},
            {"part": "Installing the GPU", "start": "3:20"},
        ],
        cues,
        500,
    )
    assert [c["start_sec"] for c in out] == [0.0, 134.0, 200.0]


def test_single_chapter_is_not_padded_with_an_invented_one():
    cues = [(0.0, "a"), (30.0, "b"), (90.0, "c"), (200.0, "d"), (400.0, "e")]
    assert (
        chapters_svc.snap_and_validate([{"start_sec": 10, "title": "Only"}], cues, 500)
        == []
    )


def test_model_clock_times_are_read_as_clock_times():
    """The model copies a line's time as written: "1:19" is 79 seconds. Asked for
    a number of seconds it answered 119, which put the chapter 40 seconds late."""
    reply = (
        '{"parts":["Meth stash stolen","Kidnapping the hostage"],'
        '"chapters":[{"part":"Meth stash stolen","start":"0:00"},'
        '{"part":"Kidnapping the hostage","start":"1:19"}]}'
    )
    items = chapters_svc.chapters_from_model_output(reply)
    cues = [(0.0, "a"), (79.0, "b"), (119.0, "c"), (300.0, "d")]
    out = chapters_svc.snap_and_validate(items, cues, 400)
    assert out == [
        {"start_sec": 0.0, "title": "Meth stash stolen"},
        {"start_sec": 79.0, "title": "Kidnapping the hostage"},
    ]


def test_too_many_chapters_merge_the_shortest_parts():
    """Over the limit, the shortest parts join their neighbour; chapters are not
    thinned to an even spacing."""
    cues = [(float(i), "x") for i in range(0, 180, 10)]
    assert chapters_svc.max_chapter_count(180) == 3
    raw = [
        {"start_sec": 0, "title": "Cold open"},
        {"start_sec": 20, "title": "Sponsor"},
        {"start_sec": 40, "title": "Teardown"},
        {"start_sec": 100, "title": "Benchmarks"},
        {"start_sec": 160, "title": "Outro"},
    ]
    out = chapters_svc.snap_and_validate(raw, cues, 180)
    assert [(c["start_sec"], c["title"]) for c in out] == [
        (0.0, "Cold open"),
        (40.0, "Teardown"),
        (100.0, "Benchmarks"),
    ]


def test_chapter_limit_grows_slowly_with_length():
    counts = [chapters_svc.max_chapter_count(m * 60) for m in (3, 10, 40, 80, 600)]
    assert counts == sorted(counts)
    assert counts[0] >= 2
    assert chapters_svc.max_chapter_count(80 * 60) <= 20
    assert counts[-1] == chapters_svc.MAX_CHAPTERS_HARD


def test_chapters_from_model_output_clock_strings_and_fences():
    fenced = """```json
{"chapters":[{"timestamp":"0:00","title":"Open"},{"time":"1:30","title":"Middle"}]}
```"""
    items = chapters_svc.chapters_from_model_output(fenced)
    assert len(items) == 2
    cues = [(0.0, "a"), (30.0, "b"), (90.0, "c"), (200.0, "d")]
    out = chapters_svc.snap_and_validate(items, cues, 240)
    assert out[0]["start_sec"] == 0.0
    assert out[1]["start_sec"] == 90.0

    as_array = chapters_svc.chapters_from_model_output(
        '[{"start":"0:00","title":"A"},{"start_time":95,"title":"B"}]'
    )
    assert len(as_array) == 2


def test_caption_artifacts_stripped_timestamps_kept():
    raw = """WEBVTT

00:01:42.000 --> 00:01:44.000
>> All right, lets hold.

00:01:44.000 --> 00:01:47.000
Let's hold here.

00:05:03.000 --> 00:05:06.000
[Music] >>I’m digging down.

00:05:06.000 --> 00:05:09.000
>> I’m digging
"""
    cues = chapters_svc.parse_vtt_cues(raw)
    assert cues
    assert all(">>" not in text and "Music" not in text for _, text in cues)
    (section,) = chapters_svc.transcript_sections(cues, max_chars=4000)
    text = chapters_svc.render_transcript(section)
    assert "[1:42]" in text
    assert "[5:03]" in text
    assert ">>" not in text
    assert "All right, lets hold here." in text
    assert text.count("digging") == 1


def test_caption_marks_are_stripped_from_titles():
    items = chapters_svc.chapters_from_model_output(
        '{"chapters":[{"part":"0:00 >> Opening remarks","start":"0:00"},'
        '{"part":"\\"Digging for treasure\\"","start":"1:40"}]}'
    )
    cues = [(0.0, "welcome back"), (100.0, "digging down"), (400.0, "wrap up")]
    out = chapters_svc.snap_and_validate(items, cues, 500)
    assert [c["title"] for c in out] == ["Opening remarks", "Digging for treasure"]


def test_section_chapters_stay_inside_the_section():
    lines = [(600.0, "a"), (612.0, "b"), (900.0, "c"), (1188.0, "d")]
    payload = [
        {"part": "Painting it red", "start": "15:00"},
        {"part": "Building the Shed", "start": "10:00"},
        {"part": "From another section", "start": "45:00"},
        {"part": "No such time", "start": "soon"},
    ]
    assert chapters_svc.section_chapters(payload, lines) == [
        {"start_sec": 600.0, "title": "Building the Shed"},
        {"start_sec": 900.0, "title": "Painting it red"},
    ]
    # How a section that opens still in the previous chapter is recognised.
    assert chapters_svc.same_title("Building the Shed", "building the shed.")
    assert not chapters_svc.same_title("Building the Shed", "Painting it red")
    assert not chapters_svc.same_title("Building the Shed", None)


def test_long_chapters_are_the_ones_far_above_average():
    chapters = [
        {"start_sec": 0.0, "title": "A"},
        {"start_sec": 300.0, "title": "B"},
        {"start_sec": 600.0, "title": "C"},
        {"start_sec": 2400.0, "title": "D"},
    ]
    # 50 minutes, 4 chapters: only the 30-minute one is over twice the average.
    assert chapters_svc.long_chapters(chapters, 3000) == [(2, 2400.0)]
    # An even 10-minute video has none, however few chapters it has.
    assert chapters_svc.long_chapters(chapters[:2], 600) == []
    # Two chapters in three hours: the one holding nearly all of it qualifies.
    assert chapters_svc.long_chapters(chapters[:2], 10_800) == [(1, 10_800.0)]
