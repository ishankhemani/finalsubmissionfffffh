import React, { useMemo, useRef, useEffect } from "react";
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(
  LineElement, PointElement, LinearScale, CategoryScale, Legend, Tooltip, Filler
);

/**
 * WindChart — memoized Chart.js line chart.
 * Performance: static CHART_OPTIONS prevents Chart.js re-init on each render.
 * React.memo: only re-renders when chartData reference or horizon changes.
 */

const CHART_OPTIONS = {
  responsive:          true,
  maintainAspectRatio: false,
  animation:           { duration: 400, easing: "easeInOutQuart" },
  interaction:         { mode: "index", intersect: false },
  plugins: {
    legend: {
      display:  true,
      position: "top",
      labels: {
        color:           "#888",
        font:            { size: 12, family: "'Inter', sans-serif" },
        usePointStyle:   true,
        pointStyleWidth: 14,
        padding:         20,
        boxHeight:       2,
      },
    },
    tooltip: {
      mode:            "index",
      intersect:       false,
      backgroundColor: "rgba(20,20,20,0.95)",
      titleColor:      "#f0f0f0",
      bodyColor:       "#9a9a9a",
      borderColor:     "rgba(255,255,255,0.1)",
      borderWidth:     1,
      padding:         12,
      cornerRadius:    10,
      callbacks: {
        label(ctx) {
          if (ctx.parsed.y === null) return null;
          const v = ctx.parsed.y;
          const formatted = Math.abs(v) >= 1000
            ? (v / 1000).toFixed(2) + "k MW"
            : v.toLocaleString() + " MW";
          return `  ${ctx.dataset.label.split(" (")[0]}: ${formatted}`;
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
        color:    "#666",
        font:     { size: 11 },
        callback(value) {
          if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + "k";
          return value;
        },
      },
    },
  },
};

function WindChart({ chartData, basisLabel }) {
  const chartRef = useRef(null);

  const stableData = useMemo(() => chartData, [chartData]);

  // Cleanup Chart.js instance on unmount to prevent canvas reuse errors
  useEffect(() => {
    const chart = chartRef.current;
    return () => { if (chart) chart.destroy(); };
  }, []);

  return (
    <section className="card chart-card" aria-label={`Wind generation chart — ${basisLabel}`}>
      <div className="chart-header">
        <h2 className="chart-title">Generation Time Series</h2>
        <span className="chart-horizon-badge">{basisLabel}</span>
      </div>
      <div className="chart-body">
        <Line ref={chartRef} data={stableData} options={CHART_OPTIONS} />
      </div>
    </section>
  );
}

export default React.memo(WindChart, (prev, next) =>
  prev.chartData === next.chartData && prev.basisLabel === next.basisLabel
);
