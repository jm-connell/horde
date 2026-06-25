from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import ensure_dirs
from .database import init_db
from .api import downloads, review, videos
from .services.scanner import start_scanner

# Static frontend build copied next to the backend in the Docker image.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    observer = start_scanner()
    try:
        yield
    finally:
        observer.stop()
        observer.join(timeout=5)


app = FastAPI(title="Horde", lifespan=lifespan)

app.include_router(videos.router)
app.include_router(downloads.router)
app.include_router(review.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


if FRONTEND_DIR.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIR / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        # Serve real files when present, otherwise fall back to the SPA entry.
        candidate = FRONTEND_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIR / "index.html")
