"""Custom CSS may not fetch remote resources (shared vectors with the frontend)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.css_sanitize import sanitize_custom_css

# One list of cases for both implementations; frontend/src/customCss.test.ts runs it too.
_VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "customCssSanitize.vectors.json"
    ).read_text(encoding="utf-8")
)


@pytest.mark.parametrize("vector", _VECTORS, ids=[v["name"] for v in _VECTORS])
def test_sanitize_vectors(vector):
    assert sanitize_custom_css(vector["input"]) == vector["output"]


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
