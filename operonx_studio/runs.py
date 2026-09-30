"""Which run store a project reads, and how long its runs are kept.

The studio never keeps runs of its own: it opens the project's
:class:`~operonx.telemetry.runs.RunStore` — the same object the project's
services and jobs write into — from configuration, without importing the
project. Which store, in order:

1. ``[studio] runs = "run_store:<name>"`` in ``operonx.toml``;
2. ``run_store: default`` in the project's resources file;
3. ``[studio] traces = "<dir>"`` — a directory some local consumer
   writes (the files store indexes it, flat or by origin);
4. ``<project>/.operonx/runs`` — where operonx files runs by default.

A ``[studio.langfuse]`` table adds a second, read-only source for runs
that live only on Langfuse; their ids carry an ``lf:`` prefix here.

Retention is per project: ``[studio.retention]`` in ``operonx.toml``
(days per origin, ``"forever"`` to keep), else operonx's defaults. The
sweep runs when a project's store first opens and then once a day.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

try:
    import tomllib as _toml
except ModuleNotFoundError:  # pragma: no cover — 3.10
    import tomli as _toml  # type: ignore[no-redef]

from operonx.telemetry.runs import DEFAULT_RETENTION, RunStore, apply_retention, open_run_store

from operonx_studio.registry import MANIFEST

__all__ = [
    "LF_PREFIX",
    "ProjectRuns",
    "project_runs",
    "read_retention",
    "write_retention",
]

LF_PREFIX = "lf:"
_ENV = re.compile(r"\$\{([^}:]+)(?::([^}]*))?\}")
_SWEEP_EVERY = 86400.0


def _env(value: Any) -> Any:
    """``${VAR}`` / ``${VAR:default}`` against this process's environment."""
    if isinstance(value, str):
        return _ENV.sub(lambda m: os.environ.get(m.group(1)) or (m.group(2) or ""), value)
    if isinstance(value, dict):
        return {k: _env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_env(v) for v in value]
    return value


