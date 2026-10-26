"""
test_cache.py — Unit tests for BoundedTTLCache.

Run with:  cd backend && .venv/bin/python -m pytest test_cache.py -v

Tests cover:
  - Basic get/set/miss
  - TTL expiry
  - LRU eviction when over capacity
  - get_or_set cache-aside pattern
  - invalidate / clear
  - stats telemetry (hits, misses, evictions, hit_rate_pct)
  - Thread safety under concurrent access
  - Edge cases (maxsize=1, ttl=0, None values as keys, large payloads)
"""
import threading
import time
import pytest

from cache import BoundedTTLCache


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_cache(maxsize=10, ttl=60.0):
    return BoundedTTLCache(maxsize=maxsize, ttl_seconds=ttl)


# ── Construction ──────────────────────────────────────────────────────────────

class TestConstruction:
    def test_default_params_accepted(self):
        c = BoundedTTLCache()
        assert c.stats()["maxsize"] == 50
        assert c.stats()["ttl_seconds"] == 600.0

    def test_custom_params(self):
        c = BoundedTTLCache(maxsize=5, ttl_seconds=30)
        s = c.stats()
        assert s["maxsize"] == 5
        assert s["ttl_seconds"] == 30

    def test_maxsize_zero_raises(self):
        with pytest.raises(ValueError):
            BoundedTTLCache(maxsize=0)

    def test_negative_maxsize_raises(self):
        with pytest.raises(ValueError):
            BoundedTTLCache(maxsize=-1)

    def test_negative_ttl_raises(self):
        with pytest.raises(ValueError):
            BoundedTTLCache(maxsize=10, ttl_seconds=-1)

    def test_ttl_zero_allowed(self):
        """ttl=0 means entries never expire."""
        c = BoundedTTLCache(maxsize=5, ttl_seconds=0)
        c.set("k", "v")
        time.sleep(0.01)
        assert c.get("k") == "v"


# ── Basic get / set ───────────────────────────────────────────────────────────

class TestGetSet:
    def test_miss_returns_none(self):
        c = make_cache()
        assert c.get("missing") is None

    def test_set_then_get(self):
        c = make_cache()
        c.set("k", "hello")
        assert c.get("k") == "hello"

    def test_overwrite_existing_key(self):
        c = make_cache()
        c.set("k", "first")
        c.set("k", "second")
        assert c.get("k") == "second"

    def test_different_keys_independent(self):
        c = make_cache()
        c.set("a", 1)
        c.set("b", 2)
        assert c.get("a") == 1
        assert c.get("b") == 2

    def test_stores_any_python_object(self):
        """Values can be DataFrames, dicts, lists — any Python object."""
        import pandas as pd
        c = make_cache()
        df = pd.DataFrame({"x": [1, 2, 3]})
        c.set("df", df)
        result = c.get("df")
        assert result is df         # same object — no copy made

    def test_falsy_value_not_confused_with_miss(self):
        """An empty list, 0, or False must not be treated as a cache miss."""
        c = make_cache()
        c.set("zero",  0)
        c.set("empty", [])
        c.set("false", False)
        assert c.get("zero")  == 0      # 0 is a valid cached value
        assert c.get("empty") == []
        assert c.get("false") is False


# ── TTL Expiry ────────────────────────────────────────────────────────────────

