"""The project's files, read-only, for Project mode's Files page.

Git decides what shows: the tracked files and the new ones it does not ignore, so ``.env``, ``secrets.*`` and the
like stay out of a read-only member's view. A file changed and not committed, or committed in the last two hours,
is marked: what the assistant has been touching.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

MAX_BYTES = 400_000
RECENT = "2.hours"


def _git(root: Path, *args: str) -> Optional[str]:
    try:
        out = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def _listed(root: Path) -> Optional[List[str]]:
    out = _git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    if out is None:
        return None
    return sorted({p for p in out.split("\0") if p and (root / p).is_file()})


def _changed(root: Path) -> Dict[str, str]:
    # log and status name paths from the repo's top, ls-files from root: a project in a subfolder strips the prefix
    prefix = (_git(root, "rev-parse", "--show-prefix") or "").strip()
    marks: Dict[str, str] = {}
    for p in (_git(root, "log", f"--since={RECENT}", "--name-only", "--format=", "-z", "--", ".") or "").split("\0"):
        if p.strip():
            marks[p.strip()] = "recent"
    parts = (_git(root, "status", "--porcelain", "-z", "--untracked-files=all", "--", ".") or "").split("\0")
    i = 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        marks[entry[3:]] = "uncommitted"
        if entry[0] in "RC":  # a rename carries its old path next
            i += 1
    return {p[len(prefix):]: m for p, m in marks.items() if p.startswith(prefix)}


def tree(root: Path) -> Dict[str, Any]:
    """``{"ok", "root", "files": [path, …], "changed": {path: "uncommitted" | "recent"}}``; ``root`` turns an absolute path the
    assistant names into one of these."""
    files = _listed(root)
    if files is None:
        return {"ok": False, "message": "not a git checkout: the Files page reads what git tracks"}
    have = set(files)
    return {"ok": True, "root": str(root), "files": files, "changed": {p: m for p, m in _changed(root).items() if p in have}}


def read(root: Path, path: str) -> Dict[str, Any]:
    """One listed file: ``text`` (up to :data:`MAX_BYTES`), or ``binary``; anything not listed is refused."""
    files = _listed(root)
    if files is None or path not in set(files):
        return {"ok": False, "message": f"no file {path!r} in this project"}
    data = (root / path).read_bytes()
    out: Dict[str, Any] = {"ok": True, "path": path, "size": len(data)}
    if b"\0" in data[:8192]:
        return {**out, "binary": True}
    return {**out, "text": data[:MAX_BYTES].decode("utf-8", "replace"), "truncated": len(data) > MAX_BYTES}
