# Updating

Horde’s Docker image is **built from source** on your host (`build: .` in `docker-compose.yml`). Updating means pulling new git commits, rebuilding the `horde` image with the current commit SHA, and recreating containers.

Library media (`DOWNLOADS_PATH`) and app data (`DATA_PATH`) live on host volumes and are **not** wiped by a rebuild.

!!! warning "TrueNAS / Dockge: use the host shell"
    Run updates from the **TrueNAS shell** or SSH on the Docker host, inside the stack directory. Do **not** use Dockge’s per-service **Bash** button — that shell is inside the running container, where host `docker compose` and stack `git pull` are not available. See [TrueNAS / Dockge](truenas-dockge.md).

## Recommended: `update.sh`

From your Horde stack / repo folder:

```bash
cd /path/to/horde          # e.g. /mnt/tank/dockge/stacks/horde
bash update.sh
```

The script:

1. `git pull` — fetch the latest code
2. `HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose build horde` — rebuild with the commit SHA baked in (keeps in-app update checks accurate)
3. `docker compose up -d` — recreate containers from the new image

On hosts that need elevated Docker access, the script uses `sudo` when invoking compose (as in the repo’s `update.sh`).

After it finishes, hard-refresh the browser (`Ctrl+Shift+R`) if the UI still looks old.

## Manual steps

Equivalent to the script:

```bash
cd /path/to/horde
git pull
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose build horde
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose up -d
```

Passing `HORDE_GIT_SHA` on the same line as `sudo` matters so the variable is not stripped from the environment.

If you use the optional Ollama profile, recreate with the profile when you bring the stack up:

```bash
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose --profile ai up -d
```

(`update.sh` runs plain `docker compose up -d`; add `--profile ai` yourself if that is how you normally run the stack.)

## What stays running

| Service | Notes |
|---------|--------|
| `bgutil-pot` | Always part of the default stack; recreated with `up -d` |
| `ollama` | Only if started with `--profile ai` |
| Host volumes | `DOWNLOADS_PATH` → `/downloads`, `DATA_PATH` → `/app/data` untouched |

## Update notices in the UI

Settings → System can show a quiet notice when a newer commit is available on GitHub (dismissible until a still-newer commit appears). That check relies on the SHA baked at build time — another reason to use `update.sh` or set `HORDE_GIT_SHA` on rebuild.

Override the repo used for checks with `HORDE_GITHUB_REPO` if needed ([Environment variables](../ops/environment.md)).

## yt-dlp freshness

YouTube changes often. Horde’s image pins yt-dlp at build time; pulling and rebuilding Horde is the normal way to pick up a newer yt-dlp along with app fixes. If downloads fail with format errors after YouTube changes, update Horde (or upgrade yt-dlp in a local-dev venv) and retry.

## After updating

1. Confirm `http://<server-ip>:8686` loads (host **8686**, not 8080).
2. Hard-refresh if assets look cached.
3. Smoke-test a short download if you care about yt-dlp changes.

Next: [First run](first-run.md) refresher, [Maintenance](../ops/maintenance.md), [Backup & restore](../ops/backup-restore.md).
