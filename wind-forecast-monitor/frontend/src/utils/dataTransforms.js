/**
 * dataTransforms.js — pure, side-effect-free functions for deriving chart data
 * and metrics from the raw API response.
 *
 * Sign convention (matches backend accuracy_metrics.py):
 *   Forecast Error = Forecast − Actual
 *   Positive error → wind was OVER-FORECAST (actual < forecast).
 *   Negative error → wind was UNDER-FORECAST (actual > forecast).
 *
 * None of these functions mutate their inputs.
 */

/**
 * Format a UTC timestamp into a short locale string for chart X-axis labels.
 * @param {string} isoString
 * @returns {string}
 */
export function formatLabel(isoString) {
  // BUG-07 FIX: BMRS timestamps are UTC. Without timeZone:'UTC', toLocaleString()
  // converts to the user's local timezone (e.g. IST = +5:30), shifting every
  // half-hour slot label by the user's UTC offset. This caused a mismatch between
  // the chart x-axis and the UTC times shown in the procurement table.
  return new Date(isoString).toLocaleString("en-GB", {
    timeZone: "UTC",
    month:    "short",
    day:      "2-digit",
    hour:     "2-digit",
    minute:   "2-digit",
  });
}

/**
 * Build the main Chart.js dataset object (actual vs forecast + error line).
 * Returns null when rawData is empty/null so the chart doesn't render.
 *
 * @param {Array<{time:string, actual:number, forecast:number|null}>} rawData
 * @returns {{labels:string[], datasets:object[]}|null}
 */
export function buildChartData(rawData) {
  if (!rawData || rawData.length === 0) return null;

  const labels   = rawData.map((d) => formatLabel(d.time));
  const actual   = rawData.map((d) => d.actual);
  const forecast = rawData.map((d) =>
    d.forecast !== undefined && d.forecast !== null ? d.forecast : null
  );
  // Signed error (Forecast − Actual); null where forecast is missing.
  const error = rawData.map((d) =>
    d.forecast != null ? Math.round(d.forecast - d.actual) : null
  );

  return {
    labels,
    datasets: [
      {
        label:           "Actual Generation (MW)",
        data:            actual,
        borderColor:     "#38bdf8",
        backgroundColor: "rgba(56,189,248,0.08)",
        borderWidth:     2,
        pointRadius:     0,
        pointHoverRadius: 4,
        tension:         0.3,
        order:           1,
      },
      {
        label:           "Forecast Generation (MW)",
        data:            forecast,
        borderColor:     "#34d399",
        backgroundColor: "rgba(52,211,153,0.08)",
        borderWidth:     2,
        pointRadius:     0,
        pointHoverRadius: 4,
        spanGaps:        true,
        tension:         0.3,
        order:           2,
      },
      {
        label:           "Forecast Error (MW)",
        data:            error,
        borderColor:     "#fbbf24",
        backgroundColor: "rgba(251,191,36,0.06)",
        borderWidth:     1.5,
        borderDash:      [5, 4],
        pointRadius:     0,
        pointHoverRadius: 3,
        spanGaps:        true,
        tension:         0.2,
        order:           3,
      },
    ],
  };
}

/**
 * Build the forecast error distribution (histogram) from raw data.
 * Bins errors into 100 MW buckets.
 *
 * @param {Array} rawData
 * @param {number} [binWidth=100] — bin width in MW
 * @returns {{labels:string[], datasets:object[]}|null}
 */
export function buildErrorDistribution(rawData, binWidth = 100) {
  if (!rawData || rawData.length === 0) return null;

  const errors = rawData
    .filter((d) => d.forecast != null && d.actual != null)
    .map((d) => d.forecast - d.actual);

  if (errors.length === 0) return null;

  const minVal = Math.floor(Math.min(...errors) / binWidth) * binWidth;
  const maxVal = Math.ceil(Math.max(...errors) / binWidth) * binWidth;
  const bins   = [];
  const counts = [];

  for (let edge = minVal; edge < maxVal; edge += binWidth) {
    const lo = edge;
    const hi = edge + binWidth;
    bins.push(`${lo >= 0 ? "+" : ""}${lo} to ${hi >= 0 ? "+" : ""}${hi}`);
    counts.push(errors.filter((e) => e >= lo && e < hi).length);
  }

  return {
    labels: bins,
    datasets: [
      {
        label:           "Frequency",
        data:            counts,
        backgroundColor: counts.map((_, i) => {
          // Colour positive-error bars amber, negative-error bars sky
          const midpoint = minVal + i * binWidth + binWidth / 2;
          return midpoint > 0
            ? "rgba(251,191,36,0.5)"
            : "rgba(56,189,248,0.5)";
        }),
        borderColor: counts.map((_, i) => {
          const midpoint = minVal + i * binWidth + binWidth / 2;
          return midpoint > 0 ? "#fbbf24" : "#38bdf8";
        }),
        borderWidth: 1,
      },
    ],
  };
}