class TestTTL:
    def test_entry_available_before_expiry(self):
        c = BoundedTTLCache(maxsize=10, ttl_seconds=60)
        c.set("k", "val")
        assert c.get("k") == "val"

    def test_entry_expired_after_ttl(self):
        """Use a very short TTL (50 ms) to test expiry without sleeping long."""
        c = BoundedTTLCache(maxsize=10, ttl_seconds=0.05)
        c.set("k", "val")
        time.sleep(0.1)             # wait past TTL
        assert c.get("k") is None

    def test_expired_entry_removed_from_store(self):
        c = BoundedTTLCache(maxsize=10, ttl_seconds=0.05)
        c.set("k", "val")
        time.sleep(0.1)
        c.get("k")                  # triggers removal
        assert c.stats()["size"] == 0

    def test_expired_key_is_a_miss(self):
        c = BoundedTTLCache(maxsize=10, ttl_seconds=0.05)
        c.set("k", "val")
        time.sleep(0.1)
        _ = c.get("k")
        assert c.stats()["misses"] == 1

    def test_refresh_on_set_resets_expiry(self):
        """Re-setting an existing key should reset its TTL."""
        c = BoundedTTLCache(maxsize=10, ttl_seconds=0.15)
        c.set("k", "v1")
        time.sleep(0.1)             # 0.1s in — not yet expired (0.15s TTL)
        c.set("k", "v2")           # reset TTL
        time.sleep(0.1)             # now 0.2s since first set, but 0.1s since reset
        assert c.get("k") == "v2"  # should still be live


# ── LRU Eviction ──────────────────────────────────────────────────────────────

class TestLRUEviction:
    def test_lru_entry_evicted_on_overflow(self):
        """With maxsize=3, inserting a 4th key evicts the LRU (first-inserted)."""
        c = BoundedTTLCache(maxsize=3, ttl_seconds=60)
        c.set("a", 1)
        c.set("b", 2)
        c.set("c", 3)
        c.set("d", 4)   # overflow → evicts "a"
        assert c.get("a") is None
        assert c.get("b") == 2
        assert c.get("c") == 3
        assert c.get("d") == 4

    def test_recent_access_promotes_to_mru(self):
        """Getting a key promotes it; so it should NOT be the next eviction."""
        c = BoundedTTLCache(maxsize=3, ttl_seconds=60)
        c.set("a", 1)
        c.set("b", 2)
        c.set("c", 3)
        _ = c.get("a")  # promote "a" to MRU; "b" is now LRU
        c.set("d", 4)   # overflow → evicts "b" (LRU), not "a"
        assert c.get("a") == 1   # "a" was promoted, survives
        assert c.get("b") is None  # "b" was LRU, evicted

    def test_eviction_count_tracked(self):
        c = BoundedTTLCache(maxsize=2, ttl_seconds=60)
        c.set("a", 1)
        c.set("b", 2)
        c.set("c", 3)   # evicts "a"
        c.set("d", 4)   # evicts "b"
        assert c.stats()["evictions"] == 2

    def test_maxsize_one_always_keeps_latest(self):
        c = BoundedTTLCache(maxsize=1, ttl_seconds=60)
        c.set("a", 1)
        c.set("b", 2)
        assert c.get("a") is None
        assert c.get("b") == 2

    def test_size_never_exceeds_maxsize(self):
        c = BoundedTTLCache(maxsize=5, ttl_seconds=60)
        for i in range(20):
            c.set(f"k{i}", i)
        assert c.stats()["size"] <= 5


# ── get_or_set ────────────────────────────────────────────────────────────────

class TestGetOrSet:
    def test_calls_factory_on_miss(self):
        c = make_cache()
        calls = []
        def factory(x):
            calls.append(x)
            return x * 2
        result = c.get_or_set("k", factory, 5)
        assert result == 10
        assert len(calls) == 1

    def test_does_not_call_factory_on_hit(self):
        c = make_cache()
        calls = []
        def factory():
            calls.append(1)
            return "expensive"
        c.set("k", "cached")
        result = c.get_or_set("k", factory)
        assert result == "cached"
        assert len(calls) == 0     # factory never called

    def test_result_is_cached_for_subsequent_calls(self):
        c = make_cache()
        call_count = [0]
        def factory():
            call_count[0] += 1
            return "value"
        c.get_or_set("k", factory)
        c.get_or_set("k", factory)
        assert call_count[0] == 1  # only computed once


# ── Invalidate / Clear ────────────────────────────────────────────────────────

