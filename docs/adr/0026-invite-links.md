# 0026. Invite links for new members

Status: Accepted

## Context

An administrator added people by choosing a username and password for them and passing the password on ([ADR 0003](0003-auth-model.md)). For a household that is awkward: the administrator learns everyone's password, has to send it somehow, and the new person then has to find the account page to change it. Most self-hosted apps solve this with an invite link.

## Decision

- **A one-time link.** `POST /api/users/invites` (administrators, behind the recent-password check) stores an invite and returns its token once: 24 random bytes from `secrets` (192 bits), of which only the SHA-256 is kept in `user_invites`, like session tokens. The administrator chooses the new account's permissions and an optional label ("Mum") that the join page shows. Links expire after 7 days by default (1 to 30), can be revoked while unused, and are listed until used or expired.
- **Members only.** An invite always makes a member. Making an administrator stays a deliberate edit of an existing account.
- **Two new public routes.** `POST /api/auth/invite/check` (is it valid, who is it for) and `POST /api/auth/invite/accept` (username and password, then a session) are added to `PUBLIC_ROUTES`. Both are throttled under one key per client address in the sign-in limiter, refused with `HORDE_AUTH_DISABLED`, and answer `404 invite_invalid` for an unknown, used or expired token alike.
- **Used once, atomically.** Accepting first claims the invite with `UPDATE ... SET used_at WHERE used_at IS NULL`, then creates the account in the same transaction. A second request with the same token finds it claimed. A taken username or an empty password rolls the claim back, so the link still works.
- **A welcome for members.** A member's first Home shows a short welcome; closing it sets the synced `memberWelcomeDone` preference.

## Consequences

- People choose their own passwords; the administrator never sees them.
- Whoever holds an unused link can create one member account with the permissions the administrator picked. A leaked link is limited by the one use, the expiry and Revoke, and gives no more than adding that member by hand would.
- Two more routes are reachable signed out. They need a 192-bit secret, so guessing is not a practical attack; the throttle limits load.
- The `user_invites` rows stay after use (who joined through whose invite); deleting either account keeps the row with the id cleared.

Detail: [Accounts and sign-in](../ops/authentication.md#invite-links).
