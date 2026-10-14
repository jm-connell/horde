"""Live manifest rewrite: DASH templates stay seekable, hosts stay allowlisted."""

from urllib.parse import parse_qs, unquote, urlparse
from xml.etree import ElementTree as ET

from app.services import live_manifest


def _upstream(proxy_url: str) -> str:
    parsed = urlparse(proxy_url)
    values = parse_qs(parsed.query)
    return values["u"][0]


def test_encode_upstream_keeps_dash_placeholders():
    raw = "https://rr.googlevideo.com/videoplayback/sq/$Number$.m4s?id=1&xtag=a+b"
    encoded = live_manifest.encode_upstream(raw)
    assert "$Number$" in encoded
    assert "&" not in encoded.replace("$Number$", "")
    assert unquote(encoded) == raw


def test_pick_live_manifest_prefers_dash_master():
    info = {
        "http_headers": {"User-Agent": "horde"},
        "formats": [
            {
                "format_id": "96",
                "protocol": "m3u8_native",
                "manifest_url": "https://manifest.googlevideo.com/api/manifest/hls_variant/a.m3u8",
                "height": 1080,
            },
            {
                "format_id": "dash",
                "protocol": "http_dash_segments",
                "manifest_url": "https://manifest.googlevideo.com/api/manifest/dash/all",
            },
        ],
    }
    url, kind, headers = live_manifest.pick_live_manifest(info)
    assert kind == "dash"
    assert url.endswith("/all")
    assert headers["User-Agent"] == "horde"


def test_info_is_live_ignores_finished_and_upcoming():
    assert live_manifest.info_is_live({"live_status": "is_live"})
    assert live_manifest.info_is_live({"is_live": True})
    assert not live_manifest.info_is_live({"live_status": "was_live", "is_live": True})
    assert not live_manifest.info_is_live({"live_status": "is_upcoming"})
    assert not live_manifest.info_is_live({"is_live": False})


def test_rewrite_dash_proxies_baseurl_and_templates():
    live_manifest.reset_for_tests()
    xml = """<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
  <ServiceDescription>
    <Latency min="1000" max="3000" target="2000"/>
  </ServiceDescription>
  <Period>
    <AdaptationSet>
      <Representation id="1" bandwidth="1000">
        <BaseURL>https://rr.googlevideo.com/videoplayback/</BaseURL>
        <SegmentTemplate timescale="1000" initialization="init.mp4" media="sq/$Number$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
"""
    rewritten = live_manifest.rewrite_dash(
        xml.encode(),
        "https://manifest.googlevideo.com/api/manifest/dash/all",
        "tok",
    )
    root = ET.fromstring(rewritten)
    ns = {"m": "urn:mpeg:dash:schema:mpd:2011"}
    base = root.find(".//m:BaseURL", ns)
    template = root.find(".//m:SegmentTemplate", ns)
    assert base is not None and base.text
    assert template is not None
    assert _upstream(base.text) == "https://rr.googlevideo.com/videoplayback/"
    media = template.attrib["media"]
    init = template.attrib["initialization"]
    assert "$Number$" in media
    assert _upstream(media) == "https://rr.googlevideo.com/videoplayback/sq/$Number$.m4s"
    assert _upstream(init) == "https://rr.googlevideo.com/videoplayback/init.mp4"
    assert "kind=playlist" not in media
    assert root.find(".//m:ServiceDescription", ns) is None


def test_rewrite_hls_marks_playlists_only():
    text = "\n".join(
        [
            "#EXTM3U",
            "#EXT-X-STREAM-INF:BANDWIDTH=1000",
            "https://manifest.googlevideo.com/live/index.m3u8",
            "#EXTINF:2.0,",
            "https://rr.googlevideo.com/seg/1.m4s",
            '#EXT-X-MAP:URI="https://rr.googlevideo.com/init.mp4"',
            "",
        ]
    )
    out = live_manifest.rewrite_hls(
        text,
        "https://manifest.googlevideo.com/live/master.m3u8",
        "tok",
    )
    lines = [line for line in out.splitlines() if line and not line.startswith("#EXT")]
    assert "kind=playlist" in lines[0]
    assert _upstream(lines[0]).endswith("index.m3u8")
    assert "kind=playlist" not in lines[1]
    assert _upstream(lines[1]).endswith("/seg/1.m4s")
    mapped = out.split('URI="', 1)[1].split('"', 1)[0]
    assert "kind=playlist" not in mapped
    assert _upstream(mapped).endswith("/init.mp4")


def test_resolve_upstream_rejects_unknown_token_and_host():
    live_manifest.reset_for_tests()
    info = {
        "formats": [
            {
                "format_id": "dash",
                "manifest_url": "https://manifest.googlevideo.com/api/manifest/dash/all",
            }
        ]
    }
    live_manifest._touch_session(
        "https://www.youtube.com/watch?v=abcdefghijk",
        info["formats"][0]["manifest_url"],
        "dash",
        {"User-Agent": "horde"},
    )
    token = live_manifest._token_by_source["https://www.youtube.com/watch?v=abcdefghijk"]
    resolved = live_manifest.resolve_upstream(
        token, "https://rr.googlevideo.com/seg/1.m4s"
    )
    assert resolved["direct_url"].endswith("/1.m4s")
    assert resolved["http_headers"]["User-Agent"] == "horde"
    try:
        live_manifest.resolve_upstream(token, "https://evil.example/seg")
    except ValueError as exc:
        assert "not allowed" in str(exc)
    else:
        raise AssertionError("expected host rejection")
    try:
        live_manifest.resolve_upstream("nope", "https://rr.googlevideo.com/seg/1.m4s")
    except KeyError:
        pass
    else:
        raise AssertionError("expected missing session")
