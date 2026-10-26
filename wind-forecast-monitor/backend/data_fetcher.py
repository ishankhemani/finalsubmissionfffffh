"""
data_fetcher.py — Elexon BMRS API integration with circuit breakers.

Fetches:
  - Actual half-hourly wind generation   → FUELHH dataset
  - Wind generation forecasts            → WINDFOR dataset

Reliability layers (innermost to outermost):
  1. requests timeout (30 s)                  — prevents hanging TCP connections
  2. Exponential-backoff retry (3 attempts)   — handles transient HTTP errors
  3. Circuit breaker (per URL)                — prevents cascade failures when
                                               BMRS is down for an extended period

Circuit breaker behaviour:
  - After 3 consecutive failures (any combination of timeout / 5xx / conn-error)
    the circuit OPENS and all subsequent calls to that endpoint fail immediately
    with CircuitOpenError — no network round-trip, no 30-second hang.
  - After 60 seconds the circuit enters HALF_OPEN and allows one probe request.
    If it succeeds, the circuit CLOSES. If it fails, it OPENS again for another 60 s.
  - Each endpoint (FUELHH, WINDFOR) has its own independent circuit breaker so
    a failure on one does not block the other.

Design decisions (unchanged from v1):
  - publishDateTimeFrom is set 2 days BEFORE the start date so that forecasts
    published in advance of the delivery window (e.g. day-ahead forecasts) are
    always included.
  - publishDateTimeTo is set 2 days AFTER the end date so that any forecast
    published after the final delivery slot's date (but before or on that slot)
    is not accidentally excluded.
  - Duplicate records are dropped before returning to avoid inflating metrics.
"""
import logging
import time
import requests
import pandas as pd
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from circuit_breaker import CircuitBreaker, CircuitOpenError

logger = logging.getLogger(__name__)

ACTUAL_URL   = "https://data.elexon.co.uk/bmrs/api/v1/datasets/FUELHH/stream"
FORECAST_URL = "https://data.elexon.co.uk/bmrs/api/v1/datasets/WINDFOR/stream"

# ── Retry configuration ────────────────────────────────────────────────────────
_MAX_RETRIES     = 3
_RETRY_BASE_WAIT = 1.5   # seconds — doubles each attempt

# ── Circuit breakers (one per external endpoint) ───────────────────────────────
# Module-level singletons — shared across all requests for the lifetime of the
# server process.  Each breaker tracks failures independently so a FUELHH outage
# does not affect WINDFOR requests and vice versa.
#
# Thresholds chosen for a production BMRS integration:
#   failure_threshold=3  — three consecutive errors (across retries) open the circuit.
#   recovery_timeout=60  — wait 60 s before probing again.
#   success_threshold=1  — one successful probe is enough to close the circuit.
breaker_actual   = CircuitBreaker(name="BMRS/FUELHH",  failure_threshold=3, recovery_timeout=60.0)
breaker_forecast = CircuitBreaker(name="BMRS/WINDFOR", failure_threshold=3, recovery_timeout=60.0)


# ── Retry helper ───────────────────────────────────────────────────────────────

def _get_with_retry(url: str, params: dict, timeout: int = 30) -> list:
    """GET request with exponential back-off retry on transient failures.

    This function is the raw network call — circuit breaker protection is applied
    by the callers (fetch_actual / fetch_forecast) which wrap this with the
    appropriate breaker.call().

    Returns the parsed JSON list on success, or raises the last exception.
    """
    last_exc = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            last_exc = exc
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and 400 <= status < 500 and status != 429:
                break   # client error: retrying cannot help
            if attempt < _MAX_RETRIES:
                wait = _RETRY_BASE_WAIT * (2 ** (attempt - 1))
                logger.warning(
                    "BMRS request failed (attempt %d/%d): %s — retrying in %.1fs",
                    attempt, _MAX_RETRIES, exc, wait,
                )
                time.sleep(wait)
    raise last_exc


# ── Actual generation ──────────────────────────────────────────────────────────

def fetch_actual(start: str, end: str) -> pd.DataFrame:
    """Fetch actual half-hourly wind generation from BMRS FUELHH endpoint.

    The call is wrapped by breaker_actual. If the circuit is OPEN a
    CircuitOpenError is raised (no network I/O). The caller (main.py cache
    helper) catches this and returns an empty DataFrame so the rest of the
    request degrades gracefully rather than hanging.

    Args:
        start: Settlement date from, format YYYY-MM-DD
        end:   Settlement date to,   format YYYY-MM-DD

    Returns:
        DataFrame with columns ["time", "actual"], sorted by time.
        Returns an empty DataFrame on network failure or open circuit.
    """
    params = {
        "fuelType":            "WIND",
        "settlementDateFrom":  start,
        "settlementDateTo":    end,
    }
    try:
        data = breaker_actual.call(_get_with_retry, ACTUAL_URL, params)
    except CircuitOpenError as e:
        logger.warning("fetch_actual skipped — circuit OPEN: %s", e)
        return pd.DataFrame(columns=["time", "actual"])
    except requests.RequestException as e:
        logger.error("Failed to fetch actual generation data after retries: %s", e)
        return pd.DataFrame(columns=["time", "actual"])

    if not data:
        logger.warning("FUELHH returned empty list for %s → %s", start, end)
        return pd.DataFrame(columns=["time", "actual"])

    df = pd.DataFrame(
        [{"time": item["startTime"], "actual": item["generation"]} for item in data]
    )
    # Parse to tz-aware UTC datetimes so downstream merges with the forecast
    # selector (which also uses UTC datetimes) never mix str and datetime keys.
    df["time"] = pd.to_datetime(df["time"], utc=True)

    # Drop duplicates: same startTime can appear if the API is queried across
    # overlapping settlement periods.
    df = df.drop_duplicates(subset=["time"])
    df = df.sort_values("time").reset_index(drop=True)
    return df


