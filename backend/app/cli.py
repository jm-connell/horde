"""Recovery commands, run inside the container:

    docker exec -it horde python -m app.cli reset-password <username>
    docker exec -it horde python -m app.cli create-admin <username>
    docker exec -it horde python -m app.cli reset-2fa <username>

The password is prompted for (twice) on a terminal, or read from standard input
when piped (``echo 'new password' | docker exec -i horde python -m app.cli ...``).
Resetting a password also signs that user out everywhere. ``reset-2fa`` turns
off the account's two-step sign-in (a lost phone and no recovery codes) and signs
it out everywhere too.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from sqlmodel import Session

from . import context, database
from .models import require_id
from .services.auth import accounts, two_factor


def _read_password(prompt_name: str) -> str:
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\r\n")
    first = getpass.getpass(f"New password for {prompt_name}: ")
    if getpass.getpass("Repeat password: ") != first:
        raise accounts.AccountError("The passwords do not match")
    return first


def _reset_password(session: Session, username: str) -> str:
    user = accounts.get_by_username(session, username)
    if user is None:
        raise accounts.UserNotFound(f"No user named {username!r}")
    accounts.update_user(
        session,
        require_id(user),
        password=_read_password(user.username),
        disabled=False,
    )
    return f"Password updated for {user.username}. They are signed out everywhere."


def _create_admin(session: Session, username: str) -> str:
    name, _ = accounts.clean_username(username)
    user = accounts.create_user(session, name, _read_password(name), is_admin=True)
    return f"Created administrator {user.username}."


def _reset_two_factor(session: Session, username: str) -> str:
    user = accounts.get_by_username(session, username)
    if user is None:
        raise accounts.UserNotFound(f"No user named {username!r}")
    two_factor.reset(session, require_id(user))
    return (
        f"Two-step sign-in is off for {user.username}. They are signed out everywhere."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, text in (
        ("reset-password", "Set a new password (also re-enables the account)"),
        ("create-admin", "Create an administrator account"),
        ("reset-2fa", "Turn off an account's two-step sign-in"),
    ):
        command = sub.add_parser(name, help=text)
        command.add_argument("username")
    args = parser.parse_args(argv)

    database.init_db()
    handler = {
        "reset-password": _reset_password,
        "create-admin": _create_admin,
        "reset-2fa": _reset_two_factor,
    }[args.command]
    try:
        with context.new_session() as session:
            print(handler(session, args.username))
    except accounts.AccountError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
