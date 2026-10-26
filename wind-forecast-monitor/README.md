# Wind Generation Forecast Monitor

A professional wind-generation forecasting and analysis platform for UK electricity purchasing teams.
Built on live Elexon BMRS data (FUELHH + WINDFOR), it provides accurate historical forecast evaluation,
quantitative accuracy metrics, and a practical demand-based procurement planning tool.

---

## Submission Links

| Item | Link |
|---|---|
| Live app (frontend) | _add Vercel URL_ |
| Live API (backend) | _add Render/Heroku URL_ (`/health`, `/docs`) |
| Demo video (unlisted YouTube, ≤ 10 min) | _add link_ |

## AI Tools Disclosure

This project was developed with AI assistance. The final review, bug-fixing and production-hardening pass
(decision-time model, API/Docker fixes, test suite, documentation) was done with **Claude (Anthropic)**.
_List here any other AI tools you used while building the first version (e.g. ChatGPT, Copilot, Cursor)._

---

## Table of Contents

1. [Architecture](#architecture)
2. [API Integration](#api-integration)
3. [Data Fields & Timestamp Semantics](#data-fields--timestamp-semantics)
4. [Forecast Selection Methodology](#forecast-selection-methodology)
5. [January 2026 Evaluation Period](#january-2026-evaluation-period)
6. [Accuracy Metric Definitions](#accuracy-metric-definitions)
7. [Forecast Coverage Calculation](#forecast-coverage-calculation)
8. [Procurement Calculation Formulas](#procurement-calculation-formulas)
9. [Uncertainty Scenario Methodology](#uncertainty-scenario-methodology)
10. [Assumptions & Limitations](#assumptions--limitations)
11. [Environment Configuration](#environment-configuration)
12. [Installation & Execution](#installation--execution)
13. [Automated Tests](#automated-tests)
14. [Changelog](#changelog--production-hardening-pass) · [Known Limitations](#known-limitations)

---

## Architecture

```
wind-forecast-monitor/
├── backend/                  FastAPI (Python 3.12)
│   ├── main.py               API: /health, /wind-data, /metrics, /cache-stats
│   ├── data_fetcher.py       Elexon BMRS client (FUELHH + WINDFOR), retries, circuit breakers, chunked fetch
│   ├── forecast_selector.py  Forecast eligibility: day-ahead decision time (default) or fixed lead time
│   ├── accuracy_metrics.py   Pure-function accuracy metrics
│   ├── cache.py              Thread-safe bounded LRU + TTL cache
│   ├── circuit_breaker.py    Circuit breaker for BMRS calls
│   ├── test_*.py             131 tests (unit + mocked end-to-end API tests, no network)
│   ├── requirements.txt / requirements-dev.txt
│   └── Dockerfile
│
├── frontend/                 React 19 + Chart.js (served by nginx in Docker)
│   └── src/
│       ├── App.js, context/WindDataContext.js (Context + useReducer)
│       ├── components/       ControlPanel, WindChart, ErrorChart, MetricsPanel,
│       │                     ProcurementPlanner, ScenarioPanel, ...
│       └── utils/            dataTransforms.js, procurementCalcs.js (pure functions + Jest tests)
│
├── analysis/forecast_analysis.ipynb   Exploratory notebook (see Known Limitations)
└── docker-compose.yml
```

**State management pattern:** Context + useReducer (Redux-like, no external dependency).

**Data flow:** Elexon API → FastAPI → React Context → Memoized chart/metric builders → Components.

---

## API Integration

### Actual Generation — FUELHH

```
GET https://data.elexon.co.uk/bmrs/api/v1/datasets/FUELHH/stream
  fuelType=WIND
  settlementDateFrom=YYYY-MM-DD
  settlementDateTo=YYYY-MM-DD
```

Returns half-hourly wind generation in MW per settlement period.

### Forecast Generation — WINDFOR

```
GET https://data.elexon.co.uk/bmrs/api/v1/datasets/WINDFOR/stream
  publishDateTimeFrom=YYYY-MM-DDTHH:MM:SSZ
  publishDateTimeTo=YYYY-MM-DDTHH:MM:SSZ
```

Returns wind generation forecasts. Multiple forecast revisions are published for each delivery slot.

**Important:** The `publishDateTimeFrom` is set 2 days before the requested start date so that
day-ahead and multi-day-ahead forecasts are always included. The `publishDateTimeTo` is set 2 days
after the end date to capture forecasts published after the last delivery date.

### Error Handling

- Retry logic: up to 3 attempts with exponential back-off (1.5s, 3s, 6s).
- Timeout: 30 seconds per attempt.
- Duplicate records are dropped before processing.
- API failures return an empty DataFrame; the caller raises HTTP 502 if actual data is missing.
- Forecast failures degrade gracefully (missing forecast slots, not fabricated zeros).

---

### Backend API

```
GET /wind-data?start=2026-01-02&end=2026-02-01&mode=decision&decision_time=09:00
GET /wind-data?start=2026-01-02&end=2026-01-08&mode=horizon&horizon=24
GET /metrics   (same parameters; metrics only)
GET /health    (status + circuit-breaker state)
```

`/wind-data` returns `{records: [{time, actual, forecast|null}], metrics: {...}, coverage}`. Invalid input → `400`,
no actual data → `502`, rate limit → `429`. Responses carry `ETag` / `Cache-Control` and are gzip-compressed.

## Data Fields & Timestamp Semantics

| Field | Source | Meaning |
|---|---|---|
| `startTime` (FUELHH) | Elexon | **Delivery interval start** — when the power was actually generated |
| `generation` (FUELHH) | Elexon | Actual wind generation in MW for that 30-min interval |
| `startTime` (WINDFOR) | Elexon | **Delivery interval the forecast applies to** |
| `publishTime` (WINDFOR) | Elexon | **When the forecast was published** — critical for horizon filtering |
| `generation` (WINDFOR) | Elexon | Forecasted wind generation in MW |

### Critical Distinction

- `startTime` = the delivery slot being forecast (when the electricity will be generated).
- `publishTime` = when the forecast was issued (when the buyer could have known it).

These are **never interchangeable**. Using `publishTime` as the delivery time would produce
completely wrong results.

All timestamps are UTC throughout the application.

---

## Forecast Selection Methodology

The buyer places the day-ahead order for delivery day **D** on day **D-1**. The key modelling question is
therefore: *which WINDFOR forecast was the latest one available at that moment?*

### Mode 1 — Day-ahead decision (default, `mode=decision`)

```
cutoff(D)  = (D − 1 day) at decision_time, Europe/London        (default 09:00)
eligible   = forecasts with publishTime ≤ cutoff(D)
forecast   = the most recently published eligible forecast
```

**Every half-hour slot of day D shares the same cutoff**, exactly as in a real day-ahead auction where one
order covers the whole day. A fixed per-slot lead time would let late-evening slots use forecasts published
after the buyer had already committed (information leakage that flatters accuracy). `decision_time` is
configurable in the UI; real gate-closure times differ by market/auction, so 09:00 is an assumption.

### Mode 2 — Fixed lead time (`mode=horizon`)

```
publishTime ≤ startTime − horizon_hours        (horizon 0–48 h)
```

Useful for studying how accuracy degrades with lead time, but it is not a day-ahead decision model.

In both modes: if no eligible forecast exists the slot is `forecast = null` (missing, **never zero**).

---

## January 2026 Evaluation Period

The brief asks for purchase decisions made **in January 2026**. A decision on D-1 is for delivery day D, so the
delivery days to evaluate are **2 January → 1 February 2026**. The **“Jan 2026 decisions”** button in the UI
sets exactly this range (30 days, within the 35-day cap).

Forecasts are fetched with `publishDateTimeFrom = start − 2 days` and `publishDateTimeTo = end + 2 days`,
split into 7-day chunks fetched in parallel (a full month of WINDFOR publications can exceed a single 30 s
request). If any chunk fails the forecast set is treated as unavailable rather than silently partial.

---

## Accuracy Metric Definitions

All metrics use the convention:

> **Forecast Error = Forecast − Actual**

| Metric | Formula | Interpretation |
|---|---|---|
| **MAE** | mean(\|Forecast − Actual\|) | Average absolute error in MW. Always ≥ 0. |
| **RMSE** | √(mean((Forecast − Actual)²)) | Penalises large errors more than MAE. Always ≥ MAE. |
| **Bias** | mean(Forecast − Actual) | Signed mean error. Positive = systematic over-forecast. |
| **Max Shortfall** | max(Forecast − Actual, 0) | Worst single interval of wind under-delivery. |
| **Coverage** | nValid / nTotal × 100 | % of intervals with an eligible forecast. |

**Sign convention:**
- **Positive error** → wind was over-forecast → actual generation was lower than expected → buyers needed more supply than anticipated.
- **Negative error** → wind was under-forecast → actual was higher than expected → less additional supply needed.

---

## Forecast Coverage Calculation

```
Coverage (%) = N_valid / N_total × 100
```

Where:
- `N_total` = delivery intervals **expected** in the requested range (48 per day) — not just the rows BMRS
  returned, so missing actuals cannot inflate coverage. The API also returns `nActual` (rows received).
- `N_valid` = intervals where both actual generation and an eligible forecast exist.

**A missing forecast is NOT treated as zero wind generation.** Missing intervals are excluded from
all accuracy metric calculations. Coverage is reported alongside every metric set.

---

## Procurement Calculation Formulas

For each 30-minute delivery interval `t`:

```
Residual(t) = Demand(t) − Wind_generation(t) − Other_generation(t)

Additional_requirement(t) = max(Residual(t), 0)
  → Demand exceeds available generation → additional electricity needed.

Potential_surplus(t) = max(−Residual(t), 0)
  → Generation exceeds demand → potential surplus.
```

**Energy conversion (MW → MWh):**

```
Energy (MWh) = Power (MW) × 0.5 h
Daily energy (MWh) = Σ_t [ Power(t) × 0.5 ]
```

Each 30-minute interval is 0.5 hours. **Never sum MW values directly to get MWh.**

**Missing value policy (enforced in code and covered by tests):**
- Missing demand → `residual = null` (not computable; displayed as "—").
- Missing wind forecast → `residual = null`: the wind is unknown, **not zero**. The interval is
  flagged and excluded from **every** energy total, so all totals refer to the same set of intervals.
- Missing other generation → treated as 0 MW, explicitly labelled as an assumption.

**Labels:**  
All procurement results are labelled _"Estimated additional electricity requirement based on forecast"_.
They are not procurement orders or guaranteed purchasing recommendations.

---

## Uncertainty Scenario Methodology

Three illustrative scenarios are derived from historical forecast errors in the loaded dataset.

**Method: Historical error percentiles**

```
Error(t)  = Forecast(t) − Actual(t)            [sign convention]
Actual(t) = Forecast(t) − Error(t)

Lower wind scenario:  Forecast − p90(errors)   → actual was this low or lower in ~10% of intervals
Central scenario:     Forecast − p50(errors)   → median-adjusted
Higher wind scenario: Forecast − p10(errors)   → actual was this high or higher in ~10% of intervals
```

**Percentile levels:** p10, p50, p90. Configurable in `buildScenarioOffsets()`.

**Minimum sample requirement:** 10 paired intervals. Below this the panel displays a warning
rather than unreliable scenarios.

**Disclosure:** These are **illustrative scenarios, not statistical confidence intervals**.
The sample covers only the selected date range. A small or unrepresentative sample produces
unreliable scenarios. This is clearly stated in the UI.

**Procurement under uncertainty:**  
For each scenario, `Additional_requirement = max(Demand − Scenario_wind − Other, 0)` is
calculated and displayed. No automatic recommendation is made — the correct procurement
decision depends on shortage costs, surplus costs, and market conditions.

---

## Assumptions & Limitations

1. **No authentication:** The Elexon BMRS API is public; no API key is required.
2. **Decision time:** One decision time (default 09:00 UK, D-1) applies to the whole query. Real gate closures vary by auction/product.
3. **Uniform demand:** When a single demand value is entered, it is applied identically
   to all 48 half-hourly intervals. Upload a CSV for per-interval precision.
4. **Other generation zero:** If other generation is not entered, it is assumed zero and
   clearly labelled as such.
5. **Bias correction is in-sample:** the mean bias used by the Procurement Planner is estimated on the loaded
   range (which includes the delivery day shown). Treat it as indicative. A single MW offset also ignores
   that errors scale with wind level.
5b. **Scenario representativeness:** Error percentiles are derived from the selected date range.
   January 2026 errors may not represent future uncertainty.
6. **Rate limiting:** `RATE_LIMIT` env var (default `30/minute`) per real client IP (`X-Forwarded-For`-aware, so users behind a proxy are not throttled together).
7. **Date range cap:** Maximum 35 days per query to control response size and API load.
8. **Timestamp timezone:** All timestamps are UTC throughout. The frontend formats them in
   en-GB locale for display only.

---

## Environment Configuration

### Backend (`backend/`)

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://wind-forecast-app-sigma.vercel.app,http://localhost:3000` | Comma-separated CORS origins |
| `RATE_LIMIT` | `30/minute` | Per-client-IP limit on data endpoints |
| `GLOBAL_RATE_LIMIT` | `300/minute` | Service-wide cap shared by all clients (spoof-proof backstop that protects the upstream BMRS API) |
| `TRUSTED_PROXY_COUNT` | `0` | `0` = use the first `X-Forwarded-For` entry (legacy). Set to the number of trusted proxies in front of the app (e.g. `1`) to take the client IP from the end of the header, which callers cannot forge |
| `STATS_TOKEN` | _(unset)_ | If set, `/cache-stats` requires this value in an `X-Stats-Token` header |
| `CACHE_TTL_SECONDS` | `600` | Server-side cache lifetime |
| `BROWSER_CACHE_MAX_AGE` | `300` | `Cache-Control: max-age` on API responses |

Set via environment variable or `.env` file. No API keys required for Elexon BMRS.

### Frontend (`frontend/`)

| Variable | Default | Description |
|---|---|---|
| `REACT_APP_API_URL` | `http://127.0.0.1:8000` | Backend base URL |

`frontend/.env` points at the local backend for `npm start`. For a deployed build, set `REACT_APP_API_URL`
in your hosting provider (e.g. Vercel project settings) to the deployed backend URL.

---

## Installation & Execution

### Local development (recommended)

**Backend:**
```bash
cd backend
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt   # runtime + test deps
uvicorn main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm start                      # Runs on http://localhost:3000
```

### Docker Compose

```bash
docker-compose up --build
```

Starts both services: frontend (nginx) on http://localhost, backend on http://localhost:8000.
The browser calls the backend directly at the URL baked in at build time (`REACT_APP_API_URL`); nginx only
serves the static bundle. For a deployed backend, set `ALLOWED_ORIGINS` to your frontend URL.

---

## Automated Tests

### Backend (137 tests, no network)

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest -q
```

Covers: forecast selection (fixed lead + day-ahead decision time incl. BST), accuracy metrics, cache,
circuit breaker, chunked BMRS fetching, and **mocked end-to-end API tests** (fetch → select → merge →
metrics → strict JSON, 304/ETag, validation, 502, graceful forecast outage).

### Frontend (60 tests)

```bash
cd frontend
npm ci
CI=true npm test -- --watchAll=false
npm run build
```

---

## Changelog — production-hardening pass

| # | Issue | Fix |
|---|---|---|
| 1 | `/wind-data` returned **500** whenever forecasts were selected (string vs datetime merge key) | Actuals parsed to UTC datetimes; regression-tested end to end |
| 2 | Backend Docker image crashed (`ImportError`: modules not copied) | `COPY *.py`; tests excluded via `.dockerignore` |
| 3 | `npm ci` failed in the frontend build (lockfile out of sync) | Lockfile regenerated |
| 4 | Cache `get_or_set` deadlock (test suite hung) | Re-entrant lock |
| 5 | Fixed per-slot horizon leaked post-decision forecasts | Day-ahead decision-time model (default) |
| 6 | Missing wind forecast counted as zero in procurement maths (contradicted docs) | Residual is `null`; excluded from all totals |
| 7 | Stale-data bug: 304 handling could show another query's data | Manual ETag logic removed (HTTP cache handles revalidation) |
| 8 | Rate limit shared by all users behind a proxy | Real-client-IP key, configurable limit |
| 9 | Coverage inflated when actuals were missing | Denominator = expected 48 slots/day |
| 10 | Month-long WINDFOR request could time out | Parallel chunked fetch, all-or-nothing |
| 11 | 4xx responses were retried and could trip the circuit breaker | 4xx (except 429) fail fast |
| 12 | `.venv` would be committed; docs claimed an nginx proxy and wrong test counts | `.gitignore`, README corrected |
| 13 | Race condition: a slow earlier response could overwrite a newer query's data | Request-ID guard in `WindDataContext` (only the latest request updates state); regression-tested |
| 14 | Default range (1–7 Jan) included a delivery day decided on 31 Dec, outside January 2026 decisions | Default range is now 2–8 Jan 2026 |
| 15 | `frontend/.env` pointed local development at the production backend | Now points at `http://127.0.0.1:8000`; production URL is set in the hosting provider |
| 16 | Notebook used 2025 dates, `actual − forecast` sign and a single unchunked forecast request | Notebook uses 2 Jan–1 Feb 2026, `Forecast − Actual`, and the same chunked publish window as the backend |
| 17 | Known-vulnerable backend dependencies (starlette via fastapi 0.115.6, requests 2.32.3) | Upgraded and pinned: fastapi 0.162.0, starlette 1.10.0, uvicorn 0.54.0, requests 2.34.2, slowapi 0.1.10; `pip-audit` reports no known vulnerabilities |
| 18 | Per-IP rate limit could be dodged by forging `X-Forwarded-For` | Optional `TRUSTED_PROXY_COUNT` plus a service-wide `GLOBAL_RATE_LIMIT` backstop; tested |
| 19 | `/cache-stats` always public | Optional `STATS_TOKEN` guard (open by default, unchanged) |
| 20 | Unbounded CSV upload; raw client error text shown in the UI | 2 MB upload cap; friendly error messages (API-provided messages still shown) |
| 21 | `npm audit` critical issues in build tooling | `npm audit fix` (non-breaking): 0 critical; runtime libraries clean; remaining items are `react-scripts` build tooling |

## Known Limitations

- **Live BMRS not exercised in CI** — tests use mocked data. Run the “Jan 2026 decisions” preset once against the
  live API before the demo to confirm response times.
- **Notebook** (`analysis/forecast_analysis.ipynb`) now targets January 2026 decisions with `Forecast − Actual`, but its
  saved outputs were cleared. Run all cells against live BMRS, then fill the `TODO` values in the two markdown
  conclusion cells from the printed output before quoting any numbers.
- **Bias correction is in-sample** (see Assumptions) and the planner has no cost model for shortage vs surplus.
- Rate limiter and caches are in-process; use a shared store (e.g. Redis) before scaling beyond one worker.
