/**
 * WindDataContext — single source of truth for all app state.
 *
 * Pattern: Context + useReducer (analogous to Redux Toolkit's slice + store,
 * without the extra dependency). All state transitions are handled by the
 * pure reducer; derived data is computed in selectors (utils/dataTransforms.js)
 * and memoized at the consumption site with useMemo.
 *
 * Latency optimisations in this file:
 *
 *  1. Request deduplication
 *     If fetchData() is called while a fetch for identical params is already
 *     in-flight, the second call is silently dropped. Prevents double-fetch on
 *     rapid "Load Data" clicks or React StrictMode double-invocation.
 *
 *  2. Browser-side in-memory response cache (LRU, 20 entries, 5-min TTL)
 *     Keyed by "start|end|horizon". A repeat query returns instantly from
 *     memory — zero network, zero server load. TTL matches the backend's
 *     Cache-Control: max-age=300 so stale data is never served for longer
 *     than the backend would serve it.
 *
 *  3. Stale-while-revalidate
 *     On a cache miss, the previous rawData/metricsData stays visible while
 *     the new request is loading (status = "refreshing"). The UI shows a
 *     subtle "Refreshing…" badge instead of a full spinner/blank screen.
 *     On completion the new data replaces the old atomically.
 *
 *  4. Combined API response
 *     The backend /wind-data endpoint now returns both records AND metrics
 *     in a single JSON response, eliminating the separate /metrics round-trip.
 *     This halves the number of network waterfalls per "Load Data" action.
 */
import React, { createContext, useContext, useReducer, useCallback, useRef } from "react";
import axios from "axios";
import { buildChartData, buildMetrics } from "../utils/dataTransforms";

// ── Constants ─────────────────────────────────────────────────────────────────
export const API_URL =
  process.env.REACT_APP_API_URL || "http://127.0.0.1:8000";

// ── Browser-side response cache ───────────────────────────────────────────────
// Simple LRU Map (insertion-order eviction, max 20 entries, 5-min TTL).
// Lives outside the React tree so it persists across component remounts.
const _CACHE_TTL_MS  = 5 * 60 * 1000; // 5 minutes — matches backend Cache-Control
const _CACHE_MAX     = 20;
const _responseCache = new Map(); // key → { data, ts }

function _cacheGet(key) {
  if (!_responseCache.has(key)) return null;
  const { data, ts } = _responseCache.get(key);
  if (Date.now() - ts > _CACHE_TTL_MS) {
    _responseCache.delete(key);
    return null;
  }
  // Promote to MRU: delete + re-insert moves to end of Map insertion order
  _responseCache.delete(key);
  _responseCache.set(key, { data, ts });
  return data;
}

function _cacheSet(key, data) {
  if (_responseCache.size >= _CACHE_MAX) {
    // Evict LRU (first entry in insertion-order Map)
    _responseCache.delete(_responseCache.keys().next().value);
  }
  _responseCache.set(key, { data, ts: Date.now() });
}

// ── State shape ───────────────────────────────────────────────────────────────
const initialState = {
  // Controls
  // Delivery days 2 Jan -> 8 Jan 2026: the first day whose day-ahead decision (D-1)
  // falls inside January 2026 (same 7-day span as before).
  start:   "2026-01-02",
  end:     "2026-01-08",
  // Forecast selection:
  //   "decision" — day-ahead model: forecast known at `decisionTime` (UK time) on D-1
  //   "horizon"  — fixed lead time of `horizon` hours before each slot
  mode:         "decision",
  decisionTime: "09:00",
  horizon:      24,

  // Async status
  // "idle"       — no data loaded yet
  // "loading"    — first fetch in progress (no previous data to show)
  // "refreshing" — re-fetching with stale data still visible (SWR pattern)
  // "success"    — data loaded successfully
  // "error"      — fetch failed
  status: "idle",
  error:  null,

  // Raw API records — array of {time, actual, forecast|null}
  // Stored once; derived chart/metrics data is memoized in consumers.
  rawData:     null,

  // Pre-computed metrics from the combined /wind-data response.
  // Avoids re-computing in the frontend (already done server-side).
  metricsData: null,
};

// ── Action types ──────────────────────────────────────────────────────────────
export const ACTIONS = {
  SET_START:   "SET_START",
  SET_END:     "SET_END",
  SET_HORIZON: "SET_HORIZON",
  SET_MODE:    "SET_MODE",
  SET_DECISION_TIME: "SET_DECISION_TIME",
  FETCH_START:    "FETCH_START",    // cold fetch (no existing data)
  FETCH_REFRESH:  "FETCH_REFRESH",  // re-fetch while keeping stale data visible
  FETCH_SUCCESS:  "FETCH_SUCCESS",
  FETCH_ERROR:    "FETCH_ERROR",
  CLEAR_ERROR:    "CLEAR_ERROR",
};

