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
    Because `ui` is server-side, opening Horde on another LAN browser picks up the same theme and library defaults. That matches the [single-admin](no-auth.md) model: one house style, not per-account profiles.

## 3. Server `ai` / app settings (keys and models)

OpenRouter API keys, Ollama base URL, model names, workload profile, budgets, schedules, and related flags live in the **`ai`** section of app settings (still on the server, still **not** protected by login).

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
SQLite                   →  library, jobs, progress, embeddings metadata
```

## Related

- [Settings overview](../settings/index.md)
- [All settings appendix](../settings/all-settings.md)
- [No authentication](no-auth.md) — server settings are world-readable/writable on the LAN