# ── Forecast generation ────────────────────────────────────────────────────────

_PUBLISH_CHUNK_DAYS = 7


def _publish_windows(from_dt: datetime, to_dt: datetime,
                     chunk_days: int = _PUBLISH_CHUNK_DAYS) -> list:
    """Split [from_dt 00:00, to_dt 23:59] into contiguous publish-time windows.

    Returns a list of BMRS param dicts. Windows are contiguous, so every
    publication falls in at least one window; boundary duplicates (if BMRS
    treats the upper bound as inclusive) are removed by drop_duplicates later.
    """
    windows = []
    cursor = from_dt
    final_end = to_dt + timedelta(hours=23, minutes=59)
    while cursor <= final_end:
        nxt = min(cursor + timedelta(days=chunk_days), final_end + timedelta(minutes=1))
        windows.append({
            "publishDateTimeFrom": cursor.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "publishDateTimeTo":   (nxt - timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        cursor = nxt
    return windows


def fetch_forecast(start: str, end: str) -> pd.DataFrame:
    """Fetch wind generation forecasts from BMRS WINDFOR endpoint.

    publishDateTimeFrom is set 2 days before `start` so that day-ahead and
    multi-day-ahead forecasts published before the delivery window are included.

    publishDateTimeTo is set 2 days after `end`.  Without this buffer, forecasts
    published on the final day(s) of the requested delivery range — but after
    00:00 on that date — could be missed.

    The call is wrapped by breaker_forecast. If the circuit is OPEN, an empty
    DataFrame is returned — the actual data can still load, procurement calculations
    will show 0 forecast coverage rather than timing out.

    Args:
        start: Delivery date from, format YYYY-MM-DD
        end:   Delivery date to,   format YYYY-MM-DD

    Returns:
        DataFrame with columns ["time", "publishTime", "forecast"],
        or empty DataFrame on failure. Duplicate (time, publishTime) pairs are
        dropped; the highest-generation value is retained (BMRS occasionally
        republishes corrected records).
    """
    try:
        start_dt = datetime.strptime(start, "%Y-%m-%d")
        end_dt   = datetime.strptime(end,   "%Y-%m-%d")
    except ValueError:
        logger.error("Invalid date format passed to fetch_forecast: %s / %s", start, end)
        return pd.DataFrame(columns=["time", "publishTime", "forecast"])

    publish_from_dt = start_dt - timedelta(days=2)
    publish_to_dt   = end_dt + timedelta(days=2)

    # A month of WINDFOR publications is large; one request can exceed the
    # 30 s timeout. Split the publish window into contiguous chunks fetched in
    # parallel. If ANY chunk fails we return an empty frame rather than a
    # partial one: a partial set would silently make the "latest eligible
    # forecast" selection fall back to older publications.
    windows = _publish_windows(publish_from_dt, publish_to_dt)
    try:
        if len(windows) == 1:
            chunks = [breaker_forecast.call(_get_with_retry, FORECAST_URL, windows[0])]
        else:
            with ThreadPoolExecutor(max_workers=min(4, len(windows))) as pool:
                futures = [
                    pool.submit(breaker_forecast.call, _get_with_retry, FORECAST_URL, w)
                    for w in windows
                ]
                chunks = [f.result() for f in futures]
    except CircuitOpenError as e:
        logger.warning("fetch_forecast skipped — circuit OPEN: %s", e)
        return pd.DataFrame(columns=["time", "publishTime", "forecast"])
    except requests.RequestException as e:
        logger.error("Failed to fetch forecast data after retries: %s", e)
        return pd.DataFrame(columns=["time", "publishTime", "forecast"])

    data = [item for chunk in chunks for item in (chunk or [])]

    if not data:
        logger.warning("WINDFOR returned empty list for %s → %s", start, end)
        return pd.DataFrame(columns=["time", "publishTime", "forecast"])

    df = pd.DataFrame([
        {
            "time":        item["startTime"],
            "publishTime": item["publishTime"],
            "forecast":    item["generation"],
        }
        for item in data
    ])

    # Drop exact duplicates (same delivery slot + same publish time).
    # If values differ, keep the latest-published version (max sort ensures
    # subsequent drop_duplicates keeps the last row when sorted ascending).
    df = df.sort_values(["time", "publishTime", "forecast"])
    df = df.drop_duplicates(subset=["time", "publishTime"], keep="last")
    df = df.reset_index(drop=True)
    return df


# ── Breaker status (for /health and /cache-stats endpoints) ───────────────────

def get_breaker_stats() -> dict:
    """Return telemetry for both circuit breakers.  Called by main.py endpoints."""
    return {
        "fuelhh":  breaker_actual.stats(),
        "windfor": breaker_forecast.stats(),
    }