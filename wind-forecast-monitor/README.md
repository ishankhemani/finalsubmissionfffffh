# Wind Forecast Monitor

A UK wind-generation forecasting and procurement support app built around live Elexon BMRS data.
The system compares actual wind output against forecast wind output, applies a decision-time selection model, and helps a buyer estimate additional electricity requirement from demand and generation assumptions.

This repository contains a FastAPI backend, a React frontend, a Docker Compose setup, and a notebook for exploratory analysis.

---

## Project status

- Local development: ready
- Docker Compose: ready
- Deployment URLs: to be filled later
- Demo video link: to be filled later
- User guide: see [USER_GUIDE.md](USER_GUIDE.md)

---

## What the app does

- Pulls actual wind generation from BMRS FUELHH
- Pulls forecast wind generation from BMRS WINDFOR
- Selects the correct forecast using either:
  - day-ahead decision time mode (default)
  - fixed lead-time horizon mode
- Computes accuracy metrics such as MAE, RMSE, bias, max shortfall, and coverage
- Shows actual vs forecast time series and error distribution
- Lets the user estimate procurement requirement using demand, wind generation, and other generation inputs
- Supports a Jan 2026 decision set and default day-ahead decision logic

---

## Architecture overview

```text
wind-forecast-monitor/
├── backend/                          FastAPI service
│   ├── main.py                      API routes, validation, caching, merged data response
│   ├── data_fetcher.py             BMRS fetcher with retries and circuit breakers
│   ├── forecast_selector.py        Forecast eligibility logic for decision-time and horizon modes
│   ├── accuracy_metrics.py         Accuracy calculations and forecast error percentiles
│   ├── cache.py                    Bounded TTL/LRU cache implementation
│   ├── circuit_breaker.py          External-call resilience logic
│   ├── test_api.py                 API integration tests
│   ├── test_decision_time.py       Decision-time model tests
│   ├── test_accuracy_metrics.py    Metric tests
│   ├── requirements.txt            Runtime dependencies
│   ├── requirements-dev.txt        Dev + test dependencies
│   └── Dockerfile                  Backend container image
│
├── frontend/                        React frontend
│   ├── Dockerfile                  Frontend production container
│   ├── nginx.conf                 Nginx configuration for static build
│   ├── package.json                Frontend scripts and dependencies
│   ├── build/                      Built static assets (generated output)
│   └── src/
│       ├── App.js                  Main shell and routing
│       ├── components/             ControlPanel, MetricsPanel, WindChart, ErrorChart,
│       │                          ProcurementPlanner, ScenarioPanel, etc.
│       ├── context/                WindDataContext provider and reducer state
│       └── utils/                 Data transforms and procurement calculations
│
├── analysis/
│   └── forecast_analysis.ipynb     Exploratory analysis notebook
├── docker-compose.yml             Runs frontend + backend together
├── LICENSE
└── README.md
```

### Data flow

```text
BMRS Elexon API
    ↓
Backend FastAPI
    ↓
Forecast selection (decision-time or fixed lead time)
    ↓
Metric computation + merged records
    ↓
React context state
    ↓
Charts, metrics panel, procurement planner, scenario panel
```

### State and UI pattern

- Frontend uses React context + reducer for app state management
- Backend returns a merged payload with records and metrics
- Derived chart data and summary metrics are calculated in the frontend utilities
- Procurement planning remains pure and testable via utility functions

---

## Core features

### Forecast analysis

- Actual wind generation vs forecast generation by time slot
- Coverage and forecast availability reporting
- MAE, RMSE, bias, max shortfall, and percentile diagnostics
- Decision-time selection vs fixed-horizon comparison

### Procurement planning

- Demand plus wind forecast based requirement calculation
- Other generation support
- Bias-corrected wind estimate
- Missing demand and missing wind handling without fabricating zero values
- MWh conversion for 30-minute interval sums

### Reliability and resilience

