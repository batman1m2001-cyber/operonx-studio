"""The run queue of a durable service (operonx ``Service(queue=...)``):
what waits, what runs where, what failed and why — and a failed run sent
back to the queue by hand (docs/PLATFORM_PAGES_PLAN.md S3).

A service's ``queue =`` is a SQLite path (relative to the project, where
``operonx serve`` runs) or a Postgres URL; the studio opens the same queue
the service does and reads it — rows, never the service's process.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

from fastapi.responses import JSONResponse

#: Rows of each kind a view shows.
SHOWN = 20


def queued_services(root: Path) -> List[Tuple[str, Any]]:
    """``(service name, its queue)`` for each service declared with
    ``queue=``. Empty when the project's operonx has no run queue."""
    try:
        from operonx.app import Application
        from operonx.app.queue import open_queue
    except ImportError:
        return []
    app = Application.load(Path(root) / "operonx.toml")
    out = []
    for spec in app.manifest.serves:
        setting = (spec.options or {}).get("queue")
        if setting is not None:
            out.append((spec.name, open_queue(setting, root=root)))
    return out


def _preview(value: Any, limit: int = 160) -> str:
    import json

    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def row(item: Any, now: float) -> Dict[str, Any]:
    """One queue row as the page shows it."""
    return {
        "id": item.id,
        "status": item.status,
        "thread_id": item.thread_id,
        "attempts": item.attempts,
        "max_attempts": item.max_attempts,
        "worker": item.worker,
        "error": item.error,
        "stop": item.stop,
        "age_s": round(now - item.created_at, 1),
        "updated_s": round(now - item.updated_at, 1),
        "lease_left_s": round(item.lease_until - now, 1) if item.lease_until else None,
        "payload": _preview(item.payload),
    }


def snapshot(service: str, queue: Any) -> Dict[str, Any]:
    """A service's queue: counts by status, and the rows worth a look —
    those running, the oldest waiting, the latest that failed."""
    now = time.time()
    rows = queue.items(service, limit=10_000)
    by = lambda status: [r for r in rows if r.status == status]  # noqa: E731
    failed = sorted(by("failed") + by("stopped") + by("discarded"), key=lambda r: -r.updated_at)
    return {
        "service": service,
        "where": repr(queue),
        "counts": queue.counts(service),
        "running": [row(r, now) for r in by("running")],
        "queued": [row(r, now) for r in by("queued")[:SHOWN]],
        "ended_badly": [row(r, now) for r in failed[:SHOWN]],
    }


def register(app: Any, *, watcher_of: Callable[[str], Any]) -> None:
    """The run-queue routes. ``watcher_of(pid)`` is the project's watcher."""

    def _queues(pid: str):
        watcher = watcher_of(pid)
        if watcher is None:
            return None
        return queued_services(watcher.root)

    @app.get("/api/p/{pid}/services/queues")
    def queues(pid: str) -> JSONResponse:
        try:
            found = _queues(pid)
        except Exception as exc:  # noqa: BLE001 — a manifest that does not load is reported
            return JSONResponse({"queues": [], "error": f"{type(exc).__name__}: {exc}"})
        if found is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        out = []
        for name, queue in found:
            try:
                out.append(snapshot(name, queue))
            except Exception as exc:  # noqa: BLE001 — a queue that cannot be reached says so
                out.append({"service": name, "where": repr(queue), "error": f"{type(exc).__name__}: {exc}"})
        return JSONResponse({"queues": out})

    @app.post("/api/p/{pid}/services/queues/requeue")
    def requeue(pid: str, body: Dict[str, Any]) -> JSONResponse:
        service, run_id = str(body.get("service") or ""), str(body.get("id") or "")
        found = dict(_queues(pid) or [])
        queue = found.get(service)
        if queue is None:
            return JSONResponse({"error": f"no queued service {service!r}"}, status_code=404)
        if not queue.requeue(run_id):
            return JSONResponse(
                {"error": f"run {run_id} is not a failed, stopped or discarded row of {service}"},
                status_code=409,
            )
        return JSONResponse({"requeued": run_id, "service": service})
