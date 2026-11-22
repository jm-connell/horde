# Live Chat Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Past livestreams (library or streamed) show YouTube's chat replay in step with playback, placed beside the player, never saved.

**Architecture:** A `chat_replay` service reads a video's chat from YouTube's internal chat-replay endpoints around a requested position (seek token) or after the last chunk (replay token), caching tokens and chunks on the `AppContext`. One GET route serves `{status, items, next_cursor}`. The watch page runs one `useChatReplay` hook that follows the playback position and renders a `ChatReplayPanel` in the slot the layout picks (sidebar, beside the info panels, inline, phone sideways, or a portal into the fullscreen player). Library videos learn whether they were streams from a new `videos.live_status` column.

**Tech Stack:** FastAPI, SQLModel, Alembic (SQLite batch mode), yt-dlp 2026.10.26 helpers (`YoutubeBaseInfoExtractor`), React 18 + TypeScript, TanStack Query, Tailwind, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-21-chat-replay-design.md`

## Global Constraints

- Chat is never saved: no table, file or sidecar holds messages.
- Chat shows only for `live_status == "was_live"`, never `post_live`; clips show none.
- Interface wording: "Live chat" (panel heading), "Show live chat" (the bring-back bar). Code, routes and settings say `chat_replay` / `chatReplay`; "chat" alone already means the AI chat.
- No avatars. Links in messages render as plain text. Custom emoji, sticker and badge images only from `https://yt3.ggpht.com` / `https://yt3.googleusercontent.com`.
- State on the `AppContext` (`ctx.chat_replay`), no module-level mutable state.
- Errors use the envelope: `youtube_rate_limited` (503), `youtube_unreachable` (503), `chat_replay_unavailable` (502), `invalid_youtube_id` (422), `invalid_cursor` (422), `invalid_request` (422).
- Any API change regenerates `backend/openapi.json` (`cd backend && PYTHONPATH=. python -m app.export_openapi openapi.json`) and `frontend/src/api/schema.d.ts` (`cd frontend && npm run gen:api`).
- Every `except Exception` logs (`logger.warning(..., exc_info=True)` or `logger.info` for expected YouTube failures, as `comments/fetch.py` does).
- Colours in the panel use `DESIGN.md` theme roles; YouTube's Super Chat tier colour appears only as a thin accent.
- Probe scripts showing the request loop against a real stream are in the session scratchpad (`chat_probe.py`, `chat_kinds.py`); YouTube's real shapes are recorded in Task 2's notes. Tests never touch the network.

## Review Focus

1. **Seeking back before what is loaded** (or far past it): chat must reload from the new position, not keep showing the old stretch. → `needsReload` tests in Task 5, seek step in Task 6's e2e.
2. **Switching to another video while a chunk is in flight:** the old video's messages must never appear. → Task 5 hook ignores results for a stale id; Task 6 e2e navigates between two videos.
3. **YouTube limits requests mid-watch:** one note with Retry, no request storm, playback unaffected. → Task 3 (paused runtime makes no call), Task 6 e2e counts requests after a 503.
4. **Chat replay turned off on YouTube after Horde recorded `was_live`:** `none` must remove the panel and give the right column back to "More like this". → Task 6 e2e.
5. **A flood:** a chunk with hundreds of messages, a 50 KB message, an unknown renderer. → Task 2 caps and unknown-kind tests; Task 5 `visibleItems` keeps at most `CHAT_KEEP`.

---

### Task 1: `videos.live_status`, exposed on videos and stream previews

**Files:**
- Modify: `backend/app/models.py` (`Video`, after `platform`)
- Create: `backend/app/migrations/versions/0036_video_live_status.py`
- Modify: `backend/app/schemas.py` (`VideoRead`, `StreamPreviewMeta`)
- Modify: `backend/app/api/video_serialize.py` (`_to_read`, both full and compact branches)
- Modify: `backend/app/services/stream_preview.py:714-717` (meta dict), `backend/app/api/preview.py:547-548`
- Modify: `backend/app/services/downloads/finalize.py` (`_apply_remote_metadata`)
- Modify: `backend/app/services/metadata_sync.py` (`refresh_video_metadata`, inside the second session)
- Modify: `backend/app/e2e_seed.py` (Cedar Notes gets `live_status="not_live"` so no e2e spec reaches YouTube)
- Modify: `backend/openapi.json`, `frontend/src/api/schema.d.ts` (regenerated)
- Modify: `docs/design/sqlite-and-migrations.md` (revision table row)
- Test: `backend/tests/test_video_live_status.py`

