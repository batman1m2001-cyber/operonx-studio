"""A project's secrets, kept outside the project (PROJECT_SOURCE_PLAN S1).

The project's ``.env`` is what everything reads, and it stays that. What
this adds is a copy of it in the studio's state, ``<state>/secrets/<project
id>/<environment>.env`` (0600), so the secrets outlive the folder: a clone
that is deleted and made again gets its ``.env`` back.

An environment is a named set of secrets and nothing more. One of them is
the current one: the set the project's ``.env`` holds now.

Two rules keep the copies honest, both in :func:`sync`:

* a ``.env`` in the project wins: it is what runs, and people edit it by
  hand, so it is saved over the current environment's copy;
* a project with no ``.env`` gets the current environment's copy.

Values never leave this module except into those two files.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List

from .envstatus import dotenv_names
from .registry import project_id, state_dir

__all__ = ["DEFAULT", "add", "current", "describe", "environments", "sync", "use"]

DEFAULT = "dev"
_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")


def _dir(pid: str) -> Path:
    return state_dir() / "secrets" / pid


def _file(pid: str, environment: str) -> Path:
    if not _NAME.fullmatch(environment):
        raise ValueError("an environment name like dev or staging: lowercase letters, digits, - and _")
    return _dir(pid) / f"{environment}.env"


def _write(path: Path, text: str) -> None:
    """Whole file, 0600 from its first byte, swapped in at once."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def environments(pid: str) -> List[str]:
    """The saved sets, the default first; always at least the default."""
    found = {p.stem for p in _dir(pid).glob("*.env")} if _dir(pid).is_dir() else set()
    found.add(current(pid))
    return sorted(found, key=lambda n: (n != DEFAULT, n))


def current(pid: str) -> str:
    name = _read(_dir(pid) / "current").strip()
    return name if _NAME.fullmatch(name) else DEFAULT


def sync(root: Path) -> None:
    """Make the project's ``.env`` and the current environment's copy agree."""
    pid = project_id(root)
    project, kept = Path(root) / ".env", _file(pid, current(pid))
    if project.is_file():
        text = _read(project)
        if text != _read(kept) or not kept.is_file():
            _write(kept, text)
    elif kept.is_file():
        _write(project, _read(kept))


def add(root: Path, environment: str) -> None:
    """A new, empty set. Refused when the name is taken."""
    path = _file(project_id(root), environment)
    if path.is_file():
        raise ValueError(f"{environment} already exists")
    sync(root)
    _write(path, "")


def use(root: Path, environment: str) -> None:
    """Put *environment*'s secrets in the project's ``.env``. What the
    ``.env`` held is saved to the environment it belonged to first."""
    pid = project_id(root)
    path = _file(pid, environment)
    if not path.is_file() and environment != current(pid):
        raise ValueError(f"no environment named {environment}")
    sync(root)
    _write(Path(root) / ".env", _read(path))
    _write(_dir(pid) / "current", environment + "\n")


def describe(root: Path) -> Dict:
    """Names only: which environments exist, which is current, and which
    variable names each one sets."""
    sync(root)
    pid = project_id(root)
    return {
        "current": current(pid),
        "environments": [{"name": n, "names": sorted(dotenv_names(_file(pid, n)))} for n in environments(pid)],
        "example": sorted(dotenv_names(Path(root) / ".env.example")),
    }
