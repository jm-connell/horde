"""The Subscriptions list: follows, automatic downloads and cleanup rules in one place."""

from datetime import UTC, datetime

from sqlmodel import Session

from app.models import ChannelAutodownload, ChannelCatalog, ChannelRetention
from app.services import follows


def test_lists_follows_autodownloads_and_rules_by_channel(
    client, init_db, admin_user, member_user, add_video
):
    add_video(
        channel="Veritasium",
        channel_url="https://www.youtube.com/@veritasium",
        title="One",
    )
    add_video(
        channel="Veritasium",
        channel_url="https://www.youtube.com/@veritasium",
        title="Two",
        channel_subscriber_count=19_500_000,
    )
    with Session(init_db["engine"]) as s:
        follows.follow(s, admin_user.id, "https://www.youtube.com/@Veritasium", "Veri")
        follows.follow(s, admin_user.id, "https://www.youtube.com/@nobodyhere", None)
        # Someone else's follow is theirs alone.
        follows.follow(s, member_user.id, "https://www.youtube.com/@member", "Mem")
        s.add(
            ChannelAutodownload(
                channel_url="https://www.youtube.com/@veritasium/videos",
                channel_name="Veritasium",
                enabled=True,
                quality_preset="720p",
            )
        )
        s.add(
            ChannelAutodownload(
                channel_url="https://www.youtube.com/@off", enabled=False
            )
        )
        s.add(ChannelRetention(channel="Veritasium", enabled=True, keep_latest=20))
        s.add(
            ChannelCatalog(
                channel_url="https://www.youtube.com/@veritasium",
                finished_at=datetime(2026, 1, 2, tzinfo=UTC),
            )
        )
        s.commit()

    resp = client.get("/api/channels/subscriptions")

    assert resp.status_code == 200
    items = resp.json()["items"]
    # URLs come back in follows' canonical form (no www., handle lower-cased).
    assert [i["channel_url"] for i in items] == [
        "https://youtube.com/@nobodyhere",
        "https://youtube.com/@veritasium",
    ]
    nobody, veri = items
    assert nobody["following"] is True
    assert nobody["autodownload"] is False
    assert nobody["video_count"] == 0
    assert nobody["subscriber_count"] is None
    assert veri["channel_name"] == "Veritasium"  # the library's name wins
    assert veri["following"] is True
    assert veri["autodownload"] is True
    assert veri["quality_preset"] == "720p"
    assert veri["retention"]["keep_latest"] == 20
    assert veri["video_count"] == 2
    assert veri["subscriber_count"] == 19_500_000
    assert veri["checked_at"].startswith("2026-01-02")


def test_autodownload_shows_up_for_someone_who_does_not_follow(member_client, init_db):
    with Session(init_db["engine"]) as s:
        s.add(
            ChannelAutodownload(
                channel_url="https://www.youtube.com/@shared",
                channel_name="Shared",
                enabled=True,
            )
        )
        s.commit()

    items = member_client.get("/api/channels/subscriptions").json()["items"]

    assert [(i["channel_name"], i["following"], i["autodownload"]) for i in items] == [
        ("Shared", False, True)
    ]
