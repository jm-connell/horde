# Notifications

Horde can tell you when something needs you without anyone having the app open: a failed download, a paused queue, an update that rolled back. An administrator adds **targets** in **Settings → System → Notifications**; each target is an [ntfy](https://ntfy.sh) topic, a Discord channel or any webhook, and chooses which events it wants.

Nothing is sent until you add a target. Horde sends from the server, so the target has to be reachable from the Horde container (a self-hosted ntfy on your LAN is fine).

## Events

The Settings screen lists these from the server, so it always matches the version you run.

| Event | Sent when | On for a new target |
|-------|-----------|:-------------------:|
| Download failed | A download gave up. Carries the video, the channel and the reason. | yes |
| Download finished | A video finished downloading into the library. Option **Only automatic downloads** (on by default) skips downloads you queued yourself and reports channel auto-downloads and subscribed playlists. Downloads "to this device" never count. | no |
| Downloads paused for disk space | The queue went from running to waiting because the library is at its [size limit](../guides/downloads.md#disk-limits) or the disk is nearly full. At most one message every 30 minutes, however often the disk hovers around the limit. | yes |
| Update available | A new Horde release is out. Sent once per release. | no |
| Update failed | **Update now** failed, was interrupted or was rolled back (within the last 24 hours). Sent once per attempt. | yes |
| Followed channel went live | A channel somebody follows started a broadcast. Needs the [live check](../design/live-streams.md) to be on; a broadcast is announced once. A channel seen for the first time (after a restart, or just followed) stays quiet. | no |
| Failed sign-ins | Ten failed sign-ins (a wrong password or a wrong second-step code) for one **existing account** within an hour: "12 failed sign-ins in the last hour from 5 addresses". At most one message per account per hour; made-up usernames never count. See the [internet exposure checklist](internet-exposure.md#alerts). | yes |
| Sign-in from a new device | An account signed in from a browser or device label it has no live session on (the "Safari on iPhone" label of *Signed-in devices*). Every account counts, and signing out and in again on the same browser counts once its session is gone, so it can be chatty on a shared server. Carries the name, the device and the address. | no |

### Bursts

Failures, finished downloads and live channels arrive in bursts (thirty auto-downloads finishing together). The first message after a quiet minute goes out at once; the rest for the same target wait and leave together, at most once a minute, as a summary such as "30 new videos downloaded" with the first few titles.

## Setting up a target

Press **Add target**, pick the type, fill in the fields and press **Send test** before saving. The result shows under the buttons: "Sent (HTTP 200)" or a short reason ("Could not connect to the server", "The server rejected the credentials (HTTP 401)").

You can add up to ten targets. The switch on a target pauses it without deleting it.

### ntfy

1. Pick a topic nobody can guess (`horde-k3m9x2`); on ntfy.sh anyone who knows a topic can read it.
2. Server URL: `https://ntfy.sh`, or the address of your own server (`http://ntfy.lan:8080`). Topic: the name from step 1.
3. If the server needs sign-in, create an access token in ntfy (`ntfy token add`) and paste it into **Access token**; Horde sends it as `Authorization: Bearer …`.
4. Subscribe to the topic in the ntfy app on your phone.

Horde posts to `{server}/{topic}` with the message as the body and the headers `Title`, `Priority` (high for failures and stalls), `Tags` (emoji) and, when `HORDE_PUBLIC_URL` is set, `Click` (tapping the notification opens Horde at the right page). Titles with accents or other non-ASCII characters are sent as RFC 2047 encoded words, which ntfy decodes.

### Discord

In the channel settings open **Integrations → Webhooks → New Webhook** and copy the webhook URL into **Webhook URL**. There is no token field: the URL is the secret. Horde posts `{"content": "**Title**\nmessage\nlink"}` and sets `allowed_mentions` so a video title can never ping `@everyone`.

### Webhook

Horde `POST`s JSON to the URL with `Content-Type: application/json`, `User-Agent: Horde-Notifications` and, if you set a token, `Authorization: Bearer <token>`. A `2xx` answer counts as delivered.

```json
{
  "event": "download_failed",
  "title": "Download failed: Some video",
  "message": "Some channel — Sign in to confirm you're not a bot",
  "url": "https://horde.example.com/download",
  "data": {
    "path": "/download",
    "count": 1,
    "items": [
      {
        "job_id": 42,
        "status": "error",
        "title": "Some video",
        "channel": "Some channel",
        "url": "https://www.youtube.com/watch?v=…",
        "error": "Sign in to confirm you're not a bot",
        "error_kind": "bot",
        "origin": "manual",
        "destination": "library",
        "video_id": null
      }
    ]
  },
  "sent_at": "2026-10-23T14:12:03+00:00"
}
```

| Field | Meaning |
|-------|---------|
| `event` | The event name from the table (`download_failed`, `download_completed`, `queue_held`, `update_available`, `update_failed`, `channel_live`, `login_failures`, `new_device_sign_in`), or `test` for **Send test**. |
| `title`, `message` | The text a person would read. |
| `url` | Link to the right page in Horde; `null` unless `HORDE_PUBLIC_URL` is set. |
| `data.path` | The same page as a path (`/download`, `/watch/12`, `/settings?tab=system`), always present. |
| `data.count` | How many occurrences this message covers (more than one for a summary). |
| `data.items` | The details of up to 50 of them. The fields depend on the event. |
| `sent_at` | UTC time the message was built. |

Item fields by event:

| Event | Fields |
|-------|--------|
| `download_failed`, `download_completed` | `job_id`, `status`, `title`, `channel`, `url`, `error`, `error_kind`, `origin` (`manual`, `channel_autodownload`, `playlist_sync`), `destination`, `video_id` |
| `queue_held` | `code` (`library_full`, `would_exceed`, `low_disk`, `disk_full`), `reason` |
| `update_available` | `latest`, `current`, `html_url` |
| `update_failed` | `state` (`failed`, `rolled_back`, `interrupted`), `exit_code`, `request_id` |
| `channel_live` | `channel`, `channel_url`, `title`, `video_id` |
| `login_failures` | `username`, `count` (failures in the last hour), `addresses` (how many different) |
| `new_device_sign_in` | `username`, `device`, `address` |

## Links back to Horde

Set `HORDE_PUBLIC_URL` (for example `https://horde.example.com`) to the address you open Horde at. Without it messages carry no link, because the server cannot know which of its addresses you use. See [Environment variables](environment.md).

## Delivery and failures

Messages are queued in memory and sent by a background worker (`notifications` in [`/api/ready`](monitoring.md#ready)), so a slow or dead target never slows a download down. Each send waits at most 10 seconds for any one step and 15 seconds in all (only the status is read, never the reply body), with up to three attempts, 2 and 8 seconds apart; a refusal such as `401` or `404` is not retried. A message that still fails is written to the log as a warning (the reason, never the address or the token) and dropped. The queue holds 500 messages; beyond that the oldest are dropped. Messages still waiting when Horde stops are lost; the log says how many.

## Security

- Only administrators can see or change targets (`/api/notifications`), and the **Send test** buttons make the server connect to the address you typed. Like the Ollama address in Settings → AI, it may be a LAN address; that is why it is admin-only.
- The address must be `http` or `https` and may not contain a user name or password. Redirects are not followed, and the answer's body is read and discarded, never stored or shown.
- The access token is stored in `app_settings.json` (so it is in backups, like the OpenRouter key) and never sent back to the browser, only its last four characters. Leave the field empty when editing to keep it, or tick **Remove the saved token**. A Discord webhook's address is masked the same way (only the end of its secret is shown) and the masked address keeps the saved one. Pointing a target that has a saved token at a different host, or moving a masked Discord address to another host, is refused (`token_required`) until you enter the token or the full address again, so a saved secret is never sent somewhere you did not mean. Tokens and Discord webhook secrets are redacted from log lines.
- Error messages in the Settings screen are fixed sentences, not the raw exception, because those can contain the address.
