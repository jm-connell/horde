# Monitoring

Horde has three probe endpoints. None of them forks a process or waits on the network, so polling them every few seconds is fine.

| Endpoint | Answers | Use it for |
|----------|---------|-----------|
| `GET /api/ping` | `{"ok": true}` | Liveness and the app's connectivity check. No database or disk work. |
| `GET /api/ready` | `200` or `503` | Readiness: can this instance serve? |
| `GET /api/health` | Status snapshot | The Settings → System panel, `update.sh`, dashboards. |

## Ready { #ready }

`GET /api/ready` returns `200` when the database answers, the schema is at the latest migration and every background worker is running, and `503` otherwise:

```json
{
  "ready": false,
  "database": true,
  "migrations": true,
  "workers": { "scanner-poller": true, "horde-ai-worker": false },
  "problems": ["worker horde-ai-worker is not running"]
}
```

A worker that finished its job on purpose (the codec probe backfill ends when nothing is left to probe) counts as running; one that crashed does not. Use `/api/ping` for the container healthcheck and `/api/ready` for "has it finished starting".

## Health { #health }

`GET /api/health` is built from values computed once at startup or refreshed in the background, plus three `COUNT` queries:

* `yt_dlp_version` is the library the app imports, read once at startup.
* `pot_provider` is refreshed every 30 s by a background probe of the PO-token sidecar; `status` is `pending` until the first probe lands.
* `ffmpeg` reports `flavor` (`jellyfin` or `debian`) and `version` as recorded in `/app/BUILD_INFO` when the image was built. It is `null` outside the image.
* `storage_warning` is a message when `DATA_DIR` sits on a network filesystem and `null` otherwise. See [Storage safety](#storage).

## Storage safety { #storage }

At startup Horde reads `/proc/self/mountinfo` to find the filesystem under `DATA_DIR`. If it is `nfs`, `nfs4`, `cifs`, `smb3`, `smbfs`, `9p` or `fuse.sshfs`, it logs an `ERROR` and reports `storage_warning` on `/api/health`.

SQLite's write-ahead log needs shared memory and file locks that network filesystems do not provide reliably, so a database there can be corrupted silently. Keep `DATA_DIR` on local disk (an SSD dataset on the host); only the downloads folder should live on network storage. The check is Linux only.
