# 0014. Playlists belong to a user and are App-wide or Private

Status: Accepted

## Context

Playlists were one shared pool: no owner, and the `manage_playlists` permission let a member create, change and delete every one of them. People wanted lists of their own that nobody else sees, without giving up the shared ones.

## Decision

- **Two columns, one rule** (migration `0011_playlist_owner`). `playlists.owner_user_id` (FK `users`, CASCADE) and `playlists.visibility` (`public` shown as *App-wide*, or `private`). Existing playlists become public and belong to the first enabled administrator, so nothing changes for an installed server. With no administrator yet (a server from before accounts) the owner stays NULL and the first administrator adopts those playlists when the account is created, next to the watch history.
- **Seeing.** A user sees public playlists and their own private ones. Every lookup goes through `services/playlists.py` (`visible_to`, `get_visible`, `get_editable`), including the list, detail, items, cover, the download queue (`DownloadCreate.playlist_id`) and the check for an existing YouTube subscription. Another user's private playlist answers **404** with the same body as a missing id, so its existence leaks nothing. Administrators get no exception: a private playlist is private from them too.
- **Editing.** The owner can always edit and delete theirs. Anyone holding `manage_playlists` (administrators always) can also edit and delete a *public* playlist they do not own, as shared editing always worked; on such a playlist a member without the grant gets **403** `permission_denied`. Only the owner changes the visibility. Making a playlist public, or creating one that is, needs `manage_playlists`; a private one affects only its owner and needs no grant. Creation without a stated visibility is public for those who may share and private for everyone else. Importing or subscribing to a YouTube playlist still needs `download`.
- **The permission moved into the handler.** The routes no longer declare `require_permission("manage_playlists")`, because the answer depends on the playlist. `tests/test_permissions.py` lists them as conditional, and `tests/test_playlist_access.py` pins the behaviour per route.
- **Order.** `position` stays one shared number per playlist. Reordering the list moves only the playlists the caller can edit, redistributed among the slots those playlists already hold, so nobody's reordering moves another person's playlists. The page shows a user's own playlists and the shared ones in separate sections for the same reason.
- **Deleting an account.** The deleting administrator inherits the account's public playlists (the first other administrator when no heir is named); its private playlists, their items and cover files are deleted (`services/playlist_owners.py`). The FK cascade is only the safety net.
- **Trash.** A trashed video's snapshot lists playlist ids; a restore puts the video back into each playlist that still exists, private or not, whoever restores it, and skips only playlists that are gone.

## Consequences

- A download job names its `playlist_id` in `GET /api/downloads`. The id of someone else's private playlist can therefore be seen in a job they queued, though the playlist itself stays unreadable (404).
- Because the visible set is per user, a YouTube playlist can be subscribed twice (once privately, once App-wide); both syncs run and the second attaches the videos the first downloaded.
- Changing a playlist's owner is not supported.
