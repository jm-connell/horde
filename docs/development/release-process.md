# Release process

Horde uses [Semantic Versioning](https://semver.org/). A release is a git tag
`vX.Y.Z` on `main`; pushing the tag does everything else.

## Cutting a release

1. Make sure `main` is green (CI, Image, Security) and contains everything you want to ship.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, and update the comparison links at the bottom. Commit with a message like `Release X.Y.Z` and merge it to `main`.
3. Tag that commit and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Horde X.Y.Z"
   git push origin vX.Y.Z
   ```

   Pre-releases use a suffix (`v1.3.0-rc.1`): they get a GitHub pre-release and are never tagged `latest`.
4. The **Release** workflow then:
   - checks that the tag points at a commit on `main`,
   - builds `linux/amd64` and `linux/arm64`,
   - pushes `ghcr.io/jm-connell/horde:X.Y.Z`, `:X.Y`, `:sha-<commit>` and `:latest`,
   - bakes `HORDE_VERSION=X.Y.Z` into the image (environment, `/app/BUILD_INFO`, OCI labels),
   - creates the GitHub Release with generated notes.
5. Check that the release page shows the notes, the package appears under *Packages*, and `docker run --rm ghcr.io/jm-connell/horde:X.Y.Z cat /app/BUILD_INFO` shows the version. The first push creates the package as private; make it public (*Package settings → Change visibility*) so users can pull without logging in.

!!! note "Mistakes"
    Never move or reuse a published tag. Fix forward with a new patch release. If a release is broken, publish the fix and mark the broken GitHub Release as a pre-release or delete it; the image tag `latest` moves with the next release.

## What users see

- `update.sh` follows releases by default (`HORDE_UPDATE_CHANNEL=release`): it installs the highest stable `vX.Y.Z` tag, so **pushing a tag is what ships a change to users who build from source**. Merging to `main` alone reaches nobody on that channel. Pre-release tags are only picked up with `HORDE_UPDATE_CHANNEL=prerelease`; `main` followers get every commit.
- The image is built with the tag as `HORDE_VERSION` and the in-app update notice compares it with the latest GitHub release. Until a first release exists, `update.sh` follows `main` and the notice compares commits, ignoring bot and docs-only commits.
- Installs using the published image follow `latest` or the pinned version tag in `HORDE_IMAGE`. See [Updating](../getting-started/updating.md#use-the-published-image).

## Rolling back a release

Users roll back with `bash update.sh --rollback` ([Updating](../getting-started/updating.md#rollback)); published-image users can also pin the previous tag in `HORDE_IMAGE` and run `docker compose up -d`. For a bad release, publish a patch release rather than editing the old one.

## Recommended branch protection (repository owner)

Branch protection cannot be set from files in the repository. In **Settings → Branches → Add branch ruleset** (or *Branch protection rule*) for `main`:

| Setting | Value |
|---------|-------|
| Require a pull request before merging | on, 1 approval (or 0 for a solo maintainer who still wants the checks), dismiss stale approvals |
| Require status checks to pass | on, *Require branches to be up to date* on. Required checks (the job names GitHub lists): `backend`, `frontend`, `e2e`, `docs` (CI); `Build and smoke test (jellyfin ffmpeg)` and `Build and smoke test (debian ffmpeg)` (Image); `Python advisories (pip-audit)`, `Frontend advisories (npm audit)`, `Image scan (Trivy)` and `Secret scan (gitleaks)` (Security). Add any further CI jobs (for example lint) as they appear |
| Require conversation resolution | on |
| Require linear history | on (matches the fast-forward-only `update.sh`) |
| Block force pushes | on |
| Restrict deletions | on |
| Do not allow bypassing the settings | on (admins included) |

Also recommended:

- **Tags**: add a tag ruleset for `v*` that blocks deletion and updates (published tags must be immutable) and restricts creation to maintainers.
- **Actions → General → Workflow permissions**: *Read repository contents* by default, and enable *Allow GitHub Actions to create and approve pull requests* (needed by the yt-dlp bump workflow).
- **Secrets**: `TRAFFIC_TOKEN` (fine-grained PAT, Administration: read) for the clone-stats workflow; optional `BOT_TOKEN` (PAT with contents and pull-requests write) so pull requests opened by the yt-dlp bump workflow trigger CI.
- **Security**: enable Dependabot alerts and security updates, secret scanning with push protection, and private vulnerability reporting.
- **Packages**: make the `horde` package public after the first release.
- **Pages**: *Settings → Pages → Source: GitHub Actions*.

## What CI checks on a release

The Release workflow refuses to build unless the `CI` and `Image` workflows have a successful run on the tagged commit (it waits up to 40 minutes for runs still in progress), so tag only commits on a green `main`.

The Trivy image scan (`Security` workflow) fails on CRITICAL findings that have a fix. It blocks on pushes to `main` and on the weekly run, but on pull requests it only reports: a newly published CVE in a base image should not block an unrelated pull request, yet it must be fixed before anything ships from `main`.

## Dependency automation

- Dependabot opens one grouped minor/patch pull request per ecosystem each week (Python, npm, Docker, Compose, Actions) and separate pull requests for major updates.
- `ytdlp-bump.yml` opens a pull request within a day of a new yt-dlp release, after the backend tests and `pip-audit` pass on the regenerated lock. Merge it and cut a patch release when YouTube extraction is broken.
- Regenerate the Python lock by hand with the command in [Dependencies](dependencies.md).
