# YouTube history (Google Takeout)

Bring what you watched, subscribed to and saved on YouTube into Horde. Google does not let other apps read your YouTube history, so it comes from a **Google Takeout** export: a .zip of your own data that you download from Google and upload to Horde.

Everything you import belongs to **your account only**. Another person on the same Horde imports their own; nobody sees anyone else's.

## Export from Google

1. Open [takeout.google.com](https://takeout.google.com/), choose **Deselect all**, then tick **YouTube and YouTube Music**.
2. Under **All YouTube data included**, keep **history**, **subscriptions** and **playlists**. Leave out **videos** (your own uploads), or the export can be many gigabytes.
3. Under **Multiple formats**, pick **JSON** for history if you can. Takeout's default, HTML, also works, but its dates are written for people (in your account's language and time zone), so Horde reads them on a best-effort basis and only English dates reliably.
4. Create the export. Google emails you when it is ready; download the .zip. A big export comes in several parts: choose all of them.

## Import into Horde

Open **Settings → Library → YouTube history → Import from Google Takeout** (or the optional **YouTube history** step of the [setup wizard](../getting-started/first-run.md)). Choose the .zip (or the loose `watch-history.json` and CSV files of an unzipped export) and press **Import**.

1. **Watch history** is stored straight away. Horde says how many views were new and how many it already had.
2. **Subscriptions** are listed with a checkbox each, plus **Select all** and **Deselect all**. Ticked channels become channels you [follow](channels.md). Channels you already follow show as **Following**. A channel you unfollowed in Horde before starts unticked, so an old subscription does not undo that.
3. **Playlists** are listed the same way. Each ticked one becomes a **private** playlist of yours. Videos you have downloaded are linked to the library copy; the rest [play from YouTube](playlists.md) until you download them. Takeout lists only video ids, so a video Horde knows nothing about yet shows without a title.
4. **Import selected** follows the channels and copies the playlists.

Limits: 4 GB per upload; Horde reads at most 160 MB of watch history (a decade of heavy viewing is about 100 MB as JSON), 16 MB per CSV and 320 MB in all, and refuses a file that unpacks to more than 100 times its packed size. Views whose date it cannot read (an HTML export in a format or time zone it does not know) are left out, and the import says how many.

### Importing again later

Keep using YouTube and Horde side by side, then import a newer export whenever you like. Horde stores each view once (by video and the time you watched it), so the views it already has are skipped and only the new ones are added. A playlist you imported before is found again and only gains the videos it lacks; it is never duplicated. Times are kept to the second, so a view imported once from JSON and again from HTML is still stored once, as long as the HTML date is in a time zone Horde knows.

## What Horde does with it

The imported views never appear in **History** or **Continue watching**; those stay what you watched in Horde. They are used here:

| Where | What changes |
|-------|--------------|
| **Channel pages and searches** | Videos you watched on YouTube carry a **Watched** badge. |
| **Recommended → For you** | Videos you watched on YouTube count as watched (they move to the end). Channels you watch there lift their videos, recent viewing far more than old: a channel's pull halves every 30 days. With AI, your latest YouTube views also seed the content matching. With **Include not downloaded**, indexed uploads of channels you watch on YouTube are suggested even if you don't follow them. |
| **Throwbacks** | About one pick in twenty, marked **Throwback**, comes from a channel you watched a lot over six months ago and hardly since (with AI, also from a topic you watched back then). The pick changes daily. |
| **Download page** | **Watched often on YouTube**, folded under the download form, lists videos you watched at least twice there that you have not downloaded, most-watched first, each with a **Download** button. |
| **History stats** | Off by default. Turn on **Include YouTube in History stats** (in Settings, or in the import dialog) to count YouTube views too. See below. |

### YouTube in History stats

Takeout records **when** you watched, not **for how long**, so YouTube views never add watch time. With the switch on:

- **Videos started** counts the YouTube videos too (a video you also watched in Horde counts once).
- **Active days** and the **streak** count days with a YouTube view.
- **Top channels** rank by videos watched in both places and show the YouTube views next to the watch time.
- **When you watch** blends both: each cell's shade is its share of the busiest hour of Horde watching plus its share of the busiest hour of YouTube views.
- The summary line adds the number of YouTube views.

## Forget it again

**Settings → Library → YouTube history → Forget** deletes your imported views. Channels you followed and playlists you imported stay; unfollow or delete them as usual. Deleting your account deletes the imported history with it.

## API

| Method | Path | What |
|--------|------|------|
| `POST` | `/api/takeout/import` | Multipart field `files` (one or more). Stores the views; returns the subscriptions and playlists found. |
| `POST` | `/api/takeout/apply` | `{subscriptions: [...], playlists: [...]}`: follow and copy the chosen ones. |
| `GET` | `/api/takeout/history` | Totals of your imported history. |
| `DELETE` | `/api/takeout/history` | Forget it. |
| `GET` | `/api/takeout/rewatched` | Videos watched at least twice, not in the library (`{items, next_cursor}`). |
| `GET` | `/api/history/stats?include_youtube=true` | Stats with YouTube views. |

Why the history is stored apart from Horde's own: [ADR 0019](../adr/0019-youtube-history-from-takeout.md).

## Related

- [History & continue watching](history.md)
- [AI features](ai-features.md): For you
- [Channels](channels.md): following
- [Playlists](playlists.md)
