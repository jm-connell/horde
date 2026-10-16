"""Custom CSS may not fetch remote resources (shared vectors with the frontend)."""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from app.services.css_sanitize import sanitize_custom_css

# One list of cases for both implementations; frontend/src/customCss.test.ts runs it too.
_VECTORS_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "customCssSanitize.vectors.json"
)
_VECTORS = json.loads(_VECTORS_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("vector", _VECTORS, ids=[v["name"] for v in _VECTORS])
def test_sanitize_vectors(vector):
    assert sanitize_custom_css(vector["input"]) == vector["output"]


@pytest.mark.parametrize("vector", _VECTORS, ids=[v["name"] for v in _VECTORS])
def test_sanitize_is_idempotent_on_the_vectors(vector):
    once = sanitize_custom_css(vector["input"])
    assert sanitize_custom_css(once) == once


# Splice corpus, shared with frontend/src/customCss.test.ts: a dangerous construct
# is cut at a random point, something the sanitizer removes is put in the cut,
# and random noise goes around it.
_CORPUS = json.loads(
    (_VECTORS_PATH.parent / "customCssSanitize.corpus.json").read_text(encoding="utf-8")
)


def _spliced(rng: random.Random) -> str:
    text = rng.choice(_CORPUS["targets"])
    for _ in range(rng.randint(1, 3)):
        cut = rng.randint(0, len(text))
        text = text[:cut] + rng.choice(_CORPUS["removable"]) + text[cut:]
    noise = _CORPUS["noise"]
    before = "".join(rng.choice(noise) for _ in range(rng.randint(0, 4)))
    after = "".join(rng.choice(noise) for _ in range(rng.randint(0, 4)))
    return before + text + after


def test_sanitize_is_idempotent_on_generated_inputs():
    """sanitize(sanitize(x)) == sanitize(x): removing something never makes a URL."""
    rng = random.Random(20261016)  # noqa: S311 - reproducible test inputs
    for _ in range(3000):
        css = _spliced(rng)
        once = sanitize_custom_css(css)
        assert sanitize_custom_css(once) == once, css


def test_saving_settings_sanitizes_css_everywhere_it_appears(client):
    resp = client.patch(
        "/api/settings",
        json={
            "ui": {
                "customCss": "@import url(https://evil.test/x.css);a{color:red}",
                "themes": [
                    {"name": "t", "custom_css": "a{background:url(//e.test/x)}"}
                ],
            }
        },
    )

    assert resp.status_code == 200
    ui = resp.json()["ui"]
    assert ui["customCss"] == "a{color:red}"
    assert ui["themes"][0]["custom_css"] == "a{background:none}"
    stored = client.get("/api/settings").json()["ui"]
    assert stored["customCss"] == "a{color:red}"


def test_ui_blob_has_a_server_side_size_cap(client):
    big = {"blob": "x" * (300 * 1024)}

    resp = client.patch("/api/settings", json={"ui": big})

    assert resp.status_code == 413
    # Many small patches cannot sneak past the cap by accumulating.
    for i in range(3):
        step = client.patch("/api/settings", json={"ui": {f"k{i}": "y" * (100 * 1024)}})
        if step.status_code == 413:
            break
    else:
        pytest.fail("merged ui blob was never capped")
