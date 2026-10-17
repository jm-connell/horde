# 0011. In-app updates through a request file and a host cron job

Status: Accepted

## Context

Updating meant opening the TrueNAS shell and running `bash update.sh` ([ADR 0008](0008-releases-and-rollback.md)). Many users of a home server are not comfortable with that and want an **Update now** button. But Horde runs in a container that cannot rebuild or recreate itself: it has no Docker CLI, no checkout of its own source, and a rebuild replaces the very process that would run it. Whatever performs the update has to live on the host, and it must keep the safety net `update.sh` provides (database backup, health wait, automatic rollback).

## Decision

**Horde only writes a request file.** An administrator presses **Update now** (Settings → System → Updates). `services/update_control.py` writes `DATA_DIR/update/request.env` (`REQUEST_ID`, `REQUESTED_AT`, `REQUESTED_BY`). The API is `GET /api/system/update`, `POST /api/system/update` and `POST /api/system/update/cancel`, all admin only.

**A host cron job does the work.** `scripts/update_watch.sh` runs every minute as root on the Docker host. Each run stamps `update/watcher.env`; Horde shows the button only if that stamp is under 5 minutes old, so a missing job means no button. If a request is waiting, the script moves it to `current.env`, writes `status.env` (`STATE=running`), runs `update.sh` (which reports its outcome in `HORDE_UPDATE_RESULT_FILE`), logs to `update.log` and records the final state (`updated`, `up_to_date`, `rolled_back`, `failed`, `interrupted`). A `flock` prevents two runs at once; a `running` state left by a run that died is marked `interrupted` by the next run. With nothing to do it prints nothing. `--setup` verifies the data folder is found and prints the cron command. Everything in `DATA_DIR/update/` is read and written as the data folder's owner (`setpriv`), never as root, because a compromised Horde controls that folder; the script also refuses the folder if it is a link, never follows links to files in it, creates files exclusively (`dd conv=excl oflag=nofollow`) and caps reads, so Horde cannot redirect it to other files of that user on the host. When run as root on a checkout owned by someone else, it lets git operate for that run and hands the files back to the owner afterwards.

The files are plain `KEY=value` lines so that neither side needs a shared library or a socket. There is no scheduled or automatic update: only a button press creates a request.

**Alternatives rejected**

- **Docker socket mounted into Horde.** Whoever controls the socket is root on the host, and Horde parses untrusted media and URLs.
- **A helper updater container holding the socket.** The same privilege, only moved; it has to recreate the container that started it, and its view of paths (bind mounts, the checkout) differs from the host's, which is the class of bug `update.sh` guards against.
- **Watchtower-style automatic image updates.** They skip the pre-update database backup and the rollback logic, follow no release channel, and take control away from the user.

## Consequences

- Horde's privilege is unchanged: the worst a compromised Horde can do is request an update of the configured channel. It cannot choose a command, a version or a path.
- One manual step remains (the cron job, once); until it exists the button is hidden and the shell way works as before. Removing the job removes the button within 5 minutes.
- The cron job runs as root and executes the checkout's scripts, so those files must not be writable by untrusted users.
- Latency is up to a minute before an update starts. Progress is read from files, so Horde reports it correctly across its own restart.
- `update.sh` stays the single engine and the way to roll back by hand; its behaviour is documented once.

Detail: [Updating](../getting-started/updating.md#update-from-the-app), [Security](../ops/security.md#in-app-updates).
