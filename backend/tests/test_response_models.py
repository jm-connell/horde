"""Every JSON route declares what it returns; every other route declares its media type.

A route that returns an ad-hoc dict is invisible to the OpenAPI schema (and to the
TypeScript client generated from it) and nothing stops its shape drifting. This test
fails when a new route forgets its ``response_model``, so the choice is deliberate:
a model for JSON, or ``responses=`` (see ``app/openapi_responses.py``) for bytes,
files and event streams.
"""

from __future__ import annotations

from typing import Any

from fastapi.datastructures import DefaultPlaceholder
from fastapi.routing import APIRoute, iter_route_contexts

NO_BODY = {204}


def _api_routes(app):
    for ctx in iter_route_contexts(app.routes):
        route = ctx.original_route
        if not isinstance(route, APIRoute) or not ctx.path.startswith("/api"):
            continue
        if not route.include_in_schema:
            continue  # HEAD companions of a GET that is listed
        methods = sorted(ctx.methods - {"HEAD", "OPTIONS"})
        if methods:
            yield methods[0], ctx.path, route


def _is_default_json(route: APIRoute) -> bool:
    return isinstance(route.response_class, DefaultPlaceholder)


def test_every_json_route_has_a_response_model(app):
    missing = []
    for method, path, route in _api_routes(app):
        if route.status_code in NO_BODY or not _is_default_json(route):
            continue
        if route.response_model in (None, dict, Any):
            missing.append(f"{method} {path}")
    assert missing == [], (
        "Give these routes a response_model (schemas.py / response_schemas.py), "
        "or declare responses= if they do not return JSON: " + ", ".join(missing)
    )


def test_non_json_routes_declare_their_media_type(app):
    undeclared = []
    for method, path, route in _api_routes(app):
        if route.status_code in NO_BODY or _is_default_json(route):
            continue
        content = (route.responses.get(200) or {}).get("content") or {}
        if not content or "application/json" in content:
            undeclared.append(f"{method} {path}")
    assert undeclared == [], (
        "Routes with a custom response_class need responses={200: {'content': ...}}: "
        + ", ".join(undeclared)
    )


def test_the_openapi_schema_lists_a_model_for_each_json_response(app):
    schema = app.openapi()
    bare = []
    for path, item in schema["paths"].items():
        for method, op in item.items():
            ok = op["responses"].get("200") or op["responses"].get("201")
            if not ok or "content" not in ok:
                continue
            json_body = ok["content"].get("application/json")
            if json_body is not None and json_body.get("schema") in (None, {}):
                bare.append(f"{method.upper()} {path}")
    assert bare == []
