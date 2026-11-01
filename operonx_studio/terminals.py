"""Terminals: real shells in a pseudo-terminal, per project (docs/WORKSPACE_PLAN.md W2).

A terminal is a login shell (or one command) on a PTY, in the project's checkout or one of its worktrees, with
the environment the assistant's own processes get (:func:`operonx_studio.chat.base_env`; a terminal the
assistant opens also gets the git guard, :func:`operonx_studio.gitpolicy.assistant_env`). It runs in its own
session and process group, and closing it hangs up the whole group, as the studio stops a service it started.

What it printed is kept (the last :data:`KEEP` bytes) so a page that opens later, or the assistant, reads it from
the start; every reader gets the output after the offset it has, so nothing is sent twice. Whether a command is
running is the terminal's own answer — its foreground process group is not the shell's — never a guess from
how recently it printed.

Terminals live as long as the studio process: a restart ends them, as it ends a turn.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import re
import signal
import struct
import subprocess
import termios
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

from fastapi import Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from starlette.routing import WebSocketRoute

__all__ = ["KEEP", "Terminal", "Terminals", "plain", "register", "worktrees"]

KEEP = 512 * 1024  # bytes of output kept per terminal
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r")


def plain(text: str) -> str:
    """Terminal output as text: colours, cursor moves and carriage returns gone."""
    return _ANSI.sub("", text)


@dataclass
class Terminal:
    id: str
    pid: str
    cwd: str
    title: str
    by: str
    card: str
    popen: subprocess.Popen
    master: int
    started: float
    out: bytearray = field(default_factory=bytearray)
    base: int = 0  # the offset of out[0] in everything printed
    last: float = 0.0
    ended: Optional[float] = None
    readers: Set[asyncio.Queue] = field(default_factory=set)

    @property
    def end(self) -> int:
        return self.base + len(self.out)

    def since(self, offset: int) -> bytes:
        return bytes(self.out[max(0, offset - self.base):])

    def running(self) -> str:
        """The command in the foreground, or "" when the shell waits for one."""
        if self.ended is not None:
            return ""
        try:
            fg = os.tcgetpgrp(self.master)
        except OSError:
            return ""
        if fg in (self.popen.pid, -1):
            return ""
        try:
            return Path(f"/proc/{fg}/comm").read_text().strip() or "a command"
        except OSError:
            return "a command"

    def as_dict(self) -> Dict[str, Any]:
        now = self.running()
        return {"id": self.id, "title": self.title, "cwd": self.cwd, "by": self.by, "card": self.card,
                "started": self.started, "last": self.last or self.started,
                "state": "ended" if self.ended is not None else ("working" if now else "idle"),
                "running": now, "exit_code": self.popen.returncode if self.ended is not None else None,
                "bytes": self.end}


class Terminals:
    """The terminals this studio opened, by id."""

    def __init__(self) -> None:
        self._all: Dict[str, Terminal] = {}

    def of(self, pid: str) -> List[Terminal]:
        return sorted((t for t in self._all.values() if t.pid == pid), key=lambda t: t.started)

    def get(self, pid: str, tid: str) -> Optional[Terminal]:
        t = self._all.get(tid)
        return t if t is not None and t.pid == pid else None

    def open(self, pid: str, cwd: Path, env: Dict[str, str], *, command: str = "", title: str = "",
             by: str = "owner", card: str = "", rows: int = 30, cols: int = 110) -> Terminal:
        master, slave = os.openpty()
        _winsize(master, rows, cols)
        env = dict(env, TERM="xterm-256color", COLORTERM="truecolor")
        shell = env.get("SHELL") or "/bin/bash"
        argv = [shell, "-lc", command] if command else [shell, "-l"]

        def child() -> None:  # the PTY becomes the new session's controlling terminal
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        try:
            popen = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=slave, stdout=slave, stderr=slave,
                                     start_new_session=True, preexec_fn=child, close_fds=True)
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        tid = uuid.uuid4().hex[:10]
        t = Terminal(tid, pid, str(cwd), title or (command[:60] if command else Path(cwd).name), by, card,
                     popen, master, time.time())
        self._all[tid] = t
        try:
            asyncio.get_running_loop().add_reader(master, self._read, t)
        except RuntimeError:  # no loop (a test, a thread): read on demand
            pass
        return t

    def _read(self, t: Terminal) -> None:
        try:
            chunk = os.read(t.master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: the shell and everything on the PTY ended
            chunk = b""
        if not chunk:
            self._ended(t)
            return
        t.out += chunk
        if len(t.out) > KEEP:
            cut = len(t.out) - KEEP
            del t.out[:cut]
            t.base += cut
        t.last = time.time()
        for q in list(t.readers):
            q.put_nowait(t.end)

    def pump(self, t: Terminal) -> None:
        """Read what is there now (no event loop reading for us)."""
        for _ in range(64):
            before = t.end
            self._read(t)
            if t.end == before:
                break

    def _ended(self, t: Terminal) -> None:
        if t.ended is not None:
            return
        try:
            asyncio.get_running_loop().remove_reader(t.master)
        except (RuntimeError, ValueError):
            pass
        try:
            t.popen.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        t.ended = time.time()
        for q in list(t.readers):
            q.put_nowait(-1)

    def write(self, t: Terminal, data: str) -> None:
        if t.ended is None:
            os.write(t.master, data.encode("utf-8", "replace"))

    def resize(self, t: Terminal, rows: int, cols: int) -> None:
        if t.ended is None:
            _winsize(t.master, rows, cols)

    def close(self, pid: str, tid: str) -> bool:
        """Hang up the terminal's whole process group and forget it."""
        t = self.get(pid, tid)
        if t is None:
            return False
        if t.ended is None:
            for sig in (signal.SIGHUP, signal.SIGKILL):
                try:
                    os.killpg(t.popen.pid, sig)
                except ProcessLookupError:
                    break
                try:
                    t.popen.wait(timeout=2)
                    break
                except subprocess.TimeoutExpired:
                    continue
            self._ended(t)
        try:
            os.close(t.master)
        except OSError:
            pass
        self._all.pop(tid, None)
        return True

    def close_all(self) -> None:
        for t in list(self._all.values()):
            self.close(t.pid, t.id)



