# Logging

Horde logs to standard error, so `docker logs horde` (or `docker compose logs -f horde`) shows everything. Application messages and uvicorn's access log share one format.

## Level and format

| Variable | Default | Effect |
|----------|---------|--------|
| `HORDE_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR`. Unknown values fall back to `INFO`. |
| `HORDE_LOG_FORMAT` | `text` | `text` (human readable) or `json` (one object per line). |

Text lines look like this:

```text
2026-10-15 09:12:31 INFO    app.services.downloads.runner [download-12] (job_id=download-12) started
```

The columns are timestamp, level, logger, thread name, then the correlation IDs when there are any, then the message. JSON lines carry the same fields (`ts`, `level`, `logger`, `thread`, `message`, `request_id`, `job_id`, and `exc_info` for tracebacks), which suits Loki, Vector or any collector that parses JSON.

## Correlating a log line with a request or job

* Every HTTP response has an `X-Request-ID` header. If the client (or your reverse proxy) sends its own `X-Request-ID` of up to 64 letters, digits and `._:-`, Horde reuses it; otherwise it generates one. Every log line written while that request is handled carries `request_id`.
* Download, ffmpeg postprocess, AI and channel-catalog jobs set `job_id` (`download-<id>`, `ai-<id>`, `catalog-<id>`) while they run, so `grep job_id=download-12` follows one download from start to finish.

Uvicorn's access lines carry the same `request_id`, so a proxy log line and the matching Horde access line can be joined on the `X-Request-ID` header.

## Caught errors are logged, not swallowed

Failures that Horde handles itself (a thumbnail that could not be written, a poll that will retry) are logged at `WARNING` with the traceback, or at `DEBUG` when they are routine and noisy. If something looks wrong in the UI but nothing is in the log, raise the level to `DEBUG` and reproduce it.
