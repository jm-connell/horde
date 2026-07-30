# Vibecoded

Horde was **vibecoded**: built quickly in an AI-enabled IDE toward a personal TrueNAS / Dockge workflow, not designed as a multi-year corporate product with a full-time maintainer staff.

## Provenance

From the project README (paraphrased and preserved in spirit):

- The author had long used Plex but disliked how it handles non-Movies/TV “Other” video — see [Why Horde](why-horde.md)
- TubeArchivist looked decent; the goal was something shaped exactly to one vision
- Implementation credit goes to AI coding models used in Cursor — notably **Opus**, **Composer**, and **Grok** — not to a claim of hand-written exclusivity
- The stack targets a homelab archive: download, organize, watch, optionally add small local AI

Treat that origin story as part of the product ethics: expect sharp edges, welcome forks, and prefer reading the running app over assuming every [roadmap](../reference/roadmap.md) line item is gospel.

## Extend with an AI IDE

If you want to change Horde:

1. Clone the repo and run [local development](../getting-started/local-dev.md) or Docker
2. Open it in **Cursor** (or another AI IDE you like)
3. Point the agent at the wiki (`/wiki/` or `docs/`) and the code under `backend/` / `frontend/`
4. Keep changes small, test downloads/playback on your LAN, and watch SQLite + volume mounts

The codebase is intentionally approachable for that loop: one container, additive SQLite migrations, React + FastAPI.

## Ask mode for questions

The recommended way to ask “how does X work?” or “why did Y break?” is:

1. Open this repository in Cursor
2. Use **Ask** mode (read-only Q&A against the tree)
3. Cite the files the model finds rather than guessing from memory

That matches how the original author works and keeps answers grounded in *this* checkout — including features that landed after any static roadmap was written.

!!! tip "Docs in the app"
    On a running instance: **Settings → System → Documentation** → `/wiki/`. Interactive API: `/docs`.

## Related

- [Why Horde](why-horde.md)
- [FAQ](../reference/faq.md)
- [Roadmap](../reference/roadmap.md) — historical phases; verify against the app
