# Dependencies and reproducible builds

Horde pins everything that ends up in the Docker image so a rebuild next month
produces the same software as a rebuild today.

| What | Where | Pinned by |
|------|-------|-----------|
| Python runtime deps | `backend/requirements.txt` (direct) and `backend/requirements.lock` (full tree, hashes) | `uv pip compile --generate-hashes` |
| Frontend deps | `frontend/package.json` and `frontend/package-lock.json` | `npm ci` |
| Docs toolchain | `docs/requirements.txt` | exact `mkdocs-material` version |
| Base images | `Dockerfile` `FROM` lines | exact version tag plus `@sha256` digest |
| Node / Python in CI | `.nvmrc` (22) and `.github/workflows` | same major as the Dockerfile |

The Docker image installs the lock file with `pip install --require-hashes`, so a
tampered or unexpectedly changed package fails the build instead of shipping.

## Regenerating the Python lock file

Edit `backend/requirements.txt` (the direct dependencies), then:

```bash
uv pip compile --generate-hashes --python-version 3.12 \
    backend/requirements.txt -o backend/requirements.lock
```

Commit both files together. To upgrade everything the constraints allow, add
`--upgrade`; to upgrade one package, add `--upgrade-package fastapi`.

`uv` is the only extra tool needed (`pipx install uv` or `pip install uv`). The
Python version must match the Docker image (3.12) so markers resolve the same way.

Then check for known advisories:

```bash
uvx pip-audit -r backend/requirements.lock --no-deps --disable-pip
```

CI runs the same audit weekly and on every pull request (`security.yml`).

## Bumping a base image

Base images are pinned like `python:3.12.15-slim-bookworm@sha256:…`. The tag keeps
the line readable, the digest makes it immutable. Dependabot opens weekly pull
requests for both. To bump by hand, find the new digest with
`docker buildx imagetools inspect python:3.12.16-slim-bookworm` and update the tag
and digest together.

## Bumping yt-dlp

yt-dlp is the one dependency that has to move quickly when YouTube changes. See
[Maintenance](../ops/maintenance.md) for the manual bump, and the opt-in runtime
updater (`YTDLP_AUTO_UPDATE=1`) in [Environment variables](../ops/environment.md).
Dependabot checks yt-dlp daily.

## Frontend

```bash
cd frontend
npm ci            # exact install from the lock file (what CI and Docker do)
npm audit --omit=dev --audit-level=high
```

Node 22 is required (`engines` in `package.json`, `.nvmrc` at the repo root).
