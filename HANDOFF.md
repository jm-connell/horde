# Horde overhaul: handoff state (written 2026-10-15 ~22:30 UTC)

## Goal (owner's request)
Fix every review finding plus week-1, weeks 2–4 and months 2–3 items. Add auth (username/password, first user is admin, admin creates users with permissions, per-user history and per-user AI chat). Lint, type and test gates. e2e preferred over unit tests. One branch with separate clean commits. Leave questions for the owner at the end.

## Branch and integration state
- Integration branch: `claude/architecture-overhaul` (pushed). Tip d2c71be.
- Merged so far:
  - WP0 tooling
  - WP-A data (Alembic, FKs)
  - WP-B downloader fixes
  - WP-C security
  - WP-D ops (incl. release-tracking update.sh and the Jellyfin fingerprint pin)
  - WP-E frontend safety and a11y
  - WP-F runtime and logging
- Remote backups (delete once merged): `backup/wp-auth`, `backup/wp-dlsplit`.
- Worktrees (may be gone if the container was reclaimed; then recreate from the backup branches):
  - /home/user/wt/auth (wp/auth)
  - /home/user/wt/dlsplit (wp/dlsplit)
  - others under /home/user/wt are merged and can be removed

## In flight
1. **WP-G auth (`wp/auth`, tip b6c9a5b, 22 commits on d2c71be; pushed as backup/wp-auth): APPROVED by security review** (36-vector redirect test; all live attacks fixed). History rewritten twice (text-only) so every commit passes; final tree identical to the approved one. ALL 22 commits pass ruff+format. Full pytest verified per commit for the first 16 (log $SP/percommit-auth2.log, older SHAs but same content except a noqa comment). Last 6 commits (efa36c6..b6c9a5b) were running in background -> $SP/percommit-auth3.log. If all green -> `git -C /home/user/horde merge --ff-only wp/auth && git push`.
   - History was rewritten so intermediate commits pass. The final tree is identical to the approved one.
   - A per-commit verification was running: log at `$SP/percommit-auth2.log`, script `$SP/percommit2.sh <range> <venv>`; it runs pytest under `setsid` in an archive copy.
   - If every line shows ruff ok, format ok and "N passed", fast-forward merge into the integration branch and push. If a commit fails, fix it with a scripted rebase that uses `edit` + amend. NEVER run tests under `rebase --exec`.
