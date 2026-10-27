# Wind Forecast Monitor — User Guide

This guide explains the app in plain language, including the logic behind the forecast selection and the procurement calculations.

---

## 1) What the app is for

The app helps a buyer understand:

- how much wind generation is expected for a delivery period
- how accurate the forecast was in the past
- what forecast was actually available at the decision time
- how much additional electricity may be required to meet demand

It combines:

- BMRS actual wind generation data
- BMRS forecast wind generation data
- a decision-time model for day-ahead purchasing
- calculation of forecast errors and procurement requirement

---

## 2) How the app works, step by step

### Step 1 — Load actual data
The app pulls actual wind generation from BMRS FUELHH.

- This is the real delivered generation for each half-hour slot
- It is the “actual” line in the chart

### Step 2 — Load forecast data
The app pulls forecast wind generation from BMRS WINDFOR.

- This is the forecasted generation for each time slot
- Each forecast also includes a `publishTime`, which tells you when the forecast was issued

### Step 3 — Select the right forecast
The key question is not “what is the latest forecast in the data?” but rather:

- “Which forecast was available at the time the buying decision was made?”

That is why the app uses a decision-time cutoff.

### Step 4 — Compare forecast vs actual
Once the selected forecast is matched to the actual delivery slot, the app calculates:

- forecast error = forecast − actual
- absolute error
- average error (bias)
- coverage rate

### Step 5 — Estimate procurement need
The user can enter demand and other generation assumptions.

The app then estimates the additional electricity needed to cover residual demand after accounting for wind generation.

---

## 3) The decision logic: how the forecast is chosen

### Decision-time mode (default)
This is the default and most realistic model.

For a delivery day D, the app assumes the buyer decides on day D-1 at a fixed time, such as 09:00.

Only forecasts published on or before that cutoff are eligible.

So the logic is:

- choose the delivery day
- choose the cutoff time for the buyer
- include only forecasts published before that time
- pick the latest eligible forecast for each slot

Example:

- delivery day = 2026-01-10
- decision time = 09:00
- only forecasts published by 2026-01-09 09:00 are valid
- if several forecast revisions exist, the latest one before the cutoff wins

This is the operational model for a day-ahead procurement decision.

### Horizon mode
This is a lead-time test, not a buyer decision model.

It selects a forecast only if it was issued at least a chosen number of hours before the delivery time.

Example:

- horizon = 24 hours
- forecast must have been published at least 24 hours before the slot

This is useful for analysis, but it is not the same as a real decision-time purchase.

---

## 4) Why publish time matters

The app tracks both:

- delivery time (`time`) — when the electricity is delivered
- publication time (`publishTime`) — when the forecast was issued

These are different concepts.

A forecast can target a delivery slot in the future, but it may only become available later.

If the app used the delivery slot itself as the selection cutoff, it would be wrong; it would effectively allow future information to influence earlier decisions.

This is why the app uses `publishTime` as the gating factor.

---

## 5) Metrics explained simply

The app reports the following accuracy indicators:

### MAE
Average absolute error in MW.

- tells you the average size of the forecast miss
- lower is better

### RMSE
Root mean squared error.

- penalises large misses more than MAE
- useful when large forecast errors are costly

### Bias
Mean forecast error.

Formula:

- bias = mean(forecast − actual)

Interpretation:

- positive bias = forecast is too high on average
- negative bias = forecast is too low on average

### Max shortfall
The largest single interval where forecast exceeded actual wind delivery.

This is a useful stress indicator for worst-case under-supply.

### Coverage
Percentage of intervals with a valid forecast.

Missing forecast is not treated as zero generation.

---

## 6) Procurement calculation logic

This is the main business calculation in the app.

### Step 1 — bias correction
The app estimates historical bias using the loaded data:

- bias = mean(forecast − actual)

If bias is positive, the forecaster is over-predicting wind on average.

The app then adjusts the expected wind as:

- expected wind = max(forecast − bias, 0)

This is the best single-point estimate of what wind is likely to arrive.

### Step 2 — residual demand
For each half-hour slot:

- residual = demand − expected wind − other generation

This tells you how much net shortfall remains after expected wind and any other generation are considered.

### Step 3 — additional requirement

- requirement = max(residual, 0)

If residual is negative, there is no additional requirement; the market is in surplus for that slot.

### Step 4 — surplus

- surplus = max(−residual, 0)

This captures the amount by which supply would exceed demand.

### Step 5 — energy conversion
Each 30-minute interval is 0.5 hours.

So:

- energy (MWh) = power (MW) × 0.5

This is why the app converts totals from MW into MWh by multiplying by 0.5 for each half-hour period.

---

## 7) Important rule: missing values are never treated as zero

This is a critical design decision.

If a forecast is missing, the app does not assume the wind is zero.

That means:

- missing wind = unknown, not zero
- missing demand = interval is not computable
- missing forecast slots are excluded from totals

This avoids systematically overstating additional requirement.

---

## 8) How the app interprets the results

### Forecast view
The chart shows:

- actual generation
- selected forecast generation
- forecast error over time

This helps answer: “Was the forecast close to real delivery?”

### Metrics view
This shows summary accuracy such as:

- MAE
- RMSE
- Bias
- Max shortfall
- Coverage

### Procurement view
This shows estimated additional requirement based on:

- demand
- expected wind after bias correction
- other generation

This is used for planning, not as a guaranteed trading instruction.

---

## 9) Practical interpretation for a user

A buyer should read the app like this:

- Forecast basis tells you what information was actually available at decision time
- Bias tells you whether the forecast tends to overstate or understate wind
- Requirement tells you how much extra electricity may be needed after expected wind is considered
- Coverage tells you how much of the period had a valid forecast available

If bias is positive, the app assumes the forecast is optimistic and reduces expected wind before calculating procurement need.

---

## 10) Assumptions and limits

The app is designed for analysis and planning support, not as a final procurement order engine.

It assumes:

- demand inputs are supplied by the user
- other generation is optional and defaults to zero when not entered
- historical bias is estimated from the loaded window and is therefore in-sample
- scenario ranges are illustrative, not legal or statistical guarantees

---

## 11) In one sentence

The app evaluates wind forecasts as a real procurement decision would, then converts that information into expected wind, forecast error, and additional electricity requirement using the bias-adjusted, missing-safe logic implemented in the code.
