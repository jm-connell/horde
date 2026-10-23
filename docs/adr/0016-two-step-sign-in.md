# 0016. Two-step sign-in: TOTP from the standard library, a ticket between the steps

Status: Accepted

## Context

Horde's sign-in was password only, throttled per address and per name. That is fine on a LAN. It is not enough for someone who wants to reach their server through a public name, where a leaked or guessed password is the whole defence. Horde has no email, so the usual second factors (email codes, magic links) are out, and the project avoids new moving parts.

## Decision

- **TOTP (RFC 6238) from `hmac`/`hashlib`**, SHA-1, 6 digits, 30 s, plus or minus one step: what every authenticator app does. The last accepted step is stored (`users.totp_last_step`) and a code is accepted only for a later step, through a SQL compare-and-set, so a code works once even under concurrent requests.
- **Ten recovery codes**, stored as an HMAC keyed with `secret_key` (which is not in the database), deleted when used.
- **Two requests to sign in.** A right password for a two-step account answers `401 totp_required` with a *ticket*: signed with `secret_key`, five minutes, single use (an in-memory registry), at most five tries, bound to the account's password hash and second-factor state. `POST /api/auth/login/totp` trades ticket plus code for the session. A right password does not clear the failure counters, and wrong codes count in the existing limiter, so alternating a known password with code guesses gains nothing.
- **The reset-by-log flow does not skip it** (ADR 0012): the password changes, the second step is still due.
- **A requirement setting** (`require_two_factor`: off, admins, everyone) enforced in `AuthMiddleware`, once, for every route: an account that must enroll can reach only the state, sign-out and enrollment routes (`403 two_factor_enrollment_required`). Unreadable settings count as "everyone".
- **QR codes are drawn on the server** with `segno` (pure Python, no dependencies), so the secret never reaches a third-party service.
- **Setting up, turning off and replacing recovery codes need the password** (and, for the last two, a code), so a stolen session cannot attach its own authenticator or strip the factor.

## Consequences

- The TOTP secret is stored readable (`users.totp_secret`); a copy of `DATA_DIR` defeats the second factor along with everything else in it. Encrypting it with `secret_key` would protect only a database file stolen without that key; that was judged not worth a home-made cipher or a new dependency, and the docs say to protect backups.
- Tickets live in memory, so a restart cancels sign-ins in progress (the person types the password again).
- The throttle keys on the username and address as before; the new daily ceiling (50 failures per name per 24 h, then one attempt per ten seconds) slows a distributed attack but, by design, cannot distinguish the owner from the attacker while it runs.
- No WebAuthn/passkeys, SMS or push; authenticator apps and recovery codes only.

Detail: [Accounts and sign-in](../ops/authentication.md#two-step-sign-in), [Internet exposure checklist](../ops/internet-exposure.md).
