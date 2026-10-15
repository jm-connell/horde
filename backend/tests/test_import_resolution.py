"""Every import in the app, including the ones inside functions, resolves.

Many services import lazily (inside a function) to avoid import cycles. Those
lines only run when the code path does, and the callers around them often
swallow the error, so moving code to a different package depth can break one
without any test noticing. This resolves them all statically.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1] / "app"


def _module_name(path: Path) -> str:
    rel = path.relative_to(APP_ROOT.parent).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _imports(path: Path) -> list[tuple[int, str, list[str]]]:
    """(line, absolute module, imported names) for every ``from`` import in the file."""
    package = _module_name(path)
    if path.name != "__init__.py":
        package = package.rpartition(".")[0]
    found: list[tuple[int, str, list[str]]] = []
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.ImportFrom):
            continue
        if node.level:
            base = package.split(".")
            base = base[: len(base) - (node.level - 1)]
            module = ".".join([*base, node.module] if node.module else base)
        elif node.module and node.module.split(".")[0] == "app":
            module = node.module
        else:
            continue
        found.append((node.lineno, module, [a.name for a in node.names]))
    return found


def _failures() -> list[str]:
    problems: list[str] = []
    for path in sorted(APP_ROOT.rglob("*.py")):
        for line, module, names in _imports(path):
            where = f"{path.relative_to(APP_ROOT.parent)}:{line}"
            try:
                mod = importlib.import_module(module)
            except ImportError as exc:
                problems.append(f"{where}: cannot import {module} ({exc})")
                continue
            for name in names:
                if name == "*" or hasattr(mod, name):
                    continue
                if importlib.util.find_spec(f"{module}.{name}") is None:
                    problems.append(f"{where}: {module} has no {name}")
    return problems


def test_every_import_in_the_app_resolves():
    problems = _failures()
    assert not problems, "\n".join(problems)
