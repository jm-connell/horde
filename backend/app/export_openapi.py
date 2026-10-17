"""Write the API's OpenAPI document to a file (or stdout).

    python -m app.export_openapi                      # print to stdout
    python -m app.export_openapi openapi.json         # write a file
    python -m app.export_openapi --check openapi.json # exit 1 if the file is stale

The document is built from the route table alone, so nothing is started: no
database, no workers. Output is sorted and stable, so it diffs cleanly and a client
generator (see ``docs/architecture/api-overview.md``) can run in CI.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def build_document() -> str:
    from .main import app

    return (
        json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.export_openapi")
    parser.add_argument("path", nargs="?", help="file to write (default: stdout)")
    parser.add_argument(
        "--check",
        action="store_true",
        help="do not write; exit 1 when PATH differs from the current API",
    )
    args = parser.parse_args(argv)
    document = build_document()
    if args.check:
        if not args.path:
            parser.error("--check needs a path")
        current = Path(args.path).read_text(encoding="utf-8")
        if current != document:
            print(f"{args.path} is out of date; regenerate it.", file=sys.stderr)
            return 1
        return 0
    if args.path:
        Path(args.path).write_text(document, encoding="utf-8")
    else:
        sys.stdout.write(document)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
