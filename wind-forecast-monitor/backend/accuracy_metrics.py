"""
accuracy_metrics.py — Pure forecast accuracy calculations.

All functions are stateless and side-effect-free, making them trivially testable.

Sign convention (documented here for traceability):
    Forecast Error = Forecast − Actual

    Positive error → wind was OVER-FORECAST (actual was lower than expected).
    Negative error → wind was UNDER-FORECAST (actual was higher than expected).

    From a procurement perspective a positive error is the problematic direction:
    the buyer expected more wind than arrived and may need additional supply.
"""
import math
import numpy as np
import pandas as pd
from typing import Optional


# ── Core metrics ───────────────────────────────────────────────────────────────

def compute_mae(errors: pd.Series) -> Optional[float]:
    """Mean Absolute Error in MW.

    MAE = mean(|Forecast − Actual|)
    """
    valid = errors.dropna()
    if valid.empty:
        return None
    return float(valid.abs().mean())


def compute_rmse(errors: pd.Series) -> Optional[float]:
    """Root Mean Squared Error in MW.

    RMSE = sqrt(mean((Forecast − Actual)²))
    RMSE penalises larger errors more heavily than MAE.
    """
    valid = errors.dropna()
    if valid.empty:
        return None
    return float(math.sqrt((valid ** 2).mean()))


def compute_bias(errors: pd.Series) -> Optional[float]:
    """Mean Forecast Bias (signed mean error) in MW.

    Bias = mean(Forecast − Actual)

    Positive → systematic over-prediction of wind.
    Negative → systematic under-prediction of wind.
    """
    valid = errors.dropna()
    if valid.empty:
        return None
    return float(valid.mean())


def compute_max_shortfall(errors: pd.Series) -> Optional[float]:
    """Maximum wind generation shortfall relative to forecast, in MW.

    Shortfall(t) = max(Forecast(t) − Actual(t), 0)

    Returns the maximum shortfall over all intervals.
    A value of zero means actual generation never fell below the forecast.
    """
    valid = errors.dropna()
    if valid.empty:
        return None
    shortfalls = valid.clip(lower=0)
    return float(shortfalls.max())


def compute_coverage(n_valid: int, n_total: int) -> Optional[float]:
    """Forecast coverage percentage.

    Coverage = (valid forecast intervals / total required intervals) × 100

    A missing forecast is NOT treated as zero generation.
    n_total is the denominator — the number of delivery intervals in the
    requested evaluation window.
    """
    if n_total == 0:
        return None
    return round(100 * n_valid / n_total, 1)


def compute_percentiles(errors: pd.Series, percentiles=(10, 25, 50, 75, 90)) -> dict:
    """Compute error percentiles for scenario analysis.

    Returns a dict of {pXX: value} pairs.
    Used to build lower/central/upper wind generation scenarios.
    """
    valid = errors.dropna()
    if valid.empty:
        return {f"p{p}": None for p in percentiles}
    result = {}
    for p in percentiles:
        result[f"p{p}"] = float(np.percentile(valid, p))
    return result


# ── Composite summary ──────────────────────────────────────────────────────────

def compute_all_metrics(paired_df: pd.DataFrame) -> dict:
    """Compute all accuracy metrics from a DataFrame of matched forecast/actual pairs.

    Args:
        paired_df: DataFrame with columns ["forecast", "actual"].
                   Only rows where both values are non-null are used.

    Returns:
        dict with keys: mae, rmse, bias, maxShortfall, nValid,
                        errorPercentiles (dict of p10/p25/p50/p75/p90).
    """
    valid = paired_df.dropna(subset=["forecast", "actual"]).copy()
    n_valid = len(valid)

    if n_valid == 0:
        return {
            "mae":              None,
            "rmse":             None,
            "bias":             None,
            "maxShortfall":     None,
            "nValid":           0,
            "errorPercentiles": compute_percentiles(pd.Series([], dtype=float)),
        }

    errors = valid["forecast"] - valid["actual"]

    return {
        "mae":              round(compute_mae(errors),           1),
        "rmse":             round(compute_rmse(errors),          1),
        "bias":             round(compute_bias(errors),          1),
        "maxShortfall":     round(compute_max_shortfall(errors), 1),
        "nValid":           n_valid,
        "errorPercentiles": compute_percentiles(errors),
    }
