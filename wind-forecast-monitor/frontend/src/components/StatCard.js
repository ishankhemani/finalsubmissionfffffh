import React from "react";

/**
 * StatCard — memoized metric card.
 *
 * @param {string}  label
 * @param {ReactNode} [labelSuffix]  — optional element appended after label (e.g. tooltip icon)
 * @param {string|number|null} value
 * @param {string}  unit
 * @param {"blue"|"green"|"amber"|"red"|"indigo"|"sky"} accent
 * @param {string}  [subtitle]
 * @param {string}  [icon]   — SVG path string for optional mini icon
 */
function StatCard({ label, labelSuffix, value, unit, accent = "sky", subtitle, icon }) {
  return (
    <article className={`stat-card stat-card--${accent}`}>
      {icon && (
        <div className="stat-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={icon} />
          </svg>
        </div>
      )}
      <div className="stat-label">
        {label}
        {labelSuffix && <span className="stat-label-suffix">{labelSuffix}</span>}
      </div>
      <div className="stat-value">
        {value !== null && value !== undefined ? (
          <>
            {value}
            <span className="stat-unit">&nbsp;{unit}</span>
          </>
        ) : (
          <span className="stat-empty">—</span>
        )}
      </div>
      {subtitle && <div className="stat-subtitle">{subtitle}</div>}
    </article>
  );
}

export default React.memo(StatCard, (prev, next) =>
  prev.value    === next.value    &&
  prev.subtitle === next.subtitle &&
  prev.accent   === next.accent   &&
  prev.label    === next.label
);