- BMRS fetch retries with backoff
- Circuit breakers for upstream failures
- LRU + TTL caches for repeated requests
- Rate limiting and proxy-aware client IP handling
- Graceful handling of empty forecast data

---

## API overview

The backend exposes these main endpoints:

- `GET /health` — health check and circuit-breaker status
- `GET /wind-data` — merged actual + forecast records and metrics
- `GET /metrics` — metrics-only response
- `GET /cache-stats` — cache and circuit-breaker telemetry

Example calls:

```bash
curl "http://localhost:8000/wind-data?start=2026-01-02&end=2026-01-08&mode=decision&decision_time=09:00"
curl "http://localhost:8000/wind-data?start=2026-01-02&end=2026-01-08&mode=horizon&horizon=24"
curl "http://localhost:8000/health"
```

### Important data semantics

- `time` = delivery slot time
- `publishTime` = when the forecast was issued
- The app uses the forecast publication time to determine eligibility
- Forecast missing is treated as missing, not zero
- Timestamps are handled in UTC internally

---

## Forecast decision logic

The app models a real day-ahead purchasing decision.

### Decision-time mode (default)

For each delivery day D, the model uses the latest forecast published on or before the buyer’s decision cutoff on D-1.

Example:

- Delivery day: 2026-01-10
- Decision time: 09:00 UK local time
- Only forecasts published by 2026-01-09 09:00 are eligible
- Every slot on 2026-01-10 shares the same cutoff

This matches the idea that a procurement decision is made once for the whole delivery day, not separately at each slot.

### Horizon mode

This mode selects a forecast only if it was issued at least `h` hours before the delivery slot.

This is useful for lead-time analysis, but it is not the same as a buying decision made at 09:00 on D-1.

---

## Local run instructions

### 1) Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Backend will be available at:

- http://localhost:8000
- docs at http://localhost:8000/docs

### 2) Frontend

```bash
cd frontend
npm install
npm start
```

Frontend will be available at:

- http://localhost:3000

If you want to point the frontend at a different API base, set:

```bash
REACT_APP_API_URL=http://127.0.0.1:8000
```

or place the value in a local `.env` file inside `frontend/`.

---

## Docker Compose

To run both services together:

```bash
cd wind-forecast-monitor
docker compose up --build
```

The Compose file starts:

- backend on http://localhost:8000
- frontend on http://localhost:3001

Useful commands:

```bash
docker compose up -d

docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
docker compose down
```

### Docker notes

- The backend Dockerfile exposes port 8000
- The frontend Dockerfile builds the React app and serves it with nginx
- The frontend build uses `REACT_APP_API_URL` to target the backend service

---

## Testing

### Backend tests

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
```

The backend tests cover:

- forecast selection logic
- decision-time cutoff behaviour
- accuracy metric calculations
- API response contract
- cache and circuit-breaker behaviour
- mocked end-to-end scenarios

### Frontend tests

```bash
cd frontend
npm install
CI=true npm test -- --watch=false --runInBand
```

---

## Deployment notes

This project is structured to be deployment-friendly, but the live URLs are intentionally left blank for now.
When deploying later, you can add:

- frontend live URL
- backend live URL
- demo video URL
- AI tooling disclosure

The app is designed so deployment mainly requires:

- setting the backend origin in CORS config
- setting the frontend `REACT_APP_API_URL` correctly
- matching the public frontend and backend URLs in your hosting platform

---

## Project assumptions and limitations

- BMRS is used as the upstream data source
- No user authentication is implemented
- Demand and other generation inputs are user-provided
- Forecast uncertainty is illustrative rather than a formal confidence model
- The app is designed for operational analysis and planning support, not direct trade execution

---

## Repo summary

This project brings together:

- Python + FastAPI backend for data retrieval and metrics
- React + Chart.js frontend for analysis and planning
- BMRS data integration with resilience patterns
- Local development and Docker Compose support
- A practical day-ahead procurement decision model tailored to wind generation forecasting