2. **WP-J1 downloader split (`wp/dlsplit`, based on d2c71be)**:
   - Status: about 24 commits. Characterization tests first, then modules moved into `services/downloads/`, then complexity reduction.
   - Its agent was asked to stop at a clean point and hand off. Read its handoff (if delivered) or `git log` in the worktree.
   - Remaining: anything in its handoff checklist, then an architect review (sonnet reviewer with `$SP/REVIEW_RULES.md`), fixes, a rebase onto the integration tip (after auth merges; conflicts are likely only in api/* import lines), per-commit check, and merge.

## Remaining packages (briefs in `$SP/WP_LATER.md`)
- WP-M data modelling (after auth): tags table, FTS5, youtube_id, vectors.
- WP-H1 API contract (after auth): response models, error envelope, pagination with frontend paging, N+1 fix, /api/v1.
- WP-H2 frontend data layer (after H1): OpenAPI codegen with a CI drift check, TanStack Query, PlaybackContext split.
- WP-J2 AppContext (after J1).
- WP-J3 frontend decomposition (after H2): VideoPlayer, Library with virtualization, Settings, useSettings, Watch.
- WP-N final:
  - mypy to zero and make it a gate in check.sh and CI
  - e2e expansion
  - ARCHITECTURE.md plus ADRs (job system, migrations, security/auth model)
  - CLAUDE.md refresh
  - remove the `backup/*` remote branches
  - delete stale worktrees
  - final whole-branch review
  - open the PR (the owner wants a single branch)
  - owner question list
- Small follow-up: make `frontend/e2e/update.spec.ts` operate on a copy of dist (serve via HORDE_FRONTEND_DIR) instead of mutating `frontend/dist` in place.

## Process rules (keep using them)
- `$SP` = /tmp/claude-0/-home-user-horde/d3776dd8-d2e0-55bb-8adf-2714698fd5e2/scratchpad
- Implementer agents: sonnet, own worktree under /home/user/wt, own venv from `backend/requirements.lock` + requirements-dev, `npm ci`. They follow `$SP/AGENT_RULES.md` (commit trailers, gates, never `rebase --exec`).
- Every package gets an architect review (sonnet, `$SP/REVIEW_RULES.md`, reviewing an immutable SHA via `git archive` snapshot), then fixes and a re-review, then a per-commit check, then a fast-forward merge and push.
- Local Playwright needs `PW_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Each agent uses unique `E2E_APP_PORT`/`E2E_SETUP_PORT`.
- Docker daemon: start with `nohup dockerd > $SP/dockerd.log 2>&1 &` if `docker info` fails.
- After any incident, check that `git -C /home/user/horde config core.bare` is `false` (a test once flipped it via an inherited GIT_DIR; conftest now scrubs GIT_*).
- Commit trailer lines (exact):
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0171D2wH7kap9wnotozJ699N

## Owner decisions already made
- Permissions:
  - Only admins delete by default. The admin picks the account type for each new user: Admin, or Member with checkboxes.
  - Member checkboxes: delete_videos (off by default), download, offline_download, edit_metadata, manage_playlists, use_ai (all on by default).
- Per-user state: AI chat history, watch history and UI prefs are per user. Library, playlists and AI summaries are shared.
- update.sh tracks releases (it falls back to main until the first tag).
- Jellyfin key fingerprint 4918AABC486CA052358D778D49023CD01DE21A7B is verified and pinned.
- Branch protection: the ruleset exists, but its required-checks list is empty. Tell the owner to add the check names once the PR has run CI. Listed earlier:
  - CI: lint, backend, frontend, e2e, docs
  - Image builds: both "Build and smoke test (jellyfin|debian ffmpeg)"
  - Security: "Python advisories (pip-audit)", "Frontend advisories (npm audit)", "Secret scan (gitleaks)"
  - Not Trivy

## Open questions to collect for the owner (so far)
- Should a playing standard-size player pause background effects by default? It currently only does so when the setting is on.
- The `/api/v1` prefix: do it or skip it (WP-H1 will decide or ask).
- Should the React Compiler ESLint rules be adopted later (~120 findings)?

## WP-J1 downloader split handoff (received 23:0x UTC)
- wp/dlsplit tip 8540ac3 (25 commits on d2c71be), backed up as backup/wp-dlsplit. HEAD: ruff/format ok, pytest 970 passed. Radon: F(94)/F(61)/F(41)/D(22) -> worst C(14).
- Remaining: (1) full `scripts/check.sh --e2e` (ports 8891/8892, PYTEST_ADDOPTS="--basetemp=$SP/dlsplit/tmp_gate -p no:cacheprovider"); (2) archive-verify the last 7 commits (from 581bb3e) with `$SP/dlsplit/verify.sh <sha>` or percommit2.sh; (3) architect review (fresh reviewer, REVIEW_RULES, immutable SHA); (4) rebase onto tip after auth merges — API-layer edits isolated in 49ad282 (import paths only; can be dropped since the facade works); (5) merge.
- Gotchas: tests patch where names are looked up (finalize.*, postprocess.*, artifacts.validate_playable); DownloadQueue runner injected (`download_queue.runner`); test_import_resolution.py guards lazy imports; .gitignore `downloads/` anchored to `/downloads/`.
- Owner question: when to delete the downloader.py facade (kept one release).

## Test-run hygiene (learned the hard way)
- NEVER `pkill -f pytest` / `pkill -f <script>`: it kills your own shell (exit 144) and other agents' runs. Kill by PID.
- Concurrent pytest sessions MUST use distinct `--basetemp` (they share /tmp/pytest-of-root and delete each other's dirs → spurious "unable to open database file").


## Progress log
- 01:05 UTC Oct 16: WP-G auth MERGED (integration tip b6c9a5b, pushed). Remote branch deletion is blocked by the proxy (403) -> owner must delete backup/* branches manually at the end.
- Launched fresh agents: J1-finish (/home/user/wt/dlsplit, rebase onto b6c9a5b + gate + per-commit), WP-M (/home/user/wt/model, ports 8991), WP-H1 (/home/user/wt/api, ports 9091). Merged worktrees removed.
- 01:45 UTC: container restarted ~01:25 (agents resumed; all commits intact; docker restart needs `rm -f /var/run/docker.pid`). WP-H1 done (wp/api tip 7f23426, 6 commits): in architect review (review-api). /api/v1 SKIPPED -> owner question (orphans offline downloads; would be its own package). Follow-up for WP-N: check.sh's double -q hides the pytest count — fix.
- 01:55 UTC: H1 review = CHANGES REQUESTED (R1 forged cursor 500->400 validation, R2 random sort stable via keyed hash, R3 /api/tags truncation; plus O2/O8/O9). Forwarded to H1 implementer abe566be17130f4ca. WP-M review (a65c5e9303fd4a34a) and J1 finisher (a18e123f628ceee88) still running. Owner Q: /api/v1 skip.
- ~02:10 UTC: H1 fixes done (wp/api tip 437f6f9, committed backend/openapi.json + --check gate) -> re-review by ac0001b39c3d95c01. WP-M review CHANGES REQUESTED (incremental vector cache + single-flight, diacritic FTS regression, trigger guard + ai_meta delete trigger, deflake test_event_loop) -> forwarded to a894eaad7e6c419c6. Merge order plan: H1 first, then J1, then M (M must rebase onto H1's query_videos changes and regen openapi.json).
- ~03:00 UTC: WP-H1 MERGED (integration tip 258a144, pushed; I added 258a144 myself for review R1b naive-datetime cursor; per-commit all green, log percommit-api.log). WP-M APPROVED (tip 979f056) -> implementer a894eaad7e6c419c6 rebasing onto 258a144 + per-commit + gate, then merge. WP-H2 launched (agent a7e10c038ad5d61d8, /home/user/wt/fdl, wp/fdl, ports 9191/9192). J1 (a18e123f628ceee88) still in per-commit verification; then architect review + rebase onto tip.
- H1 optional leftovers for WP-N: O1 /api/ai/status N+1, O3 search paging re-runs hybrid search per page, O4 review/groups recompute per page, O5 500 lacks security headers, O6 JSON decode error loc.
- ~03:45 UTC: J1 review (aa2d6d4d30cc96f9b) = CHANGES REQUESTED, test-only (no behaviour change found): strengthen characterization tests (replace merge, snapshot title/warnings, _hand_off_recovered_file, FfmpegCancelled, cookie retry members_only) + mutation rerun via $SP/review-dlsplit/mut.sh. Forwarded to a18e123f628ceee88. PR description must mention: start_download shim removed; scanner stop_event fix (abaaaed) + backup test fix (c4a6ea1) ride along in J1.
- ~03:55 UTC: Owner asked about more parallelism. Launched WP-N1 docs/ADRs (ac6fb6ddd05121538, /home/user/wt/docs, wp/docs) and WP-N2 e2e expansion (aba5bf4f4e5a4bb07, /home/user/wt/e2e, wp/e2e, ports 9291/9292), both on 258a144. Plan: after M merges -> backend perf leftovers (H1 O1/O3/O4) agent; after J1 merges -> J2 AppContext; after H2 merges -> J3 split 3-way (VideoPlayer / Library / Settings+Watch+useSettings) in parallel; mypy-to-zero near end.
- ~04:00 UTC: Owner OK'd heavy usage. Machine limits: 4 cores, disk was 82% (cleaned merged review dirs + wt/api -> 70%). Launched: WP-P backend perf leftovers (aeb6ac1a2ed07e3d1, /home/user/wt/perf, ports 9391; O1 ai/status N+1, O4 review/groups cache, O5 500 headers, O6 JSON error msg; O3 design note only), WP-J3a VideoPlayer decomposition (aabe5c6da3567ad5c, /home/user/wt/player, ports 9491; no context/api edits), interim cross-package audit (a3abdb0294e8545f0, read-only, $SP/audit1, incl. real upgrade from pre-overhaul DB).
- ~04:10 UTC: WP-N1 docs done (wp/docs tip bb408b3, 2 commits) -> accuracy review a90f051ee7d500d50. Merge docs AFTER M and J1 (rebase; conflicts in CLAUDE.md/mkdocs.yml/data-model.md). Follow-ups at merge: reword wp/model ai-pipeline "rebuilt after any change" (now incremental); workers.py comment says 30s grace but compose has 40s; local-dev.md broken anchor testing.md#quality-gates-scriptscheck-sh. Owner Qs: mermaid in docs? (needs CDN script).
- ~04:40 UTC: WP-M MERGED (integration tip d71d568, pushed). settings.spec.ts:42 sort-default flake exists on integration (1/6) -> M agent a894eaad7e6c419c6 root-causing on /home/user/wt/sortflake (wp/sortflake), + audit M2 (useSettings user-switch prefs leak).
- Interim audit (a3abdb0294e8545f0) done: upgrade from pre-overhaul DB works. Findings dispatched: H1 SSE outlives revoked session, L1 chat IntegrityError, L2 progress inf, L3 expiry hot path, L4 member sees AI provider details, M1 upgrade notes HORDE_ALLOWED_HOSTS, M3 update.sh rollback false refusal -> new agent WP-AF a3b8a11506995af64 (/home/user/wt/auditfix, ports 9691). L5 use_ai for semantic search -> perf agent. L6 403 toasts -> H2 agent. L7 docs: /api/ready in public routes (docs agent already fixed), device-download job sharing doc -> docs agent at rebase.
- ~05:00 UTC: WP-AF done (wp/auditfix tip dd3a4d8, 8 commits on d71d568) -> review a4118eb1a9730e49f (incl. per-commit full pytest). Owner Q: chat drain-to-completion after revocation (cost accuracy) vs immediate abort.
- sortflake done (wp/sortflake tip 9c9e340: e2e waits for the right PATCH; prefs tied to user via horde.settings-owner) -> asked a894eaad7e6c419c6 to add pagehide keepalive flush of pending debounced settings PATCH.
- J1 test additions done (wp/dlsplit 09e37eb, 27 commits on b6c9a5b) -> re-review aa2d6d4d30cc96f9b on 09e37eb; implementer a18e123f628ceee88 rebasing onto d71d568 + per-commit + gate. J2 note: bind download_queue.runner in lifespan (deferred from J1).
- Merge order plan: J1 -> sortflake -> auditfix (conflict api/downloads.py import) -> perf -> docs (rebase; drop in-flight wording) -> e2e -> H2 -> player.
- ~06:00 UTC: Reviews back. J1 APPROVED (re-review). H2 CHANGES REQUESTED (R1 per-user QueryClient + visibility refresh, R2 jobs poll on error, R3 Watch not-found on poll error, R4 settings cache) -> a7e10c038ad5d61d8. WP-P CHANGES REQUESTED (catalog search use_ai bypass, global lock across compute) -> aeb6ac1a2ed07e3d1. WP-AF CHANGES REQUESTED (chat str(exc) leaks provider URL; fold 873da96 into 6365322 so commits green; O1 decided: break on revocation, no drain -> owner Q dropped) -> a3b8a11506995af64. Owner Qs added: search ranking TTL 120s ok?
- ~06:20 UTC: sortflake MERGED (integration tip 466fc73, frontend-only). WP-P APPROVED (wp/perf ad71098; merge after J1, rebase needed: conftest/main.py). J1 per-commit on d71d568 base 12/27 (one test_lifecycle sprite-pool failure on 1cd6cc0 under investigation) then rebase onto 466fc73 + gate. H2 fixes -> re-review a7fca8bb0da31c358. Player (wp/player 401731b, 16 commits on 258a144) -> review a846cfec0b413ed75. AF fixing review (a3b8a11506995af64).
- ~06:40 UTC: H2 R5 fixed (wp/fdl 99706e4; test proven to fail without setQueryData). Treat H2 as APPROVED. Merge after J1, auditfix, perf; needs rebase + openapi/api-types regen + full gate.
- ~06:50 UTC: WP-N2 e2e done (wp/e2e c1d0342, 12 commits on 258a144; 98 e2e x3 green; e2e-only /api/e2e/bulk-videos gated by _e2e_browser; a11y fix in PlaylistAddVideo.tsx). Accepted without separate review (specs + gated test route). Merge late (after H2; PlaylistAddVideo.tsx may conflict with H2). Its commits carry Sonnet trailers (subagent's own attribution) - leave as is. Library default-sort-not-reapplied-after-hydration bug -> H2 agent.
- UI gap noted for owner/final: playlist rename/delete buttons not hidden for members without manage_playlists (server refuses w/ toast). No "clear history" feature exists.
- ~07:20 UTC: Player APPROVED + hardening done (wp/player 091d576, 22 commits on 258a144). Merge after H2 (rebase; recheck useStreamQuality stable-callback comment). H2 tip 8204484 (Library default sort fix).

## PAUSED ~07:30 UTC Oct 16 for usage reset (resume ~11:00 UTC)
State: integration tip 466fc73. All agents idle except J1 (told to stop at a clean point).
Ready / approved, merge in this order (each: rebase onto tip, regen openapi.json + `npm run gen:api` if needed, gate via heavy.sh, ff-merge, push):
 1. wp/dlsplit (J1, APPROVED) - per-commit on d71d568 base was 25/27 green (+1 lifecycle sprite-pool failure on 1cd6cc0 to classify); then rebase onto 466fc73 + gate. Agent a18e123f628ceee88.
 2. wp/perf ad71098 (APPROVED). Agent aeb6ac1a2ed07e3d1.
 3. wp/auditfix d8cfb86 (fixes done, per-commit all green; quick re-review by a4118eb1a9730e49f optional). Agent a3b8a11506995af64.
 4. wp/docs e03eee1 (rebase; drop "lands with"/"two changes on their way" wording; fix wp/model ai-pipeline "rebuilt after any change"; add device-download job sharing note). Agent ac6fb6ddd05121538.
 5. wp/fdl 8204484 (H2, APPROVED incl R5 + Library default-sort fix). Agent a7e10c038ad5d61d8.
 6. wp/e2e c1d0342 (done; PlaylistAddVideo.tsx may conflict with H2). Agent aba5bf4f4e5a4bb07.
 7. wp/player 091d576 (APPROVED + hardening). Agent aabe5c6da3567ad5c.
Then: J2 AppContext (after J1), J3 rest (Library/Settings/Watch/useSettings; after H2, 2 agents), mypy-to-zero gate, final whole-branch review on Fable, PR + subscribe, owner question list.
BLOCKER needing owner OK: /dev/null was clobbered into a regular file by an agent (mv ... /dev/null). Fix: `rm -f /dev/null && mknod -m 666 /dev/null c 1 3` - asked owner, no answer yet. Container restart also fixes it.
Owner Qs so far: /api/v1; pause bg effects default; React Compiler lint; downloader.py facade removal timing; UtcDateTime conversion; mermaid in docs; search ranking TTL 120s; hide playlist rename/delete for members w/o manage_playlists; delete backup/* branches; add required checks to ruleset; GHCR public; v* tag ruleset.
- 07:30 UTC: /dev/null restored (owner approved). Blocker cleared.
- 07:35 UTC: J1 rebased onto 466fc73 (wp/dlsplit 9ca505c). Gate: all green except [mobile] library.spec.ts:53 channel page (frontend untouched by J1 -> likely load flake; verify on 466fc73). Next on resume: rerun that spec, then merge J1. See $SP/dlsplit/STATUS.md.
- 11:25 UTC (resumed after reset; container had restarted, docker restarted): J1 MERGED (integration tip 9ca505c, pushed). Perf (aeb6ac1a2ed07e3d1) rebasing onto 9ca505c + per-commit + gate. Docs (ac6fb6ddd05121538) rebasing onto 9ca505c + dropping in-flight wording. J2 AppContext launched (aceeb16b3e2d126a6, /home/user/wt/ctx, wp/ctx, ports 9591) - must rebase after perf/auditfix merge.
- 11:45 UTC: container restarted again (docker restarted). PERF MERGED (7c0f20e) and DOCS MERGED (19af63b), pushed. AF rebasing onto 19af63b (a3b8a11506995af64). J2 resumed + rebasing onto 19af63b (aceeb16b3e2d126a6). Next merges: auditfix -> H2 (fdl 8204484) -> e2e -> player.
- 13:05 UTC: AUDITFIX MERGED (724b1c4, pushed). J2 ctx (fixes done, approved) rebasing onto 724b1c4; H2 fdl rebasing onto 724b1c4 in parallel; first done merges first. Then e2e, player; then J3-rest (Library/Settings/Watch/useSettings), mypy, final Fable review, PR.
- 13:25 UTC: H2 MERGED (572b781, pushed). J2 rebasing onto 572b781. e2e rebasing onto 572b781 (aba5bf4f4e5a4bb07). Launched J3b Library+useSettings (a7f1cc59dfa7d9b8c, wt/fdec-lib, ports 9891) and J3c Settings+Watch (ab13fb743c2c1a578, wt/fdec-set, ports 9991). Player rebase after e2e.