**Interfaces:**
- Produces: `Video.live_status: str | None` (yt-dlp's value); `VideoRead.live_status: str | None`; `StreamPreviewMeta.live_status: str | None`; preview meta dict key `"live_status"` from `entry_live_status(info)`.
- Consumes: `entry_live_status(entry) -> str | None` (`services/ytdlp_extract.py:550`).

- [ ] **Step 1: Write the failing tests** in `backend/tests/test_video_live_status.py`:

```python
def test_revision_backfills_live_status_from_the_channel_catalog(...):
    # Build a DB at 0035 (pattern: tests/test_database_migrate.py), insert a
    # video with youtube_id "abcdefghijk" and a channel_catalog_videos row with
    # the same id and live_status "was_live", plus a video with no catalog row.
    # Upgrade to head.
    assert live_status_of("abcdefghijk") == "was_live"
    assert live_status_of("zzzzzzzzzzz") is None

def test_finalize_records_live_status(session, ...):
    # _apply_remote_metadata(session, video, {"live_status": "was_live"}, False)
    assert video.live_status == "was_live"
    # and {"was_live": True} without live_status -> "was_live"

def test_metadata_refresh_records_live_status(monkeypatch, session, add_video):
    # monkeypatch metadata_sync._extract_metadata -> {"live_status": "was_live", ...}
    refresh_video_metadata(video_id, fields=["views"])
    assert session.get(Video, video_id).live_status == "was_live"

def test_video_read_and_preview_meta_carry_live_status(client, add_video, monkeypatch):
    # GET /api/videos/{id} -> body["live_status"] == "was_live"
    # preview meta for a post_live info -> was_live True, live_status "post_live"
```

- [ ] **Step 2: Run them, expect failures**

Run: `cd backend && PYTHONPATH=. pytest tests/test_video_live_status.py -q`
Expected: FAIL (no column / no field).

- [ ] **Step 3: Add the column and revision.** `Video.live_status: str | None = None`. Revision `0036_video_live_status` (down `0035_kb_keep_indexed_videos`): plain `op.add_column("videos", sa.Column("live_status", sa.String(), nullable=True))` (no batch rebuild, so the `videos` triggers and `videos_fts` are untouched), then `UPDATE videos SET live_status = (SELECT c.live_status FROM channel_catalog_videos c WHERE c.youtube_id = videos.youtube_id AND c.live_status IS NOT NULL LIMIT 1) WHERE youtube_id IS NOT NULL AND live_status IS NULL`. Check `channel_catalog_videos`' id column name in `models.py` (`ChannelCatalogVideo`) before writing the SQL. `downgrade` drops the column with `batch_alter_table` only if the drift test needs it; otherwise a no-op with a comment, as `0035` does.

Deviation from the spec: the spec fills the column from the comments fetcher's extract; this plan uses the metadata refresh instead, which already holds the full info dict and writes the video row, where the comments fetcher would need its result type changed for one field.

- [ ] **Step 4: Fill it.** `_apply_remote_metadata`: `video.live_status = entry_live_status(info)`. `refresh_video_metadata`: when `entry_live_status(info)` is not None and differs, set it (whatever `fields` is). `VideoRead.live_status` in both serializer branches. `StreamPreviewMeta.live_status`, filled from the meta dict. Seed: Cedar Notes `live_status="not_live"`.

- [ ] **Step 5: Regenerate the schemas and run the tests**

Run: `cd backend && PYTHONPATH=. python -m app.export_openapi openapi.json && PYTHONPATH=. pytest tests/test_video_live_status.py tests/test_database_migrate.py tests/test_stream_preview.py -q && cd ../frontend && npm run gen:api`
Expected: PASS; `git diff --stat` shows `openapi.json` and `schema.d.ts` changed.

- [ ] **Step 6: Add the revision row** to `docs/design/sqlite-and-migrations.md` ("`0036_video_live_status` | `videos.live_status` … A plain `ADD COLUMN`; `videos` is not rebuilt; backfilled from the channel video list").

- [ ] **Step 7: Commit** — `Record whether a library video was a livestream`.

---

### Task 2: Parse YouTube's chat replay JSON

**Files:**
- Create: `backend/app/services/chat_replay/__init__.py` (docstring: read around the position, never saved; module map)
- Create: `backend/app/services/chat_replay/parse.py`
- Create: `backend/tests/fixtures/chat_replay/chunk.json` (one `liveChatContinuation` with made-up authors and text, one action of each kind below, a placeholder, an engagement message, a ticker item, an unknown renderer, and both continuations)
- Create: `backend/tests/fixtures/chat_replay/watch_initial_data.json` (only the `conversationBar.liveChatRenderer` path) and `player_response.json` (only `videoDetails`)
- Test: `backend/tests/test_chat_replay_parse.py`

**Interfaces:**
- Produces (all in `parse.py`):
  - `MAX_TEXT = 2000`, `MAX_AUTHOR = 200`, `IMAGE_HOSTS = frozenset({"yt3.ggpht.com", "yt3.googleusercontent.com"})`
  - `@dataclass class ChatRun: text: str | None = None; emoji_url: str | None = None; emoji_alt: str | None = None`
  - `@dataclass class ChatItem: id: str; offset_ms: int; kind: str; author: str | None; badges: list[str]; runs: list[ChatRun]; amount: str | None = None; color: str | None = None; sticker_url: str | None = None; header: str | None = None` — `kind` in `text | paid | sticker | membership | gift`; `badges` ⊆ `owner | moderator | member | verified`; `color` is `#rrggbb`.
  - `parse_actions(actions: list[Any]) -> list[ChatItem]` — sorted by `offset_ms`, deduplicated by `id`, never raises on odd input.
  - `continuation_tokens(lcc: dict[str, Any]) -> tuple[str | None, str | None]` — `(replay_token, seek_token)`.
  - `chat_continuation(initial_data: dict[str, Any]) -> str | None` — the watch page's `reloadContinuationData` token, None when the video has no chat replay.
  - `live_status_from_player_response(pr: dict[str, Any]) -> str | None` — yt-dlp's rule (`_video.py:3868`): `isPostLiveDvr` → `post_live`, `isLive` → `is_live`, `isUpcoming` → `is_upcoming`, `isLiveContent` → `was_live`, an explicit `False` → `not_live`, else None.

Shapes seen on a real stream (2026-11-21): every action is `replayChatItemAction {videoOffsetTimeMsec, actions: [{addChatItemAction: {item: {<renderer>: …}}}]}`; inner action dicts may also carry plain-string keys (`clickTrackingParams`), so pick the first dict-valued key. Renderers: `liveChatTextMessageRenderer {id, authorName.simpleText, message.runs[{text}|{emoji:{emojiId, isCustomEmoji, shortcuts, image.thumbnails}}], authorBadges[].liveChatAuthorBadgeRenderer{icon.iconType: OWNER|MODERATOR|VERIFIED, customThumbnail (member), tooltip}}`; `liveChatPaidMessageRenderer` adds `purchaseAmountText.simpleText` and `bodyBackgroundColor` (ARGB int); `liveChatPaidStickerRenderer {sticker.thumbnails, sticker.accessibility.accessibilityData.label, purchaseAmountText, moneyChipBackgroundColor}`; `liveChatMembershipItemRenderer {headerPrimaryText?.runs, headerSubtext (simpleText|runs), message?.runs}`; `liveChatSponsorshipsGiftPurchaseAnnouncementRenderer {header.liveChatSponsorshipsHeaderRenderer{authorName, primaryText.runs, authorBadges}}`. Drop: `liveChatPlaceholderItemRenderer`, `liveChatViewerEngagementMessageRenderer`, ticker (`addLiveChatTickerItemAction`), banners, polls, mode changes, anything unknown.

- [ ] **Step 1: Write the failing tests**

```python
def test_each_kind_is_parsed_in_offset_order():
    items = parse_actions(load("chunk.json")["actions"])
    assert [i.kind for i in items] == ["text", "paid", "sticker", "membership", "gift"]
    assert [i.offset_ms for i in items] == sorted(i.offset_ms for i in items)

def test_text_runs_emoji_and_badges():
    text = by_kind("text")
    assert text.author == "Ada"
    assert text.badges == ["moderator"]
    assert text.runs[0] == ChatRun(text="hello ")
    assert text.runs[1] == ChatRun(text="😀")              # standard emoji: its character
    assert text.runs[2].emoji_url.startswith("https://yt3.ggpht.com/")
    assert text.runs[2].emoji_alt == ":wave:"                # custom emoji: shortcut as alt

def test_paid_has_amount_and_hex_colour():
    paid = by_kind("paid")
    assert paid.amount == "$5.00" and paid.color == "#1de9b6"

def test_dropped_kinds_and_unknown_renderers_leave_nothing():
    # placeholder, engagement, ticker, unknown -> not in the result

def test_duplicates_odd_input_and_caps():
    assert parse_actions([None, "x", {"replayChatItemAction": {}}]) == []
    huge = text_action("a" * 50_000, author="b" * 1000)
    item = parse_actions([huge, huge])  # same id twice
    assert len(item) == 1
    assert sum(len(r.text or "") for r in item[0].runs) == MAX_TEXT
    assert len(item[0].author) == MAX_AUTHOR

def test_images_off_youtube_hosts_are_dropped():
    # a custom emoji on http:// or another host keeps its alt text as a text run

def test_tokens_continuation_and_live_status():
    assert continuation_tokens(load("chunk.json")) == ("REPLAY", "SEEK")
    assert chat_continuation(load("watch_initial_data.json")) == "RELOAD"
    assert chat_continuation({}) is None
    assert live_status_from_player_response({"videoDetails": {"isLiveContent": True}}) == "was_live"
    assert live_status_from_player_response({"videoDetails": {"isLiveContent": True, "isPostLiveDvr": True}}) == "post_live"
    assert live_status_from_player_response({"videoDetails": {"isLiveContent": False}}) == "not_live"
```

- [ ] **Step 2: Run, expect failures** — `cd backend && PYTHONPATH=. pytest tests/test_chat_replay_parse.py -q` → FAIL (module missing).
- [ ] **Step 3: Implement `parse.py`** to the interfaces above. ARGB int → `#rrggbb` from the low 24 bits.
- [ ] **Step 4: Run, expect pass** (same command) and `ruff check app/services/chat_replay && mypy app/services/chat_replay`.
- [ ] **Step 5: Commit** — `Parse YouTube chat replay chunks`.

---

### Task 3: Read chat from YouTube, cached on the context

**Files:**
- Create: `backend/app/services/chat_replay/youtube.py`
- Create: `backend/app/services/chat_replay/runtime.py`
- Create: `backend/app/services/chat_replay/service.py`
- Modify: `backend/app/context.py` (field `chat_replay: ChatReplayRuntime` + `_new_chat_replay()`, as `comments`)
- Test: `backend/tests/test_chat_replay_service.py`

**Interfaces:**
- Consumes: Task 2's `parse_actions`, `continuation_tokens`, `chat_continuation`, `live_status_from_player_response`, `ChatItem`.
- Produces:
  - `youtube.py`: `@dataclass class Chunk: items: list[ChatItem]; replay_token: str | None; seek_token: str | None; end_ms: int | None` · `@dataclass class ChatHandle: yt_id: str; api_key: str; context: dict[str, Any]; headers: dict[str, str]; cookies: bool` · `@dataclass class Opened: live_status: str | None; handle: ChatHandle | None; first: Chunk | None` (`handle is None` = no chat replay) · `class ChatReplayError(Exception): status: str` with statuses from `comments.fetch` (`RETRY`, `LATER`, `UNAVAILABLE`, `FAILED`) · `open_chat(yt_id: str) -> Opened` · `fetch_chunk(handle: ChatHandle, token: str, offset_ms: int) -> Chunk`.
  - `runtime.py`: `OPEN_TTL_SEC = 30 * 60`, `NONE_TTL_SEC = 6 * 3600`, `CHUNK_TTL_SEC = 30 * 60`, `CHUNK_KEEP = 400`, `PAUSE_ON_LIMIT_SEC = 30 * 60`; `@dataclass class ChatReplayRuntime` with `pause(seconds)`, `seconds_paused() -> float`, `video_lock(yt_id) -> threading.Lock`, `opened_get(yt_id) -> Opened | None`, `opened_put(yt_id, opened)`, `chunk_get(key: tuple[str, str]) -> Chunk | None`, `chunk_put(key, chunk)`. Opened entries expire after `OPEN_TTL_SEC` idle (`NONE_TTL_SEC` when `handle is None`); chunks after `CHUNK_TTL_SEC`, oldest dropped past `CHUNK_KEEP`.
  - `service.py`: `@dataclass class ChatPage: status: Literal["ok", "none", "unavailable"]; items: list[ChatItem]; next_cursor: str | None` · `CURSOR_RE = re.compile(r"\d{1,9}~[A-Za-z0-9_%=-]{1,4096}")` · `read_at(yt_id: str, at_ms: int) -> ChatPage` · `read_next(yt_id: str, cursor: str) -> ChatPage` · both raise `ChatReplayError` (`RETRY` / `LATER` / `FAILED`); `UNAVAILABLE` becomes `ChatPage("unavailable", [], None)`.

Behaviour to implement:
- `open_chat`: one `yt_dlp.YoutubeDL` with `youtube_extractor_args()`, quiet, and the comments cookie rule (`url_cookie_required`, `apply_cookie_opts`, retry once with cookies when `should_retry_with_cookies`, then `remember_cookie_required`). `ie = YoutubeBaseInfoExtractor(ydl)`; watch page `https://www.youtube.com/watch?v={id}` → `extract_yt_initial_data`, player response via `ie._search_json(ie._YT_INITIAL_PLAYER_RESPONSE_RE, page, …, default={})`, `extract_ytcfg`. No chat continuation → `Opened(status, None, None)`. Otherwise `https://www.youtube.com/live_chat_replay?continuation=…` → first `Chunk`. Headers from `ie.generate_api_headers(ytcfg=…, visitor_data=…)` plus `content-type: application/json`.
- `fetch_chunk`: `ie._download_json` POST to `youtubei/v1/live_chat/get_live_chat_replay?key=…` with `{"context", "continuation", "currentPlayerState": {"playerOffsetMs": str(offset_ms)}}`.
- Failures: `is_network_error` → `LATER`; `classify_ytdlp_error` → rate limit / bot / PO token → `RETRY`; members / unavailable / cookies-without-cookie-file → `UNAVAILABLE`; else `FAILED` (logged at `info` with `exc_info=True`).
- `read_at`: while `seconds_paused() > 0` raise `RETRY` without any request. Under `video_lock(yt_id)`: reuse or open; `handle is None` → `ChatPage("none", …)`. When `at_ms` falls inside the first chunk (`at_ms <= first.end_ms`), answer with it. Otherwise cache key `("at", str(at_ms // 5000))`, fetch with the latest seek token (`fetch_chunk(handle, seek, at_ms)`), and store the chunk's new seek token on the opened entry. On `RETRY`, `pause(PAUSE_ON_LIMIT_SEC)`.
- `read_next`: validate `CURSOR_RE` (the API checks first), split `end_ms~token`, cache key `("next", token)`, `fetch_chunk(handle, token, max(end_ms - 5000, 0))`.
- `next_cursor` = `f"{chunk.end_ms}~{chunk.replay_token}"` when both are set, else None.
- After any open, when a library video has this `youtube_id` and `live_status IS NULL`, set it to `opened.live_status` (one `UPDATE … WHERE youtube_id = :id AND live_status IS NULL`).

- [ ] **Step 1: Write the failing tests** (fake `youtube.open_chat` / `youtube.fetch_chunk` with monkeypatch; count calls):

```python
def test_no_chat_replay_answers_none_and_is_remembered(monkeypatch, ctx):
    fake_open(returns=Opened("was_live", None, None))
    assert read_at("abcdefghijk", 0).status == "none"
    assert read_at("abcdefghijk", 60_000).status == "none"
    assert calls.open == 1

def test_a_position_in_the_first_chunk_needs_no_request(...):
    # first chunk ends at 65_000; read_at(.., 30_000) -> its items, fetch_chunk not called
    # next_cursor == "65000~REPLAY"

def test_a_jump_uses_the_seek_token_and_is_cached(...):
    read_at(yt, 7_200_000); read_at(yt, 7_201_000)   # same 5 s bucket
    assert calls.fetch == [("SEEK", 7_200_000)]

def test_next_uses_the_replay_token_from_the_cursor(...):
    read_next(yt, "65000~REPLAY")
    assert calls.fetch == [("REPLAY", 60_000)]

def test_two_viewers_share_one_open(...):
    # two threads read_at the same id at once -> calls.open == 1

def test_a_rate_limit_pauses_every_read(...):
    fake_fetch(raises=ChatReplayError(RETRY))
    with pytest.raises(ChatReplayError): read_at(yt, 7_200_000)
    with pytest.raises(ChatReplayError): read_at(other_yt, 0)
    assert calls.open_for(other_yt) == 0          # no YouTube request while paused

def test_unavailable_is_a_page_not_an_error(...):
    # open raises UNAVAILABLE -> ChatPage("unavailable", [], None)

def test_an_unknown_library_video_learns_its_live_status(session, add_video, ...):
    v = add_video(source_url="https://www.youtube.com/watch?v=abcdefghijk")  # live_status None
    read_at("abcdefghijk", 0)
    assert session.get(Video, v.id).live_status == "was_live"
    # a video already marked "not_live" is left alone

def test_open_chat_failures_are_classified(monkeypatch):
    # YoutubeDL stub raising "HTTP Error 429" -> RETRY; URLError -> LATER;
    # "Private video" -> UNAVAILABLE; anything else -> FAILED
```

- [ ] **Step 2: Run, expect failures** — `cd backend && PYTHONPATH=. pytest tests/test_chat_replay_service.py -q`.
- [ ] **Step 3: Implement** `youtube.py`, `runtime.py`, `service.py`, and the context field.
- [ ] **Step 4: Run, expect pass** — same command, plus `ruff check app && mypy`.
- [ ] **Step 5: Commit** — `Read chat replay from YouTube around a position`.

---

### Task 4: `GET /api/chat-replay/youtube/{youtube_id}`

**Files:**
- Create: `backend/app/api/chat_replay.py`
- Modify: `backend/app/schemas.py` (`ChatReplayRun`, `ChatReplayItem`, `ChatReplayRead`)
- Modify: `backend/app/main.py` (import and include the router next to `comments`)
- Modify: `backend/openapi.json`, `frontend/src/api/schema.d.ts` (regenerated)
- Test: `backend/tests/test_chat_replay_api.py`

**Interfaces:**
- Consumes: Task 3 `read_at`, `read_next`, `ChatReplayError`, `CURSOR_RE`, `ChatPage`.
- Produces: `ChatReplayRun {text?: str, emoji_url?: str, emoji_alt?: str}`, `ChatReplayItem {id, offset_ms, kind: Literal[...], author?, badges: list[Literal[...]], runs, amount?, color?, sticker_url?, header?}`, `ChatReplayRead {status: Literal["ok","none","unavailable"], items: list[ChatReplayItem] = [], next_cursor: str | None = None}`. Route: `GET /api/chat-replay/youtube/{youtube_id}?at_ms=&cursor=`, `response_model=ChatReplayRead`, router `dependencies=[Depends(current_user)]`, route `dependencies=[Depends(stream_guard), Depends(ytdlp_slot)]`. `at_ms: int | None = Query(None, ge=0, le=86_400_000)`; neither given → `at_ms = 0`; both → 422 `invalid_request`.

- [ ] **Step 1: Write the failing tests** (monkeypatch `service.read_at` / `read_next`):

```python
def test_reads_at_a_position(client, monkeypatch):
    r = client.get("/api/chat-replay/youtube/abcdefghijk?at_ms=7200000")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "items": [ITEM_JSON], "next_cursor": "7401682~T"}

def test_continues_from_a_cursor(client, ...): ...
def test_none_and_unavailable_are_200(client, ...): ...

@pytest.mark.parametrize("query,code", [
    ("?at_ms=1&cursor=1~T", "invalid_request"),
    ("?cursor=not a cursor", "invalid_cursor"),
    ("?at_ms=-1", None),                        # FastAPI 422
])
def test_bad_requests(client, query, code): ...

def test_bad_youtube_id(client):
    assert client.get("/api/chat-replay/youtube/short").json()["code"] == "invalid_youtube_id"

@pytest.mark.parametrize("status,http,code", [
    (RETRY, 503, "youtube_rate_limited"),
    (LATER, 503, "youtube_unreachable"),
    (FAILED, 502, "chat_replay_unavailable"),
])
def test_failures_use_the_envelope(client, monkeypatch, status, http, code): ...

def test_a_restricted_member_gets_only_allowed_channels(member_client, ...):
    # parental: allowed_channels set, stream of another channel -> 403 channel_not_allowed

def test_requires_sign_in(anon_client):
    assert anon_client.get("/api/chat-replay/youtube/abcdefghijk").status_code == 401
```

- [ ] **Step 2: Run, expect failures** — `cd backend && PYTHONPATH=. pytest tests/test_chat_replay_api.py -q`.
- [ ] **Step 3: Implement** the schemas, router and registration.
- [ ] **Step 4: Regenerate and run** — `PYTHONPATH=. python -m app.export_openapi openapi.json && PYTHONPATH=. pytest tests/test_chat_replay_api.py tests/test_permissions.py -q && cd ../frontend && npm run gen:api` → PASS.
- [ ] **Step 5: Commit** — `Serve chat replay at /api/chat-replay`.

---

### Task 5: Frontend data layer: API, model and `useChatReplay`

**Files:**
- Create: `frontend/src/api/chatReplay.ts`; Modify: `frontend/src/api.ts` (spread `chatReplayApi` like `commentsApi`)
- Modify: `frontend/src/types.ts` (`ChatReplayPage`, `ChatReplayItem`, `ChatReplayRun` aliases)
- Modify: `frontend/src/queries/keys.ts` (`chatReplay: { at: (id, bucket) => ["chatReplay", "at", id, bucket], next: (id, cursor) => ["chatReplay", "next", id, cursor] }`)
- Create: `frontend/src/hooks/useMediaQuery.ts`
- Create: `frontend/src/pages/watch/chatReplay/model.ts`, `model.test.ts`
- Create: `frontend/src/pages/watch/chatReplay/useChatReplay.ts`
- Modify: `frontend/src/hooks/settings/types.ts`, `defaults.ts` (`showChatReplay: boolean`, default `true`, added to the synced key list after `showRelatedVideos`)

**Interfaces:**
- Consumes: Task 4's route and generated types; `PlaybackActions.getCurrentPosition()` / `getStreamPosition()` (seconds); `WatchSource` (`pages/watch/useWatchVideo.ts`).
- Produces:
  - `chatReplayApi.chatReplayAt(youtubeId: string, atMs: number, opts?: ReadOptions): Promise<ChatReplayPage>`; `chatReplayApi.chatReplayNext(youtubeId: string, cursor: string, opts?: ReadOptions): Promise<ChatReplayPage>`.
  - `useMediaQuery(query: string): boolean`.
  - `model.ts`: `CHAT_KEEP = 300`, `PREFETCH_MS = 20_000`, `SEEK_BACK_SLACK_MS = 5_000`, `JUMP_AHEAD_MS = 60_000`; `type Loaded = { startMs: number; endMs: number; items: ChatReplayItem[]; nextCursor: string | null }`; `mergeChunk(loaded: Loaded | null, page: ChatReplayPage, atMs: number | null): Loaded` (`atMs` set for a jump, which replaces `loaded`; null appends a continuation; items deduplicated by id, sorted by `offset_ms`; `endMs` = last item's offset, or `atMs` when the page is empty); `visibleItems(loaded: Loaded | null, positionMs: number, keep = CHAT_KEEP): ChatReplayItem[]`; `needsNext(loaded: Loaded | null, positionMs: number): boolean`; `needsReload(loaded: Loaded | null, positionMs: number): boolean` (no data, `positionMs < startMs - SEEK_BACK_SLACK_MS`, or `positionMs > endMs + JUMP_AHEAD_MS`); `chatTarget(source: WatchSource): { youtubeId: string; known: boolean } | null` (stream: `youtubeVideoIdFromUrl(source.url)` (`utils`) when `meta.live_status === "was_live"`, known — other sites' past streams, such as Twitch VODs, also report `was_live` and get no chat; library: `video.youtube_id` when `live_status === "was_live"` (known) or `live_status == null` (not known); else null); `type ChatPlacement = "sidebar" | "beside-info" | "inline" | "sideways"`; `chatPlacement(o: { isMobile: boolean; landscape: boolean; theater: boolean; wide: boolean }): ChatPlacement` (mobile+landscape → sideways; mobile → inline; theater → beside-info; wide → sidebar; else inline).
  - `useChatReplay(youtubeId: string | null, getPositionSec: () => number): ChatReplayState` with `type ChatReplayState = { status: "idle" | "loading" | "ok" | "none" | "unavailable" | "error"; items: ChatReplayItem[]; errorCode: string | null; retry: () => void }`.

Hook behaviour: reads the position every 250 ms while `youtubeId` is set. Fetches through `queryClient.fetchQuery` (keys above, bucket = `Math.floor(atMs / 5000)`, `staleTime: Infinity`, `gcTime: 30 * 60_000`, `retry: false`) with an `AbortController` per request, so a second panel or a revisit shares results. At most one request in flight. `needsReload` → jump to the position; `needsNext` → continue. A result whose id differs from the current `youtubeId` is dropped. An error stops further requests until `retry()` (status `error`, `errorCode` from `ApiError.code`). `none` / `unavailable` stop polling. Changing `youtubeId` resets everything.

- [ ] **Step 1: Write the failing Vitest tests** in `model.test.ts`:

```ts
it("shows only messages up to the position, newest last, at most CHAT_KEEP", () => {
  const loaded = mergeChunk(null, page(range(0, 1000, 500)), 0); // 500 items, offsets 0..998
  const shown = visibleItems(loaded, 600);
  expect(shown.at(-1)!.offset_ms).toBeLessThanOrEqual(600);
  expect(visibleItems(loaded, 999_999)).toHaveLength(CHAT_KEEP);
});
it("continues before the loaded stretch runs out", () => {
  const loaded = mergeChunk(null, page([0, 50_000], "50000~T"), 0);
  expect(needsNext(loaded, 20_000)).toBe(false);
  expect(needsNext(loaded, 31_000)).toBe(true);
  expect(needsNext({ ...loaded, nextCursor: null }, 49_000)).toBe(false);
});
it("reloads after a seek back before, or far past, what is loaded", () => {
  const loaded = mergeChunk(null, page([600_000, 650_000]), 600_000);
  expect(needsReload(loaded, 610_000)).toBe(false);
  expect(needsReload(loaded, 100_000)).toBe(true);
  expect(needsReload(loaded, 800_000)).toBe(true);
  expect(needsReload(null, 0)).toBe(true);
});
it("a continuation appends without duplicates; a jump replaces", () => { ... });
it("chatTarget: was_live streams and library videos, unknown library videos, never post_live", () => {
  expect(chatTarget(stream(YT_URL, { live_status: "was_live" }))).toEqual({ youtubeId: "abcdefghijk", known: true });
  expect(chatTarget(stream(YT_URL, { live_status: "post_live", was_live: true }))).toBeNull();
  expect(chatTarget(stream("https://www.twitch.tv/videos/1", { live_status: "was_live" }))).toBeNull();
  expect(chatTarget(library({ youtube_id: "abc", live_status: null }))).toEqual({ youtubeId: "abc", known: false });
  expect(chatTarget(library({ youtube_id: "abc", live_status: "not_live" }))).toBeNull();
  expect(chatTarget(library({ youtube_id: null, live_status: "was_live" }))).toBeNull();
});
it("chatPlacement covers every layout", () => {
  expect(chatPlacement({ isMobile: true, landscape: true, theater: false, wide: false })).toBe("sideways");
  expect(chatPlacement({ isMobile: true, landscape: false, theater: false, wide: false })).toBe("inline");
  expect(chatPlacement({ isMobile: false, landscape: false, theater: true, wide: true })).toBe("beside-info");
  expect(chatPlacement({ isMobile: false, landscape: false, theater: false, wide: true })).toBe("sidebar");
  expect(chatPlacement({ isMobile: false, landscape: false, theater: false, wide: false })).toBe("inline");
});
```

- [ ] **Step 2: Run, expect failures** — `cd frontend && npx vitest run src/pages/watch/chatReplay/model.test.ts`.
- [ ] **Step 3: Implement** the API module, types, keys, `useMediaQuery`, `model.ts`, `useChatReplay.ts` and the setting.
- [ ] **Step 4: Run** — same Vitest command → PASS; `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit** — `Follow playback with a chat replay hook`.

---

### Task 6: The chat panel in the standard, theater and inline layouts

**Files:**
- Create: `frontend/src/pages/watch/chatReplay/ChatReplayPanel.tsx`
- Modify: `frontend/src/pages/Watch.tsx`, `frontend/src/pages/watch/WatchSidebar.tsx`, `frontend/src/pages/watch/WatchInfoPanels.tsx`
- Modify: `frontend/src/pages/settings/PlaybackTab.tsx` (toggle under "Show related videos in sidebar"), `backend/app/services/ai/help_catalog.json` (entry after `show-related`)
- Modify: `DESIGN.md` only if the panel adds a component pattern (message row, Super Chat accent, "Jump to latest" chip)
- Test: `frontend/e2e/chat-replay.spec.ts`

**Interfaces:**
- Consumes: Task 5's `useChatReplay`, `chatTarget`, `chatPlacement`, `useMediaQuery`, `showChatReplay`.
- Produces: `ChatReplayPanel({ chat, variant, onHide }: { chat: ChatReplayState; variant: "sidebar" | "inline" | "beside-info" | "sideways" | "fullscreen"; onHide: () => void })` — a `region` named "Live chat" with heading "Live chat", a "Hide" button, the message list (`aria-label="Live chat messages"`, `data-horde="chat-replay-messages"`, `role="log"`), a note plus "Retry" for `error`, a loading indicator for `loading`; renders nothing for `idle | none | unavailable`. `ShowChatBar({ onShow }: { onShow: () => void })` — a button "Show live chat". `WatchSidebar` gains `chat?: ReactNode` (first, above the queue; "More like this" only when `items.length > 0`). `WatchInfoPanels` gains `chatInline?: ReactNode` (first in the main column, above the AI panel) and `chatBeside?: ReactNode` (right column, above the queue; the right column shows when `queueBeside || chatBeside`).

Panel behaviour: newest message at the bottom; sticks to the bottom while new messages arrive. When the user scrolls up more than a few pixels, autoscroll pauses and the list does not move under them while messages keep arriving; a round down-arrow "Jump to latest" button appears at the bottom of the list; pressing it, or scrolling back to the bottom, resumes autoscroll. Fixed height: `sidebar` about the player's height (`aspect-video`-matched or `h-[min(70vh,…)]`, builder's call), `inline` / `beside-info` about 24rem. Message row: author (owner styled like the comments uploader badge, moderators marked), runs (emoji images 1.25em, `alt` set, `loading="lazy"`), Super Chat/Sticker with the amount and a left accent in `color`, membership/gift as one muted line with `header`.

Watch page wiring: `target = chatTarget(source)`; `chat = useChatReplay(settings.showChatReplay && target ? target.youtubeId : null, source.kind === "library" ? actions.getCurrentPosition : actions.getStreamPosition)`; `placement = chatPlacement({ isMobile, landscape: useMediaQuery("(orientation: landscape)"), theater: isWide, wide: useMediaQuery("(min-width: 1280px)") })`; `chatShown = !!target && settings.showChatReplay && (chat.status === "ok" || chat.status === "error" || (chat.status === "loading" && target.known))`; `chatBar = !!target && target.known && !settings.showChatReplay`. Sidebar placement makes the right column show (`grid … xl:grid-cols-[minmax(0,1fr)_24rem]` and `WatchSidebar`) when `chatShown || chatBar`, even if related videos are off or empty; the related grid under the video keeps its current condition (`!showRelatedRight`). Hide sets `showChatReplay: false`; the bar sets it back.

- [ ] **Step 1: Write the failing Playwright spec** `frontend/e2e/chat-replay.spec.ts`. Mock `GET /api/videos/{cedar}` to add `live_status: "was_live"` (Cedar Notes, `e2ecedar001`, real seeded media that plays) and `GET /api/chat-replay/youtube/e2ecedar001*` with synthetic pages (messages every 500 ms from 0 to 20 s, one Super Chat "$5.00", one moderator, `next_cursor` once). Tests:

```ts
test("standard view: chat tops the right column, related videos below it", ...)
  // 1440x900: region "Live chat" is inside the aside, above "More like this";
  // comments still under the description
test("chat follows playback and a seek", ...)
  // play; messages with offset <= currentTime appear; seek to 15 s via video.currentTime:
  // the list shows the message at 14.5 s; seek back to 1 s: a new at_ms request is made
test("scrolling up pauses autoscroll until Jump to latest", ...)
  // scroll the log up; new messages arrive but scrollTop stays; "Jump to latest" visible;
  // click it: scrolled to bottom, button gone
test("theater: chat beside the description", ...)
test("narrow desktop and phone portrait: chat above the AI panel", ...)   // 1100x800 and 390x844
test("hide is remembered and the bar brings it back", ...)
  // Hide -> bar "Show live chat" in the same place, reload -> still hidden, related back on top
  // in the sidebar; Settings -> Playback toggle shows it again
test("no chat replay: the page keeps its usual layout", ...)               // status none
test("a rate limit shows one note and no request storm", ...)             // 503 youtube_rate_limited
  // note + Retry visible; request count unchanged over 3 s; Retry fetches once
test("switching videos never shows the previous video's chat", ...)
  // delay the first video's response, navigate to Aurora Drift, release: no chat region
test("a streamed past stream gets chat; a post_live one does not", ...)
  // mock /api/preview/meta like stream-watch.spec.ts with live_status was_live / post_live
test("chat replay passes axe", ...)                                       // expectNoSeriousViolations
```

- [ ] **Step 2: Run, expect failures** — `cd frontend && npx playwright test e2e/chat-replay.spec.ts`.
- [ ] **Step 3: Implement** the panel, the bar, the three slots, the Watch wiring, the Settings toggle and the help-catalog entry (`{"id": "show-chat-replay", "label": "Show live chat on past streams", "tab": "playback", "anchor": "watch-page", "chat": "change", "scope": "personal", "key": "showChatReplay", "type": "bool", "about": "Chat replay beside past livestreams", "keywords": "live chat replay stream"}`).
- [ ] **Step 4: Run** — the spec, `npx playwright test e2e/comments.spec.ts e2e/watch-features.spec.ts e2e/stream-watch.spec.ts`, and `cd backend && PYTHONPATH=. pytest tests -q -k help_catalog` → PASS; `npm run lint && npm run typecheck`.
- [ ] **Step 5: Commit** — `Show chat replay beside past streams`.

---

### Task 7: Phone sideways view and touch fullscreen

**Files:**
- Modify: `frontend/src/pages/watch/WatchPlayerSection.tsx` (`sideways?: ReactNode`)
- Modify: `frontend/src/pages/Watch.tsx`
- Modify: `frontend/src/context/PlaybackContext.tsx` (`PlaybackLayout.fullscreenAside: HTMLElement | null`; pass `onFullscreenAside` to both `<VideoPlayer>` mounts)
- Modify: `frontend/src/components/VideoPlayer.tsx` (+ its props type) — an aside slot inside the player root
- Test: `frontend/e2e/chat-replay.spec.ts` (sideways cases)

**Interfaces:**
- Consumes: Task 6's `ChatReplayPanel`, `ShowChatBar`, placement and `chatShown` / `chatBar`.
- Produces: `WatchPlayerSection` prop `sideways?: ReactNode`: when set, the player block is `fixed inset-0` (above the app header; check its z-index), a flex row of the dock (`flex-1`, video centred vertically) and the aside (about a third of the width, `max-w-sm`, full height); body scrolling is locked while it is shown. `VideoPlayerProps.onFullscreenAside?: (el: HTMLElement | null) => void` — VideoPlayer renders an empty aside `div` inside `playerRootRef` only while `isNativeFullscreen && matchMedia("(pointer: coarse)").matches`, laid out to the right of the picture (the root becomes a flex row; the aside is `empty:hidden`), and reports the element (null otherwise). `PlaybackLayout.fullscreenAside` carries it to the page.

Watch wiring: `placement === "sideways" && (chatShown || chatBar)` → `sideways = chatShown ? <ChatReplayPanel variant="sideways" …/> : <ShowChatBar …/>` (a narrow vertical "Show live chat" button; hiding keeps the full-screen video). `layout.fullscreenAside && chatShown` → `createPortal(<ChatReplayPanel variant="fullscreen" …/>, layout.fullscreenAside)`; the page's own panel stays mounted (same hook state). Desktop (fine pointer) fullscreen and iPhone's `webkitEnterFullscreen` are unchanged.

- [ ] **Step 1: Write the failing e2e cases** in `chat-replay.spec.ts`:

```ts
test.describe("phone sideways", () => {
  test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  test("video and chat fill the screen side by side", ...)
    // player box and region "Live chat" both within the viewport, side by side,
    // chat width roughly a third; document does not scroll
  test("hiding gives the whole screen to the video", ...)
    // Hide -> player fills the width except a "Show live chat" button; click it -> chat back
  test("other videos turn sideways as before", ...)   // Aurora Drift: no fixed layout
});
```

- [ ] **Step 2: Run, expect failures** — `cd frontend && npx playwright test e2e/chat-replay.spec.ts -g "sideways"`.
- [ ] **Step 3: Implement** the sideways layout, the fullscreen aside slot and the portal.
- [ ] **Step 4: Run** — the whole spec plus `npx playwright test e2e/player.spec.ts e2e/safari-prep.spec.ts` → PASS. Fullscreen on a touch device can't be driven headless: check by hand on an Android or iPad browser if one is available, and say in the summary whether that was done.
- [ ] **Step 5: Commit** — `Fill a sideways phone with video and chat`.

---

### Task 8: Docs and the decision record

**Files:**
- Modify: `docs/guides/watching.md` (a "Live chat replay" section: where it shows, hide/show, phones sideways, what it needs: YouTube reachable; not for clips, `post_live`, offline)
- Modify: `docs/features.md` (one sentence beside the comments line), `docs/architecture/api-overview.md` (the route), `docs/architecture/data-model.md` (`videos.live_status`)
- Create: `docs/adr/0036-chat-replay-read-around-the-position.md` (Context / Decision / Consequences: why not saved, why read around the position, cost per viewer, YouTube-change risk, `live_status` column); list it in `docs/adr/index.md` and `mkdocs.yml`
- Modify: `README.md` only if it lists watch-page features

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Build them** — `mkdocs build --strict` (from the repo root, with `docs/requirements.txt` installed) → no warnings.
- [ ] **Step 3: Commit** — `Document chat replay`.

---

### Task 9: Review and the full gate

- [ ] **Step 1: Independent review** (CLAUDE.md: migration, new API surface, multi-file feature). A fresh reviewer that assumes the branch is broken reads the diff against `main` and this plan's Review Focus. Fix its findings (one pass).
- [ ] **Step 2: Full gate** — `E2E_SHARDS=4 scripts/check.sh --e2e` → every stage green.
- [ ] **Step 3: Commit any fixes** with their own messages; report the gate output.
