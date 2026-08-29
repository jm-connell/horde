"""Subtitle/VTT text extraction helpers."""

from app.services.ai.text import _strip_vtt


def test_strip_vtt_decodes_html_and_unknown_entities():
    raw = """WEBVTT

00:00:01.000 --> 00:00:03.000
Hello&nbsp;world &gt;&gt; &nsps speaker

00:00:03.000 --> 00:00:05.000
Tom &amp; Jerry &#39;s &amp;nbsp;cue
"""
    text = _strip_vtt(raw)
    assert "Hello world >> speaker" in text
    assert "Tom & Jerry 's cue" in text
    assert "&nbsp;" not in text
    assert "&nsps" not in text
    assert "&gt;" not in text
