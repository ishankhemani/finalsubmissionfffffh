import React, { useMemo, useState } from "react";
import StatCard from "./StatCard";
import { useWindDataContext } from "../context/WindDataContext";
import {
  buildMetrics,
  forecastBasisLabel,
  getLatestForecastPublishTime,
  formatForecastPublishTime,
} from "../utils/dataTransforms";

const TOOLTIPS = {
  mae: {
    title: "Mean Absolute Error",
    description: "Average magnitude of forecast errors in MW. Lower is better.",
  },
  rmse: {
    title: "Root Mean Squared Error",
    description: "Penalises large errors more than MAE. A high RMSE relative to MAE signals occasional large misses.",
  },
  bias: {
    title: "Forecast Bias",
    description: "Positive = wind was over-forecast on average (actual came in lower). Negative = wind was under-forecast.",
  },
  shortfall: {
    title: "Max Shortfall",
    description: "The largest single 30-minute interval where wind under-delivered versus forecast.",
  },
  coverage: {
    title: "Forecast Coverage",
    description: "Share of delivery intervals that have an eligible forecast. Missing forecasts are never assumed to be zero.",
  },
};

function TooltipIcon({ id }) {
  const [visible, setVisible] = useState(false);
  const tip = TOOLTIPS[id];
  if (!tip) return null;

  return (
    <span className="tooltip-wrapper">
      <button
        className="tooltip-trigger"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        aria-label={`About ${tip.title}`}
        type="button"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </button>
      {visible && (
        <div className="tooltip-popup" role="tooltip">
          <strong>{tip.title}</strong>
          <p>{tip.description}</p>
        </div>
      )}
    </span>
  );
}

function MetricsPanel() {
  const { state } = useWindDataContext();
  const { rawData, metricsData, mode, horizon, decisionTime } = state;
  // Use pre-computed metricsData from the combined /wind-data response.
  // Falls back to client-side buildMetrics only if metricsData is absent
  // (e.g. when talking to an older backend version).
  const metrics = useMemo(
    () => metricsData ?? buildMetrics(rawData),
    [metricsData, rawData]
  );

  if (!metrics) return null;

  const { mae, rmse, bias, maxShortfall, coverage, nValid, nTotal } = metrics;
  const basisLabel = metricsData?.mode
    ? forecastBasisLabel(metricsData.mode, metricsData.horizon, metricsData.decisionTime)
    : forecastBasisLabel(mode, horizon, decisionTime);

  const latestPublishTime = getLatestForecastPublishTime(rawData ?? []);
  const latestPublishLabel = latestPublishTime ? formatForecastPublishTime(latestPublishTime) : null;

  const sampleNote = nValid != null && nTotal != null
    ? `${nValid.toLocaleString()} of ${nTotal.toLocaleString()} intervals`
    : null;

  const biasDisplay = bias !== null
    ? (bias > 0 ? "+" : "") + bias.toLocaleString()
    : null;

  const biasAccent = bias === null ? "sky"
    : bias > 200  ? "amber"
    : bias < -200 ? "green"
    : "sky";

  const biasSubtitle = bias === null ? sampleNote
    : bias > 0  ? `Over-forecast · ${sampleNote}`
    : bias < 0  ? `Under-forecast · ${sampleNote}`
    : `Unbiased · ${sampleNote}`;

  return (
    <div className="card card-padded">
    <section aria-label="Forecast accuracy metrics">
      <div className="metrics-header">
        <span className="metrics-title">Accuracy Metrics</span>
        <div className="metrics-meta">
          <span className="metrics-horizon">{basisLabel}</span>
          {latestPublishLabel && (
            <span className="metrics-publish-time">
              Forecast published: {latestPublishLabel} UTC
            </span>
          )}
        </div>
      </div>

      <div className="metrics-grid">
        <StatCard
          label="MAE"
          labelSuffix={<TooltipIcon id="mae" />}
          value={mae !== null ? mae.toLocaleString() : null}
          unit="MW"
          accent="sky"
          subtitle={sampleNote ?? "—"}
          icon="M9 19v-6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2zm0 0V9a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v10m-6 0a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2m0 0V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z"
        />
        <StatCard
          label="RMSE"
          labelSuffix={<TooltipIcon id="rmse" />}
          value={rmse !== null ? rmse.toLocaleString() : null}
          unit="MW"
          accent="indigo"
          subtitle={sampleNote ?? "—"}
          icon="M22 12h-4l-3 9L9 3l-3 9H2"
        />
        <StatCard
          label="Bias"
          labelSuffix={<TooltipIcon id="bias" />}
          value={biasDisplay}
          unit="MW"
          accent={biasAccent}
          subtitle={biasSubtitle}
          icon="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
        />
        <StatCard
          label="Max Shortfall"
          labelSuffix={<TooltipIcon id="shortfall" />}
          value={maxShortfall !== null ? maxShortfall.toLocaleString() : null}
          unit="MW"
          accent="red"
          subtitle={sampleNote ?? "—"}
          icon="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
        />
        <StatCard
          label="Coverage"
          labelSuffix={<TooltipIcon id="coverage" />}
          value={coverage}
          unit="%"
          accent="green"
          subtitle={sampleNote ?? "—"}
          icon="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
        />
      </div>
    </section>
    </div>
  );
}

export default React.memo(MetricsPanel);
