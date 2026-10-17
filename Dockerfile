# syntax=docker/dockerfile:1

# Base images are pinned to an exact version AND an immutable digest so a
# rebuild is reproducible. Dependabot (docker ecosystem) proposes bumps.

# The frontend and the wiki are platform-independent static files, so they are
# always built on the build host (fast, no emulation) even for arm64 images.

# --- Stage 1: build the React frontend ---
FROM --platform=$BUILDPLATFORM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: build the MkDocs wiki ---
FROM --platform=$BUILDPLATFORM python:3.12.15-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS docs
WORKDIR /docs
COPY docs/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY mkdocs.yml ./
COPY docs/ ./docs/
RUN mkdocs build -d /docs-out --strict

# --- Stage 3: python runtime serving API + static build + wiki ---
FROM python:3.12.15-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS runtime
WORKDIR /app

# Which ffmpeg to ship. The build FAILS if the requested flavor cannot be
# installed; there is no silent fallback.
#   jellyfin  jellyfin-ffmpeg7 (VAAPI/QSV/NVENC-capable build; default)
#   debian    the distribution's ffmpeg (smaller, fewer hardware encoders)
ARG FFMPEG_FLAVOR=jellyfin
# Optional: expected fingerprint of the Jellyfin repository signing key (40 hex
# characters, no spaces). When set, the build fails if the downloaded key differs.
# When empty the fingerprint is printed in the build log instead.
ARG JELLYFIN_GPG_FPR=

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DOWNLOADS_DIR=/downloads \
    DATA_DIR=/app/data

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gosu mesa-va-drivers; \
    case "${FFMPEG_FLAVOR}" in \
      debian) \
        apt-get install -y --no-install-recommends ffmpeg; \
        ;; \
      jellyfin) \
        apt-get install -y --no-install-recommends gnupg; \
        mkdir -p /etc/apt/keyrings; \
        curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key -o /tmp/jellyfin.key; \
        fpr="$(gpg --show-keys --with-colons /tmp/jellyfin.key | awk -F: '/^fpr:/ {print $10; exit}')"; \
        test -n "${fpr}"; \
        echo "Jellyfin repository signing key fingerprint: ${fpr}"; \
        expected="${JELLYFIN_GPG_FPR:-4918AABC486CA052358D778D49023CD01DE21A7B}"; \
        if [ "${fpr}" != "${expected}" ]; then \
          echo "Jellyfin key fingerprint mismatch: got ${fpr}, expected ${expected}" >&2; \
          exit 1; \
        fi; \
        gpg --dearmor < /tmp/jellyfin.key > /etc/apt/keyrings/jellyfin.gpg; \
        . /etc/os-release; \
        echo "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian ${VERSION_CODENAME} main" \
          > /etc/apt/sources.list.d/jellyfin.list; \
        apt-get update; \
        apt-get install -y --no-install-recommends jellyfin-ffmpeg7; \
        ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg; \
        ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe; \
        apt-get purge -y --auto-remove gnupg; \
        rm -f /tmp/jellyfin.key; \
        ;; \
      *) \
        echo "FFMPEG_FLAVOR must be 'jellyfin' or 'debian' (got '${FFMPEG_FLAVOR}')" >&2; \
        exit 1; \
        ;; \
    esac; \
    ffmpeg -version | head -n 1; \
    ffprobe -version | head -n 1; \
    rm -rf /var/lib/apt/lists/*

# Hash-checked, fully pinned Python deps (regenerate: docs/development/dependencies.md).
COPY backend/requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

COPY backend/app ./app
COPY --from=frontend /build/dist ./static
COPY --from=docs /docs-out ./static/wiki
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Build identity goes last so changing the commit does not invalidate the
# expensive layers above. BUILD_INFO is read by the entrypoint and is handy in
# bug reports: `docker exec horde cat /app/BUILD_INFO`.
ARG HORDE_GIT_SHA=unknown
ARG HORDE_VERSION=dev
ENV HORDE_GIT_SHA=${HORDE_GIT_SHA} \
    HORDE_VERSION=${HORDE_VERSION}
RUN { \
      echo "version=${HORDE_VERSION}"; \
      echo "git_sha=${HORDE_GIT_SHA}"; \
      echo "ffmpeg_flavor=${FFMPEG_FLAVOR}"; \
      echo "ffmpeg=$(ffmpeg -version | head -n 1)"; \
    } > /app/BUILD_INFO

LABEL org.opencontainers.image.title="Horde" \
      org.opencontainers.image.description="Self-hosted YouTube archive and media library" \
      org.opencontainers.image.source="https://github.com/jm-connell/horde" \
      org.opencontainers.image.url="https://jm-connell.github.io/horde/" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.version="${HORDE_VERSION}" \
      org.opencontainers.image.revision="${HORDE_GIT_SHA}"

EXPOSE 8080

# /api/ping is a constant-time liveness probe (no database or sidecar calls).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/ping >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-graceful-shutdown", "10"]
