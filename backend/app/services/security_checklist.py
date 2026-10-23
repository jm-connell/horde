"""The Security checklist in Settings → System: facts the server knows, as pass/warn.

It is guidance for someone about to put Horde on the internet (or who already did),
not a scanner: every line is a fact the process can see about itself and the
request that asked (was it HTTPS, is a proxy trusted, which names are allowed,
who has two-step sign-in). ``evaluate`` is a pure function of ``Facts`` so each
rule is easy to test; ``api/system.py`` gathers the facts.

``docs`` is a path under the wiki (``/wiki/<docs>``), into
``docs/ops/internet-exposure.md``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .auth import two_factor

Status = Literal["ok", "warn"]


@dataclass(frozen=True)
class Facts:
    #: This request arrived over HTTPS (directly, or via a trusted proxy header).
    https: bool = False
    #: ``HORDE_TRUST_PROXY``.
    trust_proxy: bool = False
    #: The request carries ``X-Forwarded-*`` headers: something is proxying it.
    proxied: bool = False
    #: Names in ``HORDE_ALLOWED_HOSTS`` that are not LAN names.
    public_hosts: tuple[str, ...] = ()
    #: ``HORDE_ALLOWED_HOSTS=*``.
    any_host: bool = False
    require_two_factor: str = two_factor.REQUIRE_OFF
    #: Usernames of enabled administrators without two-step sign-in.
    admins_without_two_factor: tuple[str, ...] = ()
    #: Usernames of enabled non-administrators without it (only read when it is
    #: required of everyone).
    members_without_two_factor: tuple[str, ...] = ()
    auth_disabled: bool = False
    allow_private_urls: bool = False
    #: ``None``: the check could not be made.
    update_available: bool | None = None


@dataclass(frozen=True)
class Item:
    id: str
    status: Status
    title: str
    detail: str
    docs: str


@dataclass(frozen=True)
class Checklist:
    #: A public name is allowed, so Horde is (or is about to be) reachable from outside.
    exposed: bool
    items: list[Item] = field(default_factory=list)


def _item(id_: str, ok: bool, title: str, good: str, bad: str, docs: str) -> Item:
    return Item(id_, "ok" if ok else "warn", title, good if ok else bad, docs)


def _names(usernames: tuple[str, ...]) -> str:
    """The first five names, then how many more."""
    text = ", ".join(usernames[:5])
    if len(usernames) > 5:
        text += f" and {len(usernames) - 5} more"
    return text


def evaluate(facts: Facts) -> Checklist:
    exposed = bool(facts.public_hosts) or facts.any_host
    names = _names(facts.admins_without_two_factor)
    required = facts.require_two_factor == two_factor.REQUIRE_EVERYONE
    items = [
        _item(
            "https",
            facts.https,
            "Opened over HTTPS",
            "This page came over an encrypted connection.",
            "This page came over plain HTTP, so passwords and the session cookie "
            "cross the network unencrypted. Fine on a trusted LAN; put TLS in front "
            "before exposing Horde.",
            "ops/internet-exposure/#tls",
        ),
        _item(
            "proxy",
            facts.trust_proxy or not facts.proxied,
            "Proxy headers",
            "HORDE_TRUST_PROXY is set: the client address and HTTPS come from your proxy."
            if facts.trust_proxy
            else "No proxy in front of Horde was detected.",
            "A proxy is forwarding requests but HORDE_TRUST_PROXY is off. Every "
            "visitor looks like one address (one shared sign-in throttle) and the "
            "session cookie is not marked Secure.",
            "ops/internet-exposure/#proxy",
        ),
        _item(
            "hosts",
            not facts.any_host,
            "Allowed host names",
            "Only the names in HORDE_ALLOWED_HOSTS (and local names) are accepted: "
            + ", ".join(facts.public_hosts)
            if facts.public_hosts
            else "Only local names are accepted, which is right for a LAN install.",
            "HORDE_ALLOWED_HOSTS is *, which accepts any Host header and switches "
            "off the protection against DNS rebinding. List your public name instead.",
            "ops/internet-exposure/#hosts",
        ),
        _item(
            "two_factor_required",
            required,
            "Two-step sign-in required",
            "Everyone must use two-step sign-in.",
            "Two-step sign-in is optional"
            + (" for members" if facts.require_two_factor == "admins" else "")
            + ". For an internet-facing server require it of everyone in "
            "Settings → System.",
            "ops/internet-exposure/#two-step",
        ),
        _item(
            "admins_two_factor",
            not facts.admins_without_two_factor,
            "Administrators use two-step sign-in",
            "Every administrator has it on.",
            f"Without two-step sign-in: {names}.",
            "ops/internet-exposure/#two-step",
        ),
        *(
            [
                _item(
                    "members_two_factor",
                    not facts.members_without_two_factor,
                    "Every account has enrolled",
                    "Every account has two-step sign-in on.",
                    "Not enrolled yet: "
                    f"{_names(facts.members_without_two_factor)}. Until an account "
                    "enrolls, anyone who learns its password can set up their own "
                    "authenticator on it first. Have every account enroll before "
                    "you open the port.",
                    "ops/internet-exposure/#two-step",
                )
            ]
            if required
            else []
        ),
        _item(
            "auth_enabled",
            not facts.auth_disabled,
            "Sign-in is on",
            "Horde asks everyone to sign in.",
            "HORDE_AUTH_DISABLED is set: anyone who can reach the port acts as an "
            "administrator unless your proxy authenticates them. Never on the internet "
            "without one.",
            "ops/internet-exposure/#no-auth",
        ),
        _item(
            "private_urls",
            not facts.allow_private_urls,
            "Downloads cannot reach private addresses",
            "Links that point at your LAN are refused.",
            "HORDE_ALLOW_PRIVATE_URLS is set: a signed-in user can make the server "
            "fetch addresses on your network.",
            "ops/internet-exposure/#private-urls",
        ),
        _item(
            "updates",
            facts.update_available is False,
            "Up to date",
            "This is the newest release.",
            "A newer release is available. Keep an internet-facing server updated."
            if facts.update_available
            else "Horde could not check for updates just now.",
            "ops/internet-exposure/#updates",
        ),
    ]
    return Checklist(exposed=exposed, items=items)
