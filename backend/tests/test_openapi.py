"""The OpenAPI document must build cleanly (no duplicate operation ids)."""

from __future__ import annotations

import warnings


def test_openapi_schema_builds_without_warnings(client):
    app = client.app
    app.openapi_schema = None  # force a rebuild under the warnings filter
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        schema = app.openapi()

    operation_ids = [
        op["operationId"]
        for methods in schema["paths"].values()
        for op in methods.values()
        if isinstance(op, dict) and "operationId" in op
    ]
    assert len(operation_ids) == len(set(operation_ids))


def test_preview_manifest_still_answers_get_and_head(client):
    # No `url` query: both verbs reach the handler (422), neither is a 405.
    assert client.get("/api/preview/manifest").status_code == 422
    assert client.head("/api/preview/manifest").status_code == 422
