import React, { useMemo } from "react";
import {
  Chart as ChartJS,
  LineElement,
  BarElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Filler,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import { useWindDataContext } from "../context/WindDataContext";
import { buildErrorDistribution, formatLabel } from "../utils/dataTransforms";

ChartJS.register(
  LineElement,
  BarElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Filler
);

// ── Chart options — defined outside component for stable reference ─────────────

const ERROR_LINE_OPTIONS = {
  responsive:         true,
  maintainAspectRatio: false,
  animation:          { duration: 350, easing: "easeInOutQuart" },
  interaction:        { mode: "index", intersect: false },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "rgba(20,20,20,0.95)",
      titleColor:      "#f0f0f0",
      bodyColor:       "#9a9a9a",
      borderColor:     "rgba(255,255,255,0.1)",
      borderWidth:     1,
      padding:         10,
      cornerRadius:    8,
      callbacks: {
        title(ctx) { return ctx[0]?.label ?? ""; },
        label(ctx) {
          if (ctx.parsed.y === null) return null;
          const v = ctx.parsed.y;
          const sign = v > 0 ? "+" : "";
          return `  Error: ${sign}${v.toLocaleString()} MW  (Forecast − Actual)`;
        },
      },
    },
  },
  scales: {
    x: {
      grid:   { color: "rgba(128,128,128,0.08)", drawBorder: false },
      border: { display: false },
      ticks:  { color: "#666", maxTicksLimit: 8, font: { size: 11 }, maxRotation: 0 },
    },
    y: {
      grid:   { color: "rgba(128,128,128,0.08)", drawBorder: false },
      border: { display: false },
      ticks: {
        color: "#666",
        font:  { size: 11 },
        callback(v) {
          const sign = v > 0 ? "+" : "";
          return Math.abs(v) >= 1000
            ? `${sign}${(v / 1000).toFixed(1)}k`
            : `${sign}${v}`;
        },
      },
    },
  },
};

const DIST_OPTIONS = {
  responsive:         true,
  maintainAspectRatio: false,
  animation:          { duration: 350 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "rgba(20,20,20,0.95)",
      titleColor:      "#f0f0f0",
      bodyColor:       "#9a9a9a",
      borderColor:     "rgba(255,255,255,0.1)",
      borderWidth:     1,
      padding:         10,
      cornerRadius:    8,
      callbacks: {
        label(ctx) { return `  ${ctx.parsed.y} intervals`; },
      },
    },
  },
  scales: {
    x: {
      grid:   { color: "rgba(128,128,128,0.06)", drawBorder: false },
      border: { display: false },
      ticks:  { color: "#666", font: { size: 10 }, maxRotation: 30 },
    },
    y: {
      grid:   { color: "rgba(128,128,128,0.08)", drawBorder: false },
      border: { display: false },
      ticks:  { color: "#666", font: { size: 11 } },
      title:  { display: true, text: "Intervals", color: "#666", font: { size: 11 } },
    },
  },
};

/**
 * ErrorChart — two sub-charts:
 *   1. Forecast error over time (signed, MW)
 *   2. Error distribution histogram
 *
 * Sign convention: Error = Forecast − Actual.
 * Positive = over-forecast (wind under-delivered).
 * Negative = under-forecast (wind over-delivered).
 */
function ErrorChart() {
  const { state } = useWindDataContext();
  const { rawData } = state;

  const errorLineData = useMemo(() => {
    if (!rawData || rawData.length === 0) return null;
    const paired = rawData.filter((d) => d.forecast != null && d.actual != null);
    if (paired.length === 0) return null;
    return {
      labels: paired.map((d) => formatLabel(d.time)),
      datasets: [
        {
          label:           "Forecast Error (MW)",
          data:            paired.map((d) => Math.round(d.forecast - d.actual)),
          borderColor:     "#fbbf24",
          backgroundColor: (ctx) => {
            const chart = ctx.chart;
            const { ctx: canvasCtx, chartArea } = chart;
            if (!chartArea) return "rgba(251,191,36,0.1)";
            const gradient = canvasCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0,   "rgba(251,191,36,0.25)");
            gradient.addColorStop(0.5, "rgba(251,191,36,0.05)");
            gradient.addColorStop(1,   "rgba(56,189,248,0.15)");
            return gradient;
          },
          borderWidth:     1.5,
          pointRadius:     0,
          pointHoverRadius: 4,
          fill:            true,
          tension:         0.25,
          spanGaps:        false,
        },
      ],
    };
  }, [rawData]);

  const distData = useMemo(() => buildErrorDistribution(rawData, 100), [rawData]);

  if (!errorLineData && !distData) return null;

  return (
    <section className="card chart-card" aria-label="Forecast error analysis">
      <div className="chart-header">
        <h2 className="chart-title">Error Analysis</h2>
        <span className="chart-horizon-badge">Forecast − Actual</span>
      </div>

      <div className="error-charts-grid">
        {/* Error over time */}
        {errorLineData && (
          <div className="error-chart-panel">
            <p className="error-chart-label">Error over time</p>
            <div className="error-chart-body">
              <Line data={errorLineData} options={ERROR_LINE_OPTIONS} />
            </div>
          </div>
        )}

        {/* Distribution histogram */}
        {distData && (
          <div className="error-chart-panel">
            <p className="error-chart-label">Error distribution</p>
            <div className="error-chart-body">
              <Bar data={distData} options={DIST_OPTIONS} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default React.memo(ErrorChart);
