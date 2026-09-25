"""The browser-test reset route stays off unless the e2e server opts in."""


def test_e2e_reset_route_is_not_mounted_for_pytest(monkeypatch):
    monkeypatch.delenv("HORDE_E2E", raising=False)
    from app.main import app

    paths = {getattr(route, "path", None) for route in app.routes}
    assert "/api/e2e/reset" not in paths
