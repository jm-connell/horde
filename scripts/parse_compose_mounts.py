#!/usr/bin/env python3
"""Parse `docker compose config` JSON or YAML text; print dest=source bind mounts."""

from __future__ import annotations

import json
import re
import sys

TARGETS = {"/downloads", "/app/data"}


def record(out: dict[str, str], target: object, source: object) -> None:
    if not target or not source:
        return
    dest = str(target).rstrip("/") or "/"
    src = str(source)
    if dest in TARGETS or dest.endswith("/.ollama"):
        out[dest] = src


def split_short(spec: str) -> tuple[str | None, str | None]:
    spec = spec.strip().strip("'\"")
    parts = spec.split(":")
    if len(parts) < 2:
        return None, None
    mode = parts[-1]
    if mode in ("ro", "rw", "z", "Z"):
        if len(parts) < 3:
            return None, None
        return ":".join(parts[:-2]), parts[-2]
    return ":".join(parts[:-1]), parts[-1]


def from_json(cfg: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    services = cfg.get("services") or {}
    for name in ("horde", "ollama"):
        svc = services.get(name) or {}
        for vol in svc.get("volumes") or []:
            if isinstance(vol, str):
                source, target = split_short(vol)
                record(out, target, source)
            elif isinstance(vol, dict):
                record(
                    out,
                    vol.get("target") or vol.get("destination"),
                    vol.get("source"),
                )
    return out


def from_text(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    source = None
    for line in raw.splitlines():
        s = line.strip().strip(",")
        m = re.match(r"source:\s*(.+)$", s)
        if m:
            source = m.group(1).strip().strip("'\"")
            continue
        m = re.match(r"target:\s*(.+)$", s)
        if m:
            target = m.group(1).strip().strip("'\"")
            record(out, target, source)
            continue
        m = re.match(
            r"-\s*(.+):(/(?:downloads|app/data)|/root/\.ollama)(?::(ro|rw|z|Z))?$",
            s,
        )
        if m:
            record(out, m.group(2), m.group(1).strip().strip("'\""))
    return out


def parse(raw: str) -> dict[str, str]:
    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError:
        cfg = None
    if isinstance(cfg, dict):
        return from_json(cfg)
    return from_text(raw)


def main() -> int:
    raw = sys.stdin.read()
    for target, source in parse(raw).items():
        print(f"{target}={source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
