# Rules for every work-package agent (read fully before starting)

Context: we are hardening the Horde repo (FastAPI + SQLite backend in `backend/`, React/TS/Vite frontend in `frontend/`, MkDocs `docs/`) per an architecture review at
`/tmp/claude-0/-home-user-horde/d3776dd8-d2e0-55bb-8adf-2714698fd5e2/scratchpad/horde-architecture-review.md` (read the sections relevant to your package).
The owner is asleep; work autonomously. Other agents work in parallel in OTHER git worktrees.

## Workspace
- Work ONLY inside the worktree directory you are given. Never edit files in `/home/user/horde` (the integration checkout) or any other worktree. Use absolute paths.
- Python: create YOUR OWN venv (do not use or modify any other venv): `uv venv -p python3.12 $SP/<package>/venv && VIRTUAL_ENV=$SP/<package>/venv uv pip install -r backend/requirements.txt -r backend/requirements-dev.txt` (where $SP is the scratchpad dir below). If you add a Python dependency, add it to `backend/requirements.txt` (and the lock file if one exists in your tree) and install it into your venv.
- Read `CLAUDE.md` and `CONTRIBUTING.md` at the repo root of your worktree — they define conventions. The one-shot gate is `PYTHON=$SP/<package>/venv/bin/python scripts/check.sh [--e2e]`.
- Playwright locally needs `PW_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Known environment limitation: the two video-playback specs (`watch.spec.ts` "plays", `offline.spec.ts` ~line 47) fail locally because this Chromium can't decode the H.264 seed media; this is being fixed in the frontend package. Any OTHER e2e failure is yours to fix.
- Frontend: run `npm ci` in your worktree's `frontend/` before using node tooling.
- Playwright: Chromium is preinstalled (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers). NEVER run `playwright install`. Run e2e with `cd frontend && E2E_PYTHON=$VENV/bin/python npx playwright test` after `npm run build`. If the e2e web-server ports (8091/8092) clash with another agent, set env overrides if the config supports them (add support if missing: `E2E_APP_PORT`, `E2E_SETUP_PORT`) and pick ports unique to your package (given in your task).
- Docker daemon is running and usable (`docker build`, `docker run`).
- Scratch files go under the scratchpad dir above (make a subdir named after your package). Not in the repo.

- NEVER run tests (pytest, check.sh) under `git rebase --exec` or from any git hook: git exports GIT_DIR, and the update-script tests then run `git init`/`git clone --bare` against the shared repo (this already corrupted it once). To check intermediate commits, `git archive <sha> | tar -x -C <scratch dir>` and run there.

## Quality bar (you are being reviewed by a strict senior architect)
- Fix root causes; no band-aids, no silent `except: pass`, no skipped/disabled tests, no weakening of existing assertions.
- Keep each change minimal-but-complete for its finding. Match surrounding code style.
- Prefer end-to-end (Playwright, `frontend/e2e/`) and API-level (FastAPI TestClient) tests that exercise real behaviour over piles of narrow unit tests. Add a unit test only for a real bug regression or pure logic that is hard to reach end-to-end.
- Before EVERY commit, run the gates that exist in your tree: backend `ruff check` + `ruff format --check` (if configured) + `pytest -q` (from `backend/`, `PYTHONPATH=.`); frontend `npm run lint` (if exists), `npx tsc --noEmit -p tsconfig.json`, `npm test`, `npm run build`. Run Playwright e2e when your change touches UI or API behaviour used by the UI. All must pass. If a pre-existing test is flaky/order-dependent, fix the isolation problem rather than skipping it.
- Commits: small, logical, one concern per commit, imperative subject (<72 chars) + a body explaining why. End every commit message with exactly these trailer lines:

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0171D2wH7kap9wnotozJ699N

  Do NOT mention model names anywhere else (code, comments, docs). Do NOT push. Do NOT rewrite history of commits you did not make.
- Update docs (`docs/`, README, `.env.example`) when behaviour or configuration changes. Keep `mkdocs build --strict` passing.
- If a decision genuinely needs the owner, pick the safest reasonable default, implement it behind a clear seam, and list the question in your final report. Don't stop the whole package for it.

## Final report (your last message)
1. Branch name and `git log --oneline` of your commits.
2. Per finding/item: done / partially done / deferred, with one line of how.
3. Gate results (exact commands + pass counts).
4. Open questions for the owner, and any risks the integrator should know (likely merge conflicts, files touched broadly).

## Shared machine (added 05:00 UTC Oct 16)
- The box has 4 cores shared by ~8 agents. Wrap EVERY heavy run (full pytest, scripts/check.sh, full Playwright suite, per-commit loops: wrap each iteration) in `$SP/heavy.sh <command>`; it allows at most 2 heavy runs at once and waits for a free slot. Targeted test files, ruff, tsc, eslint and vitest don't need it.
