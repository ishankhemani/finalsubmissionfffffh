import React from "react";

/**
 * LoadingState — animated spinner with descriptive text.
 * React.memo: no props, never re-renders after mount.
 */
const LoadingState = React.memo(function LoadingState() {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-label="Loading wind data">
      <div className="loading-spinner" aria-hidden="true" />
      <p className="loading-label">Fetching data from BMRS…</p>
      <p className="loading-sub">Querying FUELHH & WINDFOR in parallel</p>
    </div>
  );
});

export default LoadingState;
