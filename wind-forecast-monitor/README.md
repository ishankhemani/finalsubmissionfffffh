# Wind Forecast Monitor

A UK wind-generation forecasting and procurement support application built around live Elexon BMRS data. The system compares actual wind output against forecast wind output, applies a decision-time selection model, and helps a buyer estimate how much additional electricity is needed after accounting for demand, wind generation, and other generation sources.

This repository contains:

- a FastAPI backend for BMRS data acquisition, validation, and API exposure
- a React frontend for visual exploration and procurement planning
- Docker Compose configuration for local orchestration
- a notebook for analysis and experimentation
- a client-facing guide in [USER_GUIDE.md](USER_GUIDE.md)

---

## Project purpose

This is not just a dashboard. It is a decision-support tool for operational procurement planning.

The system models the real-world challenge faced by a buyer or planner:

- How much wind is expected to arrive during each delivery interval?
- What is the forecast bias compared with actual output?
- How much demand must be served after wind and other generation are considered?
- What is the likely procurement requirement, surplus, or net imbalance for a day?

The app is designed around the commercial reality that procurement decisions are made at a known decision time, not at every individual slot independently.

---

## What the app does

### Forecast and validation layer

- pulls actual wind generation data from BMRS FUELHH
- pulls published forecast data from BMRS WINDFOR
- filters forecast data using decision-time logic or a fixed lead-time horizon
- compares actual vs forecast across time slots
- calculates key errors and accuracy metrics such as MAE, RMSE, bias, max shortfall, and coverage

### Procurement planning layer

- allows users to provide or estimate demand, wind, and other generation values
- applies historical forecast bias correction before calculating expected wind delivery
- calculates per-interval residuals and procurement need
- distinguishes between missing data and zero generation so the system does not invent missing forecast values as zero wind
- converts power values to MWh using 30-minute interval assumptions

### User experience layer

- charts actual vs forecast generation
- highlights forecast error and reliability signals
- shows the daily wind and demand summary
- provides an operational procurement planner and a scenario summary
- keeps business logic in pure utility functions so that it remains testable and easy to reason about

---

## System architecture

```text
wind-forecast-monitor/
├── backend/
│   ├── main.py                       FastAPI entrypoint, routes, validation, response assembly
│   ├── data_fetcher.py               BMRS fetch orchestration, retry logic, data shaping
│   ├── forecast_selector.py          Forecast eligibility logic for decision-time and horizon modes
│   ├── accuracy_metrics.py           Error metrics and scoring functions
│   ├── cache.py                      Thread-safe TTL/LRU cache for repeated API work
│   ├── circuit_breaker.py            Resilience wrapper around upstream dependencies
│   ├── Dockerfile                    Backend container image
│   ├── requirements.txt              Runtime dependencies
│   ├── requirements-dev.txt          Dev and test dependencies
│   ├── test_api.py                   API tests
│   ├── test_decision_time.py         Decision-time and horizon selection tests
│   ├── test_accuracy_metrics.py      Accuracy metric tests
│   ├── test_cache.py                 Cache tests
│   ├── test_circuit_breaker.py       Circuit-breaker tests
│   ├── test_forecast_selector.py     Forecast selection validation
│   └── test_decision_time.py         Additional decision logic checks
│
├── frontend/
│   ├── Dockerfile                    Front-end runtime container
│   ├── nginx.conf                    Nginx configuration for production static serving
│   ├── package.json                  Frontend package and scripts
│   ├── public/
│   ├── src/
│   │   ├── App.js                    Main shell, routes, and overall layout
│   │   ├── components/               UI sections: header, panels, planner, chart blocks
│   │   ├── context/
│   │   │   └── WindDataContext.js    Global data provider and reducer-based state
│   │   ├── utils/
│   │   │   ├── dataTransforms.js     Data reshaping and chart preparation
│   │   │   ├── procurementCalcs.js   Core business logic for residuals and procurement
│   │   │   └── ... tests
│   │   ├── index.js
│   │   ├── App.css
│   │   ├── index.css
│   │   └── setupTests.js
│   └── build/                       Production build output (generated)
│
├── analysis/
│   └── forecast_analysis.ipynb      Exploratory analysis notebook
├── docker-compose.yml                Local orchestration for backend and frontend
├── USER_GUIDE.md                     Client-facing explanation and methodology guide
├── LICENSE
├── README.md
└── .gitignore
```

---

## Layered design

### 1. Data ingestion

The backend reads BMRS information from upstream Elexon services. It normalizes the payload into a consistent internal model so the rest of the application can reason about one data contract instead of several provider-specific shapes.

### 2. Forecast selection

Before the app compares actual and forecast values, it chooses which forecast is eligible.

Key idea:

- a buyer does not choose a forecast slot-by-slot in a vacuum
- the procurement decision is made at a known decision time
- therefore, the model works with the latest eligible forecast before the cutoff

