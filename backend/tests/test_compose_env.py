"""Every runtime setting `.env.example` documents must reach the container.

Docker Compose only reads `.env` to interpolate `docker-compose.yml`; a key the
`horde` service's `environment:` list does not name never reaches the app, so a
documented setting silently does nothing. This test keeps the two in step.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
ENV_EXAMPLE = REPO / ".env.example"
COMPOSE = REPO / "docker-compose.yml"
UPDATE_SCRIPTS = [REPO / "update.sh", *sorted((REPO / "scripts").glob("*.sh"))]

#: Documented keys that are deliberately NOT container environment, with why.
NOT_RUNTIME: dict[str, str] = {
    "DOWNLOADS_PATH": "host path of the media volume",
    "DATA_PATH": "host path of the data volume",
    "OLLAMA_DATA_PATH": "host path of the ollama volume",
    "HORDE_MEM_LIMIT": "compose mem_limit",
    "HORDE_PIDS_LIMIT": "compose pids_limit",
    "HORDE_IMAGE": "compose image name",
    "HORDE_PULL_POLICY": "compose pull_policy",
    "FFMPEG_FLAVOR": "image build argument",
    "JELLYFIN_GPG_FPR": "image build argument",
    "HORDE_GIT_SHA": "image build argument (baked into the image)",
    "HORDE_UPDATE_CHANNEL": "read by update.sh on the host",
    "HORDE_ALLOW_DOWNGRADE": "read by update.sh on the host",
}

#: Commented (`# NAME=`) or active (`NAME=`) assignments at the start of a line.
_KEY = re.compile(r"^#?\s*([A-Z][A-Z0-9_]*)=", re.MULTILINE)


def documented_keys() -> set[str]:
    return set(_KEY.findall(ENV_EXAMPLE.read_text(encoding="utf-8")))


def compose_environment() -> dict[str, str]:
    data = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    entries = data["services"]["horde"]["environment"]
    assert isinstance(entries, list), "keep horde's environment an explicit list"
    out: dict[str, str] = {}
    for entry in entries:
        name, _, value = str(entry).partition("=")
        out[name] = value
    return out


def test_env_example_is_parsed() -> None:
    keys = documented_keys()
    # One active and one commented key, so a regex regression cannot pass vacuously.
    assert {"PUID", "HORDE_TRUST_PROXY"} <= keys
    assert "sudo" not in " ".join(keys)


def test_every_documented_runtime_key_reaches_the_container() -> None:
    env = compose_environment()
    missing = sorted(documented_keys() - NOT_RUNTIME.keys() - env.keys())
    assert not missing, (
        f"documented in .env.example but not passed to the horde container: {missing}. "
        "Add `- NAME=${NAME:-<default>}` to docker-compose.yml, or list the key in "
        "NOT_RUNTIME with a reason."
    )


def test_documented_keys_pass_the_operator_value_through() -> None:
    env = compose_environment()
    for name in documented_keys() & env.keys():
        assert env[name].startswith("${" + name), (
            f"{name} is hardcoded in docker-compose.yml; .env cannot change it"
        )


def test_not_runtime_allowlist_is_accurate() -> None:
    documented = documented_keys()
    env = compose_environment()
    compose_text = COMPOSE.read_text(encoding="utf-8")
    scripts_text = "\n".join(p.read_text(encoding="utf-8") for p in UPDATE_SCRIPTS)
    for name, why in NOT_RUNTIME.items():
        assert name in documented, f"{name} is allowlisted but no longer documented"
        assert name not in env, f"{name} is allowlisted but also passed to the app"
        where = scripts_text if "update.sh" in why else compose_text
        assert name in where, f"{name}: allowlisted as '{why}' but not used there"
