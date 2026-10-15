"""Request correlation: one ``request_id`` per HTTP request, echoed to the client."""

from __future__ import annotations

import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .logging_config import request_id_var, sane_request_id

REQUEST_ID_HEADER = "X-Request-ID"


class RequestIdMiddleware:
    """Sets the ``request_id`` log context and the ``X-Request-ID`` response header.

    The client's own ``X-Request-ID`` is reused when it is short and printable (so a
    reverse proxy's ID follows the request into Horde's logs); otherwise a new one is
    generated.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = None
        for key, value in scope["headers"]:
            if key == b"x-request-id":
                incoming = sane_request_id(value.decode("latin-1"))
                break
        request_id = incoming or uuid.uuid4().hex[:16]
        token = request_id_var.set(request_id)

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            request_id_var.reset(token)
