# 0031. Published release image by default; building is opt-in

Status: Accepted

## Context

Releases are published as images ([0008](0008-releases-and-rollback.md)), and `.env.example` turned them on with `HORDE_IMAGE`, but `docker-compose.yml` still carried the build section. Two things went wrong for people who simply followed the install guide:

- Compose tries to pull an image that has a `build:` section and, when the pull fails, builds it instead, so a registry or network hiccup turned into a long build on a NAS (or an apt error) instead of a clear pull error.
- `git clone` gives `main`, usually ahead of the newest release, while the image is that release. `update.sh` compared the release with the checkout, saw a downgrade and refused, so the first **Update now** of a new install failed.

## Decision

- **The published image is the default.** `docker-compose.yml` names `ghcr.io/jm-connell/horde:latest` and has no build section. Building from the checkout is an overlay, `docker-compose.build.yml`, turned on with `COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml`; it always names the image `horde:latest` so a local build never takes the published name.
- **`update.sh` pulls the image of exactly the release it checks out**, `sha-<shortsha>` (every release image carries that tag), checks the commit baked into it, and names it as compose starts it. A missing image (a just-pushed tag whose image is still building) or a mismatch stops the update and puts the checkout back. A pinned `HORDE_IMAGE` stops it too, since the update would move it.
- **The downgrade guard compares the release with what runs**, the commit baked into the running image, not the checkout. With the published image the checkout's code never runs.
- **The `main` channel builds.** Only releases have images, so `update.sh` adds the `COMPOSE_FILE` line to `.env` the first time it updates a published install on `main`.
- Installs from before keep building until their checkout reaches a release with the new compose file, then pull: they need to change nothing.

## Consequences

- A new install runs releases only, without setting anything, and a failed pull fails loudly.
- The checkout and the running image always match after an update, and rollback restores both.
- `HORDE_IMAGE` remains for forks; pinning a version is for running Compose by hand, not with `update.sh`.
- Building from source, and following `main`, are one documented `.env` line away.
