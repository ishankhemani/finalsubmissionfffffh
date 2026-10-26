"""
circuit_breaker.py — Thread-safe circuit breaker for external HTTP dependencies.

The circuit breaker pattern prevents cascading failures when a downstream
service (here: Elexon BMRS) becomes slow or unavailable.  Instead of every
request timing out after 30 s, a tripped circuit fails immediately and lets
the system serve from cache or return a graceful error.

State machine
─────────────
                  failure_threshold exceeded
  CLOSED ──────────────────────────────────────► OPEN
    ▲                                              │
    │  success_threshold successes                 │  recovery_timeout elapsed
    │                                              ▼
    └────────────────────────────────────── HALF_OPEN
                                           (one probe request)

States:
  CLOSED     — Normal operation. Requests pass through.
               Consecutive failure counter is reset on each success.
  OPEN       — Fast-fail. All calls raise CircuitOpenError immediately.
               After `recovery_timeout` seconds the circuit transitions to HALF_OPEN.
  HALF_OPEN  — One probe request is allowed through.
               ✓ Success → circuit CLOSES, counters reset.
               ✗ Failure → circuit re-OPENS, recovery_timeout resets.

Parameters (all configurable, with sane defaults):
  failure_threshold  (int,   default 3):   Consecutive failures to open circuit.
  recovery_timeout   (float, default 60s): Seconds in OPEN state before probing.
  success_threshold  (int,   default 1):   Consecutive HALF_OPEN successes to close.
  name               (str):                Label for logging / telemetry.

Thread safety:
  All state transitions are protected by threading.Lock.
  The protected call() method releases the lock before executing the
  user-supplied function — so blocking I/O does not stall other threads
  that are concurrently reading circuit state.

Usage:
    breaker = CircuitBreaker(name="FUELHH", failure_threshold=3, recovery_timeout=60)

    try:
        result = breaker.call(requests.get, url, params=params, timeout=30)
    except CircuitOpenError as e:
        # Circuit is OPEN — fail fast, serve from cache or return degraded response
        logger.warning(e)
        raise
    except requests.RequestException as e:
        # Actual network/HTTP error (circuit recorded this failure)
        raise
"""
import enum
import threading
import time
import logging

logger = logging.getLogger(__name__)


# ── Custom exception ──────────────────────────────────────────────────────────

class CircuitOpenError(Exception):
    """Raised when a call is rejected because the circuit is OPEN.

    Callers should treat this as a fast-fail signal and serve from
    cache or return a 503 without waiting for a network timeout.
    """
    def __init__(self, name: str, retry_after: float):
        self.name        = name
        self.retry_after = retry_after   # seconds until HALF_OPEN probe
        super().__init__(
            f"Circuit '{name}' is OPEN — fast-failing. "
            f"Retry after {retry_after:.0f}s."
        )


# ── State enum ────────────────────────────────────────────────────────────────

class CircuitState(enum.Enum):
    CLOSED    = "closed"
    OPEN      = "open"
    HALF_OPEN = "half_open"


# ── Circuit breaker ───────────────────────────────────────────────────────────

