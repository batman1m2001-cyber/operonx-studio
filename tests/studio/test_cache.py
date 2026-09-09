"""The studio cache: layered, shared, and never a point of failure."""

from __future__ import annotations

import time

import pytest

from operonx_studio.cache import DiskCache, LayeredCache, RedisCache

pytestmark = pytest.mark.unit


class FakeRedisClient:
    """A dict wearing the two redis methods the cache uses."""

    def __init__(self):
        self.data = {}
        self.calls = 0

    def get(self, key):
        self.calls += 1
        return self.data.get(key)

    def set(self, key, value, ex=None):
        self.calls += 1
        self.data[key] = value


class BrokenRedisClient:
    def get(self, key):
        raise ConnectionError("cluster down")

    def set(self, key, value, ex=None):
        raise ConnectionError("cluster down")


class TestDiskCache:
    def test_roundtrip(self, tmp_path):
        c = DiskCache(tmp_path)
        c.set_json("ir:abc", {"x": 1})
        assert c.get_json("ir:abc") == {"x": 1}
        assert c.get_json("ir:missing") is None

    def test_ttl_expires(self, tmp_path):
        c = DiskCache(tmp_path)
        c.set_json("k", "v", ttl=0.05)
        assert c.get_json("k") == "v"
        time.sleep(0.06)
        assert c.get_json("k") is None


class TestRedisCache:
    def test_roundtrip_is_namespaced(self):
        fake = FakeRedisClient()
        c = RedisCache("ignored", client=fake)
        c.set_json("ir:abc", [1, 2])
        assert c.get_json("ir:abc") == [1, 2]
        assert all(k.startswith("oxstudio:") for k in fake.data)

    def test_a_dead_cluster_trips_the_breaker_and_degrades(self):
        """One failure must not become a timeout on every request."""
        c = RedisCache("ignored", client=BrokenRedisClient())
        assert c.get_json("k") is None          # fails, trips
        # swap in a healthy client: still silent until the breaker resets
        c._client = FakeRedisClient()
        assert c.get_json("k") is None
        assert c._client.calls == 0, "breaker must skip the round-trip"
        c._down_until = 0.0                      # breaker window over
        c.set_json("k", "v")
        assert c.get_json("k") == "v"


class TestLayeredCache:
    def test_reads_promote_hits_upward(self, tmp_path):
        upper = RedisCache("ignored", client=FakeRedisClient())
        lower = DiskCache(tmp_path)
        lower.set_json("k", "warm")
        layered = LayeredCache([upper, lower])
        assert layered.get_json("k") == "warm"
        # promoted: the next read never reaches the lower layer
        assert upper.get_json("k") == "warm"

    def test_writes_reach_every_layer(self, tmp_path):
        upper = RedisCache("ignored", client=FakeRedisClient())
        lower = DiskCache(tmp_path)
        LayeredCache([upper, lower]).set_json("k", 7)
        assert upper.get_json("k") == 7
        assert lower.get_json("k") == 7

    def test_a_broken_layer_is_skipped_not_fatal(self, tmp_path):
        broken = RedisCache("ignored", client=BrokenRedisClient())
        lower = DiskCache(tmp_path)
        layered = LayeredCache([broken, lower])
        layered.set_json("k", "v")
        assert layered.get_json("k") == "v"


class TestSharedWarmth:
    def test_two_watchers_share_one_cache(self, tmp_path):
        """The reason redis is worth having: a second studio (or a
        restarted one) preloads from what the first extracted."""
        from operonx_studio.daemon import ProjectWatcher

        root = tmp_path / "proj"
        root.mkdir()
        (root / "main.py").write_text(
            "from operonx.core import graph, op, START, END\n"
            "@op\ndef a(x: int = 1):\n    return {'y': x}\n"
            "@graph\ndef flow():\n    s = a()\n    START >> s >> END\n",
            encoding="utf-8")
        (root / "operonx.toml").write_text(
            '[project]\nname="p"\n[[graph]]\nname="flow"\nentry="main:flow"\n',
            encoding="utf-8")

        shared = LayeredCache([RedisCache("ignored", client=FakeRedisClient())])
        first = ProjectWatcher(root=root, cache=shared)
        assert first.refresh().ok

        second = ProjectWatcher(root=root, cache=shared)
        assert second.last.ok, "the second watcher must preload from the shared tier"
        assert second.last.ir == first.last.ir
