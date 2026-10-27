import React, { useState, useMemo, useCallback, useRef } from "react";
import { useWindDataContext } from "../context/WindDataContext";
import { buildMetrics } from "../utils/dataTransforms";
import {
  processProcurementPlan,
  parseDemandCSV,
} from "../utils/procurementCalcs";
import ScenarioPanel from "./ScenarioPanel";

// Maximum accepted size for an uploaded demand CSV.
const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Generate the 48 half-hourly UTC time slots for a given YYYY-MM-DD date.
 */
function generateSlotLabels(date) {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const hh = String(h).padStart(2, "0");
      const mm = String(m).padStart(2, "0");
      slots.push(`${date}T${hh}:${mm}:00Z`);
    }
  }
  return slots;
}

/**
 * Normalise a rawData time string to YYYY-MM-DDTHH:MM:SSZ regardless of
 * what pandas serialised it as.
 *
 * Known pandas formats:
 *   "2026-01-04 00:30:00+00:00"  ← old astype(str) output
 *   "2026-01-04T00:30:00Z"       ← new strftime output
 *   "2026-01-04T00:30:00+00:00"  ← pandas variant
 */
function normTime(t) {
  if (!t) return "";
  let s = t.replace(" ", "T");
  s = s.replace(/([+-]\d{2}:\d{2}|Z)$/, "");
  return s + "Z";
}

/**
 * ProcurementPlanner — Bias-Corrected Demand & Procurement Planning.
 *
 * Core insight (the fix):
 *   Raw WINDFOR forecasts are systematically biased — the historical data
 *   shows the actual wind is consistently less than the published forecast.
 *   A buyer who plans against the raw forecast UNDER-estimates how much
 *   additional electricity they need to procure.
 *
 *   Correct calculation:
 *     ExpectedWind(t)  = max(Forecast(t) − Bias, 0)
 *     Residual(t)      = Demand(t) − ExpectedWind(t) − Other(t)
 *     Requirement(t)   = max(Residual(t), 0)
 *
 *   Where Bias = mean(Forecast − Actual) from the loaded historical period.
 *   Positive bias → forecaster over-predicts → subtract from forecast.
 *
 * Forecast basis = decision cutoff:
 *   The "Forecast basis" on the main page determines which forecasts are
 *   eligible. In the default day-ahead mode every slot of delivery day D uses
 *   the latest forecast published by the decision time (e.g. 09:00 UK) on D-1,
 *   i.e. exactly what the buyer knew when placing the day-ahead order.
 */
