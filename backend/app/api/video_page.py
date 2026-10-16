"""Cursor paging for the video list endpoints (library and review queue)."""

from __future__ import annotations

import secrets
from collections.abc import Callable, Mapping

from fastapi import HTTPException
from sqlmodel import Session

from ..models import UserVideoState, Video, require_id
from ..response_schemas import VideoPage
from ..schemas import VideoRead
from ..services import library, user_state
from ..services.pagination import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    SEED_RANGE,
    InvalidCursor,
    PageRequest,
    keyset_cursor,
    offset_cursor,
    parse_cursor,
)

__all__ = ["DEFAULT_LIMIT", "MAX_LIMIT", "page_request", "build_page"]


def page_request(
    cursor: str | None,
    *,
    limit: int,
    sort: str,
    order: str,
    seed: int | None,
    searching: bool = False,
) -> tuple[PageRequest, int | None]:
    """The requested page and the shuffle seed to use for it.

    A random order needs one seed for the whole walk, so the first page picks one
    (when the client sent none) and every cursor carries it.
    """
    try:
        page = parse_cursor(
            cursor,
            limit=limit,
            sort=sort,
            order=order,
            kind="offset" if searching else "keyset",
        )
    except InvalidCursor as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if sort != "random":
        return page, seed
    # The cursor's seed wins over a different one in the query string: the walk
    # must keep the shuffle its first page was made with.
    effective = page.seed if page.seed is not None else seed
    if effective is None:
        effective = secrets.randbelow(SEED_RANGE)
    return page, effective % SEED_RANGE


def build_page(
    rows: list[Video],
    page: PageRequest,
    *,
    sort: str,
    order: str,
    seed: int | None,
    session: Session,
    user_id: int,
    serialize: Callable[[list[Video], Mapping[int, UserVideoState]], list[VideoRead]],
    total: int | None = None,
    keyset: bool = True,
) -> VideoPage:
    """Trim the ``limit + 1`` rows to a page, serialize them and make the next cursor.

    ``keyset`` is false when ``rows`` came from a ranking the database cannot
    express (text search); the cursor is then an offset into it.
    """
    more = len(rows) > page.limit
    rows = rows[: page.limit]
    states = user_state.get_states(session, user_id, (v.id for v in rows if v.id))
    next_cursor = None
    if more and rows:
        last = rows[-1]
        last_id = require_id(last)
        if keyset:
            next_cursor = keyset_cursor(
                sort=sort,
                order=order,
                value=library.sort_value(last, sort, states.get(last_id), seed or 0),
                last_id=last_id,
                seed=seed if sort == "random" else None,
            )
        else:
            next_cursor = offset_cursor(
                sort=sort,
                order=order,
                offset=page.offset + page.limit,
                seed=seed if sort == "random" else None,
            )
    return VideoPage(
        items=serialize(rows, states), next_cursor=next_cursor, total=total
    )