def _manifest(root: Path) -> Dict[str, Any]:
    try:
        return _toml.loads((root / MANIFEST).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _resources(root: Path, manifest: Dict[str, Any]) -> Dict[str, Any]:
    overlay = (manifest.get("resources") or {}).get("overlay") or "resources.yaml"
    path = root / str(overlay)
    if not path.is_file():
        return {}
    try:
        import yaml

        return dict(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
    except Exception:  # noqa: BLE001
        return {}


def _anchor(root: Path, value: Any, default: Path) -> str:
    """A configured path, anchored at the project when relative."""
    if not value:
        return str(default)
    path = Path(str(value)).expanduser()
    return str(path if path.is_absolute() else root / path)


def _store_spec(root: Path) -> Tuple[Dict[str, Any], str]:
    """The primary store's spec, and a sentence saying where it came from."""
    manifest = _manifest(root)
    studio = dict(manifest.get("studio") or {})
    runs_dir = root / ".operonx" / "runs"
    stores = dict((_resources(root, manifest).get("run_store") or {}))
    named = str(studio.get("runs") or "")
    key = named.split(":", 1)[1] if named.startswith("run_store:") else None
    spec = stores.get(key) if key else stores.get("default")
    if isinstance(spec, dict):
        spec = _env(dict(spec))
        backend = str(spec.get("backend") or "files")
        if backend == "files":
            spec["root"] = _anchor(root, spec.get("root"), runs_dir)
        elif backend == "sqlite":
            spec["path"] = _anchor(root, spec.get("path"), runs_dir / "runs.sqlite")
        return spec, f"run_store:{key or 'default'} ({backend})"
    if studio.get("traces"):
        where = _anchor(root, _env(str(studio["traces"])), runs_dir)
        return {"backend": "files", "root": where}, f"[studio] traces → {where}"
    return {"backend": "files", "root": str(runs_dir)}, f"{runs_dir}"


def _langfuse_spec(root: Path) -> Optional[Dict[str, Any]]:
    table = (_manifest(root).get("studio") or {}).get("langfuse")
    if not isinstance(table, dict):
        return None
    cfg = _env(dict(table))
    host = str(cfg.get("host") or "").rstrip("/")
    public, secret = str(cfg.get("public_key") or ""), str(cfg.get("secret_key") or "")
    if not (host and public and secret):
        return None
    return {"backend": "langfuse", "host": host, "public_key": public, "secret_key": secret}


# ── retention ────────────────────────────────────────────────────────────


def read_retention(root: Path) -> Dict[str, Optional[float]]:
    """The project's policy: days per origin, ``None`` for forever."""
    table = (_manifest(root).get("studio") or {}).get("retention")
    policy: Dict[str, Optional[float]] = dict(DEFAULT_RETENTION)
    if isinstance(table, dict):
        for origin, value in table.items():
            if origin not in policy:
                continue
            if isinstance(value, str) and value.strip().lower() in ("forever", "never", "keep"):
                policy[origin] = None
            elif isinstance(value, (int, float)) and value >= 0:
                policy[origin] = float(value)
    return policy


def write_retention(root: Path, policy: Dict[str, Optional[float]]) -> None:
    """Save the policy as ``[studio.retention]`` in ``operonx.toml`` —
    replacing that table's lines if present, appending it otherwise.
    Every other line of the file is left exactly as it was."""
    lines = []
    for origin in DEFAULT_RETENTION:
        if origin not in policy:
            continue
        days = policy[origin]
        if days is None:
            value = '"forever"'
        else:
            days = float(days)
            if days < 0:
                raise ValueError(f"{origin}: retention must be >= 0 days or forever")
            value = str(int(days)) if days.is_integer() else repr(days)
        lines.append(f"{origin} = {value}")
    table = "[studio.retention]\n" + "\n".join(lines) + "\n"
    path = root / MANIFEST
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    out, skipping, replaced = [], False, False
    for line in text.splitlines(keepends=True):
        header = line.strip()
        if header.startswith("[") and header.endswith("]"):
            if header == "[studio.retention]":
                out.append(table)
                skipping = replaced = True
                continue
            skipping = False
        if not skipping:
            out.append(line)
    if not replaced:
        if out and not out[-1].endswith("\n"):
            out.append("\n")
        out.append(("\n" if out else "") + table)
    path.write_text("".join(out), encoding="utf-8")


# ── the per-project handle ───────────────────────────────────────────────


@dataclass
class ProjectRuns:
    """A project's stores, opened once and reused."""

    root: Path
    store: RunStore
    source: str
    spec: Dict[str, Any]
    remote: Optional[RunStore] = None
    fingerprint: Tuple[Any, ...] = ()
    swept_at: float = 0.0
    last_sweep: Dict[str, int] = field(default_factory=dict)

    def split(self, run_id: str) -> Tuple[Optional[RunStore], str]:
        """Which store holds *run_id*, and its id there."""
        if run_id.startswith(LF_PREFIX):
            return self.remote, run_id[len(LF_PREFIX):]
        return self.store, run_id

    def sweep(self, force: bool = False) -> Dict[str, int]:
        """Apply the project's retention; at most once a day unless forced.
        ``OPERONX_STUDIO_RETENTION=off`` stops the automatic sweep (a
        studio that must only read); saving a policy still applies it."""
        if not force and os.environ.get("OPERONX_STUDIO_RETENTION", "").lower() in ("off", "0", "false"):
            return self.last_sweep
        if not force and time.time() - self.swept_at < _SWEEP_EVERY:
            return self.last_sweep
        self.swept_at = time.time()
        try:
            self.last_sweep = apply_retention(self.store, read_retention(self.root))
        except Exception:  # noqa: BLE001 — retention never takes the studio down
            self.last_sweep = {}
        return self.last_sweep


_OPEN: Dict[str, ProjectRuns] = {}
_LOCK = threading.Lock()


def _fingerprint(root: Path) -> Tuple[Any, ...]:
    marks = []
    for name in (MANIFEST, "resources.yaml"):
        try:
            marks.append((root / name).stat().st_mtime_ns)
        except OSError:
            marks.append(None)
    return tuple(marks)


def project_runs(root: Path, sweep: bool = True) -> ProjectRuns:
    """The project's stores — reopened when its configuration changes."""
    root = Path(root)
    key = str(root.resolve())
    marks = _fingerprint(root)
    with _LOCK:
        got = _OPEN.get(key)
        if got is None or got.fingerprint != marks:
            spec, source = _store_spec(root)
            store = open_run_store(spec)
            remote = None
            lf = _langfuse_spec(root)
            if lf is not None:
                try:
                    remote = open_run_store(lf)
                except Exception:  # noqa: BLE001
                    remote = None
            got = ProjectRuns(root=root, store=store, source=source, spec=spec,
                              remote=remote, fingerprint=marks)
            _OPEN[key] = got
    if sweep:
        got.sweep()
    return got
