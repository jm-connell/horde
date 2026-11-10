# 0032. Parental controls are an allowlist enforced on the server

Status: Accepted

## Context

Horde is shared by a household. A parent wanted a child's account to see only some channels. Permissions say what an account may *do* (download, delete, use AI), not what it may *see*: every member saw the whole library, Recommended, YouTube search and any stream. Hiding things in the interface would not do: the API, a pasted link or a related video would still reach the rest.

## Decision

- **An allowlist per member.** `users.allowed_channels` holds the channels a member may watch (JSON; NULL means no restriction). An administrator sets it under Users (`PUT /api/users/{id}/allowed-channels`); an administrator cannot be restricted.
- **Enforced on the server, everywhere a video reaches the member.** `services/parental.py` holds the rules and `app/parental_guard.py` the route guards: lists and searches leave other channels out; any `/api/videos/{id}` route answers 404 for another channel's video; a stream (YouTube id) plays only when it belongs to an allowed channel: a library or indexed-catalog video of one, or one whose metadata read named one (remembered per user and video); YouTube search answers 403.
- **Permissions that reach past the list are withheld**, whatever was granted (downloads, subscriptions, AI and Ask, editing, deleting). Only saving allowed videos to the device stays. The grants are kept, so lifting the list restores them.
- A channel matches by its normalized URL; its name counts only when the video or the allowed entry has no URL (anyone can name a channel like an allowed one). A stream URL the server cannot read a YouTube id from is refused for a restricted member.

## Consequences

- A restricted member can rely on nothing outside the list working, links included; new routes that serve a video or a list of videos must apply the guard or the filter (`tests/test_parental.py`).
- Two channels with the same name are not told apart for videos that have no channel URL, and a video whose channel URL is written another way (`/channel/UC…` instead of `@handle`) is hidden until that form is allowed too.
- Ask, AI summaries and Recommended's new channels are off for a restricted member: Ask reads every indexed channel's captions, and filtering each answer was not worth the risk.
