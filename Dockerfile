# syntax=docker/dockerfile:1

# --- Stage 1: build the React frontend ---
FROM node:20-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Stage 2: build the MkDocs wiki ---
FROM python:3.12-slim AS docs
WORKDIR /docs
RUN pip install --no-cache-dir "mkdocs-material>=9.5,<10"
COPY mkdocs.yml ./
COPY docs/ ./docs/
RUN mkdocs build -d /docs-out --strict

# --- Stage 3: python runtime serving API + static build + wiki ---
FROM python:3.12-slim AS runtime
WORKDIR /app

ARG HORDE_GIT_SHA=unknown

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DOWNLOADS_DIR=/downloads \
    DATA_DIR=/app/data \
    HORDE_GIT_SHA=${HORDE_GIT_SHA}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg gosu \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend /build/dist ./static
COPY --from=docs /docs-out ./static/wiki
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
