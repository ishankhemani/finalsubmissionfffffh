"""
cache.py — Thread-safe bounded LRU cache with per-entry TTL.

Design:
  - BoundedTTLCache stores up to `maxsize` entries.
  - Each entry has an individual expiry timestamp.
  - On capacity overflow, the Least Recently Used entry is evicted
    (collections.OrderedDict keeps insertion / access order).
  - All public methods are protected by a threading.Lock, making the
    cache safe to use from the ThreadPoolExecutor workers in main.py.
  - No third-party dependencies — only stdlib.

Usage:
    cache = BoundedTTLCache(maxsize=50, ttl_seconds=600)

    val = cache.get(key)           # None if missing or expired
    cache.set(key, value)
    cache.invalidate(key)          # optional manual eviction
    cache.clear()                  # flush everything (e.g. on reload)
    stats = cache.stats()          # {"size": n, "hits": h, "misses": m, "evictions": e}
"""
import threading
import time
import logging
from collections import OrderedDict

logger = logging.getLogger(__name__)


class BoundedTTLCache:
    """Thread-safe LRU cache with per-entry TTL and a hard size bound.

    Args:
        maxsize     (int):   Maximum number of entries. Oldest entry is
                             evicted when this limit is exceeded.
        ttl_seconds (float): Seconds until any cached entry expires.
                             Use 0 to disable TTL (entries never expire).
    """

    def __init__(self, maxsize: int = 50, ttl_seconds: float = 600.0):
        if maxsize < 1:
            raise ValueError("maxsize must be ≥ 1")
        if ttl_seconds < 0:
            raise ValueError("ttl_seconds must be ≥ 0")

        self._maxsize     = maxsize
        self._ttl         = ttl_seconds
        self._lock        = threading.RLock()  # re-entrant: get_or_set -> set
        # OrderedDict: key → (value, expiry_time)
        # Most-recently used entry moves to the END via move_to_end().
        self._store: OrderedDict = OrderedDict()

        # Telemetry
        self._hits      = 0
        self._misses    = 0
        self._evictions = 0

    # ── Public API ──────────────────────────────────────────────────────────

    def get(self, key):
        """Return the cached value for key, or None if absent/expired."""
        with self._lock:
            return self._get_locked(key)

    def set(self, key, value) -> None:
        """Insert or update a cache entry."""
        with self._lock:
            expiry = time.monotonic() + self._ttl if self._ttl > 0 else float("inf")

            if key in self._store:
                # Update value + expiry, promote to MRU position
                self._store[key] = (value, expiry)
                self._store.move_to_end(key)
            else:
                self._store[key] = (value, expiry)
                # Evict LRU entry if over capacity
                if len(self._store) > self._maxsize:
                    evicted_key, _ = self._store.popitem(last=False)
                    self._evictions += 1
                    logger.debug("Cache evicted LRU entry: %s", evicted_key)

    def get_or_set(self, key, factory, *args, **kwargs):
        """Return cached value, or call factory(*args, **kwargs), cache it, and return it.

        This is the primary API for cache-aside pattern:

            df = cache.get_or_set(cache_key, expensive_function, arg1, arg2)

        factory is called WITHOUT the lock held, so blocking I/O
        (e.g. HTTP requests) does not block other threads.

        Race condition: two threads may both compute the same value
        simultaneously on a cold cache. The last writer wins, which is
        acceptable for immutable data like historical BMRS responses.
        """
        with self._lock:
            result = self._get_locked(key)

        if result is not None:
            return result

        # Compute outside the lock — allows concurrent requests for
        # different keys to proceed in parallel
        value = factory(*args, **kwargs)

        with self._lock:
            # Double-check: another thread may have populated the key
            # while we were computing. Overwrite is safe — same data.
            self.set(key, value)

        return value

    def invalidate(self, key) -> bool:
        """Remove a specific key. Returns True if the key existed."""
        with self._lock:
            if key in self._store:
                del self._store[key]
                return True
            return False

    def clear(self) -> None:
        """Flush all entries and reset telemetry counters."""
        with self._lock:
            self._store.clear()
            self._hits      = 0
            self._misses    = 0
            self._evictions = 0

    def stats(self) -> dict:
        """Return a snapshot of cache telemetry (size, hits, misses, evictions)."""
        with self._lock:
            total = self._hits + self._misses
            hit_rate = round(100 * self._hits / total, 1) if total > 0 else 0.0
            return {
                "size":      len(self._store),
                "maxsize":   self._maxsize,
                "ttl_seconds": self._ttl,
                "hits":      self._hits,
                "misses":    self._misses,
                "evictions": self._evictions,
                "hit_rate_pct": hit_rate,
            }

    # ── Private helpers ─────────────────────────────────────────────────────

    def _get_locked(self, key):
        """Must be called with self._lock held."""
        if key not in self._store:
            self._misses += 1
            return None

        value, expiry = self._store[key]

        if time.monotonic() > expiry:
            # Expired — remove and treat as a miss
            del self._store[key]
            self._misses += 1
            logger.debug("Cache entry expired: %s", key)
            return None

        # Promote to MRU position
        self._store.move_to_end(key)
        self._hits += 1
        return value
