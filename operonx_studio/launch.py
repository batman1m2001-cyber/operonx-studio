"""Launch tickets: how `operonx studio` hands a running studio a project.

The command writes a ticket — a small file naming the project — into the
studio's own state directory, then opens ``/open?t=<ticket>`` in the
browser, which already carries the person's sign-in. The studio takes the
ticket once, adds the project to its list and shows it.

A ticket is a file rather than a path in the URL so that a link on some
other site cannot make the studio open (and import) an arbitrary folder:
only someone who can write into the studio's state can make one.
"""

from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path
from typing import Optional

__all__ = ["TICKET_TTL", "Claim", "claim", "make_ticket", "running_info", "take_ticket"]

#: How long a ticket stays good (seconds): a browser that takes longer than
#: this to open the link gets the home screen instead.
TICKET_TTL = 600

_NAME = re.compile(r"^[0-9a-f]{32}$")


def _dir() -> Path:
    from operonx_studio.registry import state_dir

    return state_dir() / "launch"


def make_ticket(root: Path) -> str:
    """Write a ticket for *root*; return its name for ``/open?t=``."""
    folder = _dir()
    folder.mkdir(parents=True, exist_ok=True)
    name = secrets.token_hex(16)
    path = folder / f"{name}.json"
    path.write_text(json.dumps({"path": str(Path(root).resolve()), "at": time.time()}), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:  # pragma: no cover — a filesystem without modes
        pass
    return name


def take_ticket(name: str) -> Optional[Path]:
    """The project a ticket names, once: the ticket is gone afterwards.
    ``None`` for a malformed, unknown or expired ticket."""
    if not _NAME.match(name or ""):
        return None
    path = _dir() / f"{name}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        path.unlink()
    except (OSError, ValueError):
        return None
    if time.time() - float(data.get("at") or 0) > TICKET_TTL:
        return None
    root = Path(str(data.get("path") or ""))
    return root if root.is_dir() else None


# ── one studio per state ─────────────────────────────────────────────────
#
# A studio holds an OS lock on <state>/studio.lock for as long as it runs,
# and says where it listens in <state>/studio.run.json. A second launch
# that cannot take the lock knows a studio is running — whatever port it
# is on, however slow it is to answer — and hands it the project instead
# of starting another. The OS drops the lock when the process dies, crash
# or not, so a stale run file never blocks a new studio.


def _lock_path() -> Path:
    from operonx_studio.registry import state_dir

    return state_dir() / "studio.lock"


def _run_path() -> Path:
    from operonx_studio.registry import state_dir

    return state_dir() / "studio.run.json"


def _try_lock(fh) -> bool:
    try:
        import fcntl

        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False
    except ImportError:  # pragma: no cover — Windows
        import msvcrt

        try:
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False


class Claim:
    """This process is the state's studio: the lock, held until :meth:`release`."""

    def __init__(self, fh):
        self._fh = fh

    def announce(self, host: str, port: int) -> None:
        import os

        _run_path().write_text(json.dumps({"host": host, "port": port, "pid": os.getpid(),
                                           "at": time.time()}), encoding="utf-8")

    def release(self) -> None:
        try:
            _run_path().unlink()
        except OSError:
            pass
        try:
            self._fh.close()  # closing drops the lock
        except OSError:  # pragma: no cover
            pass


def claim() -> Optional[Claim]:
    """Become this state's studio: the held lock, or ``None`` when another
    studio already holds it."""
    path = _lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "a+")  # noqa: SIM115 — held open for the studio's life
    if _try_lock(fh):
        # a run file with no lock behind it is a studio that died (or one
        # that a signal ended before it could tidy up): not ours to trust
        try:
            _run_path().unlink()
        except OSError:
            pass
        return Claim(fh)
    fh.close()
    return None


def running_info(wait: float = 15.0) -> Optional[dict]:
    """Where the studio holding the lock listens ({host, port, pid}); it may
    still be starting, so wait up to *wait* seconds for it to say."""
    deadline = time.time() + wait
    while True:
        try:
            data = json.loads(_run_path().read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("port"):
                return data
        except (OSError, ValueError):
            pass
        if time.time() >= deadline:
            return None
        time.sleep(0.2)
