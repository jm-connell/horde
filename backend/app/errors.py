"""One error envelope for the whole API.

Every error response, whatever raised it, has this body::

    {"detail": "<human readable message>", "code": "<snake_case>",
     "fields": [{"loc": [...], "msg": "..."}],   # validation errors only
     "extra": {...}}                              # optional machine readable context

``detail`` is always a string, so a client that only shows a message keeps working;
``code`` is what a client branches on. The handlers in ``install_error_handlers``
cover FastAPI/Starlette ``HTTPException`` (including router 404/405), request
validation, the app's own domain exceptions and anything unhandled (a generic 500
that echoes the request id and logs the traceback).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .request_context import REQUEST_ID_HEADER
from .response_schemas import ErrorResponse
from .services.auth.accounts import AccountError
from .services.url_safety import UnsafeUrlError

logger = logging.getLogger(__name__)

#: Code for a plain ``HTTPException`` that did not name one, by status.
STATUS_CODES: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    410: "gone",
    413: "payload_too_large",
    415: "unsupported_media_type",
    416: "range_not_satisfiable",
    422: "validation_error",
    423: "locked",
    429: "rate_limited",
    500: "internal_error",
    501: "not_implemented",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "gateway_timeout",
}


def default_code(status_code: int) -> str:
    if status_code in STATUS_CODES:
        return STATUS_CODES[status_code]
    return "client_error" if status_code < 500 else "server_error"


class CodedHTTPException(StarletteHTTPException):
    """An HTTP error with a machine-readable ``code`` and optional ``extra`` context."""

    def __init__(
        self,
        status_code: int,
        detail: str,
        code: str | None = None,
        *,
        extra: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            detail=detail,
            headers=dict(headers) if headers else None,
        )
        self.code = code or default_code(status_code)
        self.extra = dict(extra) if extra else None


def error_body(
    detail: str,
    code: str,
    *,
    fields: list[dict[str, Any]] | None = None,
    extra: Mapping[str, Any] | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    return ErrorResponse(
        detail=detail,
        code=code,
        fields=fields or None,
        extra=dict(extra) if extra else None,
        request_id=request_id,
    ).model_dump(exclude_none=True)


def error_response(
    status_code: int,
    detail: str,
    code: str | None = None,
    *,
    fields: list[dict[str, Any]] | None = None,
    extra: Mapping[str, Any] | None = None,
    request_id: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        error_body(
            detail,
            code or default_code(status_code),
            fields=fields,
            extra=extra,
            request_id=request_id,
        ),
        status_code=status_code,
        headers=dict(headers) if headers else None,
    )


def extraction_error(status_code: int, detail: Mapping[str, str]) -> CodedHTTPException:
    """Turn ``ytdlp_common.http_detail_for_error`` output into the envelope."""
    return CodedHTTPException(
        status_code,
        detail["message"],
        "extract_failed",
        extra={"error_kind": detail["error_kind"]},
    )


def _message(detail: Any) -> str:
    if isinstance(detail, str):
        return detail
    if isinstance(detail, Mapping) and isinstance(detail.get("message"), str):
        return detail["message"]
    return str(detail)


async def http_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    http = cast(StarletteHTTPException, exc)
    return error_response(
        http.status_code,
        _message(http.detail),
        getattr(http, "code", None),
        extra=getattr(http, "extra", None),
        headers=http.headers,
    )


_NOT_JSON = "Request body is not valid JSON"
_LOC_ROOTS = ("body", "query", "path", "header", "cookie")


def _where(loc: tuple[Any, ...]) -> str:
    """The field path without the leading "body"/"query" marker."""
    return ".".join(
        str(p) for i, p in enumerate(loc) if not (i == 0 and p in _LOC_ROOTS)
    )


async def validation_exception_handler(
    _request: Request, exc: Exception
) -> JSONResponse:
    errors = cast(RequestValidationError, exc).errors()
    if any(e["type"] == "json_invalid" for e in errors):
        # Pydantic locates the syntax error by character offset ("body", 1), which
        # reads as a field name; say what is wrong instead.
        return error_response(
            422,
            _NOT_JSON,
            "validation_error",
            fields=[{"loc": ["body"], "msg": _NOT_JSON}],
        )
    fields = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in errors]
    parts = []
    for e in errors:
        where = _where(tuple(e["loc"]))
        parts.append(f"{where}: {e['msg']}" if where else e["msg"])
    return error_response(
        422, "; ".join(parts) or "Invalid request", "validation_error", fields=fields
    )


async def account_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    error = cast(AccountError, exc)
    return error_response(error.status_code, error.message, error.code)


async def unsafe_url_handler(_request: Request, exc: Exception) -> JSONResponse:
    return error_response(400, str(exc), "unsafe_url")


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last resort: a generic 500 that never leaks internals.

    Runs in Starlette's outermost middleware, so the request id comes from the
    request state (the id middleware has already unwound its log context).
    """
    request_id = getattr(request.state, "request_id", None)
    logger.error(
        "Unhandled error on %s %s",
        request.method,
        request.url.path,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    # Imported here: security.py imports this module for its own error responses.
    from .security import security_headers

    # This response is sent by Starlette's ServerErrorMiddleware, outside the
    # security-headers middleware, so it has to carry the headers itself.
    headers = security_headers(request.url.path)
    if request_id:
        headers[REQUEST_ID_HEADER] = request_id
    return error_response(
        500,
        "Something went wrong on the server"
        + (f" (request {request_id})." if request_id else "."),
        "internal_error",
        request_id=request_id,
        headers=headers,
    )


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(AccountError, account_error_handler)
    app.add_exception_handler(UnsafeUrlError, unsafe_url_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