/**
 * Compute the percentile value from an array.
 * @param {number[]} sorted - pre-sorted array
 * @param {number} p - percentile 0–100
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Compute all summary accuracy metrics from raw API rows.
 * Returns null if no paired rows exist.
 *
 * Metrics:
 *   mae          — Mean Absolute Error (MW)
 *   rmse         — Root Mean Squared Error (MW)
 *   bias         — Mean Forecast Bias = mean(Forecast − Actual) (MW)
 *                  Positive → systematic over-forecast; negative → under-forecast
 *   maxShortfall — max(Forecast − Actual, 0) = worst single under-delivery (MW)
 *   coverage     — % of slots with a valid forecast (paired / total × 100)
 *   nValid       — count of intervals with both actual + forecast
 *   nTotal       — total intervals in the response
 *   errorPctls   — {p10, p25, p50, p75, p90} of (Forecast − Actual)
 *
 * @param {Array} rawData
 * @returns {object|null}
 */
export function buildMetrics(rawData) {
  if (!rawData || rawData.length === 0) return null;

  const paired    = rawData.filter((d) => d.forecast != null && d.actual != null);
  const nTotal    = rawData.length;
  const nValid    = paired.length;
  const coverage  = nTotal > 0 ? Math.round((nValid / nTotal) * 100) : null;

  if (nValid === 0) {
    return { mae: null, rmse: null, bias: null, maxShortfall: null, coverage, nValid, nTotal, errorPctls: null };
  }

  const errors  = paired.map((d) => d.forecast - d.actual);
  const absErrs = errors.map(Math.abs);

  const mae = Math.round(absErrs.reduce((a, b) => a + b, 0) / nValid);

  const mse  = errors.reduce((a, e) => a + e * e, 0) / nValid;
  const rmse = Math.round(Math.sqrt(mse));

  const bias = Math.round(errors.reduce((a, b) => a + b, 0) / nValid);

  const maxShortfall = Math.round(Math.max(0, ...errors.map((e) => Math.max(e, 0))));

  const sorted = [...errors].sort((a, b) => a - b);
  const errorPctls = {
    p10: Math.round(percentile(sorted, 10)),
    p25: Math.round(percentile(sorted, 25)),
    p50: Math.round(percentile(sorted, 50)),
    p75: Math.round(percentile(sorted, 75)),
    p90: Math.round(percentile(sorted, 90)),
  };

  return { mae, rmse, bias, maxShortfall, coverage, nValid, nTotal, errorPctls };
}

/**
 * Build scenario offsets from historical error percentiles.
 * These are ILLUSTRATIVE scenarios — not statistically validated confidence intervals.
 *
 * Methodology:
 *   - Lower wind scenario: forecast adjusted by the p10 error
 *     (i.e. in 10% of historical intervals actual generation exceeded
 *      forecast by at least this amount → conservative scenario for buyer)
 *   - Central scenario:    forecast as published (p50 error ≈ 0 for unbiased forecasters)
 *   - Upper wind scenario: forecast adjusted by the p90 error
 *
 * @param {object|null} errorPctls — {p10, p25, p50, p75, p90}
 * @returns {{lower:number, central:number, upper:number}|null}
 */
export function buildScenarioOffsets(errorPctls) {
  if (!errorPctls) return null;
  // Lower wind = forecast minus the p90 error (worst over-forecast)
  // Upper wind = forecast minus the p10 error (largest under-forecast)
  return {
    lower:   -(errorPctls.p90 ?? 0), // subtract over-forecast to get lower actual
    central: -(errorPctls.p50 ?? 0),
    upper:   -(errorPctls.p10 ?? 0),
  };
}


/**
 * Human-readable description of how forecasts were selected.
 *   decision mode → "Decision 09:00 (D-1)"
 *   horizon mode  → "24h lead time"
 */
export function forecastBasisLabel(mode, horizon, decisionTime) {
  if (mode === "horizon") return `${horizon}h lead time`;
  return `Decision ${decisionTime || "09:00"} (D-1)`;
}

/**
 * Return the latest non-null forecast publication time across the selected rows.
 * This is the evidence the UI can show the user about which forecast revision
 * was actually used for the selected data slice.
 *
 * @param {Array<{forecast:number|null, publishTime:string|null}>} rawData
 * @returns {string|null}
 */
export function getLatestForecastPublishTime(rawData) {
  if (!Array.isArray(rawData) || rawData.length === 0) return null;

  const validTimes = rawData
    .filter((d) => d.forecast != null && d.publishTime)
    .map((d) => new Date(d.publishTime).getTime())
    .filter((ts) => Number.isFinite(ts));

  if (validTimes.length === 0) return null;
  return new Date(Math.max(...validTimes)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Human-friendly display for the selected forecast publication timestamp.
 * @param {string|null} isoPublishTime
 * @returns {string|null}
 */
export function formatForecastPublishTime(isoPublishTime) {
  if (!isoPublishTime) return null;
  return new Date(isoPublishTime).toLocaleString("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
