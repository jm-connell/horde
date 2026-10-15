"""Per-app authentication state: configuration, throttle, signing key.

One ``AuthRuntime`` is built by ``install_security`` and kept on
``app.state.auth``. Nothing here is module-level state, so each test app (and the
CLI) gets its own limiter and key cache.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field

from fastapi import Request

from ... import config
from . import media_token, passwords
from .limiter import LoginLimiter

logger = logging.getLogger(__name__)

AUTH_DISABLED_ENV = "HORDE_AUTH_DISABLED"
TRUST_PROXY_ENV = "HORDE_TRUST_PROXY"
TRUSTED_USER_HEADER_ENV = "HORDE_TRUSTED_USER_HEADER"


def _truthy(raw: str | None) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class AuthConfig:
    """Operator switches from the environment.

    ``disabled`` is for deployments behind a reverse proxy that already
    authenticates users: Horde stops asking for a login and runs as one
    administrator, or as the account named by ``trusted_user_header`` (honoured
    only with ``trust_proxy``).
    """

    disabled: bool = False
    trust_proxy: bool = False
    trusted_user_header: str = ""

    @classmethod
    def from_env(cls) -> AuthConfig:
        return cls(
            disabled=_truthy(os.environ.get(AUTH_DISABLED_ENV)),
            trust_proxy=_truthy(os.environ.get(TRUST_PROXY_ENV)),
            trusted_user_header=os.environ.get(TRUSTED_USER_HEADER_ENV, "")
            .strip()
            .lower(),
        )


@dataclass
class AuthRuntime:
    config: AuthConfig = field(default_factory=AuthConfig)
    limiter: LoginLimiter = field(default_factory=LoginLimiter)
    #: Serialises "is the user table empty?" with the insert that fills it.
    bootstrap_lock: threading.Lock = field(default_factory=threading.Lock)
    _secret: bytes | None = field(default=None, repr=False)
    _dummy_hash: str | None = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def secret(self) -> bytes:
        """The media-URL signing key (``DATA_DIR/secret_key``, created on first use)."""
        with self._lock:
            if self._secret is None:
                self._secret = media_token.load_or_create_secret(
                    config.DATA_DIR / "secret_key"
                )
            return self._secret

    def dummy_hash(self) -> str:
        """A valid hash nobody knows the password of, for unknown-user timing."""
        with self._lock:
            if self._dummy_hash is None:
                self._dummy_hash = passwords.hash_password(os.urandom(16).hex())
            return self._dummy_hash

    # --- Request helpers --------------------------------------------------

    def client_address(self, request: Request) -> str:
        """The caller's IP; X-Forwarded-For only when a trusted proxy is declared."""
        if self.config.trust_proxy:
            forwarded = request.headers.get("x-forwarded-for", "")
            first = forwarded.split(",")[0].strip()
            if first:
                return first
        return request.client.host if request.client else "unknown"

    def is_https(self, request: Request) -> bool:
        if self.config.trust_proxy:
            proto = request.headers.get("x-forwarded-proto", "")
            if proto:
                return proto.split(",")[0].strip().lower() == "https"
        return request.url.scheme == "https"