def _winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, rows), max(10, cols), 0, 0))


def worktrees(root: Path) -> List[str]:
    """The checkout and its worktrees: where a terminal may start."""
    try:
        out = subprocess.run(["git", "-C", str(root), "worktree", "list", "--porcelain"], capture_output=True,
                             text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    found = [line[9:] for line in out.splitlines() if line.startswith("worktree ")]
    return found or [str(root)]


def register(app: Any, *, terms: Terminals, watcher_of: Callable[[str], Any],
             env_of: Callable[[str, Path, str], Dict[str, str]], ws_user: Callable[[Any], Optional[Dict[str, Any]]],
             on_open: Optional[Callable[[str, Terminal], None]] = None) -> None:
    """The terminal routes: list, open, type, read, close, and the live socket a page draws one with.

    *env_of(pid, root, by)* is the environment a terminal starts with; *ws_user(websocket)* is who opened the
    socket, ``None`` when they may not (the HTTP sign-in and same-origin checks do not see a websocket)."""
    def root_of(pid: str) -> Optional[Path]:
        w = watcher_of(pid)
        return Path(w.root) if w is not None else None

    @app.get("/api/p/{pid}/terminals")
    async def terminals_list(pid: str) -> JSONResponse:
        root = root_of(pid)
        if root is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        places = await asyncio.to_thread(worktrees, root)
        return JSONResponse({"terminals": [t.as_dict() for t in terms.of(pid)], "places": places})

    @app.post("/api/p/{pid}/terminals")
    async def terminals_open(pid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        root = root_of(pid)
        if root is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        places = await asyncio.to_thread(worktrees, root)
        cwd = str(body.get("cwd") or root)
        if not any(cwd == p or cwd.startswith(p.rstrip("/") + "/") for p in places) or not Path(cwd).is_dir():
            return JSONResponse({"error": f"{cwd} is not in the project's checkout or its worktrees"}, status_code=400)
        user = getattr(request.state, "user", None) or {}
        # the header too (the Board reads it the same way): it only adds the git guard, so claiming it gains nothing
        by = "assistant" if user.get("via") == "assistant" or request.headers.get("x-operonx-via") == "assistant" \
            else "owner"
        env = await asyncio.to_thread(env_of, pid, root, by)
        t = terms.open(pid, Path(cwd), env, command=str(body.get("command") or ""), title=str(body.get("title") or ""),
                       by=by, card=str(body.get("card") or ""), rows=int(body.get("rows") or 30),
                       cols=int(body.get("cols") or 110))
        if on_open is not None:
            on_open(pid, t)
        return JSONResponse(t.as_dict())

    @app.post("/api/p/{pid}/terminals/{tid}")
    async def terminals_send(pid: str, tid: str, body: Dict[str, Any]) -> JSONResponse:
        t = terms.get(pid, tid)
        if t is None:
            return JSONResponse({"error": "no such terminal"}, status_code=404)
        if body.get("close"):  # the assistant's way (its client posts; DELETE is the page's)
            return JSONResponse({"ok": await asyncio.to_thread(terms.close, pid, tid)})
        for k in ("title", "card"):
            if isinstance(body.get(k), str):
                setattr(t, k, body[k][:200])
        if body.get("rows") and body.get("cols"):
            terms.resize(t, int(body["rows"]), int(body["cols"]))
        if body.get("input"):
            if t.ended is not None:
                return JSONResponse({"error": "the terminal has ended", **t.as_dict()}, status_code=409)
            terms.write(t, str(body["input"]))
        return JSONResponse(t.as_dict())

    @app.get("/api/p/{pid}/terminals/{tid}/output")
    async def terminals_output(pid: str, tid: str, since: int = 0, raw: bool = False) -> JSONResponse:
        t = terms.get(pid, tid)
        if t is None:
            return JSONResponse({"error": "no such terminal"}, status_code=404)
        text = t.since(since).decode("utf-8", "replace")
        return JSONResponse({**t.as_dict(), "since": max(since, t.base), "text": text if raw else plain(text)})

    @app.delete("/api/p/{pid}/terminals/{tid}")
    async def terminals_close(pid: str, tid: str) -> JSONResponse:
        ok = await asyncio.to_thread(terms.close, pid, tid)
        return JSONResponse({"ok": ok}, status_code=200 if ok else 404)

    async def terminals_ws(ws: WebSocket) -> None:
        pid, tid = ws.path_params["pid"], ws.path_params["tid"]
        t = terms.get(pid, tid)
        if ws_user(ws) is None or t is None:
            await ws.close(code=4403 if t is not None else 4404)
            return
        await ws.accept()
        q: asyncio.Queue = asyncio.Queue()
        t.readers.add(q)
        sent = t.base

        async def pump() -> None:
            nonlocal sent
            while True:
                if t.end > sent:
                    chunk = t.since(sent)
                    sent = t.end
                    await ws.send_bytes(chunk)
                if t.ended is not None:
                    await ws.send_json({"ended": True, "exit_code": t.popen.returncode})
                    return
                await q.get()

        task = asyncio.create_task(pump())
        try:
            while True:
                msg = await ws.receive_json()
                if "i" in msg:
                    terms.write(t, str(msg["i"]))
                elif "r" in msg:
                    terms.resize(t, int(msg["r"][0]), int(msg["r"][1]))
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            task.cancel()
            t.readers.discard(q)

    # a plain Starlette route: the app's HTTP dependency (the access table) cannot read a websocket, ws_user does
    app.router.routes.append(WebSocketRoute("/api/p/{pid}/terminals/{tid}/ws", terminals_ws))
