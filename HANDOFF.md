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
