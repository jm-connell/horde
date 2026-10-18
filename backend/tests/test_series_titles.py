"""Deciding from titles whether an upload is clearly the next part."""

from __future__ import annotations

import pytest

from app.services.series_titles import next_part_reason

REACTS = [
    "Bratty Karen Tries Fleeing Traffic Stop | xQc Reacts",
    "Traffic Stop Leads to Discovery of Dead Body | xQc Reacts",
    "Extremely Drunk Driver Goes Crazy in a Parking Lot | xQc Reacts",
    "This Alpha Male is Having a Rough Time | xQc Reacts",
]


@pytest.mark.parametrize(
    ("prev", "nxt"),
    [
        ("GTA RP Day 12 - Back in the City", "GTA RP Day 13 - The Heist"),
        ("Building a Cabin Part 3", "Building a Cabin Part 4"),
        ("Elden Ring Blind Playthrough #7", "Elden Ring Blind Playthrough #8"),
        ("NoPixel 4.0 | Chang Gang Returns", "NoPixel 4.0 | Heist Planning"),
        ("[Skunkworks Build] Draining the Loop", "[Skunkworks Build] New Distro Plate"),
    ],
)
def test_clear_continuations_are_recognised(prev, nxt):
    assert next_part_reason(prev, nxt, channel_titles=REACTS) is not None


@pytest.mark.parametrize(
    ("prev", "nxt"),
    [
        # A tag the channel puts on everything is a format, not a series.
        (REACTS[0], REACTS[1]),
        # Unrelated uploads.
        ("Testing a $769 Budget AI Rig", "Why I Switched to Linux"),
        # A number that jumps is not the next part.
        ("Building a Cabin Part 3", "Building a Cabin Part 7"),
        # Same number, different topic.
        ("Top 10 Cars of 2024", "Top 10 Phones of 2024"),
        # A re-upload with the same title.
        ("GTA RP Day 12", "GTA RP Day 12"),
    ],
)
def test_weak_or_unrelated_titles_are_not(prev, nxt):
    assert next_part_reason(prev, nxt, channel_titles=REACTS) is None


def test_a_tag_naming_the_channel_is_not_a_series():
    assert (
        next_part_reason(
            "xQc Clips | Funny Moments", "xQc Clips | Best Fails", channel_name="xQc"
        )
        is None
    )


def test_a_common_tag_counts_on_a_channel_that_uses_it_rarely():
    others = ["Unboxing a Laptop", "Studio Tour", "Q&A Stream", "My Setup 2026"]
    assert (
        next_part_reason(
            "Road Trip | Utah", "Road Trip | Nevada", channel_titles=others
        )
        is not None
    )
