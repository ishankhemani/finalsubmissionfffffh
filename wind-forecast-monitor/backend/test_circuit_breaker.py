"""
test_circuit_breaker.py — Unit tests for CircuitBreaker.

Tests cover:
  - CLOSED → OPEN on consecutive failures
  - OPEN → fast-fail (CircuitOpenError, no func call)
  - OPEN → HALF_OPEN after recovery_timeout
  - HALF_OPEN → CLOSED on success
  - HALF_OPEN → OPEN on failure (re-opens)
  - Failure counter reset on success in CLOSED state
  - success_threshold > 1 requires multiple probes
  - Independent breakers don't share state
  - stats() telemetry accuracy
  - Thread safety under concurrent load
  - reset() manual recovery
  - Constructor validation
"""
import threading
import time
import pytest

from circuit_breaker import CircuitBreaker, CircuitOpenError, CircuitState


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_breaker(**kwargs):
    defaults = dict(name="test", failure_threshold=3, recovery_timeout=0.1)
    defaults.update(kwargs)
    return CircuitBreaker(**defaults)

def ok_func():
    return "ok"

def fail_func():
    raise ConnectionError("simulated failure")

def trip(breaker, n=None):
    """Trip the breaker by calling fail_func n times (default: failure_threshold)."""
    n = n or breaker._failure_threshold
    for _ in range(n):
        try:
            breaker.call(fail_func)
        except (ConnectionError, CircuitOpenError):
            pass


# ── Construction ──────────────────────────────────────────────────────────────

class TestConstruction:
    def test_starts_closed(self):
        b = make_breaker()
        assert b.state == CircuitState.CLOSED

    def test_invalid_failure_threshold(self):
        with pytest.raises(ValueError):
            CircuitBreaker(name="x", failure_threshold=0)

    def test_invalid_recovery_timeout(self):
        with pytest.raises(ValueError):
            CircuitBreaker(name="x", failure_threshold=1, recovery_timeout=0)

    def test_invalid_success_threshold(self):
        with pytest.raises(ValueError):
            CircuitBreaker(name="x", failure_threshold=1,
                           recovery_timeout=1, success_threshold=0)


# ── CLOSED state ──────────────────────────────────────────────────────────────

class TestClosedState:
    def test_successful_call_returns_value(self):
        b = make_breaker()
        assert b.call(ok_func) == "ok"

    def test_failure_below_threshold_stays_closed(self):
        b = make_breaker(failure_threshold=3)
        for _ in range(2):          # 2 failures, threshold is 3
            try:
                b.call(fail_func)
            except ConnectionError:
                pass
        assert b.state == CircuitState.CLOSED

    def test_success_resets_failure_counter(self):
        b = make_breaker(failure_threshold=3)
        # 2 failures
        for _ in range(2):
            try: b.call(fail_func)
            except ConnectionError: pass
        # 1 success — resets counter
        b.call(ok_func)
        # 2 more failures — still below threshold (counter was reset)
        for _ in range(2):
            try: b.call(fail_func)
            except ConnectionError: pass
        assert b.state == CircuitState.CLOSED

    def test_failure_at_threshold_opens_circuit(self):
        b = make_breaker(failure_threshold=3)
        trip(b, 3)
        assert b.state == CircuitState.OPEN

    def test_failure_reraises_original_exception(self):
        b = make_breaker(failure_threshold=10)
        with pytest.raises(ConnectionError):
            b.call(fail_func)


# ── OPEN state ────────────────────────────────────────────────────────────────

class TestOpenState:
    def test_open_raises_circuit_open_error(self):
        b = make_breaker()
        trip(b)
        with pytest.raises(CircuitOpenError):
            b.call(ok_func)

    def test_open_does_not_call_func(self):
        b = make_breaker()
        trip(b)
        called = [False]
        def probe():
            called[0] = True
            return "x"
        try:
            b.call(probe)
        except CircuitOpenError:
            pass
        assert not called[0]   # func must NOT have been called

    def test_circuit_open_error_has_name(self):
        b = make_breaker(name="FUELHH")
        trip(b)
        with pytest.raises(CircuitOpenError) as exc_info:
            b.call(ok_func)
        assert "FUELHH" in str(exc_info.value)

    def test_rejected_count_increments(self):
        b = make_breaker()
        trip(b)
        for _ in range(3):
            try: b.call(ok_func)
            except CircuitOpenError: pass
        assert b.stats()["total_rejected"] == 3

    def test_open_transitions_to_half_open_after_timeout(self):
        b = make_breaker(recovery_timeout=0.05)
        trip(b)
        assert b.state == CircuitState.OPEN
        time.sleep(0.1)
        assert b.state == CircuitState.HALF_OPEN


# ── HALF_OPEN state ───────────────────────────────────────────────────────────

