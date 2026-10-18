# 0012. Forgotten passwords: a one-time code in the server log

Status: Accepted

## Context

Horde has no email, so it cannot send a reset link. A member who forgot their password could ask an administrator; a lone administrator had only the recovery CLI (`docker exec -it horde python -m app.cli reset-password <name>`), which most home-server users never find. The sign-in page offered nothing.

## Decision

**"Forgot password?" on the sign-in page writes a one-time code to the server log.** `POST /api/auth/forgot` logs, at WARNING, `PASSWORD RESET CODE for '<name>': XXXXX-XXXXX` with the asking address. Whoever runs the server reads it (`docker logs horde`, the TrueNAS app log) and enters it on the same page with a new password: `POST /api/auth/reset` checks the code, sets the password, signs the account out everywhere and signs this browser in. Reading the log is the proof of being the owner (or of being trusted by them).

The codes (`services/auth/reset_codes.py`) live in memory on the app's `AuthRuntime`, hashed: 10 characters from an unambiguous alphabet (about 49 bits), valid 15 minutes, redeemed atomically so each works once, and bound to the account id and its current password hash, so a password change or a recreated account voids them. The three newest codes of an account stay valid (asking on someone's behalf cannot replace the code they just read); 5 wrong guesses cancel them; at most one new code per account every 30 seconds, also after the guesses ran out, so the log cannot be flooded. A normal sign-in cancels pending codes. Wrong codes also count in the sign-in throttle (`reset:<name>` key). `forgot` answers `204` whether or not the account exists, and logs nothing for unknown or disabled accounts. Both routes are public (they have to be, the person is signed out) and refused when `HORDE_AUTH_DISABLED` is set.

**Rejected:** writing a temporary *password* to the log. Then anyone on the network could replace an account's password by pressing the button, locking its owner out until they read the log; a code changes nothing until it is used.

## Consequences

- No reinstall or shell is needed to recover a lone administrator, as long as someone can read the container's log. The CLI stays for when they cannot.
- Anyone who can read the log can take over any account by asking for its code. Log access already implies control of the host, so this adds no new holder of that power, but logs shipped to a shared aggregator should be treated as secrets.
- Anyone on the network can ask for codes or burn them with wrong guesses, so they can delay a reset (never perform one). The CLI is the fallback.
- A restart forgets outstanding codes. With `HORDE_LOG_LEVEL=ERROR` the code is not written; use the CLI then.