This is enforced by the logic in `backend/forecast_selector.py` and validated in the test suite.

### 3. Metric computation

The app computes aggregate quality indicators such as:

- MAE
- RMSE
- forecast bias
- max shortfall
- coverage metrics

This data is exposed via the backend API and displayed in the frontend for the analysis screen.

### 4. Procurement planning

The procurement planner uses a separate pure logic layer in `frontend/src/utils/procurementCalcs.js` to compute:

- residual = demand − expected wind − other generation
- requirement = max(residual, 0)
- surplus = max(−residual, 0)
- MWh totals for 30-minute intervals

This keeps the financial logic independent from UI rendering and makes it easier to validate with unit tests.

### 5. Presentation and interaction

The React app uses a provider-based state model to keep the data flow simple:

- the backend fetches and returns a merged dataset
- the provider stores that dataset in context
- the UI reads from that state and renders charts, metrics, and the procurement planner

---

## Key engineering decisions

### 1. Decision-time logic instead of raw latest forecast

This is a core design choice.

The app does not simply take the most recent forecast on the delivery day. Instead, it models a real procurement decision:

- each delivery day is evaluated with a decision deadline
- only forecasts published on or before the cutoff are valid
- within that decision window, the latest eligible forecast is chosen

Why this matters:

- it matches operational practice
- it prevents hindsight bias
- it avoids using a forecast that was not yet available at the decision point

### 2. Missing forecast values are treated as missing, not zero

This is a critical safety rule.

If the wind forecast is unavailable for an interval, the system does not substitute zero generation. That would artificially increase the apparent requirement and create a false procurement signal.

This is a deliberate business decision to avoid overstating need in uncertain periods.

### 3. Bias correction is applied before residual calculation

The project explicitly assumes that historical forecast bias affects expected actual wind output.

The logic is:

- bias = mean(forecast − actual)
- expected wind = max(forecast − bias, 0)

This is designed to account for systematic over-forecasting or under-forecasting.

### 4. Summary metric and interval-level metric are separated

The app keeps both views available:

- interval decomposition: shows where each slot is short or surplus
- net daily balance: shows the operational position for procurement decisions

This is important because a day can have some shortfall intervals and some surplus intervals at the same time. A summary that tries to treat those as mutually exclusive can be misleading.

### 5. Pure functions for business logic

Most procurement calculations live in frontend utility functions instead of UI components.

This keeps the logic:

- easy to test
- easy to review
- safe to refactor
- independent from rendering details

### 6. Resilience over raw network calls

The backend includes:

- retries
- circuit breakers
- caching
- guardrails for empty or invalid response payloads

This matters because BMRS data can be incomplete or slow, and production systems need predictable failover and clean error states.

---

## Data flow in practice

```text
User selects date / mode / decision time
        ↓
Frontend requests /wind-data from backend
        ↓
Backend validates request parameters
        ↓
Forecast selector decides eligible forecast set
        ↓
Data fetcher retrieves actual + forecast series
        ↓
Accuracy metrics are computed
        ↓
Merged dataset is returned as JSON
        ↓
Frontend renders charts, metrics, and procurement plan
```

The actual architecture is intentionally split into:

- API and upstream logic in Python
- planning logic in pure JavaScript utilities
- display in React components

This split improves validation and makes the model easier to audit.

---

## API overview

The backend exposes the main endpoints below.

### Health and diagnostics

- `GET /health` — verifies the backend is running and reports system health
- `GET /cache-stats` — returns cache and circuit-breaker operational stats

### Data endpoints

- `GET /wind-data` — main endpoint for forecast + actual + metrics payload
- `GET /metrics` — service-level metrics response for analysis screens

### Query parameters

Depending on the mode, the API accepts:

- `start` and `end` dates
- `mode=decision` or `mode=horizon`
- `decision_time` for D-1 decision cutoff logic
- `horizon` for fixed lead-time mode

### Example calls

```bash
curl "http://localhost:8000/health"
curl "http://localhost:8000/wind-data?start=2026-01-02&end=2026-01-08&mode=decision&decision_time=09:00"
curl "http://localhost:8000/wind-data?start=2026-01-02&end=2026-01-08&mode=horizon&horizon=24"
```

---

## Core file knowledge

### Backend

#### `backend/main.py`

This is the main API layer. It is responsible for:

- request validation
- data fetch orchestration
- applying response sanitization
- serving the merged data payload
- coordinating cache and circuit-breaker behaviour
- exposing JSON-safe payloads for frontend consumption

#### `backend/forecast_selector.py`

This file defines the forecast eligibility logic.

It decides whether a published forecast is valid according to:

- decision-time selection
- fixed horizon selection
- publication time eligibility

This is the most important logic for representing a real operating decision process.

#### `backend/data_fetcher.py`