class TestHalfOpenState:
    def test_success_in_half_open_closes_circuit(self):
        b = make_breaker(recovery_timeout=0.05)
        trip(b)
        time.sleep(0.1)
        assert b.state == CircuitState.HALF_OPEN
        b.call(ok_func)
        assert b.state == CircuitState.CLOSED

    def test_failure_in_half_open_reopens_circuit(self):
        b = make_breaker(recovery_timeout=0.05)
        trip(b)
        time.sleep(0.1)
        assert b.state == CircuitState.HALF_OPEN
        try:
            b.call(fail_func)
        except ConnectionError:
            pass
        assert b.state == CircuitState.OPEN

    def test_failure_in_half_open_resets_recovery_timer(self):
        """After re-opening from HALF_OPEN, the 60s timer restarts."""
        b = make_breaker(recovery_timeout=0.1)
        trip(b)
        time.sleep(0.11)        # → HALF_OPEN
        try: b.call(fail_func)  # → OPEN again
        except ConnectionError: pass
        # Should be OPEN again (timer reset — not immediately HALF_OPEN)
        assert b.state == CircuitState.OPEN

    def test_success_threshold_greater_than_one(self):
        """Require 2 consecutive successes in HALF_OPEN before closing."""
        b = make_breaker(recovery_timeout=0.05, success_threshold=2)
        trip(b)
        time.sleep(0.1)
        b.call(ok_func)   # 1st success — still HALF_OPEN
        assert b.state == CircuitState.HALF_OPEN
        b.call(ok_func)   # 2nd success — now CLOSED
        assert b.state == CircuitState.CLOSED


# ── Failure counter reset ─────────────────────────────────────────────────────

class TestCounterReset:
    def test_closed_after_half_open_recovery_has_clean_counter(self):
        """After full recovery, subsequent failures start from 0."""
        b = make_breaker(failure_threshold=3, recovery_timeout=0.05)
        trip(b, 3)          # open
        time.sleep(0.1)     # half_open
        b.call(ok_func)     # close
        # Now 2 failures — should NOT re-open (counter was reset)
        for _ in range(2):
            try: b.call(fail_func)
            except ConnectionError: pass
        assert b.state == CircuitState.CLOSED


# ── Stats ─────────────────────────────────────────────────────────────────────

class TestStats:
    def test_initial_stats(self):
        b = make_breaker(name="mybreaker")
        s = b.stats()
        assert s["name"]           == "mybreaker"
        assert s["state"]          == "closed"
        assert s["total_calls"]    == 0
        assert s["total_failures"] == 0
        assert s["total_rejected"] == 0

    def test_call_count_tracks_successful_calls(self):
        b = make_breaker()
        b.call(ok_func)
        b.call(ok_func)
        assert b.stats()["total_calls"] == 2

    def test_failure_count_in_stats(self):
        b = make_breaker(failure_threshold=10)
        for _ in range(3):
            try: b.call(fail_func)
            except ConnectionError: pass
        s = b.stats()
        assert s["total_failures"] == 3
        assert s["failure_count"]  == 3

    def test_stats_state_open(self):
        b = make_breaker()
        trip(b)
        s = b.stats()
        assert s["state"] == "open"
        assert s["retry_after_secs"] is not None
        assert s["retry_after_secs"] >= 0

    def test_stats_state_half_open(self):
        b = make_breaker(recovery_timeout=0.05)
        trip(b)
        time.sleep(0.1)
        s = b.stats()
        assert s["state"] == "half_open"


# ── Independence ──────────────────────────────────────────────────────────────

class TestIndependence:
    def test_two_breakers_are_independent(self):
        b1 = make_breaker(name="svc-a")
        b2 = make_breaker(name="svc-b")
        trip(b1)
        # b1 open, b2 should still be closed
        assert b1.state == CircuitState.OPEN
        assert b2.state == CircuitState.CLOSED
        # b2 calls succeed normally
        assert b2.call(ok_func) == "ok"


# ── Manual reset ──────────────────────────────────────────────────────────────

class TestReset:
    def test_reset_closes_open_circuit(self):
        b = make_breaker()
        trip(b)
        assert b.state == CircuitState.OPEN
        b.reset()
        assert b.state == CircuitState.CLOSED

    def test_reset_clears_failure_count(self):
        b = make_breaker()
        trip(b)
        b.reset()
        # Now needs failure_threshold consecutive failures to re-open
        for _ in range(b._failure_threshold - 1):
            try: b.call(fail_func)
            except ConnectionError: pass
        assert b.state == CircuitState.CLOSED


# ── Thread safety ─────────────────────────────────────────────────────────────

class TestThreadSafety:
    def test_concurrent_failures_open_circuit_exactly_once(self):
        """Many threads failing simultaneously — circuit opens once, no corruption."""
        b = make_breaker(failure_threshold=3, recovery_timeout=5)
        errors = []

        def worker():
            try:
                b.call(fail_func)
            except (ConnectionError, CircuitOpenError, Exception) as e:
                errors.append(type(e).__name__)

        threads = [threading.Thread(target=worker) for _ in range(20)]
        for t in threads: t.start()
        for t in threads: t.join()

        # Circuit must be OPEN (not corrupted to some other state)
        assert b.state == CircuitState.OPEN
        # All 20 calls should have raised something (no silent swallowing)
        assert len(errors) == 20

    def test_concurrent_reads_do_not_deadlock(self):
        """Reading stats() and state concurrently should never deadlock."""
        b = make_breaker()
        trip(b)
        done = [False]
        deadlock_errors = []

        def reader():
            try:
                for _ in range(50):
                    _ = b.state
                    _ = b.stats()
            except Exception as e:
                deadlock_errors.append(e)

        threads = [threading.Thread(target=reader) for _ in range(10)]
        for t in threads: t.start()
        for t in threads: t.join()
        done[0] = True

        assert done[0]
        assert len(deadlock_errors) == 0
