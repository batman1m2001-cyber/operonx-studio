"""Which projects the studio knows about, and what it remembers of them.

State is one JSON file, ``~/.operonx/studio.json`` — recents, nothing else.
Everything worth knowing about a project lives in the project (the
manifest, the code, the traces); duplicating any of it here would be a
cache that lies after an edit. What the file holds is only what cannot be
derived: which directories the user has opened, and when.

Project ids are short digests of the resolved path rather than the path
itself, because ids travel in URLs and paths do not belong there — but the
digest is *of* the path, so the same directory is the same project across
restarts with no registry lookup needed.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

__all__ = ["ProjectRef", "Recents", "project_id"]

STATE_DIR = Path.home() / ".operonx"
STATE_FILE = STATE_DIR / "studio.json"
MANIFEST = "operonx.toml"


def project_id(root: Path) -> str:
    return hashlib.sha1(str(Path(root).resolve()).encode()).hexdigest()[:12]


@dataclass
class ProjectRef:
    """One project the studio has seen."""

    root: Path
    opened_at: float

    @property
    def id(self) -> str:
        return project_id(self.root)

    @property
    def name(self) -> str:
        # The manifest's name when it parses; the directory's otherwise.
        # A broken manifest must still be openable — fixing it is exactly
        # what the user opened the studio to do.
        try:
            import tomllib as toml
        except ModuleNotFoundError:  # pragma: no cover — 3.10
            import tomli as toml
        try:
            raw = toml.loads((self.root / MANIFEST).read_text(encoding="utf-8"))
            return str((raw.get("project") or {}).get("name") or self.root.name)
        except Exception:  # noqa: BLE001
            return self.root.name

    @property
    def exists(self) -> bool:
        return (self.root / MANIFEST).is_file()

    def as_dict(self) -> Dict:
        return {
            "id": self.id,
            "root": str(self.root),
            "name": self.name,
            "exists": self.exists,
            "opened_at": self.opened_at,
        }


class Recents:
    """The open-project history, persisted across studio restarts."""

    def __init__(self, state_file: Optional[Path] = None):
        self._file = state_file or STATE_FILE
        self._items: Dict[str, ProjectRef] = {}
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self._file.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — absent or corrupt: start empty
            return
        for entry in raw.get("recents", []):
            try:
                ref = ProjectRef(root=Path(entry["root"]), opened_at=float(entry["opened_at"]))
                self._items[ref.id] = ref
            except Exception:  # noqa: BLE001 — one bad entry loses one entry
                continue

    def _save(self) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        payload = {"recents": [{"root": str(r.root), "opened_at": r.opened_at}
                               for r in self.ordered()]}
        self._file.write_text(json.dumps(payload, indent=1), encoding="utf-8")

    def touch(self, root: Path) -> ProjectRef:
        ref = ProjectRef(root=Path(root).resolve(), opened_at=time.time())
        self._items[ref.id] = ref
        self._save()
        return ref

    def forget(self, pid: str) -> None:
        if self._items.pop(pid, None) is not None:
            self._save()

    def get(self, pid: str) -> Optional[ProjectRef]:
        return self._items.get(pid)

    def ordered(self) -> List[ProjectRef]:
        return sorted(self._items.values(), key=lambda r: -r.opened_at)
