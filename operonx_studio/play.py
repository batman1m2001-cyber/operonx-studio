"""The playground's other end: one `operonx-play` bridge per project.

The studio never imports a project, so a playground session runs in a
bridge process (``python -m operonx.app.play``) started under the
project's own interpreter, spoken to in JSON lines (see
``operonx.app.play``). This module owns those processes: it starts one on
first use, relays requests to it, buffers what it says for the page to
poll by cursor (the same delivery as the assistant — the tunnel cuts any
response after ~10 s), and restarts it when the project's code has
changed and nothing is running, so an edit is live on the next session
or re-run without anyone thinking about processes.

A request that has an answer (``describe``, ``rerun``) can also be
awaited, which is what the assistant's tools do.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional

__all__ = ["BridgeError", "Bridges", "PlayBridge"]

#: A bridge nobody has used for this long is stopped.
IDLE_TTL = 15 * 60.0
_POLL_HOLD = 4.0
_KEEP_EVENTS = 4000
_LINE_LIMIT = 16 * 1024 * 1024


class BridgeError(RuntimeError):
    """The bridge could not start, or went away."""


def _explain(stderr: str) -> str:
    tail = stderr.strip().splitlines()[-12:]
    text = "\n".join(tail)
    if "No module named 'operonx.app.play'" in text:
        return ("this project's operonx has no playground — it needs operonx ≥ 1.9 "
                "in the project's environment")
    return text or "the playground bridge exited"


@dataclass
class PlayBridge:
    """One project's bridge process and what it has said."""

    root: Any
    cmd: List[str]
    env: Dict[str, str]
    fingerprint: Any = None
    proc: Optional[asyncio.subprocess.Process] = None
    events: List[Dict[str, Any]] = field(default_factory=list)
    base: int = 0                       # cursor of events[0]
    stderr: Deque[str] = field(default_factory=lambda: deque(maxlen=300))
    live: Dict[str, float] = field(default_factory=dict)   # open session ids
    waiters: Dict[str, asyncio.Future] = field(default_factory=dict)
    fresh: asyncio.Event = field(default_factory=asyncio.Event)
    last_used: float = field(default_factory=time.monotonic)
    ready: Optional[asyncio.Future] = None
    started_at: float = 0.0

    # -- lifecycle ----------------------------------------------------------

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> None:
        if self.alive:
            return
        loop = asyncio.get_running_loop()
        self.ready = loop.create_future()
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.cmd, cwd=str(self.root), env=self.env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=_LINE_LIMIT, start_new_session=True)
        except OSError as exc:
            raise BridgeError(f"could not start the playground bridge: {exc}") from None
        self.started_at = time.time()
        self.live.clear()
        loop.create_task(self._read_out(self.proc))
        loop.create_task(self._read_err(self.proc))
        try:
            await asyncio.wait_for(asyncio.shield(self.ready), timeout=120)
        except asyncio.TimeoutError:
            await self.stop()
            raise BridgeError("the playground bridge did not start within 120 s") from None

    async def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None and proc.returncode is None:
            try:
                proc.stdin.close()
                await asyncio.wait_for(proc.wait(), timeout=3)
            except Exception:  # noqa: BLE001
                proc.kill()
        for fut in self.waiters.values():
            if not fut.done():
                fut.set_exception(BridgeError("the playground bridge stopped"))
        self.waiters.clear()
        if self.live:
            for sid in list(self.live):
                self._push({"t": "ended", "sid": sid, "status": "error", "error": "the bridge stopped"})
            self.live.clear()

    async def _read_out(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            try:
                event = json.loads(raw)
            except ValueError:
                self.stderr.append(raw.decode(errors="replace").rstrip())
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("t")
            if kind == "ready" and self.ready is not None and not self.ready.done():
                self.ready.set_result(event)
                continue
            if kind == "opened":
                self.live[str(event.get("sid"))] = time.time()
            elif kind in ("ended", "refused"):
                self.live.pop(str(event.get("sid")), None)
            rid = event.get("id")
            if rid is not None and str(rid) in self.waiters:
                fut = self.waiters.pop(str(rid))
                if not fut.done():
                    fut.set_result(event)
            self._push(event)
        await proc.wait()
        if self.ready is not None and not self.ready.done():
            self.ready.set_exception(BridgeError(_explain("\n".join(self.stderr))))
        if proc is self.proc:  # died on its own
            self._push({"t": "bridge_exit", "code": proc.returncode, "text": _explain("\n".join(self.stderr))})
            self.proc = None
            for sid in list(self.live):
                self._push({"t": "ended", "sid": sid, "status": "error", "error": "the bridge exited"})
            self.live.clear()
            for fut in self.waiters.values():
                if not fut.done():
                    fut.set_exception(BridgeError(_explain("\n".join(self.stderr))))
            self.waiters.clear()

    async def _read_err(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            self.stderr.append(raw.decode(errors="replace").rstrip())

    # -- traffic --------------------------------------------------------------

    def _push(self, event: Dict[str, Any]) -> None:
        event.setdefault("at", time.time())
        self.events.append(event)
        if len(self.events) > _KEEP_EVENTS:
            drop = len(self.events) - _KEEP_EVENTS
            del self.events[:drop]
            self.base += drop
        self.fresh.set()

    async def send(self, msg: Dict[str, Any]) -> None:
        self.last_used = time.monotonic()
        if not self.alive:
            await self.start()
        assert self.proc is not None and self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

    async def ask(self, msg: Dict[str, Any], timeout: float = 120.0) -> Dict[str, Any]:
        """Send a request that has an answer, and wait for it."""
        rid = msg.setdefault("id", uuid.uuid4().hex[:12])
        fut = asyncio.get_running_loop().create_future()
        self.waiters[str(rid)] = fut
        await self.send(msg)
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self.waiters.pop(str(rid), None)

    async def poll(self, cursor: int = 0) -> Dict[str, Any]:
        self.last_used = time.monotonic()
        if cursor - self.base >= len(self.events):
            self.fresh.clear()
            try:
                await asyncio.wait_for(self.fresh.wait(), timeout=_POLL_HOLD)
            except asyncio.TimeoutError:
                pass
        start = max(cursor - self.base, 0)
        return {"events": self.events[start:], "cursor": self.base + len(self.events),
                "alive": self.alive, "live": sorted(self.live)}

    def status(self) -> Dict[str, Any]:
        return {"alive": self.alive, "live": sorted(self.live), "started_at": self.started_at,
                "log": list(self.stderr)[-40:]}


class Bridges:
    """Every project's bridge, keyed by project id."""

    def __init__(self) -> None:
        self._by_pid: Dict[str, PlayBridge] = {}

    async def get(self, pid: str, watcher: Any) -> PlayBridge:
        """The project's bridge, started — restarted first when the code
        changed since it started and no session is open."""
        self._sweep()
        bridge = self._by_pid.get(pid)
        fp = watcher.fingerprint()
        if bridge is None:
            bridge = PlayBridge(root=watcher.root, env=watcher._child_env(), fingerprint=fp,
                                cmd=[watcher.interpreter(), "-m", "operonx.app.play", "--root", str(watcher.root)])
            self._by_pid[pid] = bridge
        elif bridge.alive and bridge.fingerprint != fp and not bridge.live:
            await bridge.stop()
            bridge._push({"t": "bridge_restart", "reason": "the project's code changed"})
        if not bridge.alive:
            bridge.fingerprint = fp
            bridge.cmd[0] = watcher.interpreter()
            await bridge.start()
        return bridge

    def peek(self, pid: str) -> Optional[PlayBridge]:
        return self._by_pid.get(pid)

    async def restart(self, pid: str, watcher: Any) -> PlayBridge:
        bridge = self._by_pid.get(pid)
        if bridge is not None:
            await bridge.stop()
            bridge._push({"t": "bridge_restart", "reason": "restarted"})
        return await self.get(pid, watcher)

    def _sweep(self) -> None:
        now = time.monotonic()
        for bridge in self._by_pid.values():
            if bridge.alive and not bridge.live and now - bridge.last_used > IDLE_TTL:
                asyncio.get_running_loop().create_task(bridge.stop())



