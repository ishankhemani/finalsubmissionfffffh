"""Tests for the day-ahead decision-time selector."""
import pandas as pd
import pytest

from forecast_selector import select_forecast_at_decision_time, parse_decision_time


def _actual(*slots):
    return pd.DataFrame({"time": pd.to_datetime(list(slots), utc=True), "actual": 1000.0})


def _fc(rows):
    return pd.DataFrame(rows, columns=["time", "publishTime", "forecast"])


def test_parse_decision_time_ok():
    assert parse_decision_time("09:30") == (9, 30)


@pytest.mark.parametrize("bad", ["9", "25:00", "09:61", "abc", "", None])
def test_parse_decision_time_invalid(bad):
    with pytest.raises(ValueError):
        parse_decision_time(bad)


def test_same_cutoff_for_every_slot_of_delivery_day():
    # Decision 09:00 on D-1 (2026-01-09) for delivery day 2026-01-10.
    # Forecast A published 08:00 on D-1 (eligible), B at 10:00 on D-1 (too late).
    slots = ["2026-01-10T00:00Z", "2026-01-10T23:30Z"]
    rows = []
    for t in slots:
        rows.append([t, "2026-01-09T08:00Z", 100.0])
        rows.append([t, "2026-01-09T10:00Z", 999.0])
    out = select_forecast_at_decision_time(_actual(*slots), _fc(rows), "09:00")
    assert out["forecast"].tolist() == [100.0, 100.0]


def test_late_evening_slot_cannot_use_forecast_published_after_decision():
    # A fixed 24h horizon would let the 23:30 slot use a forecast from 23:00 D-1.
    # The decision-time model must NOT.
    slot = "2026-01-10T23:30Z"
    out = select_forecast_at_decision_time(
        _actual(slot), _fc([[slot, "2026-01-09T23:00Z", 555.0]]), "09:00")
    assert out.empty


def test_most_recent_eligible_forecast_wins():
    slot = "2026-01-10T12:00Z"
    rows = [[slot, "2026-01-08T12:00Z", 1.0],
            [slot, "2026-01-09T06:00Z", 2.0],
            [slot, "2026-01-09T09:00Z", 3.0],   # exactly at cutoff -> eligible
            [slot, "2026-01-09T09:30Z", 4.0]]
    out = select_forecast_at_decision_time(_actual(slot), _fc(rows), "09:00")
    assert out["forecast"].iloc[0] == 3.0


def test_uk_local_time_used_in_summer():
    # In BST (UTC+1) 09:00 local == 08:00 UTC.
    slot = "2026-07-10T12:00Z"
    rows = [[slot, "2026-07-09T07:30Z", 1.0],   # before 08:00Z -> eligible
            [slot, "2026-07-09T08:30Z", 2.0]]   # after 08:00Z -> not eligible
    out = select_forecast_at_decision_time(_actual(slot), _fc(rows), "09:00")
    assert out["forecast"].iloc[0] == 1.0


def test_empty_inputs():
    assert select_forecast_at_decision_time(
        pd.DataFrame(columns=["time", "actual"]), _fc([]), "09:00").empty
