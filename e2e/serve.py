#!/usr/bin/env python3
"""Serve Horde for Playwright.

Uses a throwaway data directory, the built SPA in frontend/dist, and HORDE_E2E=1
so background workers and yt-dlp never start. Build the frontend first.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
DIST = ROOT / "frontend" / "dist"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("app", "setup"), required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    index = DIST / "index.html"
    if not index.is_file():
        sys.exit(f"Missing {index}. From frontend/, run: npm run build")

    runtime = ROOT / "e2e" / ".runtime" / args.mode
    if runtime.exists():
        shutil.rmtree(runtime)
    data = runtime / "data"
    downloads = runtime / "downloads"
    data.mkdir(parents=True)
    downloads.mkdir(parents=True)

    os.environ["HORDE_E2E"] = "1"
    os.environ["HORDE_E2E_MODE"] = args.mode
    os.environ["TZ"] = "UTC"
    os.environ["DATA_DIR"] = str(data)
    os.environ["DOWNLOADS_DIR"] = str(downloads)
    os.environ["HORDE_FRONTEND_DIR"] = str(DIST)
    # Do not inherit a developer machine's YouTube or AI endpoints.
    os.environ.pop("YTDLP_POT_BASE_URL", None)
    os.environ.pop("OLLAMA_BASE_URL", None)
    os.environ.pop("OPENROUTER_API_KEY", None)

    sys.path.insert(0, str(BACKEND))
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
