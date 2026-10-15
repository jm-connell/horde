"""Request-level security wiring for the app (see the middleware stack added next)."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .services.url_safety import UnsafeUrlError


async def _unsafe_url_handler(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


def install_security(app: FastAPI) -> None:
    """Map a refused outbound URL (url_safety) to HTTP 400."""
    app.add_exception_handler(UnsafeUrlError, _unsafe_url_handler)
