"""Count the SQL statements a block of code runs."""

from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy import event


@contextmanager
def count_queries(engine):
    statements: list[str] = []

    def before(_conn, _cursor, statement, *_rest):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", before)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", before)
