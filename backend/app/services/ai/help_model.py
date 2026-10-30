"""Which model Ask about Horde runs on, and what that means for the user.

The assistant uses the administrator's Assistant model when one is set, else
the chat model every other AI feature uses. Its rough strength (``tier``)
comes from the model's name: small local models can link to settings and
answer how-to questions but write poor CSS, so the chat says so and suggests
something better. Whether the provider runs on this network decides how the
panel words its notice about sending library data.
"""

from __future__ import annotations

import ipaddress
import re
from typing import Literal
from urllib.parse import urlparse

from ...schemas import HelpAssistantInfo
from .. import app_settings
from ..auth.accounts import AuthUser
from .provider import Connection, chat_connection, llm_features_allowed

Tier = Literal["small", "medium", "large"]

#: Parameter counts in names: ``llama3.2:3b``, ``qwen3-235b-a22b``, ``8x7b``.
_SIZE = re.compile(r"(?<![a-z0-9.])(?:\d+x)?(\d+(?:\.\d+)?)b(?![a-z])")
_SMALL_WORDS = frozenset({"nano", "tiny"})
#: Small local families whose names carry no size (``tinyllama``, ``smollm2``).
_SMALL_FAMILIES = ("tiny", "smol")
#: Hosted model ids (``vendor/model`` or a vendor's own names). Family words
#: such as "flash" or "deepseek" only mean large there: a bare Ollama tag
#: like ``deepseek-r1`` is a 7B model.
_HOSTED_PREFIXES = ("gpt-", "claude", "gemini", "o3", "o4")
_MEDIUM_WORDS = frozenset({"lite", "mini", "haiku", "small"})
_LARGE_WORDS = frozenset(
    {"pro", "sonnet", "opus", "claude", "deepseek", "grok", "flash", "large"}
    | {"kimi", "glm"}
)
_LARGE_FAMILIES = ("gpt-4.1", "gpt-4o", "gpt-5")
_NAME_PARTS = re.compile(r"[/:_\-\s]+")
#: Hostnames that never leave the network (Docker service names have no dot).
_LOCAL_SUFFIXES = (".local", ".lan", ".internal", ".home.arpa", ".localdomain")


def assistant_model() -> str:
    """The model the assistant asks: the Assistant model, else the chat model."""
    from .workload import ensure_quality_chat_model

    chosen = str(app_settings.ai_settings().get("help_model") or "").strip()
    return chosen or ensure_quality_chat_model()


def tier(model: str) -> Tier:
    """A rough strength class from the model's name (``medium`` when unsure)."""
    name = model.strip().lower()
    sizes = [float(m) for m in _SIZE.findall(name)]
    if sizes:
        biggest = max(sizes)
        return "small" if biggest <= 4 else "medium" if biggest <= 30 else "large"
    parts = set(_NAME_PARTS.split(name))
    if parts & _SMALL_WORDS or name.startswith(_SMALL_FAMILIES):
        return "small"
    if parts & _MEDIUM_WORDS:
        return "medium"
    hosted = "/" in name or name.startswith(_HOSTED_PREFIXES)
    if hosted and (parts & _LARGE_WORDS or any(f in name for f in _LARGE_FAMILIES)):
        return "large"
    return "medium"


def is_local(conn: Connection | None) -> bool:
    """Whether the endpoint is this machine or the local network."""
    if conn is None:
        return False
    try:
        host = (urlparse(conn.base_url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host or host.endswith(_LOCAL_SUFFIXES)
    return address.is_private or address.is_loopback or address.is_link_local


def provider_label(conn: Connection | None, *, is_admin: bool) -> str:
    """Where questions go, in words (members do not see the address)."""
    if conn is None:
        return ""
    if conn.is_openrouter:
        return "OpenRouter, a cloud AI service"
    if is_local(conn):
        return "the AI server on your own network"
    if is_admin:
        host = urlparse(conn.base_url).hostname or conn.base_url
        return f"{host}, an outside AI service"
    return "an outside AI service"


def configured_model() -> str:
    """The assistant's model as saved, without checking or pulling anything."""
    ai = app_settings.ai_settings()
    return str(ai.get("help_model") or ai.get("chat_model") or "").strip()


def info(user: AuthUser) -> HelpAssistantInfo:
    # A GET: read the settings only (assistant_model() may save and pull).
    conn = chat_connection()
    available = llm_features_allowed()[0] and conn is not None
    model = configured_model() if available else ""
    return HelpAssistantInfo(
        model=(model or None) if user.is_admin else None,
        tier=tier(model) if model else "medium",
        provider_label=provider_label(conn, is_admin=user.is_admin),
        local=is_local(conn),
        available=available,
    )


def prompt_note(model: str, *, is_admin: bool) -> str:
    """What the model is told about itself, and what to recommend."""
    strength = tier(model)
    conn = chat_connection()
    if conn is not None and conn.is_openrouter:
        better = (
            "on OpenRouter, google/gemini-2.5-flash or openai/gpt-4.1-mini, "
            "or for the best CSS google/gemini-2.5-pro or anthropic/claude-sonnet-4.5"
        )
    elif is_local(conn):
        better = (
            "a local model of 14B or more such as qwen2.5:14b (about 12 GB of "
            "GPU memory), or an OpenRouter key with google/gemini-2.5-flash"
        )
    else:
        better = "a larger model from the same provider"
    who = (
        "The administrator can give you a stronger model without changing the "
        "one background jobs use: the Assistant model under [[setting:ai-models]]."
        if is_admin
        else "The administrator chooses the model; suggest they set a stronger "
        "Assistant model in Settings → AI."
    )
    names = model if is_admin else "the administrator's model"
    lines = [f"You run on {names}, which counts as a {strength} model."]
    if strength == "small":
        lines.append(
            "Small models write unreliable CSS. When asked for CSS, say so "
            f"plainly, still try if they insist, and recommend {better}. {who}"
        )
    elif strength == "medium":
        lines.append(
            "Your CSS is usually fine for simple changes (colors, sizes, "
            "spacing, hiding things). For a complete redesign, mention that "
            f"{better} does better. {who}"
        )
    return " ".join(lines)
