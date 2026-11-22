"""The explorer's windows: one function, one anchor, exact boundaries."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from pipeline.api import windows

ANCHOR = date(2026, 8, 19)  # the newest award on record
TODAY = date(2026, 11, 21)  # 94 days later: the calendar's last 90 days hold nothing


@pytest.mark.parametrize(
    ("key", "days", "start", "label"),
    [
        ("30d", 30, date(2026, 7, 21), "30 days to Aug 19"),
        ("90d", 90, date(2026, 5, 22), "90 days to Aug 19"),
        ("1y", 365, date(2025, 8, 20), "1 year to Aug 19"),
        ("all", None, None, "Everything on record, to Aug 19"),
    ],
)
def test_every_window_ends_on_the_newest_award(key, days, start, label):
    w = windows.resolve(key, ANCHOR, today=TODAY)
    assert (w.key, w.days, w.start, w.end) == (key, days, start, ANCHOR)
    assert w.latest_data_date == ANCHOR
    assert w.label == label


@pytest.mark.parametrize("key", ["30d", "90d", "1y"])
def test_a_window_is_exactly_n_days_with_both_ends_included(key):
    w = windows.resolve(key, ANCHOR)
    assert (w.end - w.start).days == w.days - 1
    assert w.contains(w.start)  # the first day
    assert w.contains(w.end)  # the last day, the newest award itself
    assert not w.contains(w.start - timedelta(days=1))  # one day too old
    assert not w.contains(w.end + timedelta(days=1))  # dated after the record ends
    assert not w.contains(None)


def test_the_90_day_window_holds_august_when_today_is_november():
    """The bug: 90 days back from Nov 21 is Aug 23, after the last award (Aug 19)."""
    w = windows.resolve("90d", ANCHOR, today=TODAY)
    assert TODAY - timedelta(days=90) > ANCHOR  # why a calendar window was empty
    assert w.contains(date(2026, 8, 19))
    assert w.contains(date(2026, 8, 1))
    assert w.contains(date(2026, 5, 22))
    assert not w.contains(date(2026, 5, 21))


def test_everything_on_record_has_no_first_day():
    w = windows.resolve("all", ANCHOR)
    assert w.contains(date(1999, 1, 1))
    assert w.contains(ANCHOR)
    assert not w.contains(ANCHOR + timedelta(days=1))


def test_recent_is_the_90_day_window_under_its_old_name():
    assert windows.canonical("recent") == "90d"
    assert windows.canonical(" Recent ") == "90d"
    assert windows.resolve("recent", ANCHOR) == windows.resolve("90d", ANCHOR)


def test_unknown_keys_are_refused():
    assert windows.canonical("7d") is None
    assert windows.canonical(None) is None
    with pytest.raises(KeyError):
        windows.resolve("7d", ANCHOR)


def test_the_label_names_the_year_when_it_is_not_this_year():
    w = windows.resolve("90d", date(2025, 12, 30), today=date(2026, 1, 4))
    assert w.label == "90 days to Dec 30, 2025"
    # A window that starts in one year and ends in the next is still N days.
    w = windows.resolve("30d", date(2026, 1, 10))
    assert w.start == date(2025, 12, 12)


def test_a_leap_day_is_counted_like_any_other():
    w = windows.resolve("30d", date(2028, 3, 1))
    assert w.start == date(2028, 2, 1)  # 29 days of February and one of March
    assert w.contains(date(2028, 2, 29))


def test_no_awards_at_all():
    w = windows.resolve("90d", None)
    assert (w.start, w.end, w.latest_data_date) == (None, None, None)
    assert not w.contains(ANCHOR)
    assert windows.count_by_window({}, None) == {"30d": 0, "90d": 0, "1y": 0, "all": 0}
    assert windows.default_key(windows.count_by_window({}, None)) == "all"


def test_counts_use_the_same_boundaries():
    per_day = {
        date(2026, 8, 19): 2,  # in every window
        date(2026, 7, 21): 1,  # the 30-day window's first day
        date(2026, 7, 20): 1,  # one day outside it
        date(2026, 5, 22): 1,  # the 90-day window's first day
        date(2026, 5, 21): 1,  # one day outside it
        date(2025, 8, 20): 1,  # the year's first day
        date(2025, 8, 19): 1,  # one day outside it
    }
    assert windows.count_by_window(per_day, ANCHOR) == {"30d": 3, "90d": 5, "1y": 7, "all": 8}


def test_the_default_is_the_first_window_with_an_award():
    # Recent (the 90 days to the newest award) comes first, and it has data.
    assert windows.default_key({"30d": 3, "90d": 5, "1y": 7, "all": 8}) == "90d"
    # Were it empty, the order goes on: 30d, 90d, 1y, all.
    assert windows.default_key({"30d": 2, "90d": 0, "1y": 7, "all": 8}) == "30d"
    assert windows.default_key({"30d": 0, "90d": 0, "1y": 7, "all": 8}) == "1y"
    assert windows.default_key({"30d": 0, "90d": 0, "1y": 0, "all": 8}) == "all"
    assert windows.default_key({}) == "all"
