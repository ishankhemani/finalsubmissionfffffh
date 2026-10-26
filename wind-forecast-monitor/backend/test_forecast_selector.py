"""
Unit tests for forecast_selector.select_forecast().

Run with:  pytest backend/test_forecast_selector.py -v
           (from the repo root, or cd backend && pytest -v)

These tests cover the core horizon-filtering algorithm without making any
real network calls — all DataFrames are constructed in-memory.
"""
import pandas as pd
import pytest

from forecast_selector import select_forecast

# ── Helpers ───────────────────────────────────────────────────────────────────

TARGET = "2026-01-01T08:00:00+00:00"  # representative target time slot


def _actual(times=None):
    """Build a minimal actual DataFrame with one or more time slots."""
    times = times or [TARGET]
    return pd.DataFrame({"time": times, "actual": [5000.0] * len(times)})


def _forecast(rows):
    """Build a forecast DataFrame.
    rows: list of (target_time, publish_time, generation) tuples.
    """
    return pd.DataFrame(rows, columns=["time", "publishTime", "forecast"])


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_empty_actual_returns_empty_dataframe():
    """If actual DataFrame is empty, result must be empty — no crash."""
    result = select_forecast(
        pd.DataFrame(columns=["time", "actual"]),
        _forecast([(TARGET, "2026-01-01T01:00:00+00:00", 5000.0)]),
        horizon=4,
    )
    assert result.empty


def test_empty_forecast_returns_empty_dataframe():
    """If forecast DataFrame is empty, result must be empty — no crash."""
    result = select_forecast(
        _actual(),
        pd.DataFrame(columns=["time", "publishTime", "forecast"]),
        horizon=4,
    )
    assert result.empty


def test_valid_forecast_is_selected():
    """
    Forecast published 6h before target slot.
    horizon=4 → cutoff = TARGET - 4h = 04:00.
    Published at 02:00 < cutoff → VALID. Should appear in result.
    """
    result = select_forecast(
        _actual(),
        _forecast([(TARGET, "2026-01-01T02:00:00+00:00", 4800.0)]),
        horizon=4,
    )
    assert len(result) == 1
    assert result.iloc[0]["forecast"] == 4800.0


def test_forecast_published_after_cutoff_is_rejected():
    """
    Forecast published only 2h before target slot.
    horizon=4 → cutoff = 04:00. Published at 06:00 > cutoff → INVALID.
    Result must be empty.
    """
    result = select_forecast(
        _actual(),
        _forecast([(TARGET, "2026-01-01T06:00:00+00:00", 4800.0)]),
        horizon=4,
    )
    assert result.empty


def test_most_recent_valid_forecast_is_selected():
    """
    Two forecasts both published before cutoff.
    Must select the one with the later publishTime (most recently updated).
    """
    result = select_forecast(
        _actual(),
        _forecast([
            (TARGET, "2026-01-01T01:00:00+00:00", 4600.0),  # older
            (TARGET, "2026-01-01T03:00:00+00:00", 4900.0),  # newer, both < cutoff 04:00
        ]),
        horizon=4,
    )
    assert len(result) == 1
    assert result.iloc[0]["forecast"] == 4900.0  # must be the more recent one


def test_horizon_zero_accepts_any_prior_forecast():
    """
    horizon=0 → cutoff = TARGET itself.
    Any forecast published at or before TARGET is valid.
    A forecast published 1h before TARGET should be included.
    """
    result = select_forecast(
        _actual(),
        _forecast([(TARGET, "2026-01-01T07:00:00+00:00", 5100.0)]),  # 1h before TARGET
        horizon=0,
    )
    assert len(result) == 1
    assert result.iloc[0]["forecast"] == 5100.0


def test_horizon_48_requires_day_ahead_forecast():
    """
    horizon=48 → cutoff = TARGET - 48h = 2025-12-30T08:00.
    A forecast published at 09:00 on Dec 30 (after cutoff) → INVALID.
    A forecast published at 07:00 on Dec 30 (before cutoff) → VALID.
    """
    cutoff_ts = pd.Timestamp(TARGET, tz="UTC") - pd.Timedelta(hours=48)
    after_cutoff = (cutoff_ts + pd.Timedelta(hours=1)).isoformat()
    before_cutoff = (cutoff_ts - pd.Timedelta(hours=1)).isoformat()

    result = select_forecast(
        _actual(),
        _forecast([
            (TARGET, after_cutoff,  4700.0),  # invalid
            (TARGET, before_cutoff, 4750.0),  # valid
        ]),
        horizon=48,
    )
    assert len(result) == 1
    assert result.iloc[0]["forecast"] == 4750.0


def test_partial_coverage_returns_only_matched_slots():
    """
    Two actual slots; only the first has a valid forecast.
    Result must contain exactly 1 row (the matched slot), not 2.
    """
    T1 = "2026-01-01T08:00:00+00:00"
    T2 = "2026-01-01T08:30:00+00:00"

    result = select_forecast(
        _actual([T1, T2]),
        _forecast([(T1, "2026-01-01T02:00:00+00:00", 5000.0)]),  # only T1
        horizon=4,
    )
    assert len(result) == 1
    matched_time = pd.Timestamp(result.iloc[0]["time"])
    assert matched_time == pd.Timestamp(T1, tz="UTC")
