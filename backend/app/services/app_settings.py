import copy
import json
import logging
import os
import tempfile
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .css_sanitize import sanitize_ui_css

logger = logging.getLogger(__name__)

AI_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "provider": "ollama",
    "base_url": "",
    "embed_model": "nomic-embed-text",
    "chat_model": "llama3.2:3b",
    # Optional OpenRouter LLM backend (summaries, chat, tags, duplicate LLM).
    "openrouter_enabled": False,
    "openrouter_api_key": "",
    "openrouter_model": "google/gemini-2.5-flash-lite",
    # specialized = LLM tasks only; all = also embeddings / invent vectors.
    "openrouter_scope": "specialized",
    "openrouter_embed_model": "openai/text-embedding-3-small",
    # When OpenRouter scope is all, prefer Ollama for embeddings if available.
    "ollama_prefer_embeddings": False,
    # Show per-response cost chips in Watch UI (Settings totals always show).
    "openrouter_show_costs": False,
    # Soft/hard weekly OpenRouter spend limit (rolling 7 days). null = off.
    "openrouter_weekly_budget_usd": None,
    # When true and weekly spend >= budget, block further OpenRouter calls.
    "openrouter_budget_hard_limit": False,
    # on_download | on_request | timer | set_time
    "schedule": "on_download",
    "timer_hours": 6,
    "schedule_time": "03:00",  # local HH:MM for set_time
    "last_daily_run": "",  # YYYY-MM-DD when set_time last ran
    "auto_pull_models": True,
    "use_subtitles": True,
    "enrich_tags": True,
    # Re-queue unlocked videos whose tags_enriched_at is older than this.
    "tag_rescan_days": 90,
    "ai_summaries": True,
    "ai_chapters": True,
    # on_download | on_watch
    "ai_chapters_mode": "on_download",
    "ai_chat": True,
    "summary_length": "short",  # short | medium | long
    "ai_duplicates": True,
    "category_min_score": 0.55,
    "workload_profile": "normal",  # light | normal | heavy
    # Optional GiB override for the Ollama machine's GPU (null = autodetect).
    "vram_gb": None,
    "pending_category_refresh": False,
    "paused": False,
}

_CATEGORY_MIN_SCORE_LO = 0.20
_CATEGORY_MIN_SCORE_HI = 0.90
_VRAM_GB_LO = 0.5
_VRAM_GB_HI = 256.0
_TAG_RESCAN_DAYS_LO = 7
_TAG_RESCAN_DAYS_HI = 365
TAG_RESCAN_DAYS_MIN = _TAG_RESCAN_DAYS_LO
TAG_RESCAN_DAYS_MAX = _TAG_RESCAN_DAYS_HI
_WEEKLY_BUDGET_USD_LO = 0.01
_WEEKLY_BUDGET_USD_HI = 100_000.0
_SUMMARY_LENGTHS = frozenset({"short", "medium", "long"})
_CHAPTERS_MODES = frozenset({"on_download", "on_watch"})
_OPENROUTER_SCOPES = frozenset({"specialized", "all"})


