"""The studio cache — one interface, layered backends.

Everything the studio computes but could recompute — extracted IR,
trace summaries, Langfuse fetches — goes through here. The layering:

    memory   (per-process, what the code already had)
    redis    (shared: every studio on the network, every restart)
    disk     (~/.operonx, the machine's own warmth)

Reads try layers in order and promote hits upward; writes go to every
layer, best-effort. Redis is configured by environment, because a cache
is machine infrastructure, not project truth::

    OPERONX_STUDIO_REDIS=192.168.1.212:30001,192.168.1.20:30001,...

Redis being down, missing, or not installed degrades to disk — never to
an error and never to a hang: a 30s circuit breaker stops a dead cluster
from adding a timeout to every request.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, List, Optional

__all__ = ["DiskCache", "RedisCache", "LayeredCache", "studio_cache"]

_NAMESPACE = "oxstudio:"


class DiskCache:
    """One JSON file per key, under a directory the env may override."""

    def __init__(self, directory: Optional[Path] = None):
        self._dir = directory or Path(
            os.environ.get("OPERONX_IR_CACHE", str(Path.home() / ".operonx" / "ircache")))

    def _file(self, key: str) -> Path:
        digest = hashlib.sha1(key.encode()).hexdigest()[:20]
        return self._dir / f"{digest}.json"

    def get_json(self, key: str) -> Optional[Any]:
        try:
            raw = json.loads(self._file(key).read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — absent or corrupt: a miss
            return None
        if raw.get("expires") and raw["expires"] < time.time():
            return None
        return raw.get("value")

    def set_json(self, key: str, value: Any, ttl: Optional[float] = None) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            self._file(key).write_text(json.dumps({
                "value": value,
                "expires": (time.time() + ttl) if ttl else None,
            }), encoding="utf-8")
        except OSError:
            pass  # an unwritable cache is a cold start later, not an error


class RedisCache:
    """The shared tier. Never raises; a failure trips a 30s breaker."""

    RETRY_AFTER = 30.0

    def __init__(self, nodes: str, client: Any = None):
        self._nodes = nodes
        self._client = client
        self._down_until = 0.0

    def _connect(self):
        if self._client is not None:
            return self._client
        from redis.cluster import ClusterNode, RedisCluster

        startup = [ClusterNode(h, int(p)) for h, p in
                   (hp.split(":") for hp in self._nodes.split(",") if hp.strip())]
        self._client = RedisCluster(
            startup_nodes=startup, socket_timeout=2, socket_connect_timeout=2)
        return self._client

    def _guard(self) -> bool:
        return time.time() >= self._down_until

    def _trip(self) -> None:
        self._down_until = time.time() + self.RETRY_AFTER

    def get_json(self, key: str) -> Optional[Any]:
        if not self._guard():
            return None
        try:
            raw = self._connect().get(_NAMESPACE + key)
            return None if raw is None else json.loads(raw)
        except Exception:  # noqa: BLE001 — the cluster's problem, not the studio's
            self._trip()
            return None

    def set_json(self, key: str, value: Any, ttl: Optional[float] = None) -> None:
        if not self._guard():
            return
        try:
            payload = json.dumps(value)
            if ttl:
                self._connect().set(_NAMESPACE + key, payload, ex=int(ttl))
            else:
                self._connect().set(_NAMESPACE + key, payload)
        except Exception:  # noqa: BLE001
            self._trip()


class LayeredCache:
    """Read through the layers in order, promote hits, write to all."""

    def __init__(self, layers: List[Any]):
        self._layers = layers

    def get_json(self, key: str) -> Optional[Any]:
        for i, layer in enumerate(self._layers):
            value = layer.get_json(key)
            if value is not None:
                for upper in self._layers[:i]:
                    upper.set_json(key, value)
                return value
        return None

    def set_json(self, key: str, value: Any, ttl: Optional[float] = None) -> None:
        for layer in self._layers:
            layer.set_json(key, value, ttl=ttl)


_singleton: Optional[LayeredCache] = None


def studio_cache(refresh: bool = False) -> LayeredCache:
    """The process-wide cache, shaped by the environment once."""
    global _singleton
    if _singleton is not None and not refresh:
        return _singleton
    layers: List[Any] = []
    nodes = os.environ.get("OPERONX_STUDIO_REDIS", "").strip()
    if nodes:
        try:
            import redis  # noqa: F401 — only to prove it is installed
            layers.append(RedisCache(nodes))
        except ImportError:
            pass  # configured but not installed: disk carries on alone
    layers.append(DiskCache())
    _singleton = LayeredCache(layers)
    return _singleton
