"""End-to-end API tests with mocked BMRS data (no network).

These guard the full request path: fetch -> select -> merge -> metrics -> JSON.
"""
import json

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import main


def _iso(ts):
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture()
def client(monkeypatch):
    times = pd.date_range("2026-01-02", periods=96, freq="30min", tz="UTC")  # 2 days
    actual = pd.DataFrame({"time": times, "actual": np.linspace(1000, 3000, 96)})
    rows = []
    for t in times:
        # published 09:00 on D-1  -> eligible in decision mode
        pub = (t.normalize() - pd.Timedelta(days=1)) + pd.Timedelta(hours=8)
        rows.append({"time": _iso(t), "publishTime": _iso(pub), "forecast": 1500.0})
    # slots on day 2 additionally have a late forecast (after the decision time)
    forecast = pd.DataFrame(rows)

    monkeypatch.setattr(main, "fetch_actual", lambda s, e: actual.copy())
    monkeypatch.setattr(main, "fetch_forecast", lambda s, e: forecast.copy())
    main._raw_cache.clear()
    main._merged_cache.clear()
    main.limiter.reset()
    return TestClient(main.app, raise_server_exceptions=False)


P = dict(start="2026-01-02", end="2026-01-03")


def test_decision_mode_full_flow(client):
    r = client.get("/wind-data", params=P)
    assert r.status_code == 200
    body = json.loads(r.text)  # strict parse (no NaN literals)
    assert len(body["records"]) == 96
    m = body["metrics"]
    assert m["mode"] == "decision" and m["nValid"] == 96
    assert m["nTotal"] == 96 and m["coverage"] == 100.0
    assert m["mae"] > 0


def test_decision_mode_returns_publish_time_and_daily_bias(client):
    r = client.get("/wind-data", params=P)
    assert r.status_code == 200
    body = json.loads(r.text)
    assert "publishTime" in body["records"][0]
    assert body["records"][0]["publishTime"].startswith("2026-01-01T08:00:00Z")
    assert "daily" in body
    assert len(body["daily"]) == 2
    assert body["daily"][0]["date"] == "2026-01-02"
    assert body["daily"][0]["biasUsed"] == 0.0


def test_daily_bias_respects_decision_cutoff():
    merged = pd.DataFrame({
        "time": pd.to_datetime([
            "2026-01-01T00:00:00Z",
            "2026-01-01T08:00:00Z",
            "2026-01-01T10:00:00Z",
            "2026-01-02T00:00:00Z",
        ], utc=True),
        "actual": [100.0, 100.0, 100.0, 100.0],
        "forecast": [100.0, 100.0, 200.0, 100.0],
        "publishTime": pd.to_datetime([
            "2026-01-01T00:00:00Z",
            "2026-01-01T08:00:00Z",
            "2026-01-01T10:00:00Z",
            "2026-01-02T00:00:00Z",
        ], utc=True),
    })

    daily = main._compute_daily_bias(
        merged,
        start="2026-01-02",
        end="2026-01-02",
        calibration_days=7,
        decision_time="09:00",
    )

    assert daily[0]["biasUsed"] == 0.0
    assert daily[0]["nCalibration"] == 2


def test_horizon_mode_and_missing_forecast_is_null_not_zero(client):
    # 48h lead: forecasts were published only ~15-39h ahead -> none eligible
    r = client.get("/wind-data", params={**P, "mode": "horizon", "horizon": 48})
    assert r.status_code == 200
    body = json.loads(r.text)
    assert all(rec["forecast"] is None for rec in body["records"])
    assert body["metrics"]["nValid"] == 0 and body["metrics"]["mae"] is None
    assert body["metrics"]["coverage"] == 0.0


def test_coverage_uses_expected_slots(client, monkeypatch):
    times = pd.date_range("2026-01-02", periods=24, freq="30min", tz="UTC")  # half a day
    monkeypatch.setattr(main, "fetch_actual",
                        lambda s, e: pd.DataFrame({"time": times, "actual": 1000.0}))
    main._raw_cache.clear(); main._merged_cache.clear()
    m = json.loads(client.get("/wind-data", params={"start": "2026-01-02", "end": "2026-01-02"}).text)["metrics"]
    assert m["nTotal"] == 48 and m["nActual"] == 24


def test_etag_304(client):
    r = client.get("/wind-data", params=P)
    r2 = client.get("/wind-data", params=P, headers={"If-None-Match": r.headers["etag"]})
    assert r2.status_code == 304


@pytest.mark.parametrize("params", [
    {"start": "2026-13-01", "end": "2026-01-02"},
    {"start": "2026-01-05", "end": "2026-01-02"},
    {"start": "2026-01-01", "end": "2026-03-30"},
    {**P, "mode": "horizon", "horizon": 99},
    {**P, "mode": "bogus"},
    {**P, "decision_time": "25:00"},
])
def test_validation_errors(client, params):
    assert client.get("/wind-data", params=params).status_code == 400


def test_no_actuals_gives_502(client, monkeypatch):
    monkeypatch.setattr(main, "fetch_actual", lambda s, e: pd.DataFrame(columns=["time", "actual"]))
    assert client.get("/wind-data", params=P).status_code == 502


def test_forecast_outage_degrades_gracefully(client, monkeypatch):
    monkeypatch.setattr(main, "fetch_forecast",
                        lambda s, e: pd.DataFrame(columns=["time", "publishTime", "forecast"]))
    r = client.get("/wind-data", params=P)
    assert r.status_code == 200
    assert json.loads(r.text)["metrics"]["nValid"] == 0


