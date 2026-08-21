# Updating

Horde’s Docker image is **built from source** on your host (`build: .` in `docker-compose.yml`). Updating means pulling new git commits, rebuilding the `horde` image with the current commit SHA, and recreating containers.

Library media (`DOWNLOADS_PATH`) and app data (`DATA_PATH`) live on host volumes and are **not** wiped by a rebuild. `update.sh` snapshots bind mounts from the running container into `.env` *before* `git pull`, so a compose-file refresh cannot remount Horde onto empty default directories (which looks like "settings reset" and "storage paths changed").

!!! warning "TrueNAS / Dockge: use the host shell"
    Run updates from the **TrueNAS shell** or SSH on the Docker host, inside the stack directory. Do **not** use Dockge’s per-service **Bash** button — that shell is inside the running container, where host `docker compose` and stack `git pull` are not available. See [TrueNAS / Dockge](truenas-dockge.md).

    After `update.sh` finishes, refresh Dockge so it reloads the compose file. Do **not** click **Deploy** with an older compose still sitting in the Dockge editor — that can rewrite volume paths. The script already recreates containers.

## Recommended: `update.sh`

From your Horde stack / repo folder:

```bash
cd /path/to/horde          # e.g. /mnt/tank/dockge/stacks/horde
bash update.sh
```

The script:

1. Snapshot live `/downloads` and `/app/data` bind mounts (and `PUID`/`PGID`) into `.env` if a Horde container already exists
2. `git pull --ff-only --autostash` — fetch the latest code without `git reset --hard` (`.env` is gitignored and is never discarded)
3. Refuse to recreate if the new compose would mount different host paths (override with `HORDE_FORCE_VOLUME_CHANGE=1`)
4. `HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose build horde` — rebuild with the commit SHA baked in (keeps in-app update checks accurate)
5. `docker compose up -d` — recreate containers from the new image (adds `--profile ai` when needed; see below)
6. Polls `GET /api/health` until `status` is `ok` (default up to 90s) and prints a short summary (`horde_version`, `yt_dlp_version`, POT, wiki, library count)

On hosts that need elevated Docker access, the script uses `sudo` when invoking compose (as in the repo’s `update.sh`).

Keep `DOWNLOADS_PATH` and `DATA_PATH` in `.env` (not hardcoded in `docker-compose.yml`). Extra compose tweaks belong in gitignored `docker-compose.override.yml`.

After it finishes, hard-refresh the browser (`Ctrl+Shift+R`) if the UI still looks old.

### AI profile and health URL

| Env | Purpose |
|-----|---------|
| `HORDE_COMPOSE_PROFILES` or `COMPOSE_PROFILES` | Set to `ai` (or include `ai` in a comma list) so `update.sh` runs `docker compose --profile ai up -d` |
| *(auto)* | If the `horde-ollama` container is already running, the script includes `--profile ai` automatically |
| `HORDE_HEALTH_URL` | Override the readiness URL (default `http://127.0.0.1:8686/api/health`, or the live host port when the container is already mapped elsewhere) |
| `HORDE_HEALTH_TIMEOUT_SEC` | Seconds to wait for health (default `90`) |
| `HORDE_FORCE_VOLUME_CHANGE` | Set to `1` only if you **intend** to move `DOWNLOADS_PATH` / `DATA_PATH`. Otherwise `update.sh` aborts when a recreate would remount empty defaults |

Example:

```bash
HORDE_COMPOSE_PROFILES=ai bash update.sh
```

## Manual steps

Equivalent to the script (without the health wait):

```bash
cd /path/to/horde
git pull
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose build horde
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose up -d
curl -sf http://127.0.0.1:8686/api/health
```

Passing `HORDE_GIT_SHA` on the same line as `sudo` matters so the variable is not stripped from the environment.

Prefer `update.sh` over a raw `git pull`. Never `git reset --hard` to unstick a pull — that drops local compose edits and can remount empty default data/media directories.

If you use the optional Ollama profile:

```bash
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose --profile ai up -d
```

## What stays running

| Service | Notes |
|---------|--------|
| `bgutil-pot` | Always part of the default stack; recreated with `up -d` |
| `ollama` | Only if started with `--profile ai` (or preserved by `update.sh` as above) |
| Host volumes | `DOWNLOADS_PATH` → `/downloads`, `DATA_PATH` → `/app/data` untouched (script aborts if those host paths would change) |
| `.env` | Seeded from the running container before pull; gitignored so `git pull` cannot reset paths |

## Update notices in the UI

Settings → System can show a quiet notice when a newer commit is available on GitHub (dismissible until a still-newer commit appears). That check relies on the SHA baked at build time — another reason to use `update.sh` or set `HORDE_GIT_SHA` on rebuild.

Override the repo used for checks with `HORDE_GITHUB_REPO` if needed ([Environment variables](../ops/environment.md)).

## yt-dlp freshness

YouTube changes often. Horde pins an exact yt-dlp version in `backend/requirements.txt` and installs it at image build time (the container does **not** auto-upgrade yt-dlp on start). Pulling and rebuilding Horde is the normal way to pick up a newer pin along with app fixes.

If downloads fail with format or extractor errors after YouTube changes, [bump yt-dlp](../ops/maintenance.md#bumping-yt-dlp), rebuild (`update.sh`), confirm `yt_dlp_version` on Settings → System / `GET /api/health`, and retry. For local-dev-only upgrades, reinstall the venv from `requirements.txt` after changing the pin.

## After updating

`update.sh` already waits on health and prints a summary. Confirm:

1. Health summary shows `status: ok`, expected `horde_version`, and a sensible `yt_dlp_version` (schema migrate + boot succeeded if health returns).
2. `http://<server-ip>:8686` loads (host **8686**, not 8080); hard-refresh if assets look cached.
3. Smoke-test a short download if you care about yt-dlp changes.
4. If the health wait failed: `sudo docker compose logs --tail=80 horde`.

Next: [First run](first-run.md) refresher, [Maintenance](../ops/maintenance.md) (including [bumping yt-dlp](../ops/maintenance.md#bumping-yt-dlp)), [Backup & restore](../ops/backup-restore.md).
