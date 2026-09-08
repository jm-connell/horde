#!/usr/bin/env python3
"""Merge GitHub clone traffic into docs/assets/github-clones.json.

GitHub only keeps 14 days of clone traffic and hides it behind Administration
read access. The default GITHUB_TOKEN cannot call this API — use a PAT in
TRAFFIC_TOKEN (classic `public_repo`, or fine-grained Administration: read).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "assets" / "github-clones.json"
API_VERSION = "2022-11-28"


def token_from_env() -> str:
    for key in ("TRAFFIC_TOKEN", "CLONE_STATS_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


def fetch_clones(repo: str, token: str) -> dict:
    url = f"https://api.github.com/repos/{repo}/traffic/clones"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "horde-wiki-clone-stats",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise ValueError("traffic/clones response must be an object")
    return payload


def merge(existing: dict, payload: dict, now: datetime) -> dict:
    days: dict[str, int] = {}
    raw_days = existing.get("days") if isinstance(existing, dict) else None
    if isinstance(raw_days, dict):
        for key, value in raw_days.items():
            if isinstance(value, int):
                days[str(key)] = value
            elif isinstance(value, dict) and isinstance(value.get("count"), int):
                days[str(key)] = value["count"]
    for row in payload.get("clones") or []:
        if not isinstance(row, dict):
            continue
        timestamp = row.get("timestamp")
        count = row.get("count")
        if not isinstance(timestamp, str) or not isinstance(count, int):
            continue
        days[timestamp[:10]] = count
    ordered = dict(sorted(days.items()))
    return {
        "count": sum(ordered.values()),
        "updated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": ordered,
    }


def load_existing(path: Path) -> dict:
    if not path.is_file():
        return {"count": 0, "days": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"count": 0, "days": {}}
    return data if isinstance(data, dict) else {"count": 0, "days": {}}


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo",
        default=os.environ.get("GITHUB_REPOSITORY", "jm-connell/horde"),
        help="owner/name of the GitHub repository",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--optional",
        action="store_true",
        help="exit 0 when the token is missing or the traffic API rejects it",
    )
    args = parser.parse_args()

    token = token_from_env()
    if not token:
        message = (
            "No TRAFFIC_TOKEN (or GITHUB_TOKEN) in the environment; "
            "skipping clone archive."
        )
        print(message, file=sys.stderr)
        return 0 if args.optional else 1

    try:
        payload = fetch_clones(args.repo, token)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"traffic/clones HTTP {exc.code}: {detail}", file=sys.stderr)
        return 0 if args.optional else 1
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"traffic/clones failed: {exc}", file=sys.stderr)
        return 0 if args.optional else 1

    existing = load_existing(args.out)
    merged = merge(existing, payload, datetime.now(timezone.utc))
    if existing.get("days") == merged["days"] and existing.get("count") == merged["count"]:
        print(f"Clone archive unchanged ({merged['count']} clones)")
        return 0

    write_json(args.out, merged)
    print(f"Wrote {args.out} ({merged['count']} clones, {len(merged['days'])} days)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
