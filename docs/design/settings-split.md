# Settings split

Horde preferences live in **three places** on purpose: ephemeral browser state, a server-persisted UI blob, and server AI/app secrets. Mixing them would either lose themes on a new browser or put API keys in `localStorage`.

## 1. `localStorage` (browser-only)

Used for **session chrome** and short-lived overrides that should not sync as “the house default,” for example:

- Settings tab / AI pane last selected
- Download queue collapse state
- Mini-player width
- Library sort override with a short TTL (toolbar sort vs Settings default)
- One-shot dismiss flags (“don’t ask again”)

Clearing site data resets these without wiping the server library.

## 2. Server `ui` blob (deep-merge)

Most appearance, library, and playback preferences are stored on the server under `app_settings` → **`ui`**: themes, fonts, SponsorBlock toggles, continue-watching visibility, channel sort defaults, subtitle layout, playback rate defaults, and similar keys.

The frontend maps camelCase React state ↔ snake_case JSON via a fixed `SERVER_UI_KEYS` list. Saves **deep-merge** the `ui` object on the server so a partial PATCH (one toggle) does not wipe nested keys like `custom_colors` or custom themes.

!!! tip "Multi-device"
    Because `ui` is stored on the server, opening Horde on another browser picks up your theme and layout. Each account has its **own** `ui` (table `user_settings`); the server-wide `ui` blob in `app_settings.json` is the default for people who have not chosen anything yet. Two `ui` keys change what the server does (`download_video_codec`, `compat_copy_resolution`) and stay server-wide, editable by admins only.

## 3. Server `ai` / app settings (keys and models)

AI provider URLs and API keys, model names, workload profile, budgets, schedules, and related flags live in the **`ai`** section of app settings (still on the server, still **not** protected by login).

These are never meant for `localStorage`:

- Secrets would be readable by any XSS on the origin
- Model/workload choices should survive browser resets
- Background workers read the same file the API writes

See [Local vs cloud AI](local-vs-cloud-ai.md) and [Settings → AI](../settings/ai.md).

## Mental model

```text
Browser localStorage     →  ephemeral UI state
Server settings.ui       →  durable presentation & playback prefs (merged)
Server settings.ai       →  providers, keys, models, schedules
Server top-level keys    →  sync intervals, catalog caps, download_queue_paused, …
SQLite                   →  library, jobs, progress, embeddings metadata
```

## Related

- [Settings overview](../settings/index.md)
- [All settings appendix](../settings/all-settings.md)
- [Security model](no-auth.md) — server settings need an administrator
