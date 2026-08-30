"""AV1-preserving MP4 remux: AAC audio + faststart, never transcode video."""

from pathlib import Path

from app.services.mp4_compat import (
    CompatPlan,
    MediaProbe,
    codec_family,
    compat_plan,
    ffmpeg_compat_cmd,
    is_aac_audio,
    mp4_moov_before_mdat,
)


def test_codec_family_and_aac():
    assert codec_family("av01.0.08M.08") == "av01"
    assert codec_family("opus") == "opus"
    assert codec_family("mp4a.40.2") == "mp4a"
    assert codec_family(None) == ""
    assert is_aac_audio("aac")
    assert is_aac_audio("mp4a.40.2")
    assert not is_aac_audio("opus")
    assert not is_aac_audio("vorbis")


def _make_atom(tag: bytes, payload: bytes) -> bytes:
    size = 8 + len(payload)
    return size.to_bytes(4, "big") + tag + payload


def test_moov_before_mdat(tmp_path: Path):
    ftyp = _make_atom(b"ftyp", b"isom")
    moov = _make_atom(b"moov", b"\x00" * 16)
    mdat = _make_atom(b"mdat", b"\x00" * 32)
    front = tmp_path / "faststart.mp4"
    front.write_bytes(ftyp + moov + mdat)
    assert mp4_moov_before_mdat(front) is True
    back = tmp_path / "slowstart.mp4"
    back.write_bytes(ftyp + mdat + moov)
    assert mp4_moov_before_mdat(back) is False


def test_compat_plan_av1_opus_needs_aac_and_faststart():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="opus",
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=False,
    )
    plan = compat_plan(probe)
    assert plan == CompatPlan(transcode_audio=True, faststart=True)
    assert plan.needed


def test_compat_plan_already_aac_faststart_is_noop():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="aac",
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=True,
    )
    plan = compat_plan(probe)
    assert not plan.needed
    assert plan.transcode_audio is False


def test_compat_plan_aac_without_faststart_copies_audio():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="mp4a.40.2",
        format_name="mp4",
        moov_front=False,
    )
    plan = compat_plan(probe)
    assert plan.needed
    assert plan.transcode_audio is False
    assert plan.faststart is True


def test_ffmpeg_cmd_copies_video_never_libx264():
    src = Path("in.mp4")
    dest = Path("out.mp4")
    cmd = ffmpeg_compat_cmd(
        src, dest, transcode_audio=True, has_video=True, has_audio=True
    )
    assert cmd[:4] == ["ffmpeg", "-y", "-i", "in.mp4"]
    assert "-c:v" in cmd and cmd[cmd.index("-c:v") + 1] == "copy"
    assert "libx264" not in cmd
    assert "libsvtav1" not in cmd
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert "+faststart" in cmd

    copy_audio = ffmpeg_compat_cmd(
        src, dest, transcode_audio=False, has_video=True, has_audio=True
    )
    assert copy_audio[copy_audio.index("-c:a") + 1] == "copy"
    assert copy_audio[copy_audio.index("-c:v") + 1] == "copy"
