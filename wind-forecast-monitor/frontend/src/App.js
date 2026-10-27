import React, { useState, useMemo, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route, NavLink, useLocation } from "react-router-dom";
import { WindDataProvider, useWindDataContext } from "./context/WindDataContext";
import { buildChartData, forecastBasisLabel } from "./utils/dataTransforms";
import ControlPanel from "./components/ControlPanel";
import WindChart from "./components/WindChart";
import MetricsPanel from "./components/MetricsPanel";
import ErrorChart from "./components/ErrorChart";
import ProcurementPlanner from "./components/ProcurementPlanner";
import LoadingState from "./components/LoadingState";
import ErrorBanner from "./components/ErrorBanner";

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icons = {
  wind: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" />
      <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
      <path d="M12.6 19.4A2 2 0 1 0 14 16H2" />
    </svg>
  ),
  chart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  clipboard: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  ),
  book: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v15H6.5A2.5 2.5 0 0 0 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  sun: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  ),
  moon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  ),
  menu: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  ),
  close: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
};

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ isOpen, onClose }) {
  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="sidebar-overlay open"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside className={`sidebar${isOpen ? " open" : ""}`} aria-label="Navigation">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon" aria-hidden="true">{Icons.wind}</div>
          <div>
            <div className="sidebar-logo-text">WindMonitor</div>
            <div className="sidebar-logo-sub">UK National Grid · BMRS</div>
          </div>
        </div>

        <div className="sidebar-divider" />

        {/* Nav */}
        <nav className="sidebar-nav" aria-label="Main navigation">
          <span className="sidebar-nav-section">Analysis</span>
          <NavLink
            to="/"
            end
            className={({ isActive }) => `sidebar-nav-item${isActive ? " active" : ""}`}
            onClick={onClose}
          >
            {Icons.chart}
            Forecast
          </NavLink>

          <span className="sidebar-nav-section">Planning</span>
          <NavLink
            to="/procurement"
            className={({ isActive }) => `sidebar-nav-item${isActive ? " active" : ""}`}
            onClick={onClose}
          >
            {Icons.clipboard}
            Procurement
          </NavLink>

          <NavLink
            to="/user-guide"
            className={({ isActive }) => `sidebar-nav-item${isActive ? " active" : ""}`}
            onClick={onClose}
          >
            {Icons.book}
            User Guide
          </NavLink>
        </nav>

      </aside>
    </>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────
function Topbar({ onMenuClick }) {
  const { state } = useWindDataContext();
  const { status, start, end } = state;
  const location = useLocation();

  const title = location.pathname === "/procurement"
    ? "Procurement Planner"
    : location.pathname === "/user-guide"
      ? "User Guide"
      : "Forecast Analysis";

  const badge = () => {
    if (status === "loading") return (
      <span className="topbar-badge topbar-badge--loading">
        <span className="spinner-xs" aria-hidden="true" /> Fetching…
      </span>
    );
    if (status === "refreshing") return (
      <span className="topbar-badge topbar-badge--loading" style={{ opacity: 0.7 }}>
        <span className="spinner-xs" aria-hidden="true" /> Refreshing…
      </span>
    );
    if (status === "success") return (
      <span className="topbar-badge topbar-badge--success">
        <span className="badge-dot" aria-hidden="true" />
        {start} – {end}
      </span>
    );
    return null;
  };

  return (
    <header className="topbar">
      <button
        className="topbar-hamburger"
        onClick={onMenuClick}
        aria-label="Open navigation menu"
        type="button"
      >
        {Icons.menu}
      </button>
      <span className="topbar-title">{title}</span>
      {badge()}
    </header>
  );
}

// ── Forecast Page ─────────────────────────────────────────────────────────────
function ForecastPage() {
  const { state } = useWindDataContext();
  const { status, rawData, metricsData, mode, horizon, decisionTime } = state;
  const basisLabel = metricsData?.mode
    ? forecastBasisLabel(metricsData.mode, metricsData.horizon, metricsData.decisionTime)
    : forecastBasisLabel(mode, horizon, decisionTime);
  const chartData = useMemo(() => buildChartData(rawData), [rawData]);
  const isLoading = status === "loading";
  const hasData   = (status === "success" || status === "refreshing") && chartData !== null;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">Forecast Analysis</h1>
        <p className="page-subtitle">BMRS FUELHH actuals vs WINDFOR forecasts · 30-min settlement periods</p>
      </div>

      <ControlPanel />
      <ErrorBanner />

      {isLoading && <LoadingState />}

      {hasData && (
        <div className="results-section">
          <WindChart chartData={chartData} basisLabel={basisLabel} />
          <MetricsPanel />
          <ErrorChart />
        </div>
      )}

      {status === "idle" && (
        <div className="empty-state" aria-live="polite">
          <div className="empty-icon" aria-hidden="true">{Icons.wind}</div>
          <p className="empty-title">Select a date range to begin</p>
          <p className="empty-sub">
            Defaults are set to January 2026. Hit <strong>Load Data</strong> to fetch BMRS data.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Procurement Page ──────────────────────────────────────────────────────────
function ProcurementPage() {
  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">Procurement Planner</h1>
        <p className="page-subtitle">Estimate additional electricity requirements against bias-corrected wind generation</p>
      </div>
      <ProcurementPlanner />
    </div>
  );
}

function UserGuidePage() {
  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">User Guide</h1>
        <p className="page-subtitle">How the system works, how the forecast is selected, and how the procurement calculation is interpreted</p>
      </div>

      <div className="card card-padded">
        <h2 className="page-title" style={{ fontSize: "1.2rem", marginBottom: "0.75rem" }}>What this tool is for</h2>
        <p>
          This dashboard helps a buyer understand how much wind generation is expected, how accurate the forecast was, and how much additional electricity may be needed to meet demand during a delivery period.
        </p>
        <ul className="proc-assump-list" style={{ marginTop: "1rem" }}>
          <li>It combines BMRS actual generation data with BMRS forecast data.</li>
          <li>It applies a decision-time model so the forecast reflects what was actually known when the order decision was made.</li>
          <li>It estimates additional procurement need after accounting for forecast bias and other generation.</li>
        </ul>
      </div>

      <div className="card card-padded">
        <h2 className="page-title" style={{ fontSize: "1.2rem", marginBottom: "0.75rem" }}>How the flow works</h2>
        <ol className="proc-assump-list" style={{ listStyle: "decimal", paddingLeft: "1.5rem" }}>
          <li>Load actual wind generation from BMRS FUELHH.</li>
          <li>Load forecast wind generation from BMRS WINDFOR.</li>
          <li>Use the selected forecast basis to decide which forecast revisions are eligible.</li>
          <li>Match the forecast to the actual delivery slot and calculate forecast error and bias.</li>
          <li>Use the procurement planner to estimate demand coverage after bias correction.</li>
        </ol>
      </div>

      <div className="card card-padded">
        <h2 className="page-title" style={{ fontSize: "1.2rem", marginBottom: "0.75rem" }}>Decision logic</h2>
        <p>
          The default model is the realistic buying case: the buyer decides on the previous day at a fixed cut-off time such as 09:00. Only forecasts published before that time are eligible. If several forecasts exist for the same slot, the latest one before the cut-off is selected.
        </p>
        <p>
          Horizon mode is also available for analysis, but it is a lead-time test rather than the operational day-ahead decision model.
        </p>
      </div>

      <div className="card card-padded">
        <h2 className="page-title" style={{ fontSize: "1.2rem", marginBottom: "0.75rem" }}>What the metrics mean</h2>
        <ul className="proc-assump-list">
          <li><strong>MAE:</strong> average absolute forecast error in MW.</li>
          <li><strong>RMSE:</strong> larger misses are weighted more heavily.</li>
          <li><strong>Bias:</strong> mean forecast error; positive values mean the forecast is too high on average.</li>
          <li><strong>Coverage:</strong> percentage of slots with valid forecast data.</li>
          <li><strong>Max shortfall:</strong> largest under-forecasted interval in the loaded data.</li>
        </ul>
      </div>

      <div className="card card-padded">
        <h2 className="page-title" style={{ fontSize: "1.2rem", marginBottom: "0.75rem" }}>Procurement calculation</h2>
        <p>
          The planner estimates expected wind using a bias correction and then compares it against demand and other generation. The residual is calculated as demand minus expected wind minus other generation; the requirement is the positive part of that residual.
        </p>
        <ul className="proc-assump-list">
          <li><strong>Bias correction:</strong> expected wind = max(forecast − bias, 0)</li>
          <li><strong>Residual:</strong> demand − expected wind − other generation</li>
          <li><strong>Requirement:</strong> max(residual, 0)</li>
          <li><strong>Surplus:</strong> max(−residual, 0)</li>
          <li><strong>MWh conversion:</strong> each half-hour interval is 0.5 hours, so MW × 0.5 = MWh</li>
        </ul>
      </div>

      <div className="card card-padded">
        <h2 className="page-title" style={{ fontSize: "1.2rem", marginBottom: "0.75rem" }}>Important rule</h2>
        <p>
          Missing forecast values are never treated as zero wind. If a forecast is unavailable, that interval is treated as missing rather than as zero generation. This prevents the planner from incorrectly overstating the additional requirement.
        </p>
      </div>
    </div>
  );
}

// ── Shell with theme + mobile nav ─────────────────────────────────────────────
function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("wfm-theme", "dark");
  }, []);

  // Close sidebar on resize back to desktop. Some test environments (JSDOM)
  // do not implement matchMedia, so guard it gracefully.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(min-width: 861px)");
    const handler = (e) => { if (e.matches) setSidebarOpen(false); };
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") setSidebarOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const openSidebar   = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar  = useCallback(() => setSidebarOpen(false), []);

  return (
    <WindDataProvider>
      <BrowserRouter>
        <div className="app-layout">
          <Sidebar
            isOpen={sidebarOpen}
            onClose={closeSidebar}
          />
          <div className="main-content">
            <Topbar onMenuClick={openSidebar} />
            <Routes>
              <Route path="/"            element={<ForecastPage />} />
              <Route path="/procurement" element={<ProcurementPage />} />
              <Route path="/user-guide" element={<UserGuidePage />} />
            </Routes>
          </div>
        </div>
      </BrowserRouter>
    </WindDataProvider>
  );
}

export default AppShell;
