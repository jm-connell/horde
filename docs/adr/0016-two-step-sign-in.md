# 0016. Two-step sign-in: TOTP from the standard library, a ticket between the steps

Status: Accepted

## Context

Horde's sign-in was password only, throttled per address and per name. That is fine on a LAN. It is not enough for someone who wants to reach their server through a public name, where a leaked or guessed password is the whole defence. Horde has no email, so the usual second factors (email codes, magic links) are out, and the project avoids new moving parts.

## Decision

- **TOTP (RFC 6238) from `hmac`/`hashlib`**, SHA-1, 6 digits, 30 s, plus or minus one step: what every authenticator app does. The last accepted step is stored (`users.totp_last_step`) and a code is accepted only for a later step, through a SQL compare-and-set, so a code works once even under concurrent requests.
- **Ten recovery codes**, stored as an HMAC keyed with `secret_key` (which is not in the database), deleted when used.
- **Two requests to sign in.** A right password for a two-step account answers `401 totp_required` with a *ticket*: signed with `secret_key`, five minutes, single use (an in-memory registry), at most five tries, bound to the account's password hash and second-factor state. `POST /api/auth/login/totp` trades ticket plus code for the session. A right password does not clear the failure counters, and wrong codes count in the existing limiter, so alternating a known password with code guesses gains nothing.
- **The reset-by-log flow does not skip it** (ADR 0012): the password changes, the second step is still due.
- **A requirement setting** (`require_two_factor`: off, admins, everyone) enforced in `AuthMiddleware`, once, for every route: an account that must enroll can reach only the state, sign-out and enrollment routes (`403 two_factor_enrollment_required`). If the settings file becomes unreadable the last value read stays in force.
- **QR codes are drawn on the server** with `segno` (pure Python, no dependencies), so the secret never reaches a third-party service.
- **Setting up, turning off and replacing recovery codes need the password** (and, for the last two, a code), so a stolen session cannot attach its own authenticator or strip the factor.
- **Step-up re-authentication for the administrator actions that would outlive a stolen session.** The setup check above is only as strong as the places a thief could otherwise learn or choose a password: an administrator session could set its *own* password (`PATCH /api/users/{id}`), enroll an authenticator and lock the owner out, or create a second administrator. So that route refuses a password for your own account (use *Change password*), and creating a user, promoting to administrator, setting another account's password, deleting an account, resetting another's two-step sign-in, signing another account out everywhere and changing the requirement answer `403 reauth_required` unless the session proved the password (and a code) within ten minutes, by signing in or by `POST /api/auth/reauth` (`user_sessions.reauth_at`). A stolen session is therefore *not* a signed-in administrator for these actions once it is ten minutes old; one stolen within ten minutes of its sign-in, or together with the password, still is.
- **The throttle reserves before it hashes** (`LoginLimiter.begin`), with a cap on concurrent password hashes, because the original check-then-hash-then-count order let a burst of concurrent guesses all pass the budget. IPv6 clients are keyed by /64. Wrong second-step codes also feed an escalating per-account wait that a right password cannot reset, and a signed `horde_device` cookie spares the owner's usual browser the name-wide lanes (not the code wait).

## Consequences

- The TOTP secret is stored readable (`users.totp_secret`); a copy of `DATA_DIR` defeats the second factor along with everything else in it. Encrypting it with `secret_key` would protect only a database file stolen without that key; that was judged not worth a home-made cipher or a new dependency, and the docs say to protect backups.
- Tickets live in memory, so a restart cancels sign-ins in progress (the person types the password again).
- The throttle keys on the username and address as before; the new daily ceiling (50 failures per name per 24 h, then one attempt per ten seconds) slows a distributed attack but cannot tell the owner from the attacker while it runs, except for a browser that carries the account's device cookie. The code step has no such exception: an attacker who knows the password and keeps guessing codes also makes the real owner wait at that step (up to an hour), and the CLI is the way round it.
- Account enrollment is trust on first use: while an account is required to enroll but has not, whoever signs in with its password first can attach their own authenticator. The docs tell operators to enroll every account before publishing the port, and the Security card lists the accounts that have not.
- Every administrator action that asks for the password again needs a browser that can show a dialog; a script calling the API must `POST /api/auth/reauth` first.
- No WebAuthn/passkeys, SMS or push; authenticator apps and recovery codes only.

Detail: [Accounts and sign-in](../ops/authentication.md#two-step-sign-in), [Internet exposure checklist](../ops/internet-exposure.md).
