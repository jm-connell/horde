"""How one user wants Recommended+ ranked: the values behind its sliders.

Every value here maps onto something ``feed.build_feed`` already does, so the
"Balanced" preset (``DEFAULTS``) ranks almost exactly as the feed did before it
could be tuned; only the small rewatch share is new. The user-facing numbers
(0..100 sliders, day counts) are kept as the user set them and turned into
engine values by the properties below, which is the one place their meaning is
defined. Stored per user in ``user_settings.rec_tuning_json`` (``load`` and
``save``); see ``docs/adr/0024-tunable-recommended-plus.md``.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlmodel import Session

from ...models import UserSettings, utcnow

if TYPE_CHECKING:
    from .interests import TasteWindow

logger = logging.getLogger(__name__)

BUCKETS = ("subscriptions", "similar", "new", "throwback", "rewatch")
Bucket = Literal["subscriptions", "similar", "new", "throwback", "rewatch"]
#: The buckets that have a relevance floor (``FLOORS`` in ``feed``).
FLOORED = ("similar", "new", "throwback")


class Shares(BaseModel):
    """How much of the feed each kind of pick gets (any scale; normalized)."""

    model_config = ConfigDict(extra="forbid")

    subscriptions: int = Field(default=29, ge=0, le=100)
    similar: int = Field(default=29, ge=0, le=100)
    new: int = Field(default=24, ge=0, le=100)
    throwback: int = Field(default=14, ge=0, le=100)
    rewatch: int = Field(default=4, ge=0, le=100)

    def normalized(self) -> dict[str, float]:
        raw = self.model_dump()
        total = sum(raw.values())
        if total <= 0:
            # Everything at zero: fall back to an even mix rather than nothing.
            return dict.fromkeys(BUCKETS, 1.0 / len(BUCKETS))
        return {k: v / total for k, v in raw.items()}


class Strictness(BaseModel):
    """How close a pick must be to the user's taste, per bucket (50 = default)."""

    model_config = ConfigDict(extra="forbid")

    similar: int = Field(default=50, ge=0, le=100)
    new: int = Field(default=50, ge=0, le=100)
    throwback: int = Field(default=50, ge=0, le=100)

    def multiplier(self, bucket: str) -> float:
        """0 -> 0.7x the default floor, 50 -> 1x, 100 -> 1.3x."""
        value: int = getattr(self, bucket)
        return 0.7 + 0.6 * value / 100


class Tuning(BaseModel):
    """One complete set of Recommended+ settings (what a preset or a save holds)."""

    model_config = ConfigDict(extra="forbid")

    shares: Shares = Field(default_factory=lambda: Shares())
    strictness: Strictness = Field(default_factory=lambda: Strictness())
    #: 0 any age .. 50 default .. 100 strongly prefer recent uploads.
    freshness: int = Field(default=50, ge=0, le=100)
    #: -100 hidden gems .. 0 default .. 100 popular.
    popularity: int = Field(default=0, ge=-100, le=100)
    #: The same channel at most once in this many picks.
    channel_gap: int = Field(default=5, ge=1, le=12)
    #: At most this many videos of one channel new to the user.
    new_channel_cap: int = Field(default=2, ge=1, le=6)
    #: 0 fixed order .. 50 default .. 100 twice the default shuffle.
    shuffle: int = Field(default=50, ge=0, le=100)
    #: A video shown on this many visits without being watched drops to the
    #: end of the feed; 0 = never.
    worn_after: Literal[0, 3, 6, 12] = 6
    #: What counts as recent taste, in days.
    recent_days: Literal[14, 30, 60, 90] = 30
    #: How far back throwbacks reach, in years (0 = all of the history).
    throwback_years: Literal[0, 1, 3] = 3
    #: Watches that got less far than this (percent) do not count as taste.
    min_watched_pct: int = Field(default=0, ge=0, le=90)
    #: A video finished at least this many days ago may come back as a rewatch.
    rewatch_after_days: Literal[30, 60, 180, 365] = 60
    hide_shorts: bool = False
    hide_past_live: bool = False
    #: Length limits in minutes (0 = no limit).
    min_minutes: int = Field(default=0, ge=0, le=600)
    max_minutes: int = Field(default=0, ge=0, le=600)
    #: Only uploads from the last this many days (0 = any age).
    max_age_days: Literal[0, 7, 30, 90, 365, 1095] = 0
    #: 0 no preference .. 100 strongly prefer videos already downloaded.
    library_boost: int = Field(default=0, ge=0, le=100)
    use_library: bool = True
    use_catalogs: bool = True
    use_youtube: bool = True
    #: Lift library videos people here with similar taste liked (only when the
    #: administrator allows household recommendations at all).
    use_household: bool = True

    @model_validator(mode="after")
    def _max_after_min(self) -> Tuning:
        if self.max_minutes and self.max_minutes < self.min_minutes:
            raise ValueError("The longest length is shorter than the shortest")
        return self

    # --- engine values -----------------------------------------------------

    def floor_multiplier(self, bucket: str) -> float:
        return self.strictness.multiplier(bucket) if bucket in FLOORED else 1.0

    @property
    def half_life_scale(self) -> float:
        """Freshness half-lives are multiplied by this: 4x at 0, 1x at 50,
        0.25x at 100 (a shorter half-life favors new uploads)."""
        return float(2.0 ** ((50 - self.freshness) / 25))

    @property
    def subscription_window_days(self) -> float:
        return min(60.0, max(7.0, 21.0 * self.half_life_scale))

    @property
    def popularity_delta(self) -> float:
        """Added to each bucket's popularity weight (it can go negative)."""
        return 0.15 * self.popularity / 100

    @property
    def jitter_scale(self) -> float:
        return self.shuffle / 50

    @property
    def throwback_max_days(self) -> int:
        return 50 * 365 if self.throwback_years == 0 else 365 * self.throwback_years

    @property
    def window(self) -> TasteWindow:
        # Imported here: request schemas import this module, and ``interests``
        # pulls in the AI services.
        from .interests import TasteWindow

        return TasteWindow(self.recent_days, self.throwback_max_days)

    @property
    def library_bonus(self) -> float:
        return 0.15 * self.library_boost / 100


