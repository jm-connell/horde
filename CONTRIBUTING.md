# Contributing to Horde

Thanks for helping. The short version:

## Quality gates are mandatory

```bash
scripts/check.sh          # ruff, pytest, eslint, prettier, tsc, vitest, vite build, mkdocs
scripts/check.sh --e2e    # ...plus the Playwright browser suite
```

Run it before every commit. CI runs the same checks and a red gate blocks the merge. Setup and per-gate commands are in [docs/getting-started/testing.md](docs/getting-started/testing.md); the local environment is described in [docs/getting-started/local-dev.md](docs/getting-started/local-dev.md).

Auto-fix helpers: `ruff check --fix . && ruff format .` (in `backend/`) and `npm run lint:fix && npm run format` (in `frontend/`).

## Commit style

- Small, logical commits, one concern each.
- Imperative subject under 72 characters (`Fix queue pause restore`), body explains why.
- Keep mechanical reformatting separate from behaviour changes, and add its commit to `.git-blame-ignore-revs`.

## Tests

- Prefer end-to-end coverage: Playwright specs in `frontend/e2e/` and FastAPI `TestClient` tests in `backend/tests/` exercise real behaviour. Add narrow unit tests for bug regressions and pure logic.
- Tests must pass in any order. Do not skip or weaken tests; fix the isolation problem instead.
- The suite must stay offline: no calls to YouTube, OpenRouter or Ollama.

## Code

- No silent `except: pass`. Log the exception (`logger.debug` / `logger.warning` with `exc_info=True`), or catch the narrowest type and handle it. `tests/test_code_conventions.py` enforces this.
- Every `noqa` / `eslint-disable` needs a reason.
- New API endpoints declare response models. Schema changes go through the migration system in `backend/app/database.py`.
- Update the docs, README and `.env.example` when behaviour or configuration changes.

More detail for AI coding agents and humans alike is in [CLAUDE.md](CLAUDE.md).
