"""
main.py — Wind Forecast API entry point.

Endpoints:
  GET /health       Liveness probe (no rate limit).
  GET /wind-data    Merged actual + eligible forecast time series.
  GET /metrics      Forecast accuracy metrics for the same date range + horizon.
  GET /cache-stats  Cache telemetry (hit rate, size, evictions).

Caching strategy (two-layer):
  L1 — Raw-fetch cache  (key: "actual:start:end" / "forecast:start:end")
       TTL: 10 min | maxsize: 100 entries
       Caches the raw DataFrames returned by BMRS API calls.
       Both fetch_actual and fetch_forecast are cached independently so a
       horizon change (which only affects select_forecast) doesn't re-hit Elexon.

  L2 — Merged result cache  (key: "merged:start:end:horizon")
       TTL: 10 min | maxsize: 50 entries
       Caches the full merged+horizon-filtered DataFrame.
       This is the most expensive step (includes select_forecast).
       A repeated identical query (same start/end/horizon) returns instantly.

  Both caches are bounded LRU — the Least Recently Used entry is evicted
  when capacity is exceeded, preventing unbounded memory growth.

  TTL rationale: BMRS publishes new WINDFOR forecasts every 30–60 minutes,
  and FUELHH actuals are settled in near-real-time. A 10-minute TTL keeps
  data fresh enough for operational use while absorbing repeated UI clicks
  (users typically hit "Load Data" multiple times in a session).

Performance improvements vs v1:
  1. L1 cache eliminates Elexon round-trips (~2–5 s each) on repeated queries.
  2. L2 cache eliminates select_forecast CPU work on repeated identical queries.
  3. forecast_selector was rewritten from an O(n×m) Python loop to a vectorised
     pandas merge+groupby (~50–200× faster for multi-day ranges).
  4. Parallel ThreadPoolExecutor fetch (already in v1) retained.

Other:
  - Rate limiting: RATE_LIMIT env var (default 30/min) per real client IP, plus a
    service-wide GLOBAL_RATE_LIMIT (default 300/min) that header spoofing cannot bypass.
  - Max date range: 35 days.
"""
import hashlib
import hmac
import json
import logging
import os
import time
import concurrent.futures
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from data_fetcher import fetch_actual, fetch_forecast, get_breaker_stats
from forecast_selector import (
    select_forecast,
    select_forecast_at_decision_time,
    parse_decision_time,
)
from accuracy_metrics import compute_all_metrics, compute_coverage
from cache import BoundedTTLCache
from circuit_breaker import CircuitState

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── CORS origins ──────────────────────────────────────────────────────────────
_raw_origins = os.getenv(
    "ALLOWED_ORIGINS",
    "https://wind-forecast-app-sigma.vercel.app,http://localhost:3000",
)
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",")]

# ── Rate limiter ──────────────────────────────────────────────────────────────
# TRUSTED_PROXY_COUNT hardens the per-IP key against X-Forwarded-For spoofing.
#   0 (default) - legacy behaviour: use the FIRST entry (the client as reported
#                 by the edge). Works behind any proxy chain, but a client can
#                 forge that entry to dodge the per-IP limit.
#   N >= 1      - the number of trusted proxies in front of the app, each of
#                 which APPENDS the address it saw. The client is then the Nth
#                 entry from the END, which a caller cannot forge. Set this
#                 once you know your host's proxy depth.
TRUSTED_PROXY_COUNT = int(os.getenv("TRUSTED_PROXY_COUNT", "0"))


