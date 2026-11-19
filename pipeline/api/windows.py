"""The explorer's time windows: one function, one anchor.

Every window ends on the same day, the anchor: the day of the newest award on
record (`latest_data_date`). It is not today, on purpose. USAspending publishes
DoD contracts about 90 days after they are signed, so a window that ends today
holds nothing: "the last 90 days" counted back from the calendar starts after
the newest award. Counted back from the record, "90 days" is the newest 90
days there is data for, and the label says so ("90 days to Aug 19").

A window of N days is exactly N calendar days, both ends included: its first
day is the anchor minus N - 1. Days are plain dates (no time, no zone), so
there is no boundary to lose an award across.

`resolve` is the only place a window's dates are computed. The API uses it for
the window it serves and for the counts of every other window, and the site
only prints what it is given.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import date, timedelta

# The windows a reader can pick, shortest first. None means everything on record.
SPANS: dict[str, int | None] = {"30d": 30, "90d": 90, "1y": 365, "all": None}
KEYS: tuple[str, ...] = tuple(SPANS)

# "recent" was the one window that ended on the newest award (the 90 days up to
# it) while the others ended today. Now that all of them do, it is the same
# window as 90d; the name is kept so old links keep working.
ALIASES: dict[str, str] = {"recent": "90d"}

# The window a visit opens on: the first of these with at least one award.
DEFAULT_ORDER: tuple[str, ...] = ("recent", "30d", "90d", "1y", "all")

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@dataclass(frozen=True)
class Window:
    key: str
    days: int | None  # None: everything on record
    start: date | None  # None: no first day (everything on record, or no data)
    end: date | None  # the anchor; None only when there are no awards at all
    latest_data_date: date | None
    label: str

    def contains(self, day: date | None) -> bool:
        """Whether an award dated `day` falls in the window, ends included."""
        if day is None or self.end is None or day > self.end:
            return False
        return self.start is None or day >= self.start

    def as_dict(self) -> dict:
        return asdict(self)


def canonical(key: str | None) -> str | None:
    """The window a key names ("recent" is 90d), or None for an unknown key."""
    if key is None:
        return None
    key = ALIASES.get(key.strip().lower(), key.strip().lower())
    return key if key in SPANS else None


def _short(day: date, today: date | None) -> str:
    """ "Aug 19", with the year when it is not this year's."""
    text = f"{_MONTHS[day.month - 1]} {day.day}"
    return text if today is None or day.year == today.year else f"{text}, {day.year}"


def resolve(key: str, anchor: date | None, *, today: date | None = None) -> Window:
    """The window `key` names, ending on `anchor` (the newest award's day).

    `today` only decides whether the label spells out the year. Raises KeyError
    for a key that is not a window."""
    name = canonical(key)
    if name is None:
        raise KeyError(key)
    days = SPANS[name]
    if anchor is None:
        return Window(name, days, None, None, None, "No awards on record")
    to = _short(anchor, today)
    if days is None:
        return Window(name, None, None, anchor, anchor, f"Everything on record, to {to}")
    span = "1 year" if days == 365 else f"{days} days"
    start = anchor - timedelta(days=days - 1)
    return Window(name, days, start, anchor, anchor, f"{span} to {to}")


def count_by_window(days: Mapping[date, int], anchor: date | None) -> dict[str, int]:
    """Awards in each window, from a count of awards per day."""
    out = {}
    for key in KEYS:
        w = resolve(key, anchor)
        out[key] = sum(n for day, n in days.items() if w.contains(day))
    return out


def default_key(counts: Mapping[str, int]) -> str:
    """The window a visit opens on: the first in DEFAULT_ORDER that holds an
    award. With nothing on record at all it is "all", whose empty state says so."""
    for key in DEFAULT_ORDER:
        name = canonical(key)
        if name and counts.get(name, 0) > 0:
            return name
    return "all"
