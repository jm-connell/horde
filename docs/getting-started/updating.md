# Updating

The easy way to update Horde is the **Update now** button in Settings → System → Updates. This page explains how to switch it on (once), what it does, and what to do if something goes wrong. The same update can also be run by hand from the shell, which is how you roll back.

Behind the scenes Horde’s Docker image is **built from source** on your host (`build: .` in `docker-compose.yml`). Updating means pulling new git commits, rebuilding the `horde` image with the current commit SHA, and recreating containers.

First-time install is a `git clone` plus Compose/Dockge deploy — [Install with Docker](install-docker.md) or [TrueNAS / Dockge](truenas-dockge.md). This page is only for an existing checkout.

Library media (`DOWNLOADS_PATH`) and app data (`DATA_PATH`) live on host volumes and are **not** wiped by a rebuild. `update.sh` snapshots bind mounts from the running container into `.env` *before* `git pull`, so a compose-file refresh cannot remount Horde onto empty default directories (which looks like "settings reset" and "storage paths changed").

## Update from the app (recommended) { #update-from-the-app }

Administrators can update Horde with one click, without opening a shell.

1. Open **Settings → System → Updates**.
2. Press **Update now**.
3. Wait. Horde shows each step and the page reconnects by itself when Horde restarts.

**What you will see**

| Step | What it means | How long |
|------|---------------|----------|
| Waiting | Your request is queued; the server picks it up within about a minute. You can **cancel** while it waits. | Up to ~1 minute |
| Updating | The new version is being downloaded and built, then Horde restarts. The page may show “reconnecting” for a moment. | Several minutes (a rebuild takes a while on a NAS) |
| Result | One of the outcomes below, with the end of the log under **details**. | |

