# Release process

Horde uses [Semantic Versioning](https://semver.org/). A release is a git tag
`vX.Y.Z` on `main`; pushing the tag does everything else.

## Cutting a release

1. Make sure `main` is green (CI, Image, Security) and contains everything you want to ship.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty `## [Unreleased]` above it, and update the comparison links at the bottom. Commit with a message like `Release X.Y.Z` and merge it to `main`. This section becomes the release page, so write it for users: what is new, what changed and anything to do when upgrading. Preview it with `python3 scripts/release_notes.py vX.Y.Z jm-connell/horde`.
3. Tag that commit and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Horde X.Y.Z"
   git push origin vX.Y.Z
   ```

   Pre-releases use a suffix (`v1.3.0-rc.1`): they get a GitHub pre-release and are never tagged `latest`.
4. The **Release** workflow then runs four jobs in order (`preflight → desktop → image → publish`):
   - **Preflight** checks that the tag points at a commit on `main`, that the `CI`, `Image` and `Desktop` workflows are green on that commit, and that the tag's `CHANGELOG.md` section exists (a stable tag without a `## [X.Y.Z]` section stops here, before any build).
   - **Desktop** builds and starts the Windows, macOS and Linux installers through [`desktop-build.yml`](#desktop-builds), with the tag as the version.
   - **Image** (only if every installer passed) builds `linux/amd64` and `linux/arm64`, pushes `ghcr.io/jm-connell/horde:X.Y.Z`, `:X.Y`, `:sha-<commit>` and `:latest`, and bakes `HORDE_VERSION=X.Y.Z` into the image (environment, `/app/BUILD_INFO`, OCI labels).
   - **Publish** writes `SHA256SUMS`, runs `scripts/check_release_assets.py` on the installers, attests them, creates the GitHub Release as a **draft** (the tag's `CHANGELOG.md` section with wrapped lines joined and repository links pointed at the tag, the image name, a pointer to the install page, then GitHub's generated list of merged pull requests), uploads every desktop file, and only then publishes it. A pre-release tag makes a pre-release.
5. Check that the release page shows the CHANGELOG notes and carries the installers (`Horde-windows-x64-setup.exe`, `Horde-mac-arm64.dmg`, `Horde-mac-arm64.zip`, `Horde-linux-x64.AppImage`, the `latest*.yml` files, the blockmaps and `SHA256SUMS`), that the package appears under *Packages*, and that `docker run --rm ghcr.io/jm-connell/horde:X.Y.Z cat /app/BUILD_INFO` shows the version. The first push creates the package as private; make it public (*Package settings → Change visibility*) so users can pull without logging in.

!!! note "Mistakes"
    Never move or reuse a published tag. Fix forward with a new patch release. If a release is broken, publish the fix and mark the broken GitHub Release as a pre-release or delete it; the image tag `latest` moves with the next release.

## What users see

- `update.sh` follows releases by default (`HORDE_UPDATE_CHANNEL=release`): it installs the highest stable `vX.Y.Z` tag, so **pushing a tag is what ships a change to users**. Merging to `main` alone reaches nobody on that channel. Pre-release tags are only picked up with `HORDE_UPDATE_CHANNEL=prerelease`; `main` followers get every commit.
- The image is built with the tag as `HORDE_VERSION` and the in-app update notice compares it with the latest GitHub release. Until a first release exists, `update.sh` follows `main` and the notice compares commits, ignoring bot and docs-only commits.
- Installs run the published image by default: `update.sh` pulls `sha-<shortsha>` of the release it checks out, so a tag reaches users only once the release workflow has pushed its image (until then `update.sh` stops and says to try later). The `sha-` tag is therefore required; do not drop `type=sha` from `release.yml`. See [Updating](../getting-started/updating.md#use-the-published-image).

## Desktop builds { #desktop-builds }

`.github/workflows/desktop-build.yml` is a reusable workflow that builds the desktop app for Windows (x64), macOS (Apple silicon) and Linux (x64) and starts each one. The **Desktop** workflow (`desktop.yml`) calls it on pull requests and `main`, next to the backend tests on Windows and macOS and the shell's own checks. **Release** calls it on a tag. One definition, so what ships is what a pull request tested.

- **The version comes from the tag** (`vX.Y.Z` becomes `X.Y.Z`), passed to electron-builder and to the server as `HORDE_VERSION`. Nothing is committed for it. Outside a tag the version is `0.0.0-dev`.
- **Each leg** downloads the pinned Python, ffmpeg, deno and YouTube helper (`desktop/vendor.lock.json`, checked by hash), installs `backend/requirements.lock` into the bundled Python and starts the bundled server and the helper once, runs the upgrade smoke test, runs electron-builder, then runs Playwright against the packaged app.
- **The upgrade smoke test** (`desktop/scripts/upgrade_smoke.py`) downloads the newest published desktop release, lets its server create a data folder and an administrator, then starts this build on that folder and signs in. The desktop app cannot go back to an older version by itself, so a build that cannot start on the previous version's data stops here, on the pull request, long before a tag. It reports a skip while no desktop release exists.
- **Fixed asset names.** The files carry no version, so the docs link to `releases/latest/download/<name>` and never change: `Horde-windows-x64-setup.exe`, `Horde-mac-arm64.dmg`, `Horde-mac-arm64.zip`, `Horde-linux-x64.AppImage`, the updater's `latest.yml`, `latest-mac.yml` and `latest-linux.yml`, the blockmaps, and `SHA256SUMS`. `scripts/check_release_assets.py` fails the release when one is missing or not in `SHA256SUMS`.
- **All or nothing.** The release is a draft until every file is on it. The updater and the download links only ever see a complete release. Every installer also gets a GitHub build attestation (`gh attestation verify <file> --repo jm-connell/horde`).
- **When a desktop leg fails**, open the run and re-run the failed job (the logs and, for a failed test, a `desktop-<name>-test-results` artifact are there). The image is not pushed until all three legs pass, so nothing is half-published, and re-running on the same tag is safe: the draft is reused and a release that is already published is never touched. If the cause is in the code, fix it on `main` and cut a new tag, as for any release.
- Bumping Python, ffmpeg or deno is in [Dependencies](dependencies.md#desktop-app).

## Hands-on check before a platform's first release { #hands-on-check }

CI proves the apps start, not that a person gets through the first-open warnings. Before the first release that carries a platform, install the previous build on a real machine of that kind (a Windows PC, an Apple-silicon Mac, a Linux desktop) and check:

- [ ] The first-open steps on the [install page](../getting-started/install-desktop.md) match what the system shows now, and the page has screenshots of them.
- [ ] The window opens on the create-admin page.
- [ ] Closing the window leaves the tray (menu bar) icon, and **Open Horde** brings the window back.
- [ ] **Start Horde when I sign in** survives a restart of the computer (on a Mac, check Login Items too).
- [ ] **Quit Horde** ends everything: no Horde or Python process is left.
- [ ] An update from the previous version installs (Windows and Linux), or the new-version notice appears (macOS).

## Switching on signing later { #switching-on-signing-later }

Signing is **not set up**. The apps are unsigned and the macOS app is labelled a preview. Nothing in the workflow signs yet; what exists is the place to add it:

- The "Build the installer" step in `desktop-build.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: "false"`, so a certificate that happens to be on a runner is never used, and a comment there says where signing goes. Switching it on means adding the certificate as repository secrets (`CSC_LINK` and `CSC_KEY_PASSWORD`), passing them to that step's environment, and removing the line that turns discovery off. macOS also needs Apple's notarization settings, which are not wired.
- `desktop/electron-builder.yml` gives the macOS app an ad-hoc signature (`identity: "-"`), which Apple silicon needs to run it at all. Replace it with the real identity.
- Then drop the "preview" wording for macOS and the first-open steps from the [install page](../getting-started/install-desktop.md), and let the Mac update itself (electron-updater needs a signed app for that).

## Rolling back a release

Users roll back with `bash update.sh --rollback` ([Updating](../getting-started/updating.md#rollback)); published-image users can also pin the previous tag in `HORDE_IMAGE` and run `docker compose up -d`. For a bad release, publish a patch release rather than editing the old one.

## Recommended branch protection (repository owner)

Branch protection cannot be set from files in the repository. In **Settings → Branches → Add branch ruleset** (or *Branch protection rule*) for `main`:

| Setting | Value |
|---------|-------|
| Require a pull request before merging | on, 1 approval (or 0 for a solo maintainer who still wants the checks), dismiss stale approvals |
| Require status checks to pass | on, *Require branches to be up to date* on. Required checks (the job names GitHub lists): `backend`, `frontend`, `e2e`, `docs` (CI); `Build and smoke test (jellyfin ffmpeg)` and `Build and smoke test (debian ffmpeg)` (Image); `Python advisories (pip-audit)`, `Frontend advisories (npm audit)`, `Image scan (Trivy)` and `Secret scan (gitleaks)` (Security); `Backend tests (windows)`, `Backend tests (mac)`, `Shell checks`, `Build / Web UI and wiki` and `Build / Build and smoke test (windows)`, `(mac)` and `(linux)` (Desktop; the `Build /` ones come from the reusable workflow, so copy the names exactly as the pull request's checks list shows them). Add any further CI jobs (for example lint) as they appear |
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

The Release workflow refuses to build unless the `CI`, `Image` and `Desktop` workflows have a successful run on the tagged commit (it waits up to 40 minutes for runs still in progress), so tag only commits on a green `main`.

The Trivy image scan (`Security` workflow) fails on CRITICAL findings that have a fix. It blocks on pushes to `main` and on the weekly run, but on pull requests it only reports: a newly published CVE in a base image should not block an unrelated pull request, yet it must be fixed before anything ships from `main`.

## Dependency automation

- Dependabot opens one grouped minor/patch pull request per ecosystem each week (Python, npm, Docker, Compose, Actions) and separate pull requests for major updates.
- `dependabot-automerge.yml` squash-merges a grouped minor/patch pull request once CI, Security, Image and Desktop have all passed on its head commit, then runs those workflows on `main` (a merge by the Actions token starts none by itself). Major updates, anything with a failing check, and any branch with a commit not made by Dependabot or `dependabot-lock.yml` wait for review.
- `dependabot-lock.yml` regenerates `backend/requirements.lock` on Dependabot's Python pull requests, which Dependabot cannot do itself, and reruns the checks there. Those reruns are not `pull_request` events, so the Trivy scan blocks on them as it does on `main`.
- Once the lock commit is on its branch, Dependabot stops rebasing that pull request. If it conflicts or goes stale, comment `@dependabot recreate`; the lock is regenerated on the fresh branch.
- `ytdlp-bump.yml` opens a pull request within a day of a new yt-dlp release, after the backend tests and `pip-audit` pass on the regenerated lock. Merge it and cut a patch release when YouTube extraction is broken.
- Regenerate the Python lock by hand with the command in [Dependencies](dependencies.md).
