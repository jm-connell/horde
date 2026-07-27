#!/usr/bin/env python3
"""Validate a YouTube URL's Horde DASH preview manifest.

Usage (from repo root, with backend deps installed):

    python scripts/check_preview_manifest.py 'https://www.youtube.com/watch?v=...'

Asserts:
  - every video AdaptationSet is codec-homogeneous
  - mediaPresentationDuration matches sidx-derived duration (within 1s)
  - alignment attributes are only present when boundaries match
  - every declared initRange / indexRange fetches successfully
"""

from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# Allow importing the backend package when run from repo root.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import httpx  # noqa: E402

from app.services import downloader  # noqa: E402

NS = {"d": "urn:mpeg:dash:schema:mpd:2011"}


def _codec_family(codecs: str) -> str:
    c = (codecs or "").lower()
    if c.startswith("av01"):
        return "av01"
    if c.startswith("avc"):
        return "avc1"
    return c.split(".")[0] if c else "unknown"


def _parse_duration(pt: str) -> float:
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", pt or "")
    if not m:
        return 0.0
    h = float(m.group(1) or 0)
    mi = float(m.group(2) or 0)
    s = float(m.group(3) or 0)
    return h * 3600 + mi * 60 + s


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="YouTube (or yt-dlp) video URL")
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="Skip fetching init/index ranges from googlevideo",
    )
    args = parser.parse_args()

    print(f"Resolving manifest for {args.url} …")
    session = downloader.resolve_preview_manifest(args.url, force=True)
    xml = downloader.build_dash_manifest(session)
    root = ET.fromstring(xml)

    mpd_dur = _parse_duration(root.attrib.get("mediaPresentationDuration", ""))
    sidx_durs = [
        float(r["duration_sec"])
        for r in (session.get("formats") or {}).values()
        if r.get("duration_sec")
    ]
    expected = max(sidx_durs) if sidx_durs else float(session.get("duration") or 0)
    if abs(mpd_dur - expected) > 1.0:
        raise SystemExit(
            f"FAIL: mediaPresentationDuration {mpd_dur:.3f}s != sidx {expected:.3f}s"
        )
    print(f"OK duration: MPD={mpd_dur:.3f}s sidx={expected:.3f}s")

    for aset in root.findall("d:Period/d:AdaptationSet", NS):
        content = aset.attrib.get("contentType", "")
        reps = aset.findall("d:Representation", NS)
        if content != "video" or not reps:
            continue
        families = {
            _codec_family(r.attrib.get("codecs", "")) for r in reps
        }
        if len(families) != 1:
            raise SystemExit(
                f"FAIL: AdaptationSet {aset.attrib.get('id')} mixed codecs: {families}"
            )
        family = next(iter(families))
        print(
            f"OK AdaptationSet id={aset.attrib.get('id')} "
            f"family={family} reps={len(reps)}"
        )

        # Verify alignment claim matches stored boundary data.
        claimed = (
            aset.attrib.get("segmentAlignment") == "true"
            and aset.attrib.get("subsegmentAlignment") == "true"
        )
        itags = [r.attrib.get("id") for r in reps]
        family_reps = [
            session["formats"][i]
            for i in itags
            if i in session["formats"]
        ]
        actually = downloader._boundaries_aligned(family_reps)
        if claimed and not actually:
            raise SystemExit(
                f"FAIL: AdaptationSet {aset.attrib.get('id')} claims alignment "
                "but boundaries diverge"
            )
        if not claimed and actually and len(family_reps) > 1:
            print(
                f"WARN: AdaptationSet {aset.attrib.get('id')} is aligned but "
                "attributes omitted (acceptable)"
            )

        for rep_el in reps:
            sb = rep_el.find("d:SegmentBase", NS)
            if sb is None:
                raise SystemExit("FAIL: missing SegmentBase")
            if sb.attrib.get("indexRangeExact") != "true":
                raise SystemExit("FAIL: missing indexRangeExact=true")

    if not args.skip_fetch:
        print("Fetching init/index ranges …")
        token = session["token"]
        with httpx.Client(timeout=30.0, follow_redirects=True) as client:
            for itag, fmt in session["formats"].items():
                for label, rng in (
                    ("init", fmt["init_range"]),
                    ("index", fmt["index_range"]),
                ):
                    resolved = downloader.lookup_preview_media(token, itag)
                    headers = dict(resolved.get("http_headers") or {})
                    headers["Range"] = f"bytes={rng}"
                    resp = client.get(resolved["direct_url"], headers=headers)
                    if resp.status_code not in (200, 206):
                        raise SystemExit(
                            f"FAIL: {itag} {label} range {rng} -> HTTP {resp.status_code}"
                        )
                    if not resp.content:
                        raise SystemExit(
                            f"FAIL: {itag} {label} range {rng} empty body"
                        )
                print(f"OK ranges itag={itag} kind={fmt.get('kind')}")

    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
