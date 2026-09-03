from datetime import datetime, timedelta, timezone

from app.services.feed_meta_cache import (
    format_relative_ago,
    parse_upload_date,
    published_at_from_entry,
    published_meta_from_entry,
    relative_label_from_text,
)


def test_parse_upload_date_yyyymmdd_and_iso():
    assert parse_upload_date("20240901").startswith("2024-09-01")
    assert parse_upload_date("2024-09-01").startswith("2024-09-01")
    iso = parse_upload_date("2024-09-01T12:30:00Z")
    assert iso and "2024-09-01T12:30:00" in iso
    assert parse_upload_date(None) is None
    assert parse_upload_date("") is None
    assert parse_upload_date("not a date") is None


def test_parse_upload_date_unix_and_millis():
    assert parse_upload_date(1388534400).startswith("2014-01-01")
    assert parse_upload_date("1388534400").startswith("2014-01-01")
    assert parse_upload_date(1388534400000).startswith("2014-01-01")


def test_parse_upload_date_relative_years():
    iso = parse_upload_date("Streamed 3 years ago")
    assert iso
    dt = datetime.fromisoformat(iso)
    delta = datetime.now(timezone.utc) - dt
    assert timedelta(days=int(2.5 * 365)) < delta < timedelta(days=int(3.5 * 365))


def test_relative_label_from_text():
    assert relative_label_from_text("Streamed 3 years ago") == "3 years ago"
    assert relative_label_from_text("1 month ago") == "1 month ago"
    assert relative_label_from_text("yesterday") == "1 day ago"


def test_format_relative_ago_buckets():
    now = datetime(2026, 9, 3, tzinfo=timezone.utc)
    assert format_relative_ago(now - timedelta(days=3 * 365), now=now) == "3 years ago"
    assert format_relative_ago(now - timedelta(days=11), now=now) == "2 weeks ago"
    assert format_relative_ago(now - timedelta(hours=5), now=now) == "5 hours ago"


def test_published_meta_prefers_real_upload_date_over_timestamp():
    meta = published_meta_from_entry(
        {
            "upload_date": "20200901",
            "timestamp": 1388534400,
        }
    )
    assert meta.iso and meta.iso.startswith("2020-09-01")
    assert meta.label is None
    assert meta.precision == "day"


def test_published_meta_timestamp_only_is_relative_not_calendar_day():
    meta = published_meta_from_entry({"timestamp": 1388534400})
    assert meta.iso and meta.iso.startswith("2014-01-01")
    assert meta.label and meta.label.endswith("ago")
    assert meta.precision == "relative"


def test_published_meta_year_only():
    meta = published_meta_from_entry({"upload_date": "2013"})
    assert meta.label == "2013"
    assert meta.precision == "year"
    assert meta.iso and meta.iso.startswith("2013-01-01")


def test_published_meta_month_only():
    meta = published_meta_from_entry({"upload_date": "201309"})
    assert meta.label == "Sep 2013"
    assert meta.precision == "month"
    assert meta.iso and meta.iso.startswith("2013-09-01")


def test_published_meta_from_published_time_text():
    meta = published_meta_from_entry({"publishedTimeText": "Streamed 3 years ago"})
    assert meta.label == "3 years ago"
    assert meta.precision == "relative"
    assert meta.iso
    assert published_at_from_entry({"publishedTimeText": "3 years ago"})
