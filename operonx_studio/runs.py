"""Which run store a project reads, and how long its runs are kept.

The studio never keeps runs of its own: it opens the project's
:class:`~operonx.telemetry.runs.RunStore` — the same object the project's
services and jobs write into — from configuration, without importing the
project. Which store, in order:

1. ``[studio] runs = "run_store:<name>"`` in ``operonx.toml`` — the
   user's override for what the studio reads;
2. the project's own trace sinks, when ``operonx.toml`` has ``[tracing]``
   (``operonx.telemetry.runs.project_stores``), in the order a team wants
   its runs read: ClickHouse, then Postgres / Mongo (``run_store:``);
3. ``run_store: default`` in the project's resources file, when it is one
   of those;
4. else **Langfuse** — a ``trace_langfuse:`` sink, or ``[studio.langfuse]``
   — with the local store beside it (:class:`WithLocal`): a Playground
   session is recorded only locally, never in a production Langfuse, and
   is still listed and opened;
5. else local: a SQLite or files sink, ``run_store: default``,
   ``[studio] traces = "<dir>"``, then ``<project>/.operonx/runs``.

Beside a ClickHouse or SQL store, Langfuse is a second, read-only source
for runs that live only there; its ids carry an ``lf:`` prefix here.

A store over the network (ClickHouse, Postgres, Mongo) that does not
answer raises :class:`StoreUnreachable`, naming it — the Runs screen
says so instead of spinning — and is not asked again for a few seconds.

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
from typing import Any, Dict, List, Optional, Tuple

try:
    import tomllib as _toml
except ModuleNotFoundError:  # pragma: no cover — 3.10
    import tomli as _toml  # type: ignore[no-redef]

from operonx.telemetry.runs import DEFAULT_RETENTION, RunStore, apply_retention, open_run_store

from operonx_studio.registry import MANIFEST

try:  # operonx >= 1.13: a project's [tracing] sinks as readable stores
    from operonx.telemetry.runs import project_stores as _project_stores
    from operonx.telemetry.runs.project import describe_spec as _describe_spec
except ImportError:  # an older operonx: the studio reads as it always has
    _project_stores = None
    _describe_spec = None

__all__ = [
    "LF_PREFIX",
    "ProjectRuns",
    "WithLocal",
    "StoreUnreachable",
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

        raw = dict(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
    except Exception:  # noqa: BLE001
        return {}
    # `run_store:default:` (flat) reads as `run_store: {default: ...}`
    for key in [k for k in raw if isinstance(k, str) and ":" in k]:
        category, name = key.split(":", 1)
        if isinstance(raw.get(category, {}), dict):
            raw.setdefault(category, {})
            raw[category].setdefault(name, raw[key])
    return raw


def _anchor(root: Path, value: Any, default: Path) -> str:
    """A configured path, anchored at the project when relative."""
    if not value:
        return str(default)
    path = Path(str(value)).expanduser()
    return str(path if path.is_absolute() else root / path)


def _store_spec(root: Path) -> Tuple[Dict[str, Any], str]:
    """The primary store's spec, and a sentence saying where it came from,
    leaving ``[tracing]`` aside (see :func:`_choose`)."""
    spec, source, _why = _store_choice(root)
    return spec, source


def _store_choice(root: Path) -> Tuple[Dict[str, Any], str, str]:
    """``_store_spec``'s answer, and why — the configuration that chose it."""
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
        why = (f"[studio] runs in operonx.toml → run_store:{key}" if key
               else "run_store:default in the resources file")
        return spec, f"run_store:{key or 'default'} ({backend})", why
    if studio.get("traces"):
        where = _anchor(root, _env(str(studio["traces"])), runs_dir)
        return {"backend": "files", "root": where}, f"[studio] traces → {where}", \
            "[studio] traces in operonx.toml"
    return {"backend": "files", "root": str(runs_dir)}, f"{runs_dir}", _DEFAULT_WHY


_DEFAULT_WHY = "the default: no [tracing] or [studio] runs in operonx.toml"
#: Which of a project's readable sinks the studio reads, best first: the
#: one built for many runs and many writers, then a database, then files.
_RANK = {"clickhouse": 0, "postgres": 1, "mongo": 1, "sqlite": 2, "files": 3}
#: Stores on this machine: below Langfuse in the order a team reads its runs.
_LOCAL = ("sqlite", "files")
#: Backends reached over the network: their failures are "unreachable".
_NETWORK = ("clickhouse", "postgres", "mongo")
#: Seconds a page waits for a ClickHouse to accept the connection.
_CONNECT_TIMEOUT = 3.0


def _describe(spec: Dict[str, Any]) -> str:
    if _describe_spec is not None:
        return _describe_spec(spec)
    return f"{spec.get('backend') or 'files'} store"  # pragma: no cover — older operonx


