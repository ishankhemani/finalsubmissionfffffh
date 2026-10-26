/**
 * procurementCalcs.js — Pure, testable procurement calculation functions.
 *
 * All functions operate on half-hourly (30-minute) interval data.
 *
 * Unit conventions:
 *   - All power values in MW.
 *   - Energy is always in MWh.
 *   - One 30-minute interval: Energy (MWh) = Power (MW) × 0.5 h.
 *
 * Procurement model:
 *   1. WINDFOR gives a published forecast for each delivery slot.
 *   2. Historical bias = mean(Forecast − Actual) over the loaded period.
 *      If bias > 0, the forecaster tends to over-predict wind.
 *   3. Bias-adjusted expected wind = max(Forecast − Bias, 0)
 *      This is the best single-point estimate of what will actually arrive.
 *   4. Residual(t) = Demand(t) − ExpectedWind(t) − OtherGeneration(t)
 *   5. Requirement(t) = max(Residual(t), 0)   (null if demand or wind is missing)
 *   6. Surplus(t)     = max(−Residual(t), 0)
 *   7. Energy (MWh)   = Σ MW × 0.5 h
 *
 * The bias correction is the KEY insight: using raw forecast understates
 * how much additional electricity you need to procure when the forecaster
 * is systematically optimistic about wind.
 */

/**
 * Apply historical bias correction to a single forecast value.
 *
 * bias = mean(Forecast − Actual) over the calibration period.
 * A positive bias means the forecaster over-predicts wind on average.
 * Subtracting bias gives the best estimate of actual wind delivery.
 *
 * @param {number|null} forecast  — published WINDFOR forecast (MW)
 * @param {number}      bias      — historical mean bias (MW); default 0 (no correction)
 * @returns {number|null}         — bias-adjusted expected wind (MW), floored at 0
 */
export function applyBiasCorrection(forecast, bias = 0) {
  if (forecast === null || forecast === undefined || isNaN(forecast)) return null;
  return Math.max(0, forecast - bias);
}

/**
 * Calculate per-interval residual requirement.
 *
 * @param {number|null} demand  — total electricity demand (MW)
 * @param {number|null} wind    — wind generation (MW, bias-adjusted or raw)
 * @param {number|null} other   — other available generation (MW); null → 0
 * @returns {number|null}       — residual in MW; null if demand OR wind is missing
 */
export function calcResidual(demand, wind, other) {
  if (demand === null || demand === undefined || isNaN(demand)) return null;
  // A missing wind forecast is UNKNOWN, not zero. Treating it as zero would
  // overstate the amount to buy, so the interval is not computable.
  if (wind === null || wind === undefined || isNaN(wind)) return null;
  // Other generation is an optional user input; unset means "none assumed".
  const o = (other !== null && other !== undefined && !isNaN(other)) ? other : 0;
  return demand - wind - o;
}

/**
 * Additional electricity requirement = max(residual, 0).
 * Returns null if residual is null.
 *
 * @param {number|null} residual
 * @returns {number|null}
 */
export function calcRequirement(residual) {
  if (residual === null || residual === undefined) return null;
  return Math.max(residual, 0);
}

/**
 * Potential surplus = max(−residual, 0).
 * Returns null if residual is null.
 *
 * @param {number|null} residual
 * @returns {number|null}
 */
export function calcSurplus(residual) {
  if (residual === null || residual === undefined) return null;
  return Math.max(-residual, 0);
}

/**
 * Convert an array of 30-minute power values (MW) to total energy (MWh).
 *
 * @param {Array<number|null>} mwValues — array of MW values per 30-min slot
 * @returns {number} total MWh (null values treated as 0)
 */
export function calcMWh(mwValues) {
  if (!mwValues || mwValues.length === 0) return 0;
  const sum = mwValues.reduce((acc, v) => acc + (v != null ? v : 0), 0);
  return sum * 0.5;  // Each slot is 0.5 hours
}

/**
 * Process a full set of half-hourly intervals and compute procurement plan.
 *
 * KEY: Pass `bias` (from buildMetrics) so that each interval's wind is
 * corrected before the residual is computed. If bias is null or 0, the
 * calculation falls back to using the raw forecast (no correction).
 *
 * @param {Array<{
 *   time: string,
 *   demand: number|null,
 *   wind: number|null,     — raw WINDFOR forecast
 *   other: number|null,
 *   windSource: string
 * }>} intervals
 *
 * @param {number} [bias=0] — historical mean bias MW (Forecast − Actual).
 *   Positive = forecaster over-predicts wind; subtract from forecast.
 *
 * @returns {{
 *   intervals: Array,       — per-interval results with both raw + adjusted wind
 *   summary: {
 *     totalDemandMWh:             number,
 *     totalWindForecastMWh:       number,   — raw forecast
 *     totalWindExpectedMWh:       number,   — bias-adjusted expected
 *     totalOtherMWh:              number,
 *     totalRequirementMWh:        number,   — based on bias-adjusted wind
 *     totalSurplusMWh:            number,
 *     nComplete:                  number,
 *     nMissingDemand:             number,
 *     nMissingWind:               number,
 *     biasApplied:                number,   — bias value that was used
 *   }
 * }}
 */
