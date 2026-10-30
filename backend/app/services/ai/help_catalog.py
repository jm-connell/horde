"""The settings and pages Ask about Horde can link to and change.

``help_catalog.json`` (beside this module) lists every setting worth pointing
someone at: where it lives (tab, pane and the ``data-setting`` anchor the page
flashes), who can see it, and whether the chat may offer to change it
(``chat: change``) or only link to it (``chat: link``: anything sensitive,
costly or hard to undo). The chat panel reads the same list from
``GET /api/ai/help/catalog`` to turn the model's ``[[setting:id]]`` and
``[[set:id=value]]`` tokens into links and Apply cards, so a token can only
name something that exists.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path

from ... import context as app_context
from ...schemas import HelpCatalog, HelpCatalogPage, HelpCatalogSetting
from ..auth.accounts import AuthUser

_PATH = Path(__file__).with_name("help_catalog.json")
#: Settings described to the model per question (the best matches).
PROMPT_SETTINGS = 14


def load() -> HelpCatalog:
    """The whole catalog, parsed and checked once per app context."""
    caches = app_context.current().caches
    catalog: HelpCatalog | None = caches.get("help_catalog")
    if catalog is None:
        catalog = parse(json.loads(_PATH.read_text(encoding="utf-8")))
        caches["help_catalog"] = catalog
    return catalog


def parse(raw: object) -> HelpCatalog:
    """Validate the catalog's shape and the rules between its fields."""
    catalog = HelpCatalog.model_validate(raw)
    ids = [p.id for p in catalog.pages] + [s.id for s in catalog.settings]
    for entry_id in ids:
        if ids.count(entry_id) > 1:
            raise ValueError(f"help catalog: duplicate id {entry_id!r}")
    for setting in catalog.settings:
        _check_setting(setting)
    return catalog


def _check_setting(s: HelpCatalogSetting) -> None:
    where = f"help catalog: {s.id}"
    if s.tab is None and s.path == "/settings":
        raise ValueError(f"{where}: a settings entry needs a tab")
    if s.chat == "link":
        if s.scope or s.key or s.type:
            raise ValueError(f"{where}: a link-only entry has no key")
        return
    if not (s.scope and s.key and s.type):
        raise ValueError(f"{where}: a changeable entry needs scope, key and type")
    if s.scope != "personal" and s.access != "admin":
        raise ValueError(f"{where}: server-wide settings are for administrators")
    if s.type == "enum" and not s.options:
        raise ValueError(f"{where}: an enum needs options")
    if s.type == "number" and (s.min is None or s.max is None or s.min >= s.max):
        raise ValueError(f"{where}: a number needs min < max")


def can_see(user: AuthUser, access: str | None) -> bool:
    if access is None:
        return True
    return user.is_admin if access == "admin" else user.can(access)


def for_user(user: AuthUser) -> HelpCatalog:
    """The entries this person can open (the rest do not exist for them)."""
    catalog = load()
    return HelpCatalog(
        pages=[p for p in catalog.pages if can_see(user, p.access)],
        settings=[s for s in catalog.settings if can_see(user, s.access)],
    )


def _terms(text: str) -> list[str]:
    # Imported here: help_chat imports this module.
    from .help_chat import tokenize

    return tokenize(text)


def best_settings(
    catalog: HelpCatalog, query: dict[str, float], *, limit: int = PROMPT_SETTINGS
) -> list[HelpCatalogSetting]:
    """The settings whose label, description and keywords best match ``query``."""
    docs = [
        Counter(_terms(f"{s.label} {s.label} {s.id} {s.about} {s.keywords}"))
        for s in catalog.settings
    ]
    total = len(docs) or 1
    df: Counter[str] = Counter()
    for doc in docs:
        df.update(doc.keys())
    scored: list[tuple[float, int]] = []
    for index, doc in enumerate(docs):
        score = 0.0
        for term, weight in query.items():
            if term in doc:
                idf = math.log(1 + total / df[term])
                score += weight * idf * min(doc[term], 2)
        if score > 0:
            scored.append((score, index))
    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    return [catalog.settings[i] for _, i in scored[:limit]]


def _value_text(value: str | float) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def setting_line(s: HelpCatalogSetting) -> str:
    """One line describing a setting to the model."""
    where = s.tab.capitalize() if s.tab else s.path
    if s.chat == "link":
        how = "link only, you cannot change it"
    elif s.type == "bool":
        how = "change: true|false"
    elif s.type == "enum":
        values = "|".join(_value_text(o.value) for o in s.options or [])
        how = f"change: {values}"
    elif s.type == "number":
        how = f"change: a number from {_value_text(s.min or 0.0)} to {_value_text(s.max or 0.0)}"
    else:
        how = "change: a #rrggbb color"
    return f"- {s.id}: {s.label} ({where}) [{how}] {s.about}"


def page_line(p: HelpCatalogPage) -> str:
    return f"- {p.id}: {p.label} ({p.path}) {p.about}"