def test_rate_limit_keyed_on_forwarded_ip(client, monkeypatch):
    monkeypatch.setattr(main, "RATE_LIMIT", "30/minute")
    h1 = {"X-Forwarded-For": "1.1.1.1"}
    codes = [client.get("/health", headers=h1).status_code for _ in range(3)]
    assert codes == [200, 200, 200]


def test_health(client):
    assert client.get("/health").json()["status"] in ("ok", "degraded")


# ── data_fetcher: chunked forecast fetch ─────────────────────────────────────
import data_fetcher
from datetime import datetime


def test_publish_windows_are_contiguous_and_cover_range():
    ws = data_fetcher._publish_windows(datetime(2025, 12, 31), datetime(2026, 2, 3))
    assert len(ws) > 1
    assert ws[0]["publishDateTimeFrom"] == "2025-12-31T00:00:00Z"
    assert ws[-1]["publishDateTimeTo"] == "2026-02-03T23:59:59Z"
    for prev, nxt in zip(ws, ws[1:]):
        p_end = datetime.strptime(prev["publishDateTimeTo"], "%Y-%m-%dT%H:%M:%SZ")
        n_start = datetime.strptime(nxt["publishDateTimeFrom"], "%Y-%m-%dT%H:%M:%SZ")
        assert (n_start - p_end).total_seconds() == 1   # no gap, no overlap


def test_fetch_forecast_merges_chunks_and_dedupes(monkeypatch):
    def fake_get(url, params, timeout=30):
        return [{"startTime": "2026-01-10T12:00:00Z",
                 "publishTime": "2026-01-09T08:00:00Z", "generation": 1234.0}]
    monkeypatch.setattr(data_fetcher, "_get_with_retry", fake_get)
    data_fetcher.breaker_forecast.reset()
    df = data_fetcher.fetch_forecast("2026-01-02", "2026-02-01")   # many chunks
    assert len(df) == 1 and df["forecast"].iloc[0] == 1234.0


def test_fetch_forecast_returns_empty_if_any_chunk_fails(monkeypatch):
    import requests
    calls = {"n": 0}
    def flaky(url, params, timeout=30):
        calls["n"] += 1
        if calls["n"] == 2:
            raise requests.ConnectionError("boom")
        return [{"startTime": "2026-01-10T12:00:00Z",
                 "publishTime": "2026-01-09T08:00:00Z", "generation": 1.0}]
    monkeypatch.setattr(data_fetcher, "_get_with_retry", flaky)
    data_fetcher.breaker_forecast.reset()
    assert data_fetcher.fetch_forecast("2026-01-02", "2026-02-01").empty
    data_fetcher.breaker_forecast.reset()


# ── Security hardening: rate-limit key, spoofing, telemetry endpoint ─────────
from starlette.requests import Request as _Req


def _req(headers: dict, client=("9.9.9.9", 1234)):
    return _Req({"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
                 "client": client, "method": "GET", "path": "/", "query_string": b""})


def test_client_ip_default_uses_first_forwarded_entry(monkeypatch):
    monkeypatch.setattr(main, "TRUSTED_PROXY_COUNT", 0)
    assert main._client_ip(_req({"X-Forwarded-For": "1.1.1.1, 2.2.2.2"})) == "1.1.1.1"


def test_client_ip_trusted_proxy_count_ignores_forged_prefix(monkeypatch):
    monkeypatch.setattr(main, "TRUSTED_PROXY_COUNT", 1)
    # attacker forges "6.6.6.6"; the trusted proxy appended the real address last
    assert main._client_ip(_req({"X-Forwarded-For": "6.6.6.6, 7.7.7.7"})) == "7.7.7.7"
    monkeypatch.setattr(main, "TRUSTED_PROXY_COUNT", 2)
    assert main._client_ip(_req({"X-Forwarded-For": "6.6.6.6, 7.7.7.7, 8.8.8.8"})) == "7.7.7.7"


def test_client_ip_falls_back_to_socket_address(monkeypatch):
    monkeypatch.setattr(main, "TRUSTED_PROXY_COUNT", 1)
    assert main._client_ip(_req({})) == "9.9.9.9"


def test_spoofed_forwarded_for_cannot_dodge_limit_when_proxy_count_set(client, monkeypatch):
    monkeypatch.setattr(main, "TRUSTED_PROXY_COUNT", 1)
    codes = [
        client.get("/wind-data", params=P,
                   headers={"X-Forwarded-For": f"10.0.0.{i}, 7.7.7.7"}).status_code
        for i in range(32)
    ]
    assert codes.count(200) == 30 and 429 in codes   # forged prefixes did not help


def test_global_key_is_constant():
    assert main._global_key(_req({"X-Forwarded-For": "1.1.1.1"})) == main._global_key(_req({}))


def test_cache_stats_open_by_default_and_token_protected_when_set(client, monkeypatch):
    monkeypatch.setattr(main, "STATS_TOKEN", "")
    assert client.get("/cache-stats").status_code == 200
    monkeypatch.setattr(main, "STATS_TOKEN", "s3cret")
    assert client.get("/cache-stats").status_code == 403
    assert client.get("/cache-stats", headers={"X-Stats-Token": "wrong"}).status_code == 403
    assert client.get("/cache-stats", headers={"X-Stats-Token": "s3cret"}).status_code == 200
