"""
test_accuracy_metrics.py — Unit tests for accuracy_metrics module.

Run with:  pytest backend/test_accuracy_metrics.py -v

All tests use in-memory DataFrames — no network calls.

Sign convention under test:
    Forecast Error = Forecast − Actual
    Positive → over-forecast (actual < forecast).
    Negative → under-forecast (actual > forecast).
"""
import math
import pandas as pd
import pytest

from accuracy_metrics import (
    compute_mae,
    compute_rmse,
    compute_bias,
    compute_max_shortfall,
    compute_coverage,
    compute_percentiles,
    compute_all_metrics,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _errors(*values):
    """Create a Series from the given error values."""
    return pd.Series(values, dtype=float)


def _paired(forecast_vals, actual_vals):
    """Build a paired DataFrame for compute_all_metrics."""
    return pd.DataFrame({"forecast": forecast_vals, "actual": actual_vals})


# ── MAE ───────────────────────────────────────────────────────────────────────

def test_mae_symmetric_errors():
    """Two equal-magnitude errors in opposite directions → MAE = magnitude."""
    errors = _errors(100.0, -100.0)
    assert compute_mae(errors) == pytest.approx(100.0)


def test_mae_all_zero():
    """Perfect forecast → MAE = 0."""
    assert compute_mae(_errors(0, 0, 0)) == pytest.approx(0.0)


def test_mae_single_value():
    errors = _errors(250.0)
    assert compute_mae(errors) == pytest.approx(250.0)


def test_mae_with_nan_ignored():
    """NaN values must be excluded from MAE calculation."""
    errors = _errors(100.0, float("nan"), 200.0)
    # mean of |100| and |200| = 150
    assert compute_mae(errors) == pytest.approx(150.0)


def test_mae_all_nan_returns_none():
    errors = pd.Series([float("nan"), float("nan")])
    assert compute_mae(errors) is None


def test_mae_empty_returns_none():
    assert compute_mae(pd.Series([], dtype=float)) is None


# ── RMSE ──────────────────────────────────────────────────────────────────────

def test_rmse_known_values():
    """RMSE of [3, 4] = sqrt((9+16)/2) = sqrt(12.5) ≈ 3.536."""
    errors = _errors(3.0, 4.0)
    assert compute_rmse(errors) == pytest.approx(math.sqrt(12.5), rel=1e-6)


def test_rmse_greater_than_or_equal_mae_for_mixed_errors():
    """RMSE >= MAE by the Cauchy-Schwarz inequality."""
    errors = _errors(10.0, -50.0, 30.0, -5.0)
    assert compute_rmse(errors) >= compute_mae(errors)


def test_rmse_all_zero():
    assert compute_rmse(_errors(0, 0, 0)) == pytest.approx(0.0)


def test_rmse_empty_returns_none():
    assert compute_rmse(pd.Series([], dtype=float)) is None


# ── Bias ──────────────────────────────────────────────────────────────────────

def test_bias_positive_means_over_forecast():
    """Positive errors → positive bias (wind over-forecast)."""
    assert compute_bias(_errors(100.0, 200.0)) == pytest.approx(150.0)


def test_bias_negative_means_under_forecast():
    """Negative errors → negative bias (wind under-forecast)."""
    assert compute_bias(_errors(-100.0, -200.0)) == pytest.approx(-150.0)


def test_bias_unbiased():
    """Errors that cancel perfectly → bias = 0."""
    assert compute_bias(_errors(100.0, -100.0)) == pytest.approx(0.0)


def test_bias_empty_returns_none():
    assert compute_bias(pd.Series([], dtype=float)) is None


# ── Max shortfall ─────────────────────────────────────────────────────────────

def test_max_shortfall_with_mixed_errors():
    """Only positive errors (over-forecasts) contribute to shortfall."""
    # Forecast − Actual = [300, -200, 150, -50]
    # Shortfalls (clamped at 0) = [300, 0, 150, 0] → max = 300
    errors = _errors(300.0, -200.0, 150.0, -50.0)
    assert compute_max_shortfall(errors) == pytest.approx(300.0)


def test_max_shortfall_all_negative_errors_returns_zero():
    """If actual always exceeded forecast, shortfall = 0."""
    errors = _errors(-10.0, -50.0, -100.0)
    assert compute_max_shortfall(errors) == pytest.approx(0.0)


def test_max_shortfall_empty_returns_none():
    assert compute_max_shortfall(pd.Series([], dtype=float)) is None


def test_max_shortfall_not_equal_to_mae():
    """Explicitly confirm max shortfall is NOT the mean absolute error."""
    errors = _errors(100.0, 50.0, -300.0)
    mae = compute_mae(errors)
    ms  = compute_max_shortfall(errors)
    # MAE ≠ max shortfall in general
    assert mae != pytest.approx(ms)


# ── Coverage ──────────────────────────────────────────────────────────────────

def test_coverage_full():
    assert compute_coverage(48, 48) == pytest.approx(100.0)


def test_coverage_partial():
    assert compute_coverage(36, 48) == pytest.approx(75.0)


def test_coverage_zero_valid():
    assert compute_coverage(0, 48) == pytest.approx(0.0)


def test_coverage_zero_total_returns_none():
    assert compute_coverage(0, 0) is None


# ── Percentiles ───────────────────────────────────────────────────────────────

def test_percentiles_all_same():
    errors = _errors(100.0, 100.0, 100.0)
    p = compute_percentiles(errors)
    for key, val in p.items():
        assert val == pytest.approx(100.0), f"{key} should be 100"


def test_percentiles_empty_returns_none_values():
    p = compute_percentiles(pd.Series([], dtype=float))
    assert all(v is None for v in p.values())


# ── compute_all_metrics ───────────────────────────────────────────────────────

def test_all_metrics_correct_values():
    """End-to-end smoke test with known inputs."""
    df = _paired(
        forecast_vals=[5100.0, 4800.0, 5000.0],
        actual_vals=  [5000.0, 5000.0, 5000.0],
    )
    # Errors: [100, -200, 0]
    m = compute_all_metrics(df)
    assert m["mae"]          == pytest.approx(100.0, abs=1)   # mean(100,200,0)/3 ≈ 100
    assert m["bias"]         == pytest.approx(-33.3, abs=1)   # mean(100,-200,0)/3
    assert m["maxShortfall"] == pytest.approx(100.0)
    assert m["nValid"]       == 3


def test_all_metrics_empty_df():
    """Empty DataFrame → all metric values are None, nValid = 0."""
    m = compute_all_metrics(pd.DataFrame({"forecast": [], "actual": []}))
    assert m["mae"]      is None
    assert m["rmse"]     is None
    assert m["bias"]     is None
    assert m["nValid"]   == 0


def test_all_metrics_missing_values_excluded():
    """NaN rows must not count toward nValid or distort calculations."""
    df = _paired(
        forecast_vals=[5000.0, float("nan"), 4800.0],
        actual_vals=  [5000.0, 5000.0,       5000.0],
    )
    # Only rows 0 and 2 are valid: errors = [0, -200]
    m = compute_all_metrics(df)
    assert m["nValid"] == 2
    assert m["mae"]    == pytest.approx(100.0)  # mean(0, 200) = 100
    assert m["bias"]   == pytest.approx(-100.0) # mean(0, -200) = -100


def test_missing_forecast_not_zero():
    """NaN forecast must not be treated as zero generation."""
    df = _paired(
        forecast_vals=[float("nan")],
        actual_vals=  [5000.0],
    )
    m = compute_all_metrics(df)
    # nValid = 0 → no metrics computable
    assert m["nValid"] == 0
    assert m["mae"]    is None