| Result | Meaning |
|--------|---------|
| Updated | You are on the newest version. The page that started the update reloads itself into the new version; other open tabs show **Update available → Reload** once they notice the new version (or hard-refresh with `Ctrl+Shift+R`). |
| Up to date | Nothing newer was available; nothing was changed. |
| Rolled back | The new version did not start properly, so Horde went back to the old version automatically (and restored the database backup if the new version had already changed it). See [Rollback](#rollback). |
| Failed / could not run | The update stopped before changing anything or could not finish. Open **details** for the reason and see [Troubleshooting](#update-troubleshooting). |
| Interrupted | The server restarted (or the job was stopped) while an update was running. Check that Horde works, then press **Update now** again. If Horde does not start, run `bash update.sh --rollback` in the shell. |

**Is it safe?** Yes, it is the same careful script as the shell way. Before changing anything it makes a checked backup of the database, and if the new version does not become healthy it goes back to the old one on its own. Your videos and settings live in separate folders and are not touched by a rebuild. Only administrators see the button; members cannot start updates.

**What it installs.** Exactly what `bash update.sh` would: the newest release on your [update channel](#update-channels) (default: the newest tagged release). It never updates by itself: nothing happens until an administrator presses the button.

### One-time setup { #update-button-setup }

Horde runs in a container and, on purpose, cannot rebuild or restart itself. The button only leaves a note in Horde’s data folder. A small scheduled job on the server (the Docker host) looks for that note every minute and runs the update. You set that job up once; until then the button does not appear.

On **TrueNAS** (the same steps work for any Dockge stack):

1. Open the TrueNAS shell (**System → Shell**) or SSH to the server. Do **not** use Dockge’s Bash button.
2. Run the check below, with the path changed to where your Horde stack is:

    ```bash
    sudo bash /mnt/tank/dockge/stacks/horde/scripts/update_watch.sh --setup
    ```

    It confirms it can find Horde’s data folder, checks in, and prints the exact command for the next step. If it prints an error instead, see [Troubleshooting](#update-troubleshooting).
3. In the TrueNAS web interface open **System → Advanced Settings → Cron Jobs → Add** and fill in:

    | Field | Value |
    |-------|-------|
    | Description | `Horde update button` |
    | Command | `bash /mnt/tank/dockge/stacks/horde/scripts/update_watch.sh` (your path) |
    | Run As User | `root` |
    | Schedule | Custom: `* * * * *` (every minute) |
    | Hide Standard Output | leave checked |
    | Hide Standard Error | leave checked, or uncheck it to get an email when something goes wrong |
    | Enabled | checked |

4. Save. Within a minute, **Settings → System → Updates** shows the **Update now** button. (Reload the page if it does not.)

On **other Linux hosts**, add this line to root’s crontab (`sudo crontab -e`) with your path:

```text
* * * * * bash /path/to/horde/scripts/update_watch.sh
```

!!! note "Why root?"
    Rebuilding and recreating containers needs Docker access, which only the host has. When the checkout belongs to another user, the job lets git work for that run and afterwards hands the git folder, `.local`, `.env`, the tracked files and their folders back to the checkout’s owner, so running `bash update.sh` by hand later still works.

!!! note "Settings for the button’s updates"
    The job runs `update.sh` without any of the variables you might type in front of it in the shell. Settings it should use go in the stack’s `.env` (`update.sh` reads `HORDE_UPDATE_CHANNEL`, `HORDE_ALLOW_DOWNGRADE`, `HORDE_IMAGE` and `YTDLP_AUTO_UPDATE` from there), or in front of the cron command, for example `HORDE_COMPOSE_PROFILES=ai bash /mnt/tank/dockge/stacks/horde/scripts/update_watch.sh`. The `ai` profile is also picked up automatically while the `horde-ollama` container runs.

Each run of the job stamps `DATA_PATH/update/watcher.env`. Horde shows the button only while the job has checked in during the last 5 minutes. With nothing to do the job prints nothing, so cron stays quiet, and a lock keeps two updates from running at once.

### Turning it off { #update-button-off }

Delete or disable the cron job. After about 5 minutes Horde notices the job is gone and the button disappears. Nothing else is left running.

### Troubleshooting { #update-troubleshooting }

| Problem | Likely cause and fix |
|---------|----------------------|
| No **Update now** button | The cron job is not running, has the wrong path, or does not run as `root`. Run the `--setup` command above by hand and read what it says. “Horde’s data folder was not found” means there is no running `horde` container and no `DATA_PATH` in the stack’s `.env`: start Horde, or fix `.env`, and run it again. Give it a minute after fixing. |
| Stuck on “Waiting” | The cron job stopped after the button appeared (disabled, or the server was off). **Cancel** (still shown while the job is missing), fix the job, and try again. |
| “Could not run” or **Failed** | Open **details** for the tail of the log, or read `DATA_PATH/update/update.log` on the server. A common cause is a hand-edited `docker-compose.yml` ([Local compose edits](#local-compose-edits)); another is the guard that refuses to recreate Horde with different library or data folders (see [AI profile and health URL](#ai-profile-and-health-url)). Fix it, then press the button again, or run `bash update.sh` in the shell to see the messages live. |
| **Rolled back** | The new version did not become healthy. Your old version and database are back. Read `failed-container.log` in `.local/update-backups/<timestamp>/` inside the stack folder to see why, and see [Rollback](#rollback). |

The shell way (`bash update.sh`, `bash update.sh --rollback`) keeps working at any time and is how you [roll back by hand](#rollback).

## Update from the shell { #update-from-the-shell }

The button runs exactly this script for you. Use the shell when the button is not set up, or to [roll back](#rollback).

!!! warning "TrueNAS / Dockge: use the host shell"
    Run updates from the **TrueNAS shell** or SSH on the Docker host, inside the stack directory. Do **not** use Dockge’s per-service **Bash** button — that shell is inside the running container, where host `docker compose` and stack `git pull` are not available. See [TrueNAS / Dockge](truenas-dockge.md).

    After `update.sh` finishes, refresh Dockge so it reloads the compose file. Do **not** click **Deploy** with an older compose still sitting in the Dockge editor — that can rewrite volume paths. The script already recreates containers.

From your Horde stack / repo folder:

```bash
cd /path/to/horde          # e.g. /mnt/tank/dockge/stacks/horde
bash update.sh
```

The script:

1. Snapshots live `/downloads` and `/app/data` bind mounts (and `PUID`/`PGID`) into `.env` if a Horde container already exists
2. `git fetch --tags`, then moves the checkout to the **newest release** (see [Update channels](#update-channels)); on the `main` channel it fast-forwards with `git merge --ff-only`. It never stashes, merges or rewrites history, and `.env` (gitignored) is never touched. If you edited a compose file it **stops**, saves your copy under `.local/update-backups/<timestamp>/` and tells you what to do (see [Local compose edits](#local-compose-edits))
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

## Update channels

`update.sh` follows **releases** by default, so you only get tested, tagged versions:

| `HORDE_UPDATE_CHANNEL` | What `update.sh` installs |
|------------------------|---------------------------|
| `release` (default) | The highest stable `vX.Y.Z` tag, checked out on a local branch named `horde-release`. The image is built with that version baked in (`HORDE_VERSION`), so the in-app update notice compares release to release |
| `prerelease` | Like `release`, but pre-release tags such as `v1.3.0-rc.1` count too (a final `v1.3.0` still wins over its own rc) |
| `main` | The previous behaviour: fast-forward the current branch to `origin`, i.e. every commit on `main` |

Set it in `.env` (`HORDE_UPDATE_CHANNEL=main`) or in the shell for one run. Notes:

- **No release exists yet?** `update.sh` says so and follows `main` until the first release tag appears.
- **Never backwards by accident.** If your checkout is ahead of the latest release (you were following `main`), switching to the release would be a downgrade, and a database migrated by newer code may refuse to start on older code. `update.sh` stops and changes nothing. Keep following `main` with `HORDE_UPDATE_CHANNEL=main`, or accept it with `HORDE_ALLOW_DOWNGRADE=1`.
- **Rollback** remembers the branch and commit you came from. Rolling back from `horde-release` after your first switch from `main` returns you to `main` at the old commit; between two releases it moves `horde-release` back to the previous tag.
- Your own tracked-file edits are still protected as described below; compose edits stop the update.

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

!!! note "Rolling back to a version from before accounts and migrations"
    The one exception is an install whose database had no `alembic_version` table before the update (a version from before the migration system). That older code has no check for an unknown schema revision and runs fine on the migrated database, so `--rollback` goes back **without** restoring the database and prints a warning instead of refusing. Things to expect: watch history recorded per account since the update is invisible to the old version; history the old version records afterwards is not picked up again when you update later, and AI chat messages the old version writes stay unowned (no account sees them). Use `--rollback --restore-db` instead if you would rather return to the exact pre-update database and lose everything written since.

!!! note "Upstream is unchanged"
    Rolling back does not change GitHub. Running `update.sh` again pulls the same upstream commit. Wait for a fix, or stay on the old version until you want to retry.

## Local compose edits

Keep host paths in `.env` and other tweaks in `docker-compose.override.yml` (gitignored). If you edited `docker-compose.yml` directly, `update.sh` saves a copy to `.local/update-backups/<timestamp>/docker-compose.yml.local-edit` and stops without changing anything, rather than stashing and merging (which can leave conflict markers in the file). Then either `git checkout -- docker-compose.yml` and re-run, or run `HORDE_DISCARD_COMPOSE_EDITS=1 bash update.sh` to do both steps at once. Edits to other tracked files are kept as long as the incoming change does not touch the same files.

Uncommented the GPU lines in `docker-compose.yml` (older instructions said to)? Move them: create `docker-compose.override.yml` with the block for your GPU from [GPU](../ops/environment.md#pass-the-gpu-into-horde), run `git checkout -- docker-compose.yml`, then update again. The override file survives every update.

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

Settings → System → Updates shows **Update available** next to the version when a newer one exists, with a link to what changed. When the [update button](#update-from-the-app) is set up, **Update now** sits below it; otherwise the section tells you how to update. The check runs at most once a day and fails silently when GitHub is unreachable. The notice only informs: nothing is installed until an administrator presses the button or runs `update.sh`.

- When the image has a release version baked in (`HORDE_VERSION`, set for tagged releases and by `update.sh` from your nearest `v*` tag), Horde compares it with the **latest GitHub release**.
- Otherwise, or while the repository has no releases, it compares the baked commit SHA with `main` and **ignores** commits by the `github-actions[bot]` stats bot and changes that only touch docs, so a daily bot commit no longer shows up as an update.

Installs on the default `release` channel bake the exact release version (for example `1.2.0`), so the notice appears when a newer release is published. Installs that follow `main` (`HORDE_UPDATE_CHANNEL=main`) bake a `git describe` version such as `1.2.0-5-gabc1234`; they only see notices for new **releases**, not for every commit on `main` in between.

Both rely on identity baked at build time — another reason to use the button, `update.sh`, or set `HORDE_GIT_SHA` on rebuild.

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