def normalize_openrouter_scope(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in _OPENROUTER_SCOPES:
        return raw
    return "specialized"


def normalize_openrouter_embed_model(value: Any) -> str:
    raw = str(value or "").strip()
    return raw or str(AI_DEFAULTS["openrouter_embed_model"])


def clamp_category_min_score(value: Any) -> float:
    try:
        score = float(value)
    except TypeError, ValueError:
        score = float(AI_DEFAULTS["category_min_score"])
    return max(_CATEGORY_MIN_SCORE_LO, min(_CATEGORY_MIN_SCORE_HI, score))


def normalize_summary_length(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in _SUMMARY_LENGTHS:
        return raw
    return str(AI_DEFAULTS["summary_length"])


def normalize_ai_chapters_mode(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in _CHAPTERS_MODES:
        return raw
    return str(AI_DEFAULTS["ai_chapters_mode"])


def clamp_tag_rescan_days(value: Any) -> int:
    try:
        days = int(value)
    except TypeError, ValueError:
        days = int(AI_DEFAULTS["tag_rescan_days"])
    return max(_TAG_RESCAN_DAYS_LO, min(_TAG_RESCAN_DAYS_HI, days))


def clamp_vram_gb(value: Any) -> float | None:
    """None/empty clears the override; otherwise clamp to a sane GiB range."""
    if value is None or value == "":
        return None
    try:
        gb = float(value)
    except TypeError, ValueError:
        return None
    if gb <= 0:
        return None
    return max(_VRAM_GB_LO, min(_VRAM_GB_HI, gb))


def clamp_weekly_budget_usd(value: Any) -> float | None:
    """None/empty/0 clears the weekly spend limit; otherwise clamp USD."""
    if value is None or value == "":
        return None
    try:
        amount = float(value)
    except TypeError, ValueError:
        return None
    if amount <= 0 or amount != amount:  # NaN
        return None
    return max(_WEEKLY_BUDGET_USD_LO, min(_WEEKLY_BUDGET_USD_HI, amount))


DEFAULTS: dict[str, Any] = {
    "progress_expiry_days": 14,
    "continue_watching_days": 7,
    "metadata_sync_interval_hours": 24,
    "channel_catalog_enabled": True,
    "channel_catalog_max_videos": 1000,
    "direct_youtube_search": True,
    "youtube_video_search": True,
    "download_queue_paused": False,
    # Where outgoing notifications go (services/notifications/targets.py).
    "notification_targets": [],
    # Which update/failure notifications were already sent (services/notifications/watchers.py).
    "notification_state": {},
    # Downloads wait once the library takes this many bytes. None = no limit.
    "max_library_bytes": None,
    # Write Jellyfin / Kodi / Plex files (.nfo, thumbnails) beside the media
    # (services/media_sidecars.py).
    "media_server_sidecars": False,
    # Two-step sign-in required of: "off" | "admins" | "everyone"
    # (services/auth/two_factor.py).
    "require_two_factor": "off",
    "setup_completed": False,
    "ui": {},
    "ai": dict(AI_DEFAULTS),
}

#: The smallest library size limit the settings accept (1 GiB), and the largest.
MAX_LIBRARY_BYTES_MIN = 1024**3
MAX_LIBRARY_BYTES_MAX = 1024**5

CHANNEL_CATALOG_MAX_MIN = 100
CHANNEL_CATALOG_MAX_MAX = 5000
CHANNEL_CATALOG_DESC_LIMIT = 200


def clamp_catalog_max_videos(value: Any) -> int:
    try:
        n = int(value)
    except TypeError, ValueError:
        n = int(DEFAULTS["channel_catalog_max_videos"])
    return max(CHANNEL_CATALOG_MAX_MIN, min(CHANNEL_CATALOG_MAX_MAX, n))


def clamp_max_library_bytes(value: Any) -> int | None:
    """None/empty/0 means no limit; otherwise a size between 1 GiB and 1 PiB."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        size = int(value)
    except TypeError, ValueError:
        return None
    if size <= 0:
        return None
    return max(MAX_LIBRARY_BYTES_MIN, min(MAX_LIBRARY_BYTES_MAX, size))


def direct_youtube_search_system(data: dict[str, Any] | None = None) -> bool:
    raw = (data if data is not None else load()).get("direct_youtube_search", True)
    return bool(raw)


def youtube_video_search_system(data: dict[str, Any] | None = None) -> bool:
    raw = (data if data is not None else load()).get("youtube_video_search", True)
    return bool(raw)


def direct_youtube_search_effective(override: Any, system: Any = None) -> bool:
    """Per-channel override wins; None/unknown inherits the system default."""
    if override is True:
        return True
    if override is False:
        return False
    if override in (1, "1", "true", "True"):
        return True
    if override in (0, "0", "false", "False"):
        return False
    if system is None:
        system = direct_youtube_search_system()
    return bool(system)


def _path() -> Path:
    from ..context import get_paths

    return get_paths().data / "app_settings.json"


def _merge_ai(raw: Any) -> dict[str, Any]:
    merged = dict(AI_DEFAULTS)
    if isinstance(raw, dict):
        merged.update({k: v for k, v in raw.items() if k in AI_DEFAULTS})
    merged["category_min_score"] = clamp_category_min_score(
        merged.get("category_min_score")
    )
    merged["summary_length"] = normalize_summary_length(merged.get("summary_length"))
    merged["ai_chapters_mode"] = normalize_ai_chapters_mode(
        merged.get("ai_chapters_mode")
    )
    merged["tag_rescan_days"] = clamp_tag_rescan_days(merged.get("tag_rescan_days"))
    merged["vram_gb"] = clamp_vram_gb(merged.get("vram_gb"))
    merged["openrouter_scope"] = normalize_openrouter_scope(
        merged.get("openrouter_scope")
    )
    merged["openrouter_embed_model"] = normalize_openrouter_embed_model(
        merged.get("openrouter_embed_model")
    )
    merged["ollama_prefer_embeddings"] = bool(merged.get("ollama_prefer_embeddings"))
    merged["openrouter_show_costs"] = bool(merged.get("openrouter_show_costs", False))
    merged["openrouter_weekly_budget_usd"] = clamp_weekly_budget_usd(
        merged.get("openrouter_weekly_budget_usd")
    )
    merged["openrouter_budget_hard_limit"] = bool(
        merged.get("openrouter_budget_hard_limit")
    )
    return merged


def _factory_defaults(*, setup_completed: bool) -> dict[str, Any]:
    out = dict(DEFAULTS)
    out["ui"] = {}
    out["ai"] = dict(AI_DEFAULTS)
    out["setup_completed"] = setup_completed
    return out


def _normalize(data: dict[str, Any]) -> dict[str, Any]:
    """Merge a parsed settings file over the defaults."""
    merged = {**DEFAULTS, **data}
    # Deep-merge ui so partial saves don't wipe nested keys on read.
    ui = data.get("ui")
    merged["ui"] = ui if isinstance(ui, dict) else {}
    merged["ai"] = _merge_ai(data.get("ai"))
    # Existing installs predating the wizard must not be trapped in setup.
    if "setup_completed" not in data:
        merged["setup_completed"] = True
    else:
        merged["setup_completed"] = bool(data.get("setup_completed"))
    return merged


class SettingsError(RuntimeError):
    """Base class for settings persistence failures."""


class SettingsCorruptError(SettingsError):
    """The settings file cannot be parsed and no backup could restore it."""


class SettingsUnavailableError(SettingsError):
    """The settings file could not be read (I/O error); nothing was assumed."""


class _Store:
    """Thread-safe settings reader/writer with an mtime+size validated cache.

    Writes are atomic (temp file, fsync, ``os.replace``, directory fsync), so a
    concurrent reader sees either the old or the new file, never a torn one.
    One ``.bak`` of the previous good file is kept. A file that fails to parse
    is preserved as ``<name>.corrupt-<timestamp>``, restored from ``.bak`` when
    possible, and is never overwritten by defaults.
    """

    def __init__(self) -> None:
        self.lock = threading.RLock()
        # path -> (signature, normalized settings, degraded)
        self._cache: dict[Path, tuple[tuple[int, int, int], dict[str, Any], bool]] = {}

    @staticmethod
    def _signature(p: Path) -> tuple[int, int, int] | None:
        try:
            st = p.stat()
        except FileNotFoundError:
            return None
        return (st.st_ino, st.st_mtime_ns, st.st_size)

    @staticmethod
    def _parse(raw: bytes) -> dict[str, Any]:
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"expected a JSON object, got {type(data).__name__}")
        return data

    def read(self, p: Path) -> tuple[dict[str, Any], bool]:
        """Return ``(settings, degraded)``.

        ``degraded`` means the file is corrupt and unrecoverable: the returned
        settings are stand-in defaults and must never be persisted.
        """
        with self.lock:
            sig = self._signature(p)
            cached = self._cache.get(p)
            if cached is not None and sig is not None and cached[0] == sig:
                return copy.deepcopy(cached[1]), cached[2]
            try:
                return self._read_uncached(p, sig)
            except OSError as exc:
                if cached is not None:
                    logger.error(
                        "Cannot read %s (%s); serving last known settings",
                        p,
                        exc,
                    )
                    return copy.deepcopy(cached[1]), cached[2]
                raise SettingsUnavailableError(
                    f"Cannot read settings file {p}: {exc}"
                ) from exc

    def _read_uncached(
        self, p: Path, sig: tuple[int, int, int] | None
    ) -> tuple[dict[str, Any], bool]:
        bak = _backup_path(p)
        if sig is None:
            restored = self._load_backup(bak)
            if restored is None:
                return _factory_defaults(setup_completed=False), False
            logger.error("%s is missing; restoring it from %s", p, bak)
            self._atomic_write(p, bak.read_bytes(), keep_backup=False)
            return self._remember(p, restored, False)
        raw = p.read_bytes()
        try:
            data = self._parse(raw)
        except (ValueError, UnicodeDecodeError) as exc:
            return self._recover(p, raw, exc)
        return self._remember(p, _normalize(data), False)

    def _remember(
        self, p: Path, settings: dict[str, Any], degraded: bool
    ) -> tuple[dict[str, Any], bool]:
        sig = self._signature(p)
        if sig is not None:
            self._cache[p] = (sig, settings, degraded)
        return copy.deepcopy(settings), degraded

    def _load_backup(self, bak: Path) -> dict[str, Any] | None:
        try:
            return _normalize(self._parse(bak.read_bytes()))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            logger.error("Settings backup %s is unusable: %s", bak, exc)
            return None

    def _recover(
        self, p: Path, raw: bytes, exc: Exception
    ) -> tuple[dict[str, Any], bool]:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f")
        corrupt = p.with_name(f"{p.name}.corrupt-{stamp}")
        bak = _backup_path(p)
        restored = self._load_backup(bak)
        if restored is not None:
            os.replace(p, corrupt)
            logger.error(
                "Settings file %s is corrupt (%s). Preserved as %s and restored "
                "from backup %s",
                p,
                exc,
                corrupt,
                bak,
            )
            self._atomic_write(p, bak.read_bytes(), keep_backup=False)
            return self._remember(p, restored, False)
        # Leave the corrupt file in place (so a save is refused) but keep a copy.
        corrupt.write_bytes(raw)
        logger.error(
            "Settings file %s is corrupt (%s) and no usable backup exists. A copy "
            "was preserved as %s. Running on defaults; saving is disabled until "
            "the file is fixed or removed.",
            p,
            exc,
            corrupt,
        )
        # An install that has a settings file has finished setup; do not drop
        # the user into the wizard because the file is unreadable.
        return self._remember(p, _factory_defaults(setup_completed=True), True)

    def write(
        self, p: Path, settings: dict[str, Any], *, keep_backup: bool = True
    ) -> None:
        with self.lock:
            payload = json.dumps(settings, indent=2).encode("utf-8")
            self._atomic_write(p, payload, keep_backup=keep_backup)
            self._remember(p, _normalize(settings), False)

    def clean_backup(
        self, p: Path, clean: Callable[[dict[str, Any]], dict[str, Any]]
    ) -> bool:
        """Rewrite the ``.bak`` of ``p`` through ``clean`` if that changes it.

        A backup that does not parse is left alone: it is never restored.
        """
        bak = _backup_path(p)
        with self.lock:
            try:
                data = self._parse(bak.read_bytes())
            except FileNotFoundError:
                return False
            except (OSError, ValueError) as exc:
                logger.warning("Not cleaning settings backup %s: %s", bak, exc)
                return False
            cleaned = clean(data)
            if cleaned == data:
                return False
            payload = json.dumps(cleaned, indent=2).encode("utf-8")
            self._atomic_write(bak, payload, keep_backup=False)
            return True

    def purge_copies(self, p: Path) -> None:
        """Delete the ``.bak`` and every ``.corrupt-*`` copy of ``p``."""
        with self.lock:
            for extra in [_backup_path(p), *p.parent.glob(f"{p.name}.corrupt-*")]:
                try:
                    extra.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not delete %s", extra, exc_info=True)

    def _atomic_write(self, p: Path, payload: bytes, *, keep_backup: bool) -> None:
        p.parent.mkdir(parents=True, exist_ok=True)
        if keep_backup:
            self._rotate_backup(p)
        fd, tmp_name = tempfile.mkstemp(
            dir=p.parent, prefix=f".{p.name}.", suffix=".tmp"
        )
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as fh:
                os.fchmod(fh.fileno(), 0o600)
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, p)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        _fsync_dir(p.parent)

    def _rotate_backup(self, p: Path) -> None:
        """Copy the current file to ``.bak`` if (and only if) it parses."""
        try:
            raw = p.read_bytes()
            self._parse(raw)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            logger.warning("Not backing up %s: %s", p, exc)
            return
        self._atomic_write(_backup_path(p), raw, keep_backup=False)


def _backup_path(p: Path) -> Path:
    return p.with_name(p.name + ".bak")


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


_store = _Store()
# Held across load-modify-write cycles in save(); re-entrant with the store lock.
_lock = _store.lock


def load() -> dict[str, Any]:
    """Return the current settings.

    Never returns factory defaults because of a read or parse error: a corrupt
    file is restored from its backup, an unreadable one raises
    ``SettingsUnavailableError`` (or serves the last known good value).
    """
    settings, _degraded = _store.read(_path())
    return settings


def save(updates: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        current, degraded = _store.read(_path())
        if degraded:
            raise SettingsCorruptError(
                f"{_path()} is corrupt and could not be restored from "
                f"{_backup_path(_path()).name}; refusing to overwrite it with "
                "defaults. Restore the file from a backup (a copy of the corrupt "
                "file was saved next to it as app_settings.json.corrupt-*), or "
                "delete it to start over."
            )
        if "ui" in updates and isinstance(updates["ui"], dict):
            current_ui = current.get("ui")
            existing_ui = current_ui if isinstance(current_ui, dict) else {}
            current["ui"] = {**existing_ui, **updates["ui"]}
            updates = {k: v for k, v in updates.items() if k != "ui"}
        if "ai" in updates and isinstance(updates["ai"], dict):
            current["ai"] = _merge_ai({**current.get("ai", {}), **updates["ai"]})
            updates = {k: v for k, v in updates.items() if k != "ai"}
        current.update(updates)
        _write(current)
        return current


def edit(change: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
    """Read, change and save under the settings lock.

    ``change`` gets the current settings and returns the updates to save, so two
    callers editing the same list (the notification targets) cannot overwrite each
    other.
    """
    with _lock:
        return save(change(load()))


def _sanitize_settings_css(data: dict[str, Any]) -> dict[str, Any]:
    ui = data.get("ui")
    if not isinstance(ui, dict):
        return data
    return {**data, "ui": sanitize_ui_css(ui)}


def sanitize_stored_ui() -> bool:
    """Strip network-fetching custom CSS from the stored ``ui`` blob.

    Saves through the API are sanitized, but a blob written before the sanitizer
    existed (and adopted as the first administrator's preferences and the members'
    default) was not. Runs at startup; rewrites the file only when something
    changed. Returns whether it did.

    The ``.bak`` is cleaned as well, since a missing or corrupt file is restored
    from it, and the rewrite does not rotate the backup: rotating would copy the
    CSS being removed into the ``.bak``.
    """
    with _lock:
        if _store.clean_backup(_path(), _sanitize_settings_css):
            logger.warning(
                "Removed @import rules and remote url() references from the "
                "custom CSS stored in %s",
                _backup_path(_path()).name,
            )
        current, degraded = _store.read(_path())
        if degraded:
            return False
        cleaned = _sanitize_settings_css(current)
        if cleaned == current:
            return False
        _store.write(_path(), cleaned, keep_backup=False)
    logger.warning(
        "Removed @import rules and remote url() references from the custom CSS "
        "stored in %s",
        _path().name,
    )
    return True


def reset_to_defaults() -> dict[str, Any]:
    """Replace the settings file with factory defaults (no ui/ai merge).

    This is the one deliberate way out of a corrupt, unrecoverable file. No
    backup is kept and the ``.bak`` / ``.corrupt-*`` copies are deleted, since
    they would still contain secrets such as the OpenRouter key.
    """
    with _lock:
        out = _factory_defaults(setup_completed=False)
        _store.write(_path(), out, keep_backup=False)
        _store.purge_copies(_path())
        return out


def is_degraded() -> bool:
    """True when the settings file is corrupt and no backup could restore it."""
    try:
        return _store.read(_path())[1]
    except SettingsError:
        return True


def _write(data: dict[str, Any]) -> None:
    _store.write(_path(), data)


def ai_settings() -> dict[str, Any]:
    return _merge_ai(load().get("ai"))