This reads upstream BMRS data and normalizes it into a consistent set of records.

It is responsible for:

- request execution
- error recovery
- deduplication and time window extraction
- data shaping before response assembly

#### `backend/accuracy_metrics.py`

This computes accuracy metrics for actual vs forecast performance.

It is used for error diagnostics and for comparing how effective the forecast is over a chosen period.

#### `backend/cache.py`

This implements a bounded in-memory cache.

It keeps repeated requests efficient while preventing unbounded memory growth.

#### `backend/circuit_breaker.py`

This is the resilience layer for upstream calls.

It protects the service from repeated failures when BMRS is slow or temporarily unavailable.

### Frontend

#### `frontend/src/context/WindDataContext.js`

This is the central state provider.

It is responsible for:

- fetching the data from the backend
- maintaining app state
- managing loading and error states
- exposing the data to the rest of the React application

#### `frontend/src/utils/procurementCalcs.js`

This is the most important business logic file.

It contains:

- `applyBiasCorrection`
- `calcResidual`
- `calcRequirement`
- `calcSurplus`
- `calcMWh`
- `processProcurementPlan`

This file is the canonical source of the procurement logic. It is intentionally kept pure so it can be tested independently of the UI.

#### `frontend/src/components/ProcurementPlanner.js`

This is the user-facing planner component.

It renders:

- total demand
- expected wind delivery
- demand vs wind gap
- requirement/surplus cards
- interval-level detail table
- explanatory notes for missing forecast slots

#### `frontend/src/App.js`

This defines the overall app shell, navigation, and route structure.

---

## Local development

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Then open:

- http://localhost:8000
- http://localhost:8000/docs

### Frontend

```bash
cd frontend
npm install
npm start
```

Then open:

- http://localhost:3000

### Using Docker Compose

```bash
docker compose up --build
```

The stack exposes:

- backend: http://localhost:8000
- frontend: http://localhost:3001

Useful commands:

```bash
docker compose down
docker compose logs -f backend
docker compose logs -f frontend
docker compose ps
```

---

## Environment variables

The app depends on a small number of runtime variables.

### Frontend

```bash
REACT_APP_API_URL=http://127.0.0.1:8000
```

This should point to the backend origin used by the frontend application.

### Backend

The backend should allow the frontend origin via CORS configuration, usually through an environment variable such as:

```bash
ALLOWED_ORIGINS=http://localhost:3000,https://your-frontend-domain.com
```

This is important for production deployment and browser-based cross-origin requests.

---

## Testing

### Backend

```bash
cd backend
source .venv/bin/activate
pytest -q
```

Key areas covered:

- data-fetch validation
- forecast selection logic
- D-1 decision cutoff rules
- metrics accuracy
- cache behaviour
- circuit-breaker protection

### Frontend

```bash
cd frontend
CI=true npm test -- --watch=false --runInBand
```

The frontend tests cover the procurement helpers and core logic that drive the planner summary.

---

## Deployment guidance

This project is designed to be deployable in a standard split-stack pattern.

### Recommended production split

- Frontend: Vercel / static hosting
- Backend: Render / Railway / a Python container host

### Required configuration

- set frontend `REACT_APP_API_URL` to the deployed backend URL
- set backend CORS allowed origins to the frontend domain
- ensure no trailing `/` is accidentally appended to the API base URL

A common production bug is having a double path such as:

```text
https://frontend-domain.com//wind-data
```

This can happen when an API URL string ends with a trailing slash. The value should be the clean origin only.

---

## Important operational assumptions

- BMRS is the upstream source of truth for actual and forecast data
- demand and other generation values are user-entered inputs
- the system assumes 30-minute intervals for power-to-energy conversion
- data gaps are not treated as zero output unless explicitly defined by the user
- forecast eligibility is tied to publication time and decision cutoff, not simply to the latest available value

---

## Known project strengths

- clear separation between data layer, business logic, and UI
- strong validation around forecasting decision logic
- pure business logic that is testable without UI dependencies
- explicit handling of missing data rather than silently forcing zero values
- resilience patterns around upstream BMRS failures

---

## Limitations and future extension opportunities

- no authentication or role-based access control currently implemented
- live BMRS access depends on upstream availability and network access
- some client-specific assumptions are encoded as business configuration rather than dynamic generalization
- the planner is optimized for a single decision-time procurement workflow and can be extended to more advanced portfolio scenarios later

---

## User guide

For a client-friendly explanation of how the model works, see [USER_GUIDE.md](USER_GUIDE.md).

---

## Summary

This project combines:

- BMRS forecast validation
- real decision-time forecast selection
- bias-corrected wind estimation
- demand and supply forecasting for procurement planning
- a clean split between backend logic, frontend UI, and testable calculation utilities

It is designed to support a practical operational decision: how much additional power needs to be secured after considering expected wind and other available generation.