DEFAULTS = Tuning()


class Preset(BaseModel):
    id: str
    name: str
    description: str
    tuning: Tuning


def _preset(id: str, name: str, description: str, **changes: object) -> Preset:
    return Preset(
        id=id,
        name=name,
        description=description,
        tuning=Tuning.model_validate({**DEFAULTS.model_dump(), **changes}),
    )


PRESETS: list[Preset] = [
    _preset(
        "balanced",
        "Balanced",
        "A bit of everything: new uploads, more of what you watch, some new "
        "channels and the odd throwback.",
    ),
    _preset(
        "catch_up",
        "Catch up",
        "Mostly new uploads from the channels you follow and watch.",
        shares={
            "subscriptions": 60,
            "similar": 25,
            "new": 8,
            "throwback": 4,
            "rewatch": 3,
        },
        freshness=75,
    ),
    _preset(
        "familiar",
        "Familiar",
        "Channels you already know, close to what you watch.",
        shares={
            "subscriptions": 35,
            "similar": 45,
            "new": 8,
            "throwback": 7,
            "rewatch": 5,
        },
        strictness={"similar": 60, "new": 75, "throwback": 60},
        shuffle=30,
    ),
    _preset(
        "explorer",
        "Explorer",
        "Lots of channels you have never watched, matched more loosely.",
        shares={
            "subscriptions": 15,
            "similar": 20,
            "new": 50,
            "throwback": 12,
            "rewatch": 3,
        },
        strictness={"similar": 40, "new": 30, "throwback": 45},
        new_channel_cap=3,
        shuffle=80,
        popularity=-30,
    ),
    _preset(
        "nostalgia",
        "Nostalgia",
        "Interests you have not touched in a while, and old favorites.",
        shares={
            "subscriptions": 15,
            "similar": 15,
            "new": 10,
            "throwback": 40,
            "rewatch": 20,
        },
        throwback_years=0,
        freshness=30,
    ),
]
PRESET_IDS = frozenset(p.id for p in PRESETS)


class Selection(BaseModel):
    """What a user has picked: a preset, or their own values (``custom``)."""

    model_config = ConfigDict(extra="ignore")

    #: A preset id, or "custom".
    active: str = "balanced"
    #: The user's own values (kept when they switch to a preset and back).
    custom: Tuning | None = None


def resolve(selection: Selection) -> Tuning:
    """The values a selection ranks with."""
    if selection.active == "custom" and selection.custom is not None:
        return selection.custom
    for preset in PRESETS:
        if preset.id == selection.active:
            return preset.tuning
    return DEFAULTS


def load(session: Session, user_id: int) -> Selection:
    """The user's saved selection (Balanced when nothing, or nothing valid, is saved)."""
    row = session.get(UserSettings, user_id)
    if row is None or not row.rec_tuning_json:
        return Selection()
    try:
        selection = Selection.model_validate(json.loads(row.rec_tuning_json))
    except json.JSONDecodeError, ValidationError:
        # Saved by an older version with values this one rejects: start over
        # rather than fail every feed request.
        logger.warning(
            "Unreadable Recommended+ settings for user %s; using Balanced",
            user_id,
            exc_info=True,
        )
        return Selection()
    if selection.active != "custom" and selection.active not in PRESET_IDS:
        selection.active = "balanced"
    return selection


def save(session: Session, user_id: int, selection: Selection) -> Selection:
    row = session.get(UserSettings, user_id)
    if row is None:
        row = UserSettings(user_id=user_id)
    row.rec_tuning_json = selection.model_dump_json()
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    return selection


def for_user(session: Session, user_id: int) -> Tuning:
    return resolve(load(session, user_id))