class CircuitBreaker:
    """Thread-safe circuit breaker.

    Args:
        name              (str):   Human-readable label for logs / telemetry.
        failure_threshold (int):   Consecutive failures before opening. Default 3.
        recovery_timeout  (float): Seconds to wait in OPEN before probing. Default 60.
        success_threshold (int):   Consecutive HALF_OPEN successes to close. Default 1.
    """

    def __init__(
        self,
        name: str,
        failure_threshold: int   = 3,
        recovery_timeout:  float = 60.0,
        success_threshold: int   = 1,
    ):
        if failure_threshold < 1:
            raise ValueError("failure_threshold must be ≥ 1")
        if recovery_timeout <= 0:
            raise ValueError("recovery_timeout must be > 0")
        if success_threshold < 1:
            raise ValueError("success_threshold must be ≥ 1")

        self.name              = name
        self._failure_threshold = failure_threshold
        self._recovery_timeout  = recovery_timeout
        self._success_threshold = success_threshold

        self._lock              = threading.Lock()
        self._state             = CircuitState.CLOSED
        self._failure_count     = 0   # consecutive failures (CLOSED / HALF_OPEN)
        self._success_count     = 0   # consecutive successes in HALF_OPEN
        self._opened_at: float  = 0.0 # monotonic time when circuit was opened
        self._total_calls       = 0
        self._total_failures    = 0
        self._total_rejected    = 0   # fast-failed by open circuit

    # ── Public API ──────────────────────────────────────────────────────────

    @property
    def state(self) -> CircuitState:
        """Current state, resolving OPEN → HALF_OPEN if recovery_timeout has elapsed."""
        with self._lock:
            return self._resolve_state()

    def call(self, func, *args, **kwargs):
        """Execute func(*args, **kwargs) through the circuit breaker.

        Raises:
            CircuitOpenError         — circuit is OPEN; request was fast-failed.
            Any exception from func  — circuit records this as a failure.

        Returns:
            Whatever func returns on success.
        """
        with self._lock:
            state = self._resolve_state()

            if state == CircuitState.OPEN:
                self._total_rejected += 1
                retry_after = self._recovery_timeout - (time.monotonic() - self._opened_at)
                raise CircuitOpenError(self.name, max(retry_after, 0))

            # CLOSED or HALF_OPEN — allow the call
            self._total_calls += 1

        # ── Execute WITHOUT the lock ──────────────────────────────────────
        # Blocking I/O must not hold the lock — other threads need to read
        # circuit state concurrently.
        try:
            result = func(*args, **kwargs)
        except Exception as exc:
            self._on_failure(exc)
            raise

        self._on_success()
        return result

    def reset(self) -> None:
        """Manually close the circuit and reset all counters (e.g., after a deploy)."""
        with self._lock:
            self._transition(CircuitState.CLOSED, reason="manual reset")
            self._failure_count = 0
            self._success_count = 0

    def stats(self) -> dict:
        """Return a telemetry snapshot."""
        with self._lock:
            state = self._resolve_state()
            retry_after = None
            if state == CircuitState.OPEN:
                retry_after = round(
                    max(0.0, self._recovery_timeout - (time.monotonic() - self._opened_at)), 1
                )
            return {
                "name":              self.name,
                "state":             state.value,
                "failure_count":     self._failure_count,
                "failure_threshold": self._failure_threshold,
                "recovery_timeout":  self._recovery_timeout,
                "total_calls":       self._total_calls,
                "total_failures":    self._total_failures,
                "total_rejected":    self._total_rejected,
                "retry_after_secs":  retry_after,
            }

    # ── Private helpers ─────────────────────────────────────────────────────

    def _resolve_state(self) -> CircuitState:
        """Must be called with self._lock held.

        Automatically transitions OPEN → HALF_OPEN when recovery_timeout
        has elapsed.  Pure state inspection — no side effects other than
        the state transition itself.
        """
        if self._state == CircuitState.OPEN:
            elapsed = time.monotonic() - self._opened_at
            if elapsed >= self._recovery_timeout:
                self._transition(CircuitState.HALF_OPEN,
                                 reason=f"recovery_timeout ({self._recovery_timeout}s) elapsed")
        return self._state

    def _on_success(self) -> None:
        with self._lock:
            if self._state == CircuitState.HALF_OPEN:
                self._success_count += 1
                if self._success_count >= self._success_threshold:
                    self._transition(CircuitState.CLOSED,
                                     reason=f"{self._success_count} consecutive success(es) in HALF_OPEN")
                    self._failure_count = 0
                    self._success_count = 0
            else:
                # CLOSED — reset failure streak on success
                self._failure_count = 0

    def _on_failure(self, exc: Exception) -> None:
        with self._lock:
            self._total_failures += 1
            self._failure_count  += 1
            self._success_count   = 0   # reset success streak

            should_open = (
                self._state == CircuitState.HALF_OPEN or
                self._failure_count >= self._failure_threshold
            )
            if should_open and self._state != CircuitState.OPEN:
                self._opened_at = time.monotonic()
                self._transition(
                    CircuitState.OPEN,
                    reason=f"{self._failure_count} failure(s): {type(exc).__name__}: {exc}",
                )

    def _transition(self, new_state: CircuitState, reason: str = "") -> None:
        """Must be called with self._lock held."""
        old_state = self._state
        self._state = new_state
        if old_state != new_state:
            logger.warning(
                "CircuitBreaker[%s]: %s → %s%s",
                self.name,
                old_state.value,
                new_state.value,
                f" ({reason})" if reason else "",
            )