@dataclass
class _Choice:
    spec: Dict[str, Any]
    source: str
    info: Dict[str, Any]
    remote: Optional[Dict[str, Any]]
    #: Langfuse is the source: the local store read beside it
    local: Optional[Dict[str, Any]] = None


def _choose(root: Path) -> _Choice:
    """Which stores the studio reads for *root*, and why — the order is
    the module docstring's."""
    manifest = _manifest(root)
    studio = dict(manifest.get("studio") or {})
    explicit = bool(studio.get("runs"))
    traced = _project_stores is not None and "tracing" in manifest
    sources: list = []
    error = ""
    if traced:
        try:
            sources = list(_project_stores(root))
        except Exception as exc:  # noqa: BLE001 — a bad [tracing] is shown, not fatal
            error = f"[tracing] could not be read: {exc}"
    readable = [s for s in sources if s.readable]
    stores = sorted((s for s in readable if s.backend != "langfuse"),
                    key=lambda s: _RANK.get(s.backend or "", 3))
    langfuse = next((s for s in readable if s.backend == "langfuse"), None)
    if stores and not explicit:
        best = stores[0]
        spec = dict(best.spec)
        label = best.describe()
        why = f"from {best.source} in operonx.toml"
        source = f"{label} — {why}"
    else:
        spec, source, why = _store_choice(root)
        label = _describe(spec)
        if traced and not explicit:
            if error:
                why = f"{error}; reading {label}"
            else:
                why = f"[tracing] names no readable store; reading {label}"
    if spec.get("backend") == "clickhouse":
        spec["timeout"] = min(float(spec.get("timeout") or 10.0), _CONNECT_TIMEOUT)
    info: Dict[str, Any] = {
        "label": label,
        "why": why,
        "backend": str(spec.get("backend") or "files"),
        "skipped": [{"sink": s.sink, "source": s.source, "reason": s.reason}
                    for s in sources if not s.readable],
        "remote": None,
    }
    remote = _langfuse_spec(root)
    remote_why = "[studio.langfuse] in operonx.toml"
    if remote is not None:
        remote_label = f"Langfuse at {remote['host']}"
    elif langfuse is not None:
        remote = dict(langfuse.spec)
        remote_label, remote_why = langfuse.describe(), str(langfuse.source)
    if remote is not None and not explicit and str(spec.get("backend") or "files") in _LOCAL:
        # no ClickHouse or SQL store: Langfuse is what the team reads, and
        # the local store stays beside it for what only it holds
        local_label = label
        info.update({
            "label": remote_label,
            "why": f"from {remote_why} — no ClickHouse store; local runs ({local_label}) read beside it",
            "backend": "langfuse",
            "local": local_label,
        })
        return _Choice(spec=dict(remote), source=f"{remote_label} — from {remote_why}", info=info,
                       remote=None, local=spec)
    if remote is not None:
        info["remote"] = f"{remote_label} — from {remote_why}"
    return _Choice(spec=spec, source=source, info=info, remote=remote)


class StoreUnreachable(RuntimeError):
    """The project's store is over the network and did not answer.
    ``info`` is the store's :attr:`ProjectRuns.info`."""

    def __init__(self, message: str, info: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.info = dict(info or {})


class _Guarded:
    """A network store whose failures name it, and are remembered.

    Any method that fails other than on its arguments (``ValueError``,
    ``KeyError``, ``TypeError``) raises :class:`StoreUnreachable`, "can't
    reach the <what> (<which>): <why>" (``what``: the trace store, the
    score store); for ``_COOLDOWN`` seconds
    after, every call raises the same at once, so one page's dozen
    requests do not each wait out a connect timeout."""

    _COOLDOWN = 10.0
    _PASS = (ValueError, KeyError, TypeError, NotImplementedError)

    def __init__(self, store: Any, info: Dict[str, Any], what: str = "trace store"):
        self._store = store
        self._info = info
        self._what = what
        self._down_until = 0.0
        self._down = ""

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._store, name)
        if name.startswith("_") or not callable(attr):
            return attr

        def call(*args: Any, **kwargs: Any) -> Any:
            if time.time() < self._down_until:
                raise StoreUnreachable(self._down, self._info)
            try:
                return attr(*args, **kwargs)
            except self._PASS:
                raise
            except Exception as exc:  # noqa: BLE001 — every transport's own error type
                label = self._info.get("label") or "?"
                self._down = f"can't reach the {self._what} ({label}): {type(exc).__name__}: {exc}"
                self._down_until = time.time() + self._COOLDOWN
                raise StoreUnreachable(self._down, self._info) from exc

        return call


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
    after = "".join(out)
    if after == text:
        return
    # atomically, and only the [studio.retention] table may change (safewrite)
    from operonx_studio import safewrite

    safewrite.commit(root, path, after, safewrite.sha(text), before=text,
                     scope=safewrite.toml_scope([("studio", "retention")]), what="retention")


