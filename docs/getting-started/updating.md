# Updating

Horde’s Docker image is **built from source** on your host (`build: .` in `docker-compose.yml`). Updating means pulling new git commits, rebuilding the `horde` image with the current commit SHA, and recreating containers.

First-time install is a `git clone` plus Compose/Dockge deploy — [Install with Docker](install-docker.md) or [TrueNAS / Dockge](truenas-dockge.md). This page is only for an existing checkout.

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

1. Snapshots live `/downloads` and `/app/data` bind mounts (and `PUID`/`PGID`) into `.env` if a Horde container already exists
2. `git fetch` + `git merge --ff-only`. It never stashes, merges or rewrites history, and `.env` (gitignored) is never touched. If you edited a compose file it **stops**, saves your copy under `.local/update-backups/<timestamp>/` and tells you what to do (see [Local compose edits](#local-compose-edits))
3. If the checkout is already at the commit the running container was built from, it prints "Already up to date" and exits without touching anything, **including the rollback point of the previous update**
4. Refuses to recreate if the new compose would mount different host paths (override with `HORDE_FORCE_VOLUME_CHANGE=1`)
5. Builds the image with the commit and version baked in and tags it `horde:latest` **and** `horde:<shortsha>`; the previous image is kept as `horde:<previous shortsha>`. Only the newest `HORDE_KEEP_IMAGES` (default 3) `horde:<shortsha>` tags are kept, always including the current and the previous one
6. **Backs up the SQLite database** just before recreating (so a failed build leaves no backup behind). It uses SQLite's online backup, consistent while Horde runs, run inside the running container (or a throwaway container of the current image when it is stopped), and verifies it with `PRAGMA integrity_check`. It writes `.local/update-backups/<timestamp>/horde.db`. "No database" is decided by the tool itself, not by looking at the host directory, so a dataset the invoking user cannot read is still backed up; any other failure aborts the update unless `HORDE_SKIP_DB_BACKUP=1`
7. `docker compose up -d` — recreates containers from the new image (adds `--profile ai` when needed; see below)
8. Polls `GET /api/health` until `status` is `ok` (default up to 90s, 150s when `YTDLP_AUTO_UPDATE=1`) and prints a short summary (`horde_version`, `yt_dlp_version`, POT, wiki, library count)
9. **If the new version is not healthy, it rolls back automatically** (see [Rollback](#rollback)) and exits non-zero

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
| `HORDE_KEEP_BACKUPS` | How many `.local/update-backups/<timestamp>/` folders to keep (default `5`) |
| `HORDE_KEEP_IMAGES` | How many `horde:<shortsha>` image tags to keep (default `3`; the current and previous are always kept) |
| `HORDE_FORCE_REBUILD` | `1` rebuilds even when the checkout is already at the running commit |
| `HORDE_AUTO_ROLLBACK` | `0` disables the automatic rollback on a failed health check |
| `HORDE_SKIP_DB_BACKUP` | `1` continues even if the database cannot be backed up (otherwise the update aborts before touching the running stack) |
| `HORDE_DISCARD_COMPOSE_EDITS` | `1` backs up and then discards local edits to the compose file (see below) |

Example:

```bash
HORDE_COMPOSE_PROFILES=ai bash update.sh
```

## Backups

Every update writes `.local/update-backups/<timestamp>/` (gitignored) containing `horde.db` (the online backup), the `.env` before and after seeding, and the snapshot of the live mounts. Only the newest `HORDE_KEEP_BACKUPS` folders (default 5) are kept. This is a pre-update safety net, not a replacement for the regular backups in [Backup & restore](../ops/backup-restore.md).

## Rollback

`update.sh` remembers where it came from in `.local/update-state.env`: the previous git commit, the previous image id, the database backup and the Alembic schema revision before the update.

**Automatic.** If the new container is not healthy within `HORDE_HEALTH_TIMEOUT_SEC`, `update.sh`:

1. keeps the failed container's log in the backup folder (`failed-container.log`),
2. stops the failed container and reads the database's Alembic revision (`alembic_version`). If it differs from the one recorded before the update, or the database had no `alembic_version` table before (the first Alembic adoption), a **migration ran** and the backup is restored. If the revision cannot be read at all, the state is *unknown*: the database is **not** restored automatically and the script prints how to do it by hand,
3. restores by copying the backup next to the live file, running `PRAGMA integrity_check` on the copy, and only then renaming it into place; the newer database is kept as `horde.db.pre-rollback-<timestamp>` (with its `-wal`/`-shm`). If any restore step fails the script stops loudly with Horde stopped and the `pre-rollback` file untouched, and does nothing else,
4. retags the previous image as `horde:latest` and moves the checkout back with `git reset --keep` to the previous commit, **only if** the checkout is still exactly where the update left it. If you committed or switched branches since, it stops with instructions instead of discarding your work,
5. recreates the containers without building or pulling, and exits non-zero with a clear message.

Restoring discards everything written since the backup (minutes at most for an automatic rollback).

**Manual.** To undo an update that is healthy but wrong:

```bash
bash update.sh --rollback              # code + image only
bash update.sh --rollback --restore-db # also restore the pre-update database backup
```

If a migration ran (or the revision cannot be read), `--rollback` **refuses before stopping or changing anything**, because the previous version would refuse to start on the migrated database and you may have days of new data. It tells you to re-run with `--restore-db` if you accept losing that data. Only the most recent update can be rolled back.

!!! note "Upstream is unchanged"
    Rolling back does not change GitHub. Running `update.sh` again pulls the same upstream commit. Wait for a fix, or stay on the old version until you want to retry.

## Local compose edits

Keep host paths in `.env` and other tweaks in `docker-compose.override.yml` (gitignored). If you edited `docker-compose.yml` directly, `update.sh` saves a copy to `.local/update-backups/<timestamp>/docker-compose.yml.local-edit` and stops without changing anything, rather than stashing and merging (which can leave conflict markers in the file). Then either `git checkout -- docker-compose.yml` and re-run, or run `HORDE_DISCARD_COMPOSE_EDITS=1 bash update.sh` to do both steps at once. Edits to other tracked files are kept as long as the incoming change does not touch the same files.

## Use the published image

Tagged releases are published as multi-arch (`amd64`, `arm64`) images to `ghcr.io/jm-connell/horde` with the tags `X.Y.Z`, `X.Y`, the commit SHA and `latest`. Building from source remains the default. To skip the build instead, put this in `.env`:

```env
HORDE_IMAGE=ghcr.io/jm-connell/horde:1.2.3   # or :latest to follow releases
HORDE_PULL_POLICY=always
```

`update.sh` then runs `docker compose pull horde` instead of building (the git checkout is still updated for compose and docs changes), and backs up the database and rolls back exactly as above. Pin an exact version to control when you move; `latest` follows the newest release. Without `update.sh`: `docker compose pull horde && docker compose up -d`.

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

Settings → System can show a quiet notice when a newer version is available (dismissible until a still-newer one appears). The check runs at most once a day and fails silently when GitHub is unreachable.

- When the image has a release version baked in (`HORDE_VERSION`, set for tagged releases and by `update.sh` from your nearest `v*` tag), Horde compares it with the **latest GitHub release**.
- Otherwise, or while the repository has no releases, it compares the baked commit SHA with `main` and **ignores** commits by the `github-actions[bot]` stats bot and changes that only touch docs, so a daily bot commit no longer shows up as an update.

Both rely on identity baked at build time — another reason to use `update.sh` or set `HORDE_GIT_SHA` on rebuild.

Override the repo used for checks with `HORDE_GITHUB_REPO` if needed ([Environment variables](../ops/environment.md)).

## yt-dlp freshness

YouTube changes often. Horde pins an exact yt-dlp version in `backend/requirements.txt` and installs it at image build time. The container does **not** upgrade yt-dlp on start unless you opt in with `YTDLP_AUTO_UPDATE=1` ([Environment variables](../ops/environment.md#runtime-yt-dlp-updater)). Pulling and rebuilding Horde is the normal way to pick up a newer pin along with app fixes.

If downloads fail with format or extractor errors after YouTube changes, [bump yt-dlp](../ops/maintenance.md#bumping-yt-dlp), rebuild (`update.sh`), confirm `yt_dlp_version` on Settings → System / `GET /api/health`, and retry. For local-dev-only upgrades, reinstall the venv from `requirements.txt` after changing the pin.

## After updating

`update.sh` already waits on health and prints a summary. Confirm:

1. Health summary shows `status: ok`, expected `horde_version`, and a sensible `yt_dlp_version` (schema migrate + boot succeeded if health returns).
2. `http://<server-ip>:8686` loads (host **8686**, not 8080); hard-refresh if assets look cached.
3. Smoke-test a short download if you care about yt-dlp changes.
4. If the health wait failed, `update.sh` already rolled back; read `.local/update-backups/<timestamp>/failed-container.log`.

Next: [First run](first-run.md) refresher, [Maintenance](../ops/maintenance.md) (including [bumping yt-dlp](../ops/maintenance.md#bumping-yt-dlp)), [Backup & restore](../ops/backup-restore.md).
