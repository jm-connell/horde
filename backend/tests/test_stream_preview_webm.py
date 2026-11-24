"""WebM init/index range discovery for the DASH preview manifest."""

from __future__ import annotations

import struct
from types import SimpleNamespace

import pytest

from app.services import stream_preview


def _vint(n: int) -> bytes:
    """Encode an EBML size in the shortest form."""
    for length in range(1, 9):
        if n < (1 << (7 * length)) - 1:
            return (n | (1 << (7 * length))).to_bytes(length, "big")
    raise ValueError(n)


def _el(eid: str, body: bytes) -> bytes:
    return bytes.fromhex(eid) + _vint(len(body)) + body


def _webm(
    *,
    cues_size: int,
    void_before: int = 0,
    duration: float | None = 635.0,
    cues: bool = True,
) -> bytes:
    info_body = _el("2AD7B1", (1_000_000).to_bytes(4, "big"))
    if duration is not None:
        # Duration is a float in TimecodeScale units (here milliseconds).
        info_body += _el("4489", struct.pack(">d", duration * 1000))
    children = _el("114D9B74", b"\x00" * 20)
    children += _el("1549A966", info_body)
    children += _el("1654AE6B", b"\x00" * 30)
    if void_before:
        children += _el("EC", b"\x00" * void_before)
    if cues:
        children += bytes.fromhex("1C53BB6B") + _vint(cues_size) + b"\x00" * cues_size
    children += _el("1F43B675", b"\x00" * 50)
    ebml = _el("1A45DFA3", b"\x00" * 20)
    segment = bytes.fromhex("18538067") + b"\x01" + len(children).to_bytes(7, "big")
    return ebml + segment + children


def test_ranges_end_where_cues_starts():
    data = _webm(cues_size=2189)
    start = data.index(bytes.fromhex("1C53BB6B"))
    init, index, dur = stream_preview._find_webm_ranges(data)
    assert init == f"0-{start - 1}"
    assert index == f"{start}-{start + 4 + 2 + 2189 - 1}"  # id + 2-byte size + body
    assert dur == pytest.approx(635.0)


def test_missing_duration_is_none():
    data = _webm(cues_size=100, duration=None)
    assert stream_preview._find_webm_ranges(data)[2] is None


def test_only_the_cues_header_must_be_in_the_window():
    data = _webm(cues_size=163_814)
    start = data.index(bytes.fromhex("1C53BB6B"))
    assert stream_preview._find_webm_ranges(data[: start + 12])[1].startswith(
        f"{start}-"
    )


def test_a_window_that_stops_before_cues_asks_for_more():
    data = _webm(cues_size=100, void_before=5000)
    assert stream_preview._find_webm_ranges(data[:1000]) is None


def test_no_cues_before_the_first_cluster_fails():
    with pytest.raises(RuntimeError, match="no Cues"):
        stream_preview._find_webm_ranges(_webm(cues_size=0, cues=False))


def test_the_probe_grows_its_window(monkeypatch):
    data = _webm(cues_size=100, void_before=300_000)
    sizes = []

    def fake(url, *, max_bytes, timeout, headers):
        sizes.append(max_bytes)
        return SimpleNamespace(body=data[:max_bytes])

    monkeypatch.setattr(stream_preview, "fetch_bytes", fake)
    init, index, info = stream_preview._probe_webm_ranges("https://x/v", {})
    start = data.index(bytes.fromhex("1C53BB6B"))
    assert sizes == [256 * 1024, 1024 * 1024]
    assert init == f"0-{start - 1}" and info["boundaries"] == []
