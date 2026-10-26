import React from "react";
import { useWindDataContext } from "../context/WindDataContext";

/**
 * Header — shows app title and a contextual status badge.
 *
 * The badge reflects the actual application state rather than
 * always showing "Live data" regardless of context:
 *   - idle/error → no badge (or data-source info only)
 *   - loading     → "Fetching…"
 *   - success     → "Historical data · [date range]"
 *
 * The permanent pulse-green "Live data" badge has been removed because
 * the application primarily queries historical BMRS data; displaying a
 * live-data indicator for January 2026 queries would be misleading.
 */
const Header = React.memo(function Header() {
  const { state } = useWindDataContext();
  const { status, start, end } = state;

  const badge = () => {
    if (status === "loading") {
      return (
        <div className="header-badge header-badge--loading" aria-live="polite">
          <span className="spinner-sm" aria-hidden="true" />
          Fetching…
        </div>
      );
    }
    if (status === "success") {
      return (
        <div className="header-badge header-badge--success" aria-live="polite">
          <span className="dot-success" aria-hidden="true" />
          {start} → {end}
        </div>
      );
    }
    return null;
  };

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="header-brand">
          <div className="brand-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" />
              <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
              <path d="M12.6 19.4A2 2 0 1 0 14 16H2" />
            </svg>
          </div>
          <div>
            <h1 className="brand-title">Wind Generation Forecast Monitor</h1>
            <p className="brand-sub">
              BMRS&nbsp;<span className="tag">FUELHH</span>&nbsp;·&nbsp;
              <span className="tag">WINDFOR</span>&nbsp;·&nbsp;
              UK National Grid · 30-min intervals
            </p>
          </div>
        </div>

        {badge()}
      </div>
    </header>
  );
});

export default Header;
