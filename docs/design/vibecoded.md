# How Horde is built

Horde is written with **AI coding assistants**, and so is most of this documentation. One person directs the project and decides what goes in; the assistants write most of the code.

That is worth saying up front, because it is fair to ask how a project built this way stays reliable. The answer is that nothing reaches a release on the model's word alone.

## What every change has to pass

The same gates run locally (`scripts/check.sh`) and in CI on every pull request, and a red gate blocks the merge ([Automated testing](../getting-started/testing.md)):

- **Thousands of automated tests**: the API through FastAPI's `TestClient` (permissions, migrations, downloads, the update script and its rollback), the interface with Vitest, and the real app in a browser with Playwright, including accessibility checks.
- **Static checks**: `ruff`, `mypy` at zero errors, `eslint` with no warnings, `tsc`, and a strict docs build, so a broken link fails too.
- **Schema checks**: database changes are [Alembic revisions](sqlite-and-migrations.md), and a test fails when the models and the migrations drift apart. The committed API schema and the frontend's generated types must match the code.
- **Project rules as tests**: no silently swallowed errors, every `noqa` explained, and every route that changes something classified as admin-only or permission-gated.

Larger or riskier changes (migrations, sign-in and security, deleting data, concurrency) also get an independent review that assumes the change is broken until shown otherwise.

## What that means for you

- **Releases, not commits.** Installs follow tagged releases cut from a green `main`. Updates back up the database first and [roll back by themselves](../getting-started/updating.md) when the new version does not start.
- **Decisions are written down.** The [decision records](../adr/index.md) explain the big choices (SQLite, threads, the auth model, the error envelope, how releases work), so the design does not live only in someone's head.
- **Bugs still happen.** Please [report them](https://github.com/jm-connell/horde/issues): **Report a bug or idea** in Horde's footer fills in your version.

## Changing Horde yourself

The codebase is set up to be easy to work on, with or without an AI assistant:

1. Run it locally ([Local development](../getting-started/local-dev.md)).
2. Read [`CLAUDE.md`](https://github.com/jm-connell/horde/blob/main/CLAUDE.md) and [`CONTRIBUTING.md`](https://github.com/jm-connell/horde/blob/main/CONTRIBUTING.md): the project rules, written for humans and coding agents alike. The [architecture map](architecture.md) shows where things live.
3. Keep changes small and run `scripts/check.sh` before you open a pull request.

## Related

- [Why Horde](why-horde.md)
- [FAQ](../reference/faq.md)
