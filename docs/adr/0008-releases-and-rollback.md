# 0008. Releases, update channels and rollback in `update.sh`

Status: Accepted

## Context

Horde is built from source on the user's host (`build: .` in Compose) and updated with `git pull` and a rebuild, usually on a NAS by someone who is not watching it. Following `main` meant every merged commit reached every user, an update that broke startup left a stopped service, and, since migrations are forward-only ([ADR 0001](0001-sqlite-wal-alembic.md)), the previous build refuses to start on a database the broken build already migrated. There was no named version to point at.

## Decision

**Releases.** Versions follow SemVer and a release is a git tag `vX.Y.Z` on `main`. Pushing the tag runs the Release workflow, which refuses unless the tag is on `main` and the `CI` and `Image` workflows succeeded for that commit, builds `linux/amd64` and `linux/arm64`, pushes `ghcr.io/jm-connell/horde` with `X.Y.Z`, `X.Y`, `sha-<commit>` and `latest`, bakes `HORDE_VERSION` into the image, and creates the GitHub Release. Tags are immutable; a bad release is fixed forward. Pre-release tags (`-rc.1`) never become `latest`.

**Update channels** (`HORDE_UPDATE_CHANNEL`, read by `update.sh`):

| Channel | Installs |
|---|---|
| `release` (default) | The highest stable `vX.Y.Z` tag, checked out on a local `horde-release` branch |
| `prerelease` | The same, counting `-rc` tags |
| `main` | Fast-forward of the current branch, every commit |

Until a first release tag exists the script follows `main`. It never goes backwards by accident: if the checkout is ahead of the newest release it stops, unless `HORDE_ALLOW_DOWNGRADE=1`. Installs that use the published image pin or follow a tag in `HORDE_IMAGE` instead. The in-app update notice compares the baked version with the latest GitHub release.

**Update with a safety net.** `update.sh` never stashes or rewrites history and refuses to recreate with different host volumes. It builds an image tagged `horde:latest` and `horde:<shortsha>` (keeping the previous one), takes a consistent, integrity-checked **database backup** with SQLite's online backup just before recreating, records the previous commit, previous image id, backup path and Alembic revision in `.local/update-state.env`, recreates the containers and polls `GET /api/health`.

**Rollback.** If the new version is not healthy within the timeout, `update.sh` rolls back automatically (`HORDE_AUTO_ROLLBACK=0` disables it); `bash update.sh --rollback` does it on demand.

- It compares the Alembic revision recorded before the update with the one in the live database. If they differ (or there was no `alembic_version`, the first adoption) **a migration ran**, because the old code would refuse the new schema.
- Automatic rollback then restores the pre-update backup: copy beside the live file, `integrity_check`, atomic rename; the newer database is kept as `horde.db.pre-rollback-<timestamp>`. A failed restore stops loudly and leaves that file untouched.
- A **manual** rollback after a migration **refuses before changing anything** and tells you to re-run with `--restore-db`, because restoring discards everything written since the backup. If the revision cannot be read the state is "unknown" and nothing is restored automatically.
- The git checkout moves back with `git reset --keep` only if it is still exactly where the update left it; otherwise the script stops with instructions rather than discard your commits. The previous image is retagged and the containers recreated without building. Only the most recent update can be rolled back.

## Consequences

- Merging to `main` reaches nobody on the default channel; **tagging is what ships**. Release discipline (changelog, green `main`) now matters.
- A failed update self-heals in the common case, and data loss is only ever an explicit choice (`--restore-db`) or limited to the minutes of an automatic rollback.
- The rollback logic is a shell script with real Docker and git side effects, so its tests build throwaway repositories; they must never run under `git rebase --exec` or a hook, where `GIT_DIR` leaks into them.
- Rolling back does not change GitHub: running `update.sh` again pulls the same upstream version. Wait for a fix or stay put.
- The state file means one rollback point; two updates in a row lose the first.

Detail: [Release process](../development/release-process.md), [Updating](../getting-started/updating.md).
