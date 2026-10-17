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

`/api/ready` answers `503` with the problem `shutting down` as soon as a stop signal arrives, so a proxy stops sending traffic while the workers wind down. It reads the stored migration revision with one cheap query and compares it with the head revision cached at startup.

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

## Metrics { #metrics }

`GET /api/metrics` returns the [Prometheus text format](https://prometheus.io/docs/instrumenting/exposition_formats/) with no extra dependency. It is cheap (a few `GROUP BY` queries and `stat` calls), so scraping every 15 s is fine. It sits behind the same host and CSRF checks as the rest of `/api`.

| Metric | Type | Meaning |
|--------|------|---------|
| `horde_download_jobs{status}` | gauge | Download jobs per status (`queued` and `downloading` are the live queue). |
| `horde_download_queue_paused` | gauge | `1` while the queue is paused. |
| `horde_ai_jobs{status}` | gauge | AI jobs per status. |
| `horde_catalog_channels{status}` | gauge | Channel catalogs per status (`queued` + `indexing` is the catalog queue). |
| `horde_library_videos` | gauge | Videos in the library. |
| `horde_worker_up{worker}` | gauge | `1` when the background worker is running (or finished its one-shot job). |
| `horde_db_size_bytes{file}` | gauge | Size of `horde.db` and its `-wal` file. |
| `horde_last_backup_timestamp_seconds` | gauge | Time of the newest [nightly backup](backup-restore.md#nightly); `0` when there is none. |
| `horde_disk_bytes{volume,kind}` | gauge | Free and total bytes of the downloads and data volumes. |
| `horde_http_requests_total{status_class}` | counter | Responses by `2xx`, `4xx`, ... since start. |
| `horde_http_request_seconds_total` | counter | Total request handling time since start. |

A Prometheus scrape job for a Compose install:

```yaml
scrape_configs:
  - job_name: horde
    metrics_path: /api/metrics
    static_configs:
      - targets: ["horde:8080"]
```

If you reach Horde under a hostname that is not on the LAN default list, add it to `HORDE_ALLOWED_HOSTS` or the scrape is answered with `400`.