# ── the per-project handle ───────────────────────────────────────────────


class WithLocal(RunStore):
    """Langfuse as the source, the project's local store beside it.

    A Playground session is recorded only locally (``operonx.app.play``:
    a test never lands in a production Langfuse), and a service may write
    both. Lists merge the two newest first, by start time — one row per
    run, the local copy when both hold it (it has every op's numbers) —
    with a time cursor, so a page is
    the same whichever store has more. A run opens from the local store
    when it has it (no round trip), else from Langfuse. Writes, deletes
    and retention reach the local store only: the studio never reaches
    into someone else's server. When Langfuse does not answer, the local
    runs are still listed, and :attr:`primary_error` says why the rest
    are not.
    """

    writable = True

    def __init__(self, primary: RunStore, local: RunStore):
        self.primary, self.local = primary, local
        self.config = dict(getattr(primary, "config", {}) or {})
        self.primary_error: Optional[str] = None
        self.media_dir = getattr(local, "media_dir", None)

    def put_trace(self, trace: Any) -> Any:
        return self.local.put_trace(trace)

    def consume(self, trace: Any) -> Any:
        return self.local.put_trace(trace)

    def list_runs(self, where: Any = None, order: str = "started_desc", limit: int = 50,
                  cursor: Optional[str] = None) -> Any:
        from dataclasses import replace

        from operonx.telemetry.runs.model import Page, RunFilter

        where = where or RunFilter()
        desc = order != "started_asc"
        if cursor and cursor.startswith("t:"):
            at = float(cursor[2:])
            where = (replace(where, until=at if where.until is None else min(where.until, at)) if desc
                     else replace(where, since=at if where.since is None else max(where.since, at)))
        pages = [self.local.list_runs(where, order, limit)]
        try:
            pages.append(self.primary.list_runs(where, order, limit))
            self.primary_error = None
        except Exception as exc:  # noqa: BLE001 — someone else's server: the local runs still show
            self.primary_error = f"{type(exc).__name__}: {exc}"
        seen: Dict[str, Any] = {}
        for page in pages:  # local first: its copy of a run wins
            for s in page.items:
                if cursor and cursor.startswith("t:") and s.started_at == float(cursor[2:]):
                    continue  # the last row of the page before
                seen.setdefault(s.trace_id, s)
        items = sorted(seen.values(), key=lambda s: s.started_at or 0.0, reverse=desc)
        more = any(p.next_cursor for p in pages) or len(items) > limit
        items = items[:limit]
        nxt = f"t:{items[-1].started_at}" if more and items else None
        return Page(items=items, next_cursor=nxt, total=None)

    def get_run(self, trace_id: str) -> Any:
        rec = self.local.get_run(trace_id)
        return rec if rec is not None else self.primary.get_run(trace_id)

    def rollups(self, where: Any = None) -> List[Any]:
        out = list(self.local.rollups(where))
        have = {r.trace_id for r in out}
        try:
            out += [r for r in self.primary.rollups(where) if r.trace_id not in have]
        except Exception:  # noqa: BLE001
            pass
        return out

    def delete_runs(self, where: Any) -> int:
        return self.local.delete_runs(where)

    def refresh(self) -> int:
        return self.local.refresh()

    def close(self) -> None:
        for s in (self.primary, self.local):
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass


@dataclass
class ProjectRuns:
    """A project's stores, opened once and reused."""

    root: Path
    store: RunStore
    source: str
    spec: Dict[str, Any]
    remote: Optional[RunStore] = None
    fingerprint: Tuple[Any, ...] = ()
    #: what the Runs screen and Settings say: ``label`` (the store in a
    #: few words), ``why`` (the configuration that chose it), ``backend``,
    #: ``skipped`` (sinks it cannot read, with the reason) and ``remote``
    info: Dict[str, Any] = field(default_factory=dict)
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
    overlay = (_manifest(root).get("resources") or {}).get("overlay") or "resources.yaml"
    marks = []
    for name in dict.fromkeys((MANIFEST, "resources.yaml", str(overlay), ".env")):
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
            choice = _choose(root)
            spec = choice.spec
            store = open_run_store(spec)
            if spec.get("backend") in _NETWORK:
                store = _Guarded(store, choice.info)
            if choice.local is not None:
                store = WithLocal(store, open_run_store(choice.local))
            remote = None
            if choice.remote is not None:
                try:
                    remote = open_run_store(choice.remote)
                except Exception:  # noqa: BLE001
                    remote = None
            got = ProjectRuns(root=root, store=store, source=choice.source, spec=spec,
                              remote=remote, fingerprint=marks, info=choice.info)
            _OPEN[key] = got
    if sweep:
        got.sweep()
    return got