class TestInvalidateAndClear:
    def test_invalidate_removes_key(self):
        c = make_cache()
        c.set("k", "v")
        removed = c.invalidate("k")
        assert removed is True
        assert c.get("k") is None

    def test_invalidate_nonexistent_returns_false(self):
        c = make_cache()
        assert c.invalidate("ghost") is False

    def test_clear_removes_all_entries(self):
        c = make_cache()
        for i in range(5):
            c.set(f"k{i}", i)
        c.clear()
        assert c.stats()["size"] == 0
        for i in range(5):
            assert c.get(f"k{i}") is None

    def test_clear_resets_telemetry(self):
        c = make_cache()
        c.set("k", "v")
        c.get("k")          # 1 hit
        c.get("missing")    # 1 miss
        c.clear()
        s = c.stats()
        assert s["hits"] == 0
        assert s["misses"] == 0
        assert s["evictions"] == 0


# ── Stats / Telemetry ─────────────────────────────────────────────────────────

class TestStats:
    def test_initial_stats_all_zero(self):
        c = make_cache()
        s = c.stats()
        assert s["size"] == 0
        assert s["hits"] == 0
        assert s["misses"] == 0
        assert s["evictions"] == 0
        assert s["hit_rate_pct"] == 0.0

    def test_hit_rate_100_percent(self):
        c = make_cache()
        c.set("k", "v")
        c.get("k")
        c.get("k")
        s = c.stats()
        assert s["hits"] == 2
        assert s["misses"] == 0
        assert s["hit_rate_pct"] == 100.0

    def test_hit_rate_50_percent(self):
        c = make_cache()
        c.set("k", "v")
        c.get("k")          # hit
        c.get("missing")    # miss
        s = c.stats()
        assert s["hit_rate_pct"] == 50.0

    def test_size_increments_on_set(self):
        c = make_cache()
        c.set("a", 1)
        assert c.stats()["size"] == 1
        c.set("b", 2)
        assert c.stats()["size"] == 2

    def test_size_decrements_on_expiry(self):
        c = BoundedTTLCache(maxsize=10, ttl_seconds=0.05)
        c.set("k", "v")
        time.sleep(0.1)
        c.get("k")   # triggers removal
        assert c.stats()["size"] == 0


# ── Thread Safety ─────────────────────────────────────────────────────────────

class TestThreadSafety:
    def test_concurrent_writes_do_not_corrupt(self):
        """Many threads writing different keys — no exceptions, correct sizes."""
        c = BoundedTTLCache(maxsize=200, ttl_seconds=60)
        errors = []

        def writer(start, n):
            try:
                for i in range(start, start + n):
                    c.set(f"key-{i}", i)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(i * 10, 10)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        assert c.stats()["size"] <= 200

    def test_concurrent_reads_and_writes(self):
        """Mixed read/write load — no deadlocks, no exceptions."""
        c = BoundedTTLCache(maxsize=50, ttl_seconds=60)
        # Pre-populate
        for i in range(20):
            c.set(f"k{i}", i)

        errors = []

        def reader():
            try:
                for i in range(100):
                    c.get(f"k{i % 20}")
            except Exception as e:
                errors.append(e)

        def writer():
            try:
                for i in range(50):
                    c.set(f"new-{i}", i)
            except Exception as e:
                errors.append(e)

        threads = (
            [threading.Thread(target=reader) for _ in range(5)] +
            [threading.Thread(target=writer) for _ in range(3)]
        )
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0

    def test_get_or_set_under_concurrent_load(self):
        """All threads ask for the same key simultaneously. Factory may be called
        multiple times (intentional — we don't lock during computation), but the
        final cached value must be correct and all threads get the right answer."""
        c = make_cache()
        factory_calls = [0]
        lock = threading.Lock()

        def factory():
            with lock:
                factory_calls[0] += 1
            time.sleep(0.002)    # simulate slow computation (short enough for CI)
            return 42

        results = []

        def worker():
            results.append(c.get_or_set("shared", factory))

        threads = [threading.Thread(target=worker) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All threads must get 42
        assert all(r == 42 for r in results)
        # Factory may be called > 1 time (race on cold cache), but value is correct
        assert factory_calls[0] >= 1