// ── Pure reducer ──────────────────────────────────────────────────────────────
function windDataReducer(state, action) {
  switch (action.type) {
    case ACTIONS.SET_START:
      return { ...state, start: action.payload };
    case ACTIONS.SET_END:
      return { ...state, end: action.payload };
    case ACTIONS.SET_HORIZON:
      return { ...state, horizon: action.payload };
    case ACTIONS.SET_MODE:
      return { ...state, mode: action.payload };
    case ACTIONS.SET_DECISION_TIME:
      return { ...state, decisionTime: action.payload };

    case ACTIONS.FETCH_START:
      // Full spinner: clear stale data so blank state shows
      return { ...state, status: "loading", error: null, rawData: null, metricsData: null };

    case ACTIONS.FETCH_REFRESH:
      // Stale-while-revalidate: keep rawData visible, show subtle "Refreshing" badge
      return { ...state, status: "refreshing", error: null };

    case ACTIONS.FETCH_SUCCESS:
      return {
        ...state,
        status:      "success",
        rawData:     action.payload.records,
        metricsData: action.payload.metrics,
        error:       null,
      };

    case ACTIONS.FETCH_ERROR:
      return { ...state, status: "error", error: action.payload };

    case ACTIONS.CLEAR_ERROR:
      return { ...state, error: null, status: state.rawData ? "success" : "idle" };

    default:
      return state;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────
const WindDataContext = createContext(null);

// ── Provider ──────────────────────────────────────────────────────────────────
export function WindDataProvider({ children }) {
  const [state, dispatch] = useReducer(windDataReducer, initialState);

  // Ref tracking the in-flight request key for deduplication.
  // Using a ref (not state) so changes don't trigger re-renders.
  const _inFlight = useRef(null);
  // Monotonic request counter. Only the most recently issued request may update
  // state, so a slow earlier response can never overwrite a newer one.
  const _latestReq = useRef(0);

  /**
   * fetchData — stable reference via useCallback.
   *
   * Latency flow:
   *   1. Check browser-side cache → instant return if hit.
   *   2. Deduplicate: drop if same key already in-flight.
   *   3. If previous data exists → FETCH_REFRESH (SWR: keep old data visible).
   *      If no previous data     → FETCH_START (show spinner).
   *   4. Await axios GET /wind-data (combined records + metrics response).
   *   5. Store in browser cache for 5 min.
   *   6. Dispatch FETCH_SUCCESS → consumers update atomically.
   */
  const fetchData = useCallback(async (start, end, horizon, mode = "decision", decisionTime = "09:00") => {
    // Client-side guard before touching the network
    if (start && end && start > end) {
      dispatch({
        type:    ACTIONS.FETCH_ERROR,
        payload: "Start date must be on or before the end date.",
      });
      return;
    }

    // Only the parameter relevant to the chosen mode is part of the key.
    const cacheKey = mode === "decision"
      ? `${start}|${end}|decision|${decisionTime}`
      : `${start}|${end}|horizon|${horizon}`;

    // ── 1. Browser cache hit → instant ────────────────────────────────────
    const cached = _cacheGet(cacheKey);
    if (cached) {
      _latestReq.current += 1;   // supersede any older in-flight request
      _inFlight.current = null;
      dispatch({ type: ACTIONS.FETCH_SUCCESS, payload: cached });
      return;
    }

    // ── 2. Request deduplication ──────────────────────────────────────────
    if (_inFlight.current === cacheKey) {
      return; // identical request already in-flight — drop silently
    }
    _inFlight.current = cacheKey;
    const reqId = ++_latestReq.current;

    // ── 3. Stale-while-revalidate vs cold load ─────────────────────────────
    const hasPreviousData = state.rawData !== null;
    dispatch({ type: hasPreviousData ? ACTIONS.FETCH_REFRESH : ACTIONS.FETCH_START });

    try {
      // No manual If-None-Match handling: the browser's HTTP cache already
      // revalidates using the ETag, and a hand-rolled 304 path could attach a
      // previous query's data to the wrong parameters.
      const res = await axios.get(`${API_URL}/wind-data`, {
        params: mode === "decision"
          ? { start, end, mode, decision_time: decisionTime }
          : { start, end, mode, horizon },
      });

      // Backend now returns { records, metrics, coverage } combined
      // A newer request was issued while this one was in flight: discard.
      if (reqId !== _latestReq.current) return;

      const body = res.data;
      const records = body.records ?? body; // backwards compat: if still plain array

      if (!records || records.length === 0) {
        dispatch({
          type:    ACTIONS.FETCH_ERROR,
          payload: "No data returned for the selected range. " +
                   "BMRS may not have data for these dates — try dates in January 2026.",
        });
        return;
      }

      const payload = {
        records,
        metrics: body.metrics ?? null,
      };

      // ── 5. Store in browser cache ────────────────────────────────────────
      _cacheSet(cacheKey, payload);

      dispatch({ type: ACTIONS.FETCH_SUCCESS, payload });

    } catch (err) {
      if (reqId !== _latestReq.current) return;   // stale request: ignore its error too
      const status = err.response?.status;
      // Show our API's own message when it sent one; otherwise a friendly
      // generic message instead of raw client/network error text.
      const detail = err.response?.data?.detail;
      const msg =
        (typeof detail === "string" ? detail : null) ||
        (status === 429
          ? "Too many requests — please wait a minute and try again."
          : null) ||
        (err.response
          ? `The server returned an error (${status}). Please try again.`
          : "Could not reach the server. Check your network connection and try again.");
      dispatch({ type: ACTIONS.FETCH_ERROR, payload: msg });
    } finally {
      // Only the latest request owns the in-flight marker.
      if (reqId === _latestReq.current) _inFlight.current = null;
    }
  }, [state.rawData]); // deps: need current rawData for SWR check

  const value = { state, dispatch, fetchData, buildChartData, buildMetrics };

  return (
    <WindDataContext.Provider value={value}>
      {children}
    </WindDataContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────
export function useWindDataContext() {
  const ctx = useContext(WindDataContext);
  if (!ctx) {
    throw new Error("useWindDataContext must be used inside WindDataProvider");
  }
  return ctx;
}