function ProcurementPlanner() {
  const { state } = useWindDataContext();
  const { rawData, metricsData, daily, start } = state;

  // ── Local state ────────────────────────────────────────────────────────────
  const [deliveryDate, setDeliveryDate]   = useState(start || "2026-01-15");
  const [uniformDemand, setUniformDemand] = useState("");
  const [uniformOther,  setUniformOther]  = useState("");
  const [csvErrors,     setCsvErrors]     = useState([]);
  const [customDemand,  setCustomDemand]  = useState(null);
  const [inputMode,     setInputMode]     = useState("uniform");
  const [showTable,     setShowTable]     = useState(false);
  const fileRef = useRef(null);

  // ── Historical bias from loaded data ──────────────────────────────────────
  // Read pre-computed metrics from context. Falls back to buildMetrics for
  // older backend compatibility.
  const metrics = useMemo(
    () => metricsData ?? buildMetrics(rawData),
    [metricsData, rawData]
  );
  const selectedDailyBias = useMemo(() => {
    const match = Array.isArray(daily) ? daily.find((d) => d.date === deliveryDate) : null;
    if (match) return match.biasUsed ?? 0;
    return metrics?.bias ?? 0;
  }, [daily, deliveryDate, metrics]);
  const historicalBias = selectedDailyBias;

  // ── Wind by slot (from loaded rawData) ────────────────────────────────────
  const windBySlot = useMemo(() => {
    if (!rawData) return {};
    const map = {};
    rawData.forEach((d) => {
      if (!d.time) return;
      const key = normTime(d.time);
      if (key.startsWith(deliveryDate)) {
        map[key] = d.forecast ?? null;
      }
    });
    return map;
  }, [rawData, deliveryDate]);

  // ── Build 48 intervals for the delivery date ───────────────────────────────
  const intervals = useMemo(() => {
    const slots = generateSlotLabels(deliveryDate);
    return slots.map((time) => {
      let demand = null;
      let other  = null;

      if (inputMode === "uniform") {
        const d = parseFloat(uniformDemand);
        const o = parseFloat(uniformOther);
        demand = isNaN(d) || d < 0 ? null : d;
        other  = isNaN(o) || o < 0 ? 0    : o;
      } else if (inputMode === "csv" && customDemand) {
        const row = customDemand.find((r) => r.time.startsWith(time.substring(0, 16)));
        if (row) { demand = row.demand; other = row.other ?? 0; }
      }

      return { time, demand, wind: windBySlot[time] ?? null, other, windSource: "forecast" };
    });
  }, [deliveryDate, inputMode, uniformDemand, uniformOther, customDemand, windBySlot]);

  // ── Process plan with bias correction ─────────────────────────────────────
  const plan = useMemo(
    () => processProcurementPlan(intervals, historicalBias),
    [intervals, historicalBias]
  );

  // ── Representative values for ScenarioPanel ───────────────────────────────
  const representativeDemand = useMemo(() => {
    if (inputMode === "uniform") {
      const d = parseFloat(uniformDemand);
      return isNaN(d) || d < 0 ? null : d;
    }
    const withDemand = plan.intervals.filter((r) => r.demand != null);
    if (withDemand.length === 0) return null;
    return Math.round(withDemand.reduce((a, r) => a + r.demand, 0) / withDemand.length);
  }, [inputMode, uniformDemand, plan]);

  const representativeOther = useMemo(() => {
    const o = parseFloat(uniformOther);
    return isNaN(o) || o < 0 ? 0 : o;
  }, [uniformOther]);

  // Raw forecast average for the delivery date's matched slots.
  // Per README §Uncertainty Scenario Methodology: scenario base = Forecast (raw),
  // then subtract the error percentile. Do NOT use bias-corrected expected wind
  // here or the bias would be subtracted twice (once here, once via offset).
  const avgForecastMW = useMemo(() => {
    const complete = plan.intervals.filter((r) => r.windForecast != null);
    if (complete.length === 0) return null;
    return Math.round(
      complete.reduce((a, r) => a + r.windForecast, 0) / complete.length
    );
  }, [plan]);

  // ── CSV upload ─────────────────────────────────────────────────────────────
  const handleCSVUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // A full month of half-hourly rows is well under 1 MB; refuse anything
    // larger so a huge file cannot freeze the browser tab.
    if (file.size > MAX_CSV_BYTES) {
      setCsvErrors([`File is too large (max ${MAX_CSV_BYTES / (1024 * 1024)} MB).`]);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { intervals: parsed, errors } = parseDemandCSV(ev.target.result);
      setCsvErrors(errors);
      if (errors.length === 0) { setCustomDemand(parsed); setInputMode("csv"); }
    };
    reader.readAsText(file);
  }, []);

  const resetToUniform = useCallback(() => {
    setInputMode("uniform");
    setCustomDemand(null);
    setCsvErrors([]);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  // ── Derived display values ─────────────────────────────────────────────────
  const { summary } = plan;
  const hasDemand = summary.nComplete > 0 || (inputMode === "uniform" && uniformDemand !== "");
  const formatMWh = (v) => v != null ? `${Math.round(v).toLocaleString()} MWh` : "—";
  const biasSign = historicalBias >= 0 ? "+" : "";

  return (
    <div className="proc-page">

      {/* ── Inputs card ────────────────────────────────────────────────── */}
      <div className="card card-padded">
        <div className="card-header">
          <span className="card-title">Inputs</span>
          {inputMode === "csv" && (
            <span className="card-badge">{customDemand?.length ?? 0} CSV rows loaded</span>
          )}
        </div>

        <div className="proc-inputs-grid">
          {/* Delivery date */}
          <div className="control-field">
            <label htmlFor="delivery-date" className="field-label">Delivery Date</label>
            <input
              id="delivery-date"
              type="date"
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
              className="field-input"
            />
            <p className="field-hint">
              Use a date within your loaded data range ({start} – {state.end}).
            </p>
          </div>

          {/* Demand */}
          <div className="control-field">
            <label htmlFor="uniform-demand" className="field-label">Total Demand</label>
            <div className="input-with-unit">
              <input
                id="uniform-demand"
                type="number"
                min="0"
                step="100"
                placeholder="e.g. 35000"
                value={uniformDemand}
                onChange={(e) => setUniformDemand(e.target.value)}
                className="field-input"
                disabled={inputMode === "csv"}
              />
              <span className="input-unit">MW</span>
            </div>
            <p className="field-hint">Applied to all 48 half-hourly intervals.</p>
          </div>

          {/* Other generation */}
          <div className="control-field">
            <label htmlFor="other-gen" className="field-label">Other Generation</label>
            <div className="input-with-unit">
              <input
                id="other-gen"
                type="number"
                min="0"
                step="100"
                placeholder="0"
                value={uniformOther}
                onChange={(e) => setUniformOther(e.target.value)}
                className="field-input"
                disabled={inputMode === "csv"}
              />
              <span className="input-unit">MW</span>
            </div>
            <p className="field-hint">Nuclear, gas, hydro, etc. Leave blank if unknown.</p>
          </div>

          {/* CSV upload */}
          <div className="control-field">
            <label htmlFor="csv-upload" className="field-label">Half-hourly CSV</label>
            <input
              ref={fileRef}
              id="csv-upload"
              type="file"
              accept=".csv,text/csv"
              onChange={handleCSVUpload}
              className="field-input file-input"
            />
            {inputMode === "csv" && (
              <button className="btn-secondary" onClick={resetToUniform} type="button" style={{ marginTop: 6 }}>
                Clear CSV
              </button>
            )}
            <p className="field-hint">Columns: <code>time, demand, other</code></p>
          </div>
        </div>

        {/* CSV validation errors */}
        {csvErrors.length > 0 && (
          <div className="csv-errors" role="alert">
            <strong>CSV errors:</strong>
            <ul>{csvErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}

        {/* Zero-other assumption warning */}
        {inputMode === "uniform" && uniformOther === "" && uniformDemand !== "" && (
          <div className="proc-info-banner">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            Other generation not entered — assumed 0 MW.
          </div>
        )}
      </div>

      {/* ── Bias correction breakdown ─────────────────────────────────── */}
      {hasDemand && rawData && metrics && (
        <div className="card card-padded bias-card">
          <div className="card-header">
            <span className="card-title">Bias Correction Applied</span>
            {historicalBias !== 0 && (
              <span className={`card-badge ${historicalBias > 0 ? "card-badge--warn" : "card-badge--info"}`}>
                {historicalBias > 0 ? "Forecast over-predicts wind" : "Forecast under-predicts wind"}
              </span>
            )}
          </div>

          <div className="bias-breakdown">
            <div className="bias-row">
              <span className="bias-label">Published WINDFOR Forecast</span>
              <span className="bias-value">{formatMWh(summary.totalWindForecastMWh)}</span>
              <span className="bias-note">Raw forecast energy for delivery day</span>
            </div>
            <div className="bias-row bias-row--deduct">
              <span className="bias-label">
                Historical Bias Deduction
                {/* BUG-05 FIX: use nComplete (actual matched slots) not hardcoded 48,
                    so the displayed deduction matches the real calculation:
                    totalWindForecastMWh - deduction = totalWindExpectedMWh */}
                <span className="bias-detail"> ({biasSign}{Math.round(historicalBias).toLocaleString()} MW × {summary.nComplete} slots × 0.5h)</span>
              </span>
              <span className={`bias-value ${historicalBias > 0 ? "text-amber" : "text-sky"}`}>
                {historicalBias > 0 ? "−" : "+"}{formatMWh(Math.abs(historicalBias) * summary.nComplete * 0.5)}
              </span>
              <span className="bias-note">Subtracted from each slot's forecast</span>
            </div>
            <div className="bias-row bias-row--result">
              <span className="bias-label">Expected Wind Delivery</span>
              <span className="bias-value text-sky">{formatMWh(summary.totalWindExpectedMWh)}</span>
              <span className="bias-note">What is likely to actually arrive</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Results summary cards ─────────────────────────────────────── */}
      {hasDemand && rawData && (
        <>
          <div className="proc-summary-grid">
            <div className="proc-summary-card proc-summary-card--demand">
              <div className="proc-sum-label">Total Demand</div>
              <div className="proc-sum-value">{formatMWh(summary.totalDemandMWh)}</div>
              <div className="proc-sum-sub">{summary.nComplete} matched intervals</div>
            </div>

            <div className="proc-summary-card proc-summary-card--wind">
              <div className="proc-sum-label">WINDFOR Forecast</div>
              <div className="proc-sum-value proc-sum-value--muted">{formatMWh(summary.totalWindForecastMWh)}</div>
              <div className="proc-sum-sub">
                {summary.nMissingWind > 0
                  ? `${summary.nMissingWind} intervals missing forecast`
                  : "Published forecast (before correction)"}
              </div>
            </div>

            <div className="proc-summary-card proc-summary-card--expected">
              <div className="proc-sum-label">Expected Wind Delivery</div>
              <div className="proc-sum-value">{formatMWh(summary.totalWindExpectedMWh)}</div>
              <div className="proc-sum-sub">
                Bias-adjusted ({historicalBias >= 0 ? "−" : "+"}{Math.abs(Math.round(historicalBias)).toLocaleString()} MW/slot)
              </div>
            </div>

            <div className="proc-summary-card proc-summary-card--other">
              <div className="proc-sum-label">Other Generation</div>
              <div className="proc-sum-value">{formatMWh(summary.totalOtherMWh)}</div>
              <div className="proc-sum-sub">User-entered</div>
            </div>

            <div className="proc-summary-card proc-summary-card--req">
              <div className="proc-sum-label">
                {summary.netRequirementMWh > 0 ? "Net Requirement" : summary.netSurplusMWh > 0 ? "Net Surplus" : "Net Position"}
              </div>
              <div className="proc-sum-value">
                {formatMWh(Math.max(summary.netRequirementMWh, summary.netSurplusMWh))}
              </div>
              <div className="proc-sum-sub">
                {summary.netRequirementMWh > 0
                  ? "Daily shortfall after wind and other generation"
                  : summary.netSurplusMWh > 0
                    ? "Daily surplus after wind and other generation"
                    : "Balanced across matched intervals"}
              </div>
            </div>

            {summary.totalSurplusMWh > 0 && (
              <div className="proc-summary-card proc-summary-card--surplus">
                <div className="proc-sum-label">Interval Surplus</div>
                <div className="proc-sum-value">{formatMWh(summary.totalSurplusMWh)}</div>
                <div className="proc-sum-sub">Positive residual hours across matched intervals</div>
              </div>
            )}
          </div>

          {/* MWh note */}
          <div className="proc-note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>
              <strong>MWh = MW × 0.5 h per interval.</strong>{" "}
              Summary totals are energy (MWh). The half-hourly table shows per-slot power (MW).
              <strong> Additional Requirement</strong> is based on bias-corrected expected wind, not raw forecast.
            </span>
          </div>

          {/* BUG-06 FIX: Warn when demand total covers more slots than requirement.
              totalDemandMWh now counts all demand slots, but requirement/surplus
              can only be computed for the nComplete matched slots.               */}
          {summary.nMissingWind > 0 && (
            <div className="proc-info-banner" role="alert">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>
                <strong>{summary.nMissingWind} of 48 intervals have no eligible WINDFOR forecast.</strong>{" "}
                Total Demand shows the full {summary.nMissingWind + summary.nComplete} delivery slots,
                but Additional Requirement and Surplus are only computed for the{" "}
                <strong>{summary.nComplete} matched slots</strong> — the {summary.nMissingWind} unforecasted
                slots represent unquantified procurement risk not reflected above.
              </span>
            </div>
          )}
          <button className="btn-secondary" onClick={() => setShowTable((v) => !v)} type="button">
            {showTable ? "Hide" : "Show"} half-hourly breakdown ({plan.intervals.length} intervals)
          </button>

          {showTable && (
            <div className="proc-table-wrapper">
              <table className="proc-table" aria-label="Half-hourly procurement plan">
                <thead>
                  <tr>
                    <th>Time (UTC)</th>
                    <th>Demand (MW)</th>
                    <th>Forecast (MW)</th>
                    <th>Expected Wind (MW)</th>
                    <th>Other (MW)</th>
                    <th>Residual (MW)</th>
                    <th>Requirement (MW)</th>
                    <th>Surplus (MW)</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.intervals.map((row) => (
                    <tr key={row.time}
                      className={row.requirement > 0 ? "row-requirement" : row.surplus > 0 ? "row-surplus" : ""}
                    >
                      <td className="td-time">{row.time.substring(11, 16)}</td>
                      <td>{row.demand != null ? row.demand.toLocaleString() : <span className="td-missing">—</span>}</td>
                      <td className="td-muted">{row.windForecast != null ? Math.round(row.windForecast).toLocaleString() : <span className="td-missing">—</span>}</td>
                      <td>{row.windExpected != null ? Math.round(row.windExpected).toLocaleString() : <span className="td-missing">no forecast</span>}</td>
                      <td>{row.other != null ? row.other.toLocaleString() : "0"}</td>
                      <td className={row.residual > 0 ? "td-pos" : row.residual < 0 ? "td-neg" : ""}>
                        {row.residual != null ? (row.residual > 0 ? "+" : "") + Math.round(row.residual).toLocaleString() : "—"}
                      </td>
                      <td className={row.requirement > 0 ? "td-req" : ""}>
                        {row.requirement != null ? Math.round(row.requirement).toLocaleString() : "—"}
                      </td>
                      <td className={row.surplus > 0 ? "td-surplus-val" : ""}>
                        {row.surplus != null && row.surplus > 0 ? Math.round(row.surplus).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        </>
      )}

      {/* ── No wind data prompt ──────────────────────────────────────── */}
      {!rawData && !hasDemand && (
        <p className="proc-no-data">
          Go to <strong>Forecast</strong>, load wind data, then enter demand here.
        </p>
      )}

      {/* ── Uncertainty scenarios ────────────────────────────────────── */}
      <ScenarioPanel
        demandMW={representativeDemand}
        otherMW={representativeOther}
        avgForecastMW={avgForecastMW}
      />
    </div>
  );
}

export default React.memo(ProcurementPlanner);
