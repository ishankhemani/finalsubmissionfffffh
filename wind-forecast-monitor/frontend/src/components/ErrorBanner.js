import React, { useCallback } from "react";
import { useWindDataContext, ACTIONS } from "../context/WindDataContext";

/**
 * ErrorBanner — dismissible error notification.
 * Reads only `error` from context; React.memo prevents re-renders when
 * rawData / status changes without affecting the error field.
 */
function ErrorBanner() {
  const { state, dispatch } = useWindDataContext();
  const { error } = state;

  const dismiss = useCallback(
    () => dispatch({ type: ACTIONS.CLEAR_ERROR }),
    [dispatch]
  );

  if (!error) return null;

  return (
    <div
      className="error-banner"
      role="alert"
      aria-live="assertive"
    >
      <div className="error-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <span className="error-text">{error}</span>
      <button
        className="error-dismiss"
        onClick={dismiss}
        aria-label="Dismiss error"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export default React.memo(ErrorBanner, (prev, next) => prev === next);
