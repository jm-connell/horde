from app.services.ffmpeg_progress import parse_out_time_seconds, progress_percent


def test_parse_out_time_ms_is_microseconds():
    assert parse_out_time_seconds("out_time_ms=1500000") == 1.5
    assert parse_out_time_seconds("out_time_us=2000000") == 2.0
    assert parse_out_time_seconds("out_time=00:00:02.500000") == 2.5
    assert parse_out_time_seconds("progress=continue") is None


def test_progress_percent_clamps():
    assert progress_percent(5, 10) == 50.0
    assert progress_percent(20, 10) == 100.0
    assert progress_percent(1, 0) == 0.0
