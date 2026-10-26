import React, { useCallback } from "react";
import { useWindDataContext, ACTIONS } from "../context/WindDataContext";

/**
 * ControlPanel — date range + forecast basis (day-ahead decision time OR fixed
 * lead time) + trigger.
 *
 * Performance: Uses useCallback for onChange handlers so the functions are
 * stable references across renders.  The component only re-renders when the
 * specific slice of state it reads (start/end/horizon/status) changes.
 */
function ControlPanel() {
  const { state, dispatch, fetchData } = useWindDataContext();
  const { start, end, horizon, mode, decisionTime, status } = state;
  const loading = status === "loading";

  const handleStart = useCallback(
    (e) => dispatch({ type: ACTIONS.SET_START, payload: e.target.value }),
    [dispatch]
  );
  const handleEnd = useCallback(
    (e) => dispatch({ type: ACTIONS.SET_END, payload: e.target.value }),
    [dispatch]
  );
  const handleHorizon = useCallback(
    (e) => dispatch({ type: ACTIONS.SET_HORIZON, payload: Number(e.target.value) }),
    [dispatch]
  );
  const handleMode = useCallback(
    (e) => dispatch({ type: ACTIONS.SET_MODE, payload: e.target.value }),
    [dispatch]
  );
  const handleDecisionTime = useCallback(
    (e) => dispatch({ type: ACTIONS.SET_DECISION_TIME, payload: e.target.value }),
    [dispatch]
  );
  // Purchase decisions made during January 2026 are for delivery days
  // 2 Jan → 1 Feb (decision on D-1), so the delivery range is shifted by a day.
  const handleJanuaryPreset = useCallback(() => {
    dispatch({ type: ACTIONS.SET_START, payload: "2026-01-02" });
    dispatch({ type: ACTIONS.SET_END,   payload: "2026-02-01" });
    dispatch({ type: ACTIONS.SET_MODE,  payload: "decision" });
  }, [dispatch]);

  const handleFetch = useCallback(
    () => fetchData(start, end, horizon, mode, decisionTime || "09:00"),
    [fetchData, start, end, horizon, mode, decisionTime]
  );

  const horizonLabel =
    horizon === 0
      ? "Real-time"
      : horizon >= 24
      ? `${horizon}h · Day-ahead`
      : `${horizon}h`;

  return (
    <section className="card control-panel" aria-label="Query controls">
      {/* Date inputs row */}
      <div className="controls-row">
        <div className="control-field">
          <label htmlFor="start-date" className="field-label">Start Date</label>
          <input
            id="start-date"
            type="date"
            value={start}
            onChange={handleStart}
            disabled={loading}
            className="field-input"
          />
        </div>

        <div className="control-field">
          <label htmlFor="end-date" className="field-label">End Date</label>
          <input
            id="end-date"
            type="date"
            value={end}
            onChange={handleEnd}
            disabled={loading}
            className="field-input"
          />
        </div>

        <div className="control-field">
          <label htmlFor="mode-select" className="field-label">Forecast basis</label>
          <select
            id="mode-select"
            value={mode}
            onChange={handleMode}
            disabled={loading}
            className="field-input"
          >
            <option value="decision">Day-ahead decision (D-1)</option>
            <option value="horizon">Fixed lead time</option>
          </select>
        </div>

        {mode === "decision" ? (
          <div className="control-field">
            <label htmlFor="decision-time" className="field-label">
              Decision time (UK, D-1)
            </label>
            <input
              id="decision-time"
              type="time"
              value={decisionTime}
              onChange={handleDecisionTime}
              disabled={loading}
              className="field-input"
              aria-describedby="decision-time-help"
            />
            <span id="decision-time-help" className="field-help">
              Latest forecast published by this time on the day before delivery.
            </span>
          </div>
        ) : (
          <div className="control-field horizon-field">
            <label htmlFor="horizon-slider" className="field-label">
              Forecast Horizon&nbsp;
              <span className="horizon-value">{horizonLabel}</span>
            </label>
            <input
              id="horizon-slider"
              type="range"
              min="0"
              max="48"
              step="1"
              value={horizon}
              onChange={handleHorizon}
              disabled={loading}
              className="slider"
              aria-label="Forecast horizon in hours"
              aria-valuetext={`${horizon} hour${horizon !== 1 ? "s" : ""} horizon${horizon === 0 ? " (real-time)" : horizon >= 24 ? " (day-ahead)" : ""}`}
            />
            <div className="slider-labels" aria-hidden="true">
              <span>0h</span>
              <span>24h</span>
              <span>48h</span>
            </div>
          </div>
        )}

        <button
          type="button"
          id="jan-preset-btn"
          onClick={handleJanuaryPreset}
          disabled={loading}
          className="btn-secondary"
          title="Delivery days 2 Jan – 1 Feb 2026, i.e. every day-ahead decision made in January 2026"
        >
          Jan 2026 decisions
        </button>

        <button
          id="load-data-btn"
          onClick={handleFetch}
          disabled={loading}
          className={`btn-primary ${loading ? "btn-loading" : ""}`}
          aria-busy={loading}
        >
          {loading ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Loading…
            </>
          ) : (
            <>
              Load Data
              <svg className="btn-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </>
          )}
        </button>
      </div>
    </section>
  );
}

export default React.memo(ControlPanel);
