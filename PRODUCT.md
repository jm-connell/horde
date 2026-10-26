# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the person who runs the server: a self-hoster who archives
YouTube and other online videos on a home NAS (TrueNAS with Dockge) and wants to
find and watch them later in an organised way, the way Plex handles films and TV
but not "other" video. Household members are the second audience. Each has an
account the admin creates, with their own watch history, AI chats and
appearance, and only the permissions the admin grants. Everyone reaches Horde
over the home network or a VPN, on desktops, TVs (through Chromecast), tablets
and phones (often as an installed PWA).

## Product Purpose

Horde is a self-hosted video library and downloader. It lets the household
collect videos from any yt-dlp-supported site or from files on disk, keeps them
as plain files (`Channel/Year/Title [id].ext`) that still make sense over SMB,
and gives them a clean place to browse, search and watch. Success is that the
archive is pleasant to use day to day: finding a video, picking up where you
left off and adding a new one all take seconds.

## Positioning

A personal archive first, not a streaming client. Videos are downloaded and kept
as ordinary files the user owns; YouTube streaming exists to preview before
deciding to download. Organising is built around channels, playlists, tags and
search across the whole archive, with optional AI (summaries, chapters, chat,
tags, semantic search) through any OpenAI-compatible provider the user chooses.

## Operating Context

- One Docker container on a home server, plus a small helper container for
  YouTube; optional bundled Ollama. Updates follow tagged releases.
- Used in short sessions: browse or search, watch, queue a few videos, paste a
  link to download. Long viewing happens in the player, often in theater mode,
  the mini player or on a TV.
- The admin also runs housekeeping: download queue, review queue for imported
  files, storage limits, channel catalogs, accounts and permissions.

## Capabilities and Constraints

- Downloads with presets, a live queue (pause, resume, retry) and playlist
  import; uploads and a review queue for files dropped into the media folder.
- Library with channel sidebar, hybrid search, tags, bulk selection, continue
  watching, channel catalogs and followed live streams.
- Player: standard, theater and windowed modes, mini player, picture-in-picture,
  Chromecast, SponsorBlock, chapters, subtitles, a play queue ("Up next"). No
  live transcoding; optional pre-made H.264 copies for devices without AV1.
- Accounts: one admin plus members with granted permissions; optional two-step
  sign-in. Trusted LAN or VPN, not built for open internet exposure.
- Offline: the PWA can keep downloaded videos for offline viewing.
- Every user picks their own theme (13 built-in palettes plus custom colors and
  custom CSS), font, font size, hover motion and panel transparency. Design work
  must hold up across all of them.

## Brand Commitments

- The name is Horde (a pun on "hoard"). The tone of the README and docs is
  plain, first-person and unpretentious.
- The default look is dark with a cyan accent; users can re-theme freely, so
  the brand is carried by structure and restraint rather than a fixed palette.

## Evidence on Hand

- Screenshots in `docs/` and the README; the user guide in `docs/` (also served
  at `/wiki`).
- No testimonials, user counts, benchmarks or press exist. Do not invent them.

## Product Principles

1. The video is the point. Chrome recedes so thumbnails, titles and the player
   carry the screen.
2. The archive belongs to the user: plain files, no lock-in, nothing that only
   works through Horde.
3. Fast daily use beats feature display. Common actions (find, resume, queue,
   download) stay one or two steps away.
4. Personal, not one-size-fits-all: every user's theme and preferences are
   honoured, and nothing assumes the default palette.
5. Honest about fragile parts. Streaming and AI say when they may not work
   instead of hiding it.

## Accessibility & Inclusion

- Secondary text must meet WCAG AA (4.5:1) on every theme surface; use the
  `text-muted` token rather than low-contrast grays.
- Respect `prefers-reduced-motion`: keep fades, drop movement.
- Keyboard and screen-reader use is covered by axe checks in the Playwright
  suite; forms need labels and clickable non-buttons need roles and key
  handling (see CLAUDE.md).
