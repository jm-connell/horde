"""The device label shown for a signed-in browser."""

from __future__ import annotations

import pytest

from app.services.auth.user_agent import describe

CASES = [
    (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Safari on iPhone",
    ),
    (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1",
        "Chrome on iPhone",
    ),
    (
        "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15",
        "Firefox on iPad",
    ),
    (
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like "
        "Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
        "Chrome on Android",
    ),
    (
        "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 "
        "(KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
        "Samsung Internet on Android",
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
        "Firefox on Windows",
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like "
        "Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.67",
        "Edge on Windows",
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like "
        "Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Chrome on Windows",
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like "
        "Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0",
        "Opera on Windows",
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, "
        "like Gecko) Version/17.4 Safari/605.1.15",
        "Safari on macOS",
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, "
        "like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Chrome on macOS",
    ),
    (
        "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
        "Firefox on Linux",
    ),
    (
        "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like "
        "Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Chrome on ChromeOS",
    ),
    ("curl/8.5.0", "Unknown device"),
    ("Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7)", "Android"),
    ("", "Unknown device"),
    (None, "Unknown device"),
]


@pytest.mark.parametrize(("user_agent", "label"), CASES)
def test_describe(user_agent, label):
    assert describe(user_agent) == label