def _client_ip(request: Request) -> str:
    """Real client IP. Behind Render/Vercel/nginx every request arrives from the
    proxy's address, so the per-IP limit would otherwise be shared by ALL users.
    X-Forwarded-For is "client, proxy1, proxy2" - the first entry is the client."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            if TRUSTED_PROXY_COUNT > 0:
                return parts[max(len(parts) - TRUSTED_PROXY_COUNT, 0)]
            return parts[0]
    return get_remote_address(request)


def _global_key(request: Request) -> str:
    """Constant key: one shared bucket for ALL clients (spoof-proof backstop)."""
    return "global"


RATE_LIMIT = os.getenv("RATE_LIMIT", "30/minute")
# Backstop for the whole service. Per-IP limits can be sidestepped by forging
# X-Forwarded-For; this cap cannot, and protects the upstream BMRS API.
GLOBAL_RATE_LIMIT = os.getenv("GLOBAL_RATE_LIMIT", "300/minute")
limiter = Limiter(key_func=_client_ip)

app = FastAPI(
    title="Wind Forecast API",
    description=(
        "Serves actual and forecast UK wind generation data from BMRS "
        "(FUELHH + WINDFOR) and computes forecast accuracy metrics."
    ),
    version="3.0.0",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── Middleware ────────────────────────────────────────────────────────────────
# CORS must be registered AFTER GZip — Starlette executes middleware in
# reverse registration order, so the last-added runs first.  CORS headers
# must be attached before GZip compresses the body, otherwise some proxies
# strip unrecognised headers from compressed responses.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
    expose_headers=["ETag", "Cache-Control"],
)

app.add_middleware(GZipMiddleware, minimum_size=1000)

# ── Cache-Control / ETag helpers ─────────────────────────────────────────────
# Browser-level caching lets the client skip the network entirely for
# repeated identical queries, even faster than the server-side L2 cache.
#
# Strategy:
#   Cache-Control: public, max-age=300, stale-while-revalidate=60
#     → Browser serves cached response for up to 5 minutes without any
#       network call.  During the 60s stale window it serves the old
#       response immediately AND re-validates in the background.
#   ETag: SHA-256 of the serialised response body (first 16 hex chars).
#     → If the client sends If-None-Match and it matches, we return 304
#       with no body — zero payload, minimal latency.
_BROWSER_CACHE_MAX_AGE = int(os.getenv("BROWSER_CACHE_MAX_AGE", "300"))  # 5 min
_STALE_WHILE_REVALIDATE = 60   # seconds


def _etag(body: str) -> str:
    """Compute a short ETag from the serialised JSON body."""
    return '"' + hashlib.sha256(body.encode()).hexdigest()[:16] + '"'


def _cache_headers() -> dict:
    return {
        "Cache-Control": (
            f"public, max-age={_BROWSER_CACHE_MAX_AGE}, "
            f"stale-while-revalidate={_STALE_WHILE_REVALIDATE}"
        ),
    }


# ── Caches ────────────────────────────────────────────────────────────────────
# TTL: 10 minutes — balances freshness vs. avoiding repeated Elexon round-trips.
# Maxsize: 100 raw / 50 merged — prevents unbounded memory growth.
# Both are module-level singletons shared across all requests.
_CACHE_TTL = int(os.getenv("CACHE_TTL_SECONDS", "600"))   # override via env var
_CALIBRATION_DAYS = 7

# L1: Raw BMRS API responses (independent of horizon)
_raw_cache: BoundedTTLCache = BoundedTTLCache(maxsize=100, ttl_seconds=_CACHE_TTL)

# L2: Merged + horizon-filtered result (horizon is part of the cache key)
_merged_cache: BoundedTTLCache = BoundedTTLCache(maxsize=50, ttl_seconds=_CACHE_TTL)


# ── Shared validation helper ──────────────────────────────────────────────────
VALID_MODES = ("decision", "horizon")


def _validate_params(start: str, end: str, horizon: int,
                     mode: str = "decision", decision_time: str = "09:00"):
    """Raise HTTPException for any invalid combination of query parameters."""
    try:
        start_dt = datetime.strptime(start, "%Y-%m-%d")
        end_dt   = datetime.strptime(end,   "%Y-%m-%d")
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="start and end must be in YYYY-MM-DD format (e.g. 2026-01-01).",
        )

    if start_dt > end_dt:
        raise HTTPException(
            status_code=400,
            detail="start must be on or before end.",
        )

    if mode not in VALID_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"mode must be one of: {', '.join(VALID_MODES)}.",
        )

    try:
        parse_decision_time(decision_time)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not (0 <= horizon <= 48):
        raise HTTPException(
            status_code=400,
            detail="horizon must be between 0 and 48 hours.",
        )

    max_days = (end_dt - start_dt).days
    if max_days > 35:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Date range cannot exceed 35 days. "
                f"Requested {max_days} days ({start} → {end})."
            ),
        )

    return start_dt, end_dt


# ── Cached fetch helpers ──────────────────────────────────────────────────────

def _cached_fetch_actual(start: str, end: str) -> pd.DataFrame:
    """Fetch actual generation, serving from L1 cache when available."""
    key = f"actual:{start}:{end}"
    cached = _raw_cache.get(key)
    if cached is not None:
        logger.info("L1 cache HIT  — actual %s→%s", start, end)
        return cached
    logger.info("L1 cache MISS — fetching actual %s→%s from BMRS", start, end)
    df = fetch_actual(start, end)
    if not df.empty:                 # Don't cache empty (API errors / no data)
        _raw_cache.set(key, df)
    return df


def _cached_fetch_forecast(start: str, end: str) -> pd.DataFrame:
    """Fetch wind forecast, serving from L1 cache when available."""
    key = f"forecast:{start}:{end}"
    cached = _raw_cache.get(key)
    if cached is not None:
        logger.info("L1 cache HIT  — forecast %s→%s", start, end)
        return cached
    logger.info("L1 cache MISS — fetching forecast %s→%s from BMRS", start, end)
    df = fetch_forecast(start, end)
    if not df.empty:
        _raw_cache.set(key, df)
    return df


# ── Merged result helper ──────────────────────────────────────────────────────

def _fetch_and_merge(start: str, end: str, horizon: int,
                     mode: str = "decision",
                     decision_time: str = "09:00") -> pd.DataFrame:
    """Fetch actual + forecast data, merge, and apply horizon filter.

    Two-layer caching:
      L2 hit  → return instantly (no network, no CPU).
      L2 miss → check L1 for each raw fetch, then run select_forecast + merge.

    Returns a DataFrame with columns [time, actual, forecast, publishTime].
    Raises HTTPException if actual data is unavailable.
    """
    # decision mode ignores `horizon`; horizon mode ignores `decision_time`.
    # Normalise the irrelevant parameter so equivalent queries share a cache key.
    if mode == "decision":
        merged_key = f"merged:{start}:{end}:decision:{decision_time}"
    else:
        merged_key = f"merged:{start}:{end}:horizon:{horizon}"
    cached_merged = _merged_cache.get(merged_key)
    if cached_merged is not None:
        logger.info("L2 cache HIT  — merged %s→%s %s", start, end, merged_key)
        return cached_merged

    logger.info("L2 cache MISS — building merged %s→%s %s", start, end, merged_key)
    t0 = time.perf_counter()

    start_dt = datetime.strptime(start, "%Y-%m-%d")
    history_start = (start_dt - timedelta(days=_CALIBRATION_DAYS)).strftime("%Y-%m-%d")

    # Fetch actual + forecast in parallel, each with L1 caching. We pull a
    # short trailing calibration window so the planner can compute a day-ahead
    # bias that excludes the delivery day itself.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        future_actual   = executor.submit(_cached_fetch_actual,   history_start, end)
        future_forecast = executor.submit(_cached_fetch_forecast, history_start, end)
        actual   = future_actual.result()
        forecast = future_forecast.result()

    if actual.empty:
        raise HTTPException(
            status_code=502,
            detail=(
                "No actual generation data returned from BMRS for the requested "
                "date range. The BMRS API may be unavailable or the date range "
                "may have no data."
            ),
        )

    warnings = []
    if forecast.empty:
        warnings.append("forecast_unavailable")

    if mode == "decision":
        selected = select_forecast_at_decision_time(actual, forecast, decision_time)
    else:
        selected = select_forecast(actual, forecast, horizon)
    actual = actual.copy()
    actual["time"] = pd.to_datetime(actual["time"], utc=True)
    if selected.empty:
        selected = pd.DataFrame({
            "time": pd.Series(dtype="datetime64[ns, UTC]"),
            "forecast": pd.Series(dtype="float64"),
            "publishTime": pd.Series(dtype="datetime64[ns, UTC]"),
        })
    full_merged = actual.merge(selected, on="time", how="left")
    # Keep exactly the requested delivery dates [start, end] (UTC).
    lo = pd.Timestamp(start, tz="UTC")
    hi = pd.Timestamp(end, tz="UTC") + timedelta(days=1)
    merged = full_merged[(full_merged["time"] >= lo) & (full_merged["time"] < hi)]
    merged = merged.sort_values(by="time", ascending=True).reset_index(drop=True)
    merged.attrs["daily"] = _compute_daily_bias(full_merged, start, end, calibration_days=_CALIBRATION_DAYS)
    merged.attrs["warnings"] = warnings

    elapsed = time.perf_counter() - t0
    logger.info(
        "Built merged DataFrame in %.2fs — %d rows for %s→%s (%s)",
        elapsed, len(merged), start, end, merged_key,
    )

    if not forecast.empty:
        _merged_cache.set(merged_key, merged)
    return merged


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health_check():
    """Liveness probe. Returns degraded status if any circuit breaker is open."""
    breakers = get_breaker_stats()
    open_circuits = [
        name for name, s in breakers.items()
        if s["state"] == CircuitState.OPEN.value
    ]
    status = "degraded" if open_circuits else "ok"
    return {
        "status":        status,
        "version":       app.version,
        "open_circuits": open_circuits,
        "circuit_breakers": breakers,
    }


# Optional protection for the telemetry endpoint. If STATS_TOKEN is set, callers
# must send it in the X-Stats-Token header; if unset the endpoint stays open.
STATS_TOKEN = os.getenv("STATS_TOKEN", "")


@app.get("/cache-stats")
def cache_stats(request: Request):
    """Return cache and circuit breaker telemetry."""
    if STATS_TOKEN and not hmac.compare_digest(
        request.headers.get("x-stats-token", ""), STATS_TOKEN
    ):
        raise HTTPException(status_code=403, detail="Forbidden.")
    return {
        "l1_raw":          _raw_cache.stats(),
        "l2_merged":       _merged_cache.stats(),
        "ttl_seconds":     _CACHE_TTL,
        "circuit_breakers": get_breaker_stats(),
    }


def _compute_daily_bias(merged: pd.DataFrame, start: str, end: str, calibration_days: int = 7) -> list:
    """Compute a day-by-day trailing bias series using only prior days.

    For delivery day D, calibration uses all valid paired intervals from the
    previous `calibration_days` days and excludes D itself. If there is no valid
    history, the day falls back to a zero bias and is labelled as such in the UI.
    """
    if merged.empty:
        return []

    df = merged.copy()
    df["time"] = pd.to_datetime(df["time"], utc=True)
    valid = df.dropna(subset=["actual", "forecast"]).copy()
    if valid.empty:
        start_ts = pd.Timestamp(start, tz="UTC")
        end_ts = pd.Timestamp(end, tz="UTC")
        dates = pd.date_range(start_ts.normalize(), end_ts.normalize(), freq="D")
        return [{
            "date": d.strftime("%Y-%m-%d"),
            "biasUsed": 0.0,
            "nCalibration": 0,
            "forecastIssuedAt": None,
            "calibrationFallback": True,
        } for d in dates]

    daily = []
    start_ts = pd.Timestamp(start, tz="UTC").normalize()
    end_ts = pd.Timestamp(end, tz="UTC").normalize()
    for day in pd.date_range(start_ts, end_ts, freq="D"):
        day_start = day.normalize()
        day_end = day_start + pd.Timedelta(days=1)
        train = valid[(valid["time"] >= day_start - pd.Timedelta(days=calibration_days)) & (valid["time"] < day_start)]
        bias_value = float((train["forecast"] - train["actual"]).mean()) if not train.empty else 0.0
        selected_day = valid[(valid["time"] >= day_start) & (valid["time"] < day_end)]
        publish_at = None
        if not selected_day.empty and selected_day["publishTime"].notna().any():
            publish_at = selected_day["publishTime"].max().strftime("%Y-%m-%dT%H:%M:%SZ")
        daily.append({
            "date": day.strftime("%Y-%m-%d"),
            "biasUsed": round(bias_value, 2) if not train.empty else 0.0,
            "nCalibration": int(len(train)),
            "forecastIssuedAt": publish_at,
            "calibrationFallback": len(train) == 0,
        })
    return daily


def _metrics_block(merged: pd.DataFrame, start: str, end: str, horizon: int,
                   mode: str, decision_time: str) -> dict:
    """Accuracy metrics for a merged frame.

    nTotal is the number of delivery intervals EXPECTED in the requested range
    (48 per day), not the number of rows BMRS happened to return - otherwise
    missing actuals would silently inflate coverage.
    """
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt   = datetime.strptime(end,   "%Y-%m-%d")
    n_expected = ((end_dt - start_dt).days + 1) * 48

    metrics  = compute_all_metrics(merged)
    coverage = compute_coverage(metrics["nValid"], n_expected)
    return {
        **metrics,
        "nTotal":   n_expected,
        "nActual":  int(len(merged)),
        "coverage": coverage,
        "start":    start,
        "end":      end,
        "mode":     mode,
        "horizon":  horizon if mode == "horizon" else None,
        "decisionTime": decision_time if mode == "decision" else None,
        "signConvention": "Forecast Error = Forecast − Actual. Positive = over-forecast.",
    }


def _json_safe(value):
    """Recursively convert NaN/Inf values to None so strict JSON encoding works."""
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [_json_safe(v) for v in value]
    if isinstance(value, np.ndarray):
        return [_json_safe(v) for v in value.tolist()]
    if isinstance(value, (np.floating, float)):
        if pd.isna(value) or not np.isfinite(value):
            return None
        return float(value)
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    return value


def _json_response(request: Request, body: dict) -> Response:
    """Serialise body as strict JSON (NaN is invalid JSON) with ETag / 304 support."""
    body = _json_safe(body)
    body_str = json.dumps(body, default=str, allow_nan=False)
    etag     = _etag(body_str)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, **_cache_headers()})
    return Response(
        content=body_str,
        media_type="application/json",
        headers={"ETag": etag, **_cache_headers()},
    )


@app.get("/wind-data")
@limiter.limit(RATE_LIMIT)
@limiter.limit(GLOBAL_RATE_LIMIT, key_func=_global_key)
def get_wind_data(request: Request, response: Response, start: str, end: str,
                  horizon: int = 24, mode: str = "decision",
                  decision_time: str = "09:00"):
    """Merged actual + eligible-forecast time series AND accuracy metrics.

    Query params:
        start, end      Delivery dates (YYYY-MM-DD, inclusive, UTC).
        mode            "decision" (default): one fixed decision time per delivery
                        day - the forecast known at `decision_time` UK time on D-1.
                        "horizon": fixed lead time of `horizon` hours per slot.
        decision_time   HH:MM, UK local time, used when mode = "decision".
        horizon         0-48 hours, used when mode = "horizon".

    Response: {"records": [{time, actual, forecast|null}], "metrics": {...},
               "coverage": float}
    """
    _validate_params(start, end, horizon, mode, decision_time)
    merged = _fetch_and_merge(start, end, horizon, mode, decision_time)

    out = merged.copy()
    out["forecast"] = out["forecast"].astype(object).where(out["forecast"].notna(), None)
    out["actual"]   = out["actual"].astype(object).where(out["actual"].notna(), None)
    if "publishTime" in out.columns:
        out["publishTime"] = out["publishTime"].apply(
            lambda ts: ts.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(ts) else None
        )
    out["time"] = out["time"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    record_columns = ["time", "actual", "forecast"]
    if "publishTime" in out.columns:
        record_columns.append("publishTime")
    records = out[record_columns].to_dict(orient="records")

    metrics = _metrics_block(merged, start, end, horizon, mode, decision_time)
    daily = merged.attrs.get("daily", [])
    warnings = merged.attrs.get("warnings", [])

    logger.info(
        "wind-data: %d rows %s→%s mode=%s coverage=%s%%",
        len(merged), start, end, mode, metrics["coverage"],
    )
    return _json_response(request, {
        "records":  records,
        "metrics":  metrics,
        "coverage": metrics["coverage"],
        "daily":    daily,
        "warnings": warnings,
    })


@app.get("/metrics")
@limiter.limit(RATE_LIMIT)
@limiter.limit(GLOBAL_RATE_LIMIT, key_func=_global_key)
def get_metrics(request: Request, response: Response, start: str, end: str,
                horizon: int = 24, mode: str = "decision",
                decision_time: str = "09:00"):
    """Standalone metrics endpoint (same parameters as /wind-data)."""
    _validate_params(start, end, horizon, mode, decision_time)
    merged  = _fetch_and_merge(start, end, horizon, mode, decision_time)
    metrics = _metrics_block(merged, start, end, horizon, mode, decision_time)
    return _json_response(request, metrics)
