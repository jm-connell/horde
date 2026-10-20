"""HLS playlist parsing and rendering for the live proxy."""

from __future__ import annotations

from app.services.live import hls

SEG = (
    "https://rr1---sn-x.googlevideo.com/videoplayback/id/abc.1/itag/95/"
    "source/yt_live_broadcast/expire/1900000000/sig/AB{{x}}/sq/{sq}/dur/5.000/file/seg.ts"
)


def _playlist(first: int, count: int, *, ended: bool = False) -> str:
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:5",
        f"#EXT-X-MEDIA-SEQUENCE:{first}",
    ]
    for sq in range(first, first + count):
        lines += ["#EXTINF:5.005,", SEG.format(sq=sq)]
    if ended:
        lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines)


def test_parse_reads_sequence_numbers_from_the_segment_urls():
    pl = hls.parse_media_playlist(_playlist(100, 3), "https://manifest.example/x.m3u8")
    assert pl.target_duration == 5
    assert [s.sq for s in pl.segments] == [100, 101, 102]
    assert pl.segments[0].duration == 5.005
    assert pl.head_sq == 102
    assert not pl.ended


def test_parse_numbers_plain_segments_by_media_sequence_and_resolves_relative_uris():
    text = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST\n"
    pl = hls.parse_media_playlist(text, "https://cdn.example/live/index.m3u8")
    assert [(s.sq, s.uri) for s in pl.segments] == [
        (7, "https://cdn.example/live/a.ts"),
        (8, "https://cdn.example/live/b.ts"),
    ]
    assert pl.ended


def test_parse_tolerates_garbage_values():
    text = "#EXTM3U\n#EXT-X-TARGETDURATION:abc\n#EXT-X-MEDIA-SEQUENCE:x\n#EXTINF:nan,\na.ts\n"
    pl = hls.parse_media_playlist(text, "https://cdn.example/i.m3u8")
    assert pl.media_sequence == 0
    assert pl.segments[0].duration == 5.0


def test_template_rebuilds_any_earlier_segment_and_keeps_literal_braces():
    uri = SEG.format(sq=4321)
    template = hls.segment_template(uri)
    assert template is not None
    assert hls.fill_template(template, 4321) == uri
    assert "/sq/12/" in hls.fill_template(template, 12)
    assert "{x}" in hls.fill_template(template, 12)


def test_template_supports_query_sq_and_rejects_urls_without_one():
    template = hls.segment_template("https://h.example/vp?itag=95&sq=55&x=1")
    assert template is not None
    assert hls.fill_template(template, 3) == "https://h.example/vp?itag=95&sq=3&x=1"
    assert hls.segment_template("https://h.example/seg-55.ts") is None


def test_render_media_is_contiguous_and_points_at_the_proxy():
    body = hls.render_media(
        [(10, 5.0), (11, 4.5)],
        segment_uri="../seg/95/{sq}.ts",
        ended=False,
        target_duration=5,
    )
    assert "#EXT-X-MEDIA-SEQUENCE:10" in body
    assert "#EXT-X-TARGETDURATION:5" in body
    assert body.count("#EXTINF") == 2
    assert "../seg/95/11.ts" in body
    assert "#EXT-X-ENDLIST" not in body
    ended = hls.render_media([], segment_uri="{sq}", ended=True, target_duration=0)
    assert "#EXT-X-ENDLIST" in ended


def test_render_master_lists_each_variant():
    body = hls.render_master(
        [
            hls.VariantInfo("94", 1_000_000, 854, 480, 30.0, "avc1.4d401f,mp4a.40.2"),
            hls.VariantInfo("95", 2_500_000, 1280, 720, None, None),
        ]
    )
    assert 'RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30.000' in body
    assert body.strip().endswith("v/95.m3u8")


def test_render_master_with_a_separate_audio_rendition():
    body = hls.render_master(
        [hls.VariantInfo("232", 2_400_000, 1280, 720, None, "avc1.4d401f")],
        hls.VariantInfo("234", 128_000, None, None, None, "mp4a.40.2"),
    )
    assert '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio"' in body
    assert 'URI="v/234.m3u8"' in body
    assert (
        'BANDWIDTH=2528000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",'
        'AUDIO="audio"' in body
    )
    assert body.strip().endswith("v/232.m3u8")


# Keep in step with frontend/src/utils/followUrl.test.ts (same table).
NORMALIZE_CASES = [
    ("https://www.youtube.com/@Foo/live", "https://youtube.com/@foo"),
    ("http://youtube.com:443/@Foo/Videos/", "https://youtube.com/@foo"),
    ("m.youtube.com/channel/UCabc?x=1", "https://youtube.com/channel/UCabc"),
    (
        "https://www.youtube.com/channel/UCAbC/streams",
        "https://youtube.com/channel/UCAbC",
    ),
    ("youtube.com/c/SomeName", "https://youtube.com/c/SomeName"),
    ("https://youtube.com/@x/featured/live", "https://youtube.com/@x"),
]


def test_channel_url_normalization_matches_the_frontend():
    from app.services.follows import normalize_channel_url

    for raw, expected in NORMALIZE_CASES:
        assert normalize_channel_url(raw) == expected, raw
    assert normalize_channel_url("   ") == ""
