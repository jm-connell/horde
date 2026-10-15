"""The event loop must never run blocking work, and yt-dlp requests stay bounded."""

from __future__ import annotations

import ast
import threading
import time
from pathlib import Path

import pytest

from app.services.limits import YtdlpSlots

APP_DIR = Path(__file__).resolve().parents[1] / "app"

#: Calls that block: file and database I/O, subprocesses, sync HTTP, yt-dlp, sleeping.
BLOCKING_NAMES = {"open", "Session", "sleep"}
BLOCKING_ATTRS = {
    "extract_info",
    "read_bytes",
    "write_bytes",
    "read_text",
    "write_text",
    "mkdir",
    "unlink",
    "iterdir",
    "rglob",
    "glob",
    "stat",
    "commit",
    "exec",
}
BLOCKING_MODULE_CALLS = {
    "time": {"sleep"},
    "subprocess": None,  # any attribute
    "shutil": None,
    "httpx": {"get", "post", "put", "patch", "delete", "head", "request", "stream"},
    "os": {
        "makedirs",
        "remove",
        "unlink",
        "rename",
        "replace",
        "stat",
        "walk",
        "scandir",
    },
    "requests": None,
}
#: Blocking project helpers an async route must hand to a thread instead of calling.
BLOCKING_PROJECT_CALLS = {
    "validate_public_url",
    "extract_preview",
    "resolve_preview_stream",
    "resolve_preview_subtitle",
    "resolve_preview_manifest",
    "lookup_preview_media",
    "save_upload",
    "read_upload_bytes",
}

#: ``module.function`` -> why blocking calls there are acceptable.
ALLOWLIST = {
    "main.lifespan": "startup and shutdown run before / after any request is served",
    "main._ImmutableStaticFiles.get_response": "Starlette's StaticFiles offloads its own I/O",
}


def _calls(node: ast.AST):
    """Calls in ``node`` that run on the loop: not inside a nested function."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        child = stack.pop()
        if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
            continue
        if isinstance(child, ast.Call):
            yield child
        stack.extend(ast.iter_child_nodes(child))


def _describe(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        if func.id in BLOCKING_NAMES | BLOCKING_PROJECT_CALLS:
            return func.id
        return None
    if isinstance(func, ast.Attribute):
        if func.attr in BLOCKING_PROJECT_CALLS:
            return func.attr
        if isinstance(func.value, ast.Name) and func.value.id in BLOCKING_MODULE_CALLS:
            allowed = BLOCKING_MODULE_CALLS[func.value.id]
            if allowed is None or func.attr in allowed:
                return f"{func.value.id}.{func.attr}"
        if func.attr in BLOCKING_ATTRS:
            return f".{func.attr}"
    return None


def _async_functions(tree: ast.Module):
    def visit(node: ast.AST, prefix: str):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                yield from visit(child, f"{prefix}{child.name}.")
            elif isinstance(child, ast.AsyncFunctionDef | ast.FunctionDef):
                if isinstance(child, ast.AsyncFunctionDef):
                    yield f"{prefix}{child.name}", child
                yield from visit(child, f"{prefix}{child.name}.")

    yield from visit(tree, "")


def test_async_routes_do_no_blocking_work_on_the_loop():
    offenders: list[str] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if "migrations" in path.parts or path.name == "legacy_migrations.py":
            continue
        module = ".".join(path.relative_to(APP_DIR).with_suffix("").parts)
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for qualname, func in _async_functions(tree):
            if f"{module}.{qualname}" in ALLOWLIST:
                continue
            for call in _calls(func):
                what = _describe(call)
                if what:
                    offenders.append(
                        f"{path.relative_to(APP_DIR)}:{call.lineno} "
                        f"{qualname}() calls {what}"
                    )
    assert not offenders, (
        "blocking calls inside async def (make the route a plain `def`, or hand the "
        "work to run_in_threadpool / asyncio.to_thread):\n" + "\n".join(offenders)
    )


def test_the_guard_notices_blocking_calls():
    tree = ast.parse(
        "async def bad(path):\n"
        "    open(path)\n"
        "    time.sleep(1)\n"
        "    with Session(engine) as s:\n"
        "        s.commit()\n"
        "    def inner():\n"
        "        open(path)  # not on the loop\n"
        "    return await run_in_threadpool(validate_public_url, path)\n"
    )
    ((_, func),) = _async_functions(tree)
    found = {_describe(c) for c in _calls(func)} - {None}
    assert found == {"open", "time.sleep", "Session", ".commit"}


# -- behaviour ---------------------------------------------------------------


def test_slow_yt_dlp_work_does_not_stall_other_requests(client, monkeypatch):
    from app.services import stream_preview

    release = threading.Event()

    def slow_resolve(*_a, **_k):
        release.wait(5)
        raise KeyError("no such subtitle")

    monkeypatch.setattr(stream_preview, "resolve_preview_subtitle", slow_resolve)
    results: list[int] = []

    def request_subtitles() -> None:
        r = client.get(
            "/api/preview/subtitles", params={"url": "https://youtu.be/dQw4w9WgXcQ"}
        )
        results.append(r.status_code)

    threads = [threading.Thread(target=request_subtitles) for _ in range(3)]
    for t in threads:
        t.start()
    try:
        time.sleep(0.3)  # all three are now parked in yt-dlp work
        worst = 0.0
        for _ in range(10):
            started = time.monotonic()
            assert client.get("/api/ping").status_code == 200
            worst = max(worst, time.monotonic() - started)
        assert worst < 0.5, f"/api/ping took {worst:.2f}s while yt-dlp work was running"
    finally:
        release.set()
        for t in threads:
            t.join(10)
    assert results == [404, 404, 404]


def test_requests_beyond_the_yt_dlp_slots_get_429_without_taking_threads(
    app, client, monkeypatch
):
    from app.services import downloader

    app.state.ytdlp_slots = YtdlpSlots(1, 0.2)
    release = threading.Event()
    entered = threading.Event()

    def slow_preview(url):
        entered.set()
        release.wait(5)
        raise ValueError("boom")

    monkeypatch.setattr(downloader, "extract_preview", slow_preview)
    first = threading.Thread(
        target=lambda: client.get(
            "/api/downloads/preview", params={"url": "https://example.com/a"}
        )
    )
    first.start()
    try:
        assert entered.wait(5)
        started = time.monotonic()
        second = client.get(
            "/api/downloads/preview", params={"url": "https://example.com/b"}
        )
        assert second.status_code == 429
        assert second.headers["Retry-After"] == "5"
        assert time.monotonic() - started < 2
    finally:
        release.set()
        first.join(10)


@pytest.mark.parametrize("slots", [1, 3])
def test_the_slot_limit_is_exact(slots):
    import anyio

    gate = YtdlpSlots(slots, 0.05)
    inside = 0
    peak = 0

    async def worker() -> None:
        nonlocal inside, peak
        try:
            async with gate.slot():
                inside += 1
                peak = max(peak, inside)
                await anyio.sleep(0.1)
                inside -= 1
        except Exception:  # the 429 for those that waited too long
            return

    async def main() -> None:
        async with anyio.create_task_group() as tg:
            for _ in range(8):
                tg.start_soon(worker)

    anyio.run(main)
    assert peak == slots
