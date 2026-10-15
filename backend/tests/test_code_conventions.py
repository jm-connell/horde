"""Repository conventions that a linter alone does not pin down."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
APP = BACKEND / "app"

#: ``path:line`` -> why a silent handler is acceptable. Keep this empty if you can:
#: log with ``logger.debug(..., exc_info=True)`` instead.
SILENT_EXCEPT_ALLOWLIST: dict[str, str] = {}

NOQA = re.compile(r"#\s*noqa(?::\s*([A-Z0-9]+(?:,\s*[A-Z0-9]+)*))?(.*)$")


def _app_sources():
    for path in sorted(APP.rglob("*.py")):
        if "migrations" in path.parts:
            continue
        yield path, path.read_text(encoding="utf-8").splitlines()


def test_no_silent_except_markers_remain():
    found = []
    for path, lines in _app_sources():
        for number, line in enumerate(lines, 1):
            match = NOQA.search(line)
            codes = (match.group(1) or "") if match else ""
            if re.search(r"\b(S110|SIM105)\b", codes):
                key = f"{path.relative_to(BACKEND)}:{number}"
                if key not in SILENT_EXCEPT_ALLOWLIST:
                    found.append(f"{key}: {line.strip()}")
    assert not found, (
        "silent exception handlers must log (logger.debug/warning with exc_info=True):\n"
        + "\n".join(found)
    )


def test_every_noqa_says_why():
    bare = []
    for path, lines in _app_sources():
        for number, line in enumerate(lines, 1):
            match = NOQA.search(line)
            if match and not re.match(r"\s+[-—]\s+\S", match.group(2) or ""):
                bare.append(f"{path.relative_to(BACKEND)}:{number}: {line.strip()}")
    assert not bare, "add ' - reason' to these noqa markers:\n" + "\n".join(bare)


def test_silent_except_rules_are_enforced_without_per_file_exemptions():
    config = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    lint = config["tool"]["ruff"]["lint"]
    selected = set(lint["select"])
    assert {"S", "BLE"} <= selected  # S110 try-except-pass, BLE001 blind except
    ignored = set(lint.get("ignore", []))
    assert not ignored & {"S", "S110", "BLE", "BLE001", "SIM105"}
    for pattern, rules in lint.get("per-file-ignores", {}).items():
        assert not set(rules) & {"S110", "BLE001", "SIM105", "S", "BLE"}, pattern
