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
    assert chapters_svc.normalize_ytdlp_chapters([{"start_time": 0, "title": "Only"}]) == []


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


def test_parse_vtt_cues_and_downsample_keeps_ends():
    cues = []
    for i in range(0, 3600, 5):
        cues.append((float(i), f"cue at {i}"))
    text = chapters_svc.format_timed_transcript(cues, max_chars=800)
    assert text.startswith("[0:00]")
    assert "[59:" in text
    assert text.count("[") >= 20


def test_timed_transcript_char_cap_samples_whole_file():
    windows = [(float(i * 12), f"section-{i} unique words here") for i in range(200)]
    # Build fake cues every 12s already window-sized.
    text = chapters_svc.format_timed_transcript(windows, max_chars=600)
    assert "section-0" in text
    assert "section-199" in text
    assert len(text) <= 600


def test_skip_too_short_and_description(add_video):
    video = add_video(duration_sec=120, description="plain")
    assert chapters_svc.skip_reason(video, None, force=False, cues=[(0.0, "hi")]) == "too_short"
    assert chapters_svc.skip_reason(video, None, force=True, cues=[(0.0, "hi")]) is None

    mid = add_video(duration_sec=200, description="plain", file_path="talks/mid.mp4")
    assert chapters_svc.skip_reason(mid, None, force=False, cues=[(0.0, "hi")]) is None

    video = add_video(duration_sec=1200, description="0:00 A\n2:00 B")
    assert chapters_svc.skip_reason(video, None) == "description_chapters"


def test_too_short_skip_is_not_sticky(add_video):
    video = add_video(duration_sec=200, description="plain")
    meta = VideoAiMeta(video_id=video.id, chapters_skip_reason="too_short")
    assert chapters_svc.skip_reason(video, meta, force=False, cues=[(0.0, "hi")]) is None


def test_skip_music_like_and_source(add_video):
    video = add_video(duration_sec=1200)
    chapters_svc.apply_source_chapters(
        video,
        {"chapters": [{"start_time": 0, "title": "A"}, {"start_time": 60, "title": "B"}]},
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

    only = chapters_svc.snap_and_validate(
        [{"start_sec": 10, "title": "Only"}], cues, 500
    )
    assert len(only) >= 2
    assert only[0]["start_sec"] == 0.0
    descending = [
        {"start_sec": 90, "title": "Later"},
        {"start_sec": 0, "title": "First"},
    ]
    # After sort + snap this becomes valid.
    snapped = chapters_svc.snap_and_validate(descending, cues, 500)
    assert snapped[0]["start_sec"] == 0.0
    assert snapped[1]["start_sec"] == 90.0


def test_topic_onset_walks_back_to_first_mention():
    cues = [
        (0.0, "welcome back to the channel"),
        (80.0, "quick look at the motherboard"),
        (95.0, "let's talk about the case for this sff build"),
        (110.0, "the case is tiny so airflow matters"),
        (134.0, "choosing the right chassis for small form factor"),
        (200.0, "now we install the gpu"),
        (400.0, "wrap up"),
    ]
    out = chapters_svc.snap_and_validate(
        [
            {"start_sec": 0, "title": "Intro"},
            {
                "start_sec": 134,
                "title": "Choosing the Right Chassis for Small Form Factor",
            },
            {"start_sec": 200, "title": "Installing the GPU"},
        ],
        cues,
        500,
    )
    chassis = next(c for c in out if "Chassis" in c["title"] or "chassis" in c["title"])
    assert chassis["start_sec"] == 95.0


def test_transcript_keeps_all_windows_when_compressed():
    windows = [
        (float(i * 12), f"talking about unique topic {i} with extra filler words")
        for i in range(40)
    ]
    text = chapters_svc.format_timed_transcript(windows, max_chars=2500)
    assert "[0:00]" in text
    assert "[7:48]" in text
    assert text.count("[") == 40


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


def test_fallback_chapters_from_cues():
    cues = [(float(i), f"unique topic {i} continues") for i in range(0, 480, 12)]
    out = chapters_svc.fallback_chapters_from_cues(cues, 480)
    assert len(out) >= 2
    assert out[0]["start_sec"] == 0.0