export function processProcurementPlan(intervals, bias = 0) {
  let nComplete      = 0;
  let nMissingDemand = 0;
  let nMissingWind   = 0;

  const processed = intervals.map((row) => {
    const missingDemand = row.demand === null || row.demand === undefined || isNaN(row.demand);
    const missingWind   = row.wind   === null || row.wind   === undefined || isNaN(row.wind);

    if (missingDemand) nMissingDemand++;
    if (missingWind)   nMissingWind++;
    if (!missingDemand && !missingWind) nComplete++;

    // Bias-adjusted expected wind: what we expect to actually be delivered
    const windExpected = applyBiasCorrection(row.wind, bias);

    // Residual is computed against the bias-adjusted wind, not raw forecast
    const residual    = calcResidual(row.demand, windExpected, row.other);
    const requirement = calcRequirement(residual);
    const surplus     = calcSurplus(residual);

    return {
      ...row,
      windForecast: row.wind,      // Raw WINDFOR published forecast
      windExpected,                // Bias-adjusted expected actual
      residual,
      requirement,
      surplus,
    };
  });

  // All summary totals use the SAME set of intervals (complete = both demand and
  // wind forecast available). This is the invariant stated in the README:
  // "all totals refer to the same set of intervals."
  // A missing wind forecast makes the residual null, so that interval is excluded
  // from EVERY total — demand included. The warning banner already tells the user
  // how many unforecasted slots exist (nMissingWind).
  const complete     = processed.filter((r) => r.residual !== null);

  const demandVals   = complete.map((r) => r.demand);
  const forecastVals = complete.map((r) => r.windForecast);
  const expectedVals = complete.map((r) => r.windExpected);
  const otherVals    = complete.map((r) => r.other);
  const reqVals      = complete.map((r) => r.requirement);
  const surplusVals  = complete.map((r) => r.surplus);

  return {
    intervals: processed,
    summary: {
      totalDemandMWh:        calcMWh(demandVals),      // all demand slots
      totalWindForecastMWh:  calcMWh(forecastVals),    // complete slots only (raw WINDFOR)
      totalWindExpectedMWh:  calcMWh(expectedVals),    // complete slots only (bias-corrected)
      totalOtherMWh:         calcMWh(otherVals),
      totalRequirementMWh:   calcMWh(reqVals),
      totalSurplusMWh:       calcMWh(surplusVals),
      nComplete,
      nMissingDemand,
      nMissingWind,
      biasApplied: bias,
    },
  };
}

/**
 * Apply a scenario offset to all wind values in a procurement plan.
 * Used for lower/central/upper wind generation scenarios.
 *
 * @param {Array} intervals — base intervals
 * @param {number} offset   — MW adjustment to add to wind values (can be negative)
 * @param {string} scenarioLabel — label for this scenario
 * @returns {Array} — new intervals array with adjusted wind values
 */
export function applyScenarioOffset(intervals, offset, scenarioLabel) {
  return intervals.map((row) => ({
    ...row,
    wind: row.wind != null ? Math.max(0, row.wind + offset) : row.wind,
    windSource: scenarioLabel,
  }));
}

/**
 * Parse a CSV string of demand data into half-hourly intervals.
 * Expected format (header optional):
 *   time,demand,other
 *   2026-01-15T00:00:00Z,5000,1000
 *
 * @param {string} csvText
 * @returns {{ intervals: Array, errors: string[] }}
 */
export function parseDemandCSV(csvText) {
  const lines  = csvText.trim().split("\n");
  const errors = [];
  const intervals = [];

  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes("time") || firstLine.includes("demand");
  const dataLines = hasHeader ? lines.slice(1) : lines;

  dataLines.forEach((line, idx) => {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2) {
      errors.push(`Row ${idx + 1}: expected at least 2 columns (time, demand), got ${parts.length}.`);
      return;
    }

    const time   = parts[0];
    const demand = parseFloat(parts[1]);
    const other  = parts[2] !== undefined ? parseFloat(parts[2]) : 0;

    if (!time) {
      errors.push(`Row ${idx + 1}: missing time value.`);
      return;
    }
    if (isNaN(demand)) {
      errors.push(`Row ${idx + 1}: demand "${parts[1]}" is not a valid number.`);
      return;
    }
    if (demand < 0) {
      errors.push(`Row ${idx + 1}: demand cannot be negative (got ${demand}).`);
      return;
    }
    if (!isNaN(other) && other < 0) {
      errors.push(`Row ${idx + 1}: other generation cannot be negative (got ${other}).`);
      return;
    }

    intervals.push({ time, demand, other: isNaN(other) ? 0 : other, wind: null, windSource: null });
  });

  return { intervals, errors };
}
