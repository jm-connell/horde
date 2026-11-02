"""Saved Recommended+ algorithms: named ``Tuning`` values, kept or shared.

A user saves their own values under a name ("Weeknight"), optionally shared
with every account. Picking someone else's shared algorithm ranks with it as it
is, so its owner's later changes reach them too; moving a slider makes the
user's own copy ("Custom"), so nobody changes someone else's algorithm. When an
algorithm is deleted or stops being shared, everyone else ranking with it keeps
its last values as their own (``_release``).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, or_, select

from ...models import RecAlgorithm, User, UserSettings, require_id, utcnow
from . import tuning
from .tuning import Selection, Tuning

logger = logging.getLogger(__name__)

MAX_NAME = 60
#: Saved algorithms one person may keep.
MAX_PER_USER = 30


class NameTaken(ValueError):
    """The owner already has an algorithm with this name."""


class TooMany(ValueError):
    """Over ``MAX_PER_USER`` saved algorithms."""


@dataclass
class Listed:
    row: RecAlgorithm
    owner: str
    mine: bool
    values: Tuning


def values_of(row: RecAlgorithm) -> Tuning:
    try:
        return Tuning.model_validate(json.loads(row.tuning_json))
    except json.JSONDecodeError, ValidationError:
        logger.warning(
            "Unreadable saved algorithm %s; using Balanced", row.id, exc_info=True
        )
        return tuning.DEFAULTS


def available(session: Session, user_id: int, algo_id: int) -> RecAlgorithm | None:
    """The algorithm, when it is the user's own or shared."""
    row = session.get(RecAlgorithm, algo_id)
    if row is None or (row.owner_id != user_id and not row.shared):
        return None
    return row


def listed(session: Session, user_id: int) -> list[Listed]:
    """The user's own algorithms, then the ones others share, by name."""
    rows = session.exec(
        select(RecAlgorithm, User.username)
        .join(User, col(User.id) == col(RecAlgorithm.owner_id))
        .where(or_(RecAlgorithm.owner_id == user_id, col(RecAlgorithm.shared)))
    ).all()
    out = [
        Listed(row, owner, row.owner_id == user_id, values_of(row))
        for row, owner in rows
    ]
    out.sort(key=lambda a: (not a.mine, a.row.name.casefold(), a.owner.casefold()))
    return out


def current(session: Session, user_id: int) -> tuple[Selection, Tuning]:
    """The user's selection and the values it ranks with right now.

    A saved algorithm that went away (deleted, or no longer shared) leaves the
    user on their own copy of its last values.
    """
    selection = tuning.load(session, user_id)
    algo_id = tuning.algorithm_id(selection.active)
    if algo_id is None:
        return selection, tuning.resolve(selection)
    row = available(session, user_id, algo_id)
    if row is None:
        selection = Selection(
            active="custom",
            custom=selection.snapshot or selection.custom or tuning.DEFAULTS,
        )
        tuning.save(session, user_id, selection)
        return selection, tuning.resolve(selection)
    values = values_of(row)
    if selection.snapshot != values:
        selection.snapshot = values
        tuning.save(session, user_id, selection)
    return selection, values


def _clean_name(name: str) -> str:
    return " ".join(name.split())[:MAX_NAME]


def _check_name(session: Session, owner_id: int, name: str, own_id: int | None) -> None:
    """Names are unique per owner, whatever their case."""
    for other_id, other in session.exec(
        select(RecAlgorithm.id, RecAlgorithm.name).where(
            RecAlgorithm.owner_id == owner_id
        )
    ).all():
        if other_id != own_id and other.casefold() == name.casefold():
            raise NameTaken(f"You already have an algorithm called {other}")


def create(
    session: Session, user_id: int, *, name: str, shared: bool, values: Tuning
) -> RecAlgorithm:
    count = len(
        session.exec(
            select(RecAlgorithm.id).where(RecAlgorithm.owner_id == user_id)
        ).all()
    )
    if count >= MAX_PER_USER:
        raise TooMany(f"At most {MAX_PER_USER} saved algorithms")
    _check_name(session, user_id, _clean_name(name), None)
    row = RecAlgorithm(
        owner_id=user_id,
        name=_clean_name(name),
        shared=shared,
        tuning_json=values.model_dump_json(),
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise NameTaken(f"You already have an algorithm called {row.name}") from exc
    session.refresh(row)
    return row


def update(
    session: Session,
    row: RecAlgorithm,
    *,
    name: str | None = None,
    shared: bool | None = None,
    values: Tuning | None = None,
) -> RecAlgorithm:
    unshared = shared is False and row.shared
    if name is not None:
        _check_name(session, row.owner_id, _clean_name(name), row.id)
        row.name = _clean_name(name)
    if shared is not None:
        row.shared = shared
    if values is not None:
        row.tuning_json = values.model_dump_json()
    row.updated_at = utcnow()
    session.add(row)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise NameTaken(f"You already have an algorithm called {row.name}") from exc
    session.refresh(row)
    if unshared:
        _release(session, row, values_of(row))
    return row


def delete(session: Session, row: RecAlgorithm) -> None:
    last = values_of(row)
    algo_id = require_id(row)
    session.delete(row)
    session.commit()
    _release(session, row, last, deleted_id=algo_id)


def _release(
    session: Session, row: RecAlgorithm, last: Tuning, *, deleted_id: int | None = None
) -> list[int]:
    """Put everyone else ranking with ``row`` on their own copy of ``last``;
    the owner too when it was deleted. Returns their user ids."""
    algo_id = deleted_id if deleted_id is not None else require_id(row)
    active = f"{tuning.ALGORITHM_PREFIX}{algo_id}"
    moved: list[int] = []
    for settings in session.exec(
        select(UserSettings).where(
            col(UserSettings.rec_tuning_json).contains(f'"{active}"')
        )
    ).all():
        if deleted_id is None and settings.user_id == row.owner_id:
            continue
        selection = tuning.load(session, settings.user_id)
        if selection.active == active:
            tuning.save(
                session, settings.user_id, Selection(active="custom", custom=last)
            )
            moved.append(settings.user_id)
        elif selection.based_on == algo_id:
            selection.based_on = None
            tuning.save(session, settings.user_id, selection)
    return moved
