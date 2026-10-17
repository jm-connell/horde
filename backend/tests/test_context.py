"""AppContext: the one place paths and the engine come from."""

from __future__ import annotations

from app import context
from app.services.downloads import runner
from app.services.downloads.queue import download_queue
from app.services.paths import staging_dir


def test_services_follow_the_active_context(tmp_path):
    first = context.build_context(context.Paths(tmp_path / "a-dl", tmp_path / "a"))
    second = context.build_context(context.Paths(tmp_path / "b-dl", tmp_path / "b"))
    previous = context.activate(first)
    try:
        assert staging_dir(7).is_relative_to(tmp_path / "a-dl")
        assert context.activate(second) is first
        assert staging_dir(7).is_relative_to(tmp_path / "b-dl")
        assert context.get_engine() is second.engine
    finally:
        context.deactivate(previous)
        first.engine.dispose()
        second.engine.dispose()


def test_building_a_context_binds_the_download_runner(tmp_dirs):
    assert download_queue.runner is runner.run_download


def test_e2e_context_turns_download_dispatch_off(tmp_path, monkeypatch):
    monkeypatch.setattr(download_queue, "dispatch_enabled", True)  # restored after
    ctx = context.build_context(
        context.Paths(tmp_path / "dl", tmp_path / "d"), e2e=True
    )
    try:
        assert ctx.e2e is True
        assert download_queue.dispatch_enabled is False
    finally:
        ctx.engine.dispose()


def test_get_session_uses_the_apps_context(client, init_db):
    assert client.app.state.ctx is init_db["ctx"]
    assert client.get("/api/videos").status_code == 200
