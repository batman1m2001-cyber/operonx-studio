"""Services control: a project's listeners, running or not, from the studio.

A listener is one host and port and the services bound to it — the unit a
process serves (``operonx-serve --only a --only b``), because two processes
cannot share a port. The studio starts one the way a developer would, in
the project's own interpreter, detached, its output in a log under
``.operonx/services``; it stops what it started (the whole process group:
workers included); and it tells what is up by asking the port itself, so
a listener started from a terminal shows as running too.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

__all__ = ["Listener", "ServiceProcs", "listeners_of", "probe_port"]


def probe_port(host: str, port: int, timeout: float = 0.25) -> bool:
    """Something accepts connections on host:port."""
    target = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    try:
        with socket.create_connection((target, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


@dataclass
class Listener:
    host: str
    port: int
    services: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.host or '0.0.0.0'}:{self.port}"


def listeners_of(services: List[Dict[str, Any]]) -> List[Listener]:
    """The IR's services grouped by where they listen, in declaration order."""
    out: Dict[Tuple[str, int], Listener] = {}
    for s in services:
        if not s.get("port"):
            continue
        key = (str(s.get("host") or "0.0.0.0"), int(s["port"]))
        out.setdefault(key, Listener(*key)).services.append(s)
    return list(out.values())


@dataclass
class _Proc:
    popen: subprocess.Popen
    log: Path
    started: float
    names: List[str]
    stopped: bool = False  # ended because the studio stopped it, not on its own


class ServiceProcs:
    """What this studio started, per project and listener."""

    def __init__(self) -> None:
        self._procs: Dict[Tuple[str, str], _Proc] = {}

    def _alive(self, pid: str, key: str) -> Optional[_Proc]:
        p = self._procs.get((pid, key))
        if p is not None and p.popen.poll() is not None:
            return p  # ended — still the source of its log and exit code
        return p

    def state(self, pid: str, listener: Listener) -> Dict[str, Any]:
        p = self._alive(pid, listener.key)
        up = probe_port(listener.host, listener.port)
        ours = p is not None and p.popen.poll() is None
        return {
            "key": listener.key, "host": listener.host, "port": listener.port,
            "services": [s.get("name") for s in listener.services],
            "running": up, "managed": ours,
            "starting": ours and not up,
            # an exit the studio caused is a stop, not a crash worth a code
            "exit_code": p.popen.returncode if p is not None and not ours and not p.stopped else None,
            "started": p.started if p is not None else None,
            "log": str(p.log) if p is not None else None,
        }

    def start(self, pid: str, listener: Listener, *, interpreter: str, root: Path,
              env: Dict[str, str]) -> Dict[str, Any]:
        if probe_port(listener.host, listener.port):
            raise RuntimeError(f"{listener.key} is already taken — something is listening there")
        p = self._procs.get((pid, listener.key))
        if p is not None and p.popen.poll() is None:
            raise RuntimeError(f"{listener.key} is already starting")
        logs = root / ".operonx" / "services"
        logs.mkdir(parents=True, exist_ok=True)
        log = logs / f"{listener.port}-{time.strftime('%Y%m%dT%H%M%S')}.log"
        names = [str(s.get("name")) for s in listener.services]
        cmd = [interpreter, "-m", "operonx.cli.serve"]
        for n in names:
            cmd += ["--only", n]
        env = dict(env)
        env.setdefault("PYTHONUNBUFFERED", "1")
        with log.open("ab") as fh:
            popen = subprocess.Popen(cmd, cwd=str(root), stdout=fh, stderr=subprocess.STDOUT, env=env,
                                     start_new_session=True)
        self._procs[(pid, listener.key)] = _Proc(popen, log, time.time(), names)
        return {"started": listener.key, "pid": popen.pid, "log": str(log), "cmd": cmd[1:]}

    def stop(self, pid: str, key: str, timeout: float = 8.0) -> bool:
        """Stop what the studio started on *key* — its workers too."""
        p = self._procs.get((pid, key))
        if p is None or p.popen.poll() is not None:
            return False
        p.stopped = True
        try:
            os.killpg(p.popen.pid, signal.SIGTERM)
        except ProcessLookupError:
            return False
        try:
            p.popen.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.popen.pid, signal.SIGKILL)
            p.popen.wait(timeout=3)
        return True

    def log_tail(self, pid: str, key: str, max_bytes: int = 20000) -> str:
        p = self._procs.get((pid, key))
        if p is None or not p.log.is_file():
            return ""
        with p.log.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            return fh.read().decode("utf-8", "replace")

    def stop_all(self) -> None:
        for (pid, key) in list(self._procs):
            self.stop(pid, key, timeout=3)
