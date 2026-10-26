import React, { useMemo } from "react";
import { useWindDataContext } from "../context/WindDataContext";
import { buildMetrics, buildScenarioOffsets } from "../utils/dataTransforms";

/**
 * ScenarioPanel
 *
 * Props:
 *   demandMW      — uniform demand per interval (MW)
 *   otherMW       — other generation per interval (MW)
 *   avgForecastMW — raw (un-corrected) average WINDFOR forecast for the delivery
 *                   date's matched slots, computed by ProcurementPlanner.
 *
 * Per README §Uncertainty Scenario Methodology:
 *   Lower wind  = Forecast − p90(errors)
 *   Central     = Forecast − p50(errors)
 *   Higher wind = Forecast − p10(errors)
 *
 * Base must be RAW forecast (not bias-corrected). Bias correction is already
 * baked into the error percentiles (the errors were computed against actual
 * generation, which implicitly captures the bias). Applying a pre-corrected
 * base would subtract the bias twice.
 */
function ScenarioPanel({ demandMW = null, otherMW = null, avgForecastMW = null }) {
  const { state } = useWindDataContext();
  const { rawData, metricsData } = state;

  // Read pre-computed metrics from context (zero-cost on re-render).
  // Falls back to buildMetrics if metricsData absent (older backend).
  const metrics = useMemo(
    () => metricsData ?? buildMetrics(rawData),
    [metricsData, rawData]
  );
  // BUG-04 FIX: backend sends `errorPercentiles`; `errorPctls` was a frontend-only
  // name used in buildMetrics (dataTransforms.js). Support both so the correct
  // percentiles are used regardless of whether metricsData came from the backend
  // or was computed locally by buildMetrics.
  const offsets = useMemo(
    () => buildScenarioOffsets(metrics?.errorPercentiles ?? metrics?.errorPctls ?? null),
    [metrics]
  );

  // Use raw avgForecastMW passed from ProcurementPlanner (delivery date only).
  // Falls back to raw forecast average over the entire loaded period if prop absent.
  // Must be RAW forecast per README: scenario = Forecast − error_percentile.
  const baseWind = useMemo(() => {
    if (avgForecastMW !== null && !isNaN(avgForecastMW)) return avgForecastMW;
    // Fallback: raw average over entire loaded period (less accurate — spans all dates)
    if (!rawData) return null;
    const withForecast = rawData.filter((d) => d.forecast != null);
    if (withForecast.length === 0) return null;
    return Math.round(
      withForecast.reduce((a, d) => a + d.forecast, 0) / withForecast.length
    );
  }, [avgForecastMW, rawData]);

  if (!metrics || metrics.nValid < 10) {
    return (
      <section className="card card-padded" aria-label="Forecast uncertainty scenarios">
        <div className="card-header">
          <span className="card-title">Wind Scenarios</span>
        </div>
        <p className="scenario-insufficient">
          {!metrics || metrics.nValid === 0
            ? "Load wind data to view uncertainty scenarios."
            : `Not enough data yet — ${metrics.nValid} intervals loaded (10 minimum).`}
        </p>
      </section>
    );
  }

  const { nValid } = metrics;

  const scenarios = [
    {
      name:        "Lower Wind",
      description: "Conservative estimate — actual exceeded this in ~90% of historical intervals.",
      offset:      offsets?.lower ?? 0,
      accent:      "red",
      icon:        "M19 14l-7 7m0 0l-7-7m7 7V3",
    },
    {
      name:        "Central",
      description: "Published forecast adjusted for historical median error.",
      offset:      offsets?.central ?? 0,
      accent:      "sky",
      icon:        "M5 12h14",
    },
    {
      name:        "Higher Wind",
      description: "Optimistic estimate — actual only exceeded this in ~10% of historical intervals.",
      offset:      offsets?.upper ?? 0,
      accent:      "green",
      icon:        "M5 10l7-7m0 0l7 7m-7-7v18",
    },
  ];

  const hasDemand = demandMW !== null && !isNaN(demandMW) && demandMW > 0;

  return (
    <section className="card card-padded" aria-label="Forecast uncertainty scenarios">
      <div className="card-header">
        <span className="card-title">Wind Scenarios</span>
        <span className="card-badge">Based on {nValid.toLocaleString()} intervals</span>
      </div>

      <div className="scenario-notice">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>
          <strong>Illustrative scenarios</strong> — derived from historical forecast errors. Not a guarantee of future accuracy.
        </span>
      </div>

      <div className="scenario-cards">
        {scenarios.map((s) => {
          // Apply scenario offset to the bias-corrected base wind.
          // Both baseWind and the offset are in MW (per-interval averages).
          const scenarioWind = baseWind != null
            ? Math.max(0, baseWind + s.offset)
            : null;

          let requirement = null;
          let surplus = null;
          if (hasDemand && scenarioWind !== null) {
            const other = otherMW ?? 0;
            const residual = demandMW - scenarioWind - other;
            requirement = Math.max(residual, 0);
            surplus     = Math.max(-residual, 0);
          }

          return (
            <article key={s.name} className={`scenario-card scenario-card--${s.accent}`}>
              <div className="scenario-card-header">
                <div className={`scenario-icon scenario-icon--${s.accent}`} aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={s.icon} />
                  </svg>
                </div>
                <div>
                  <p className="scenario-name">{s.name}</p>
                  <p className="scenario-offset">
                    {s.offset >= 0 ? "+" : ""}{s.offset.toLocaleString()} MW adj.
                  </p>
                </div>
              </div>

              <p className="scenario-desc">{s.description}</p>

              {scenarioWind !== null && (
                <div className="scenario-wind-value">
                  <span className="scenario-wind-label">Avg wind</span>
                  <span className={`scenario-wind-num scenario-wind-num--${s.accent}`}>
                    {scenarioWind.toLocaleString()} <span className="unit">MW</span>
                  </span>
                </div>
              )}

              {hasDemand && (
                <div className="scenario-procurement">
                  <div className="scenario-proc-row">
                    <span>Demand</span>
                    <span>{demandMW.toLocaleString()} MW</span>
                  </div>
                  <div className="scenario-proc-row">
                    <span>Wind</span>
                    <span>{scenarioWind != null ? scenarioWind.toLocaleString() + " MW" : "—"}</span>
                  </div>
                  {(otherMW ?? 0) > 0 && (
                    <div className="scenario-proc-row">
                      <span>Other</span>
                      <span>{(otherMW ?? 0).toLocaleString()} MW</span>
                    </div>
                  )}
                  <div className="scenario-proc-row scenario-proc-total">
                    <span>Additional requirement</span>
                    <span className={requirement > 0 ? "text-amber" : "text-green"}>
                      {requirement != null ? requirement.toLocaleString() + " MW" : "—"}
                    </span>
                  </div>
                  {surplus > 0 && (
                    <div className="scenario-proc-row">
                      <span>Potential surplus</span>
                      <span className="text-green">{surplus.toLocaleString()} MW</span>
                    </div>
                  )}
                </div>
              )}

              {!hasDemand && (
                <p className="scenario-no-demand">
                  Enter demand above to see per-scenario requirements.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default React.memo(ScenarioPanel);
