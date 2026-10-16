"""Response models for routes that used to return ad-hoc dicts, plus the error
envelope and the pagination wrapper.

Models that belong to one area of the API and already live in ``schemas.py`` stay
there; this module holds the ones added when every JSON route got a
``response_model``.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ErrorField(BaseModel):
    loc: list[str | int]
    msg: str


class ErrorResponse(BaseModel):
    """The body of every error response (see ``app/errors.py``)."""

    detail: str
    code: str
    fields: list[ErrorField] | None = None
    extra: dict[str, Any] | None = None
    request_id: str | None = Field(
        default=None, description="Echo of X-Request-ID, set on unhandled 500s."
    )
