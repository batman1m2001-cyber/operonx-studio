"""Review queues (operonx ``[[queue]]``) in the Review tab
(docs/PLATFORM_PAGES_PLAN.md S1).

A queue is a list of things to look at that operonx keeps in
``.operonx/queues/<name>.jsonl`` — filled by an online eval's failures or
``operonx eval queue add``. Its items open as the same conversation the
run-based review shows; a verdict, labels, a note and the rubric's answers
are written by ``operonx.app.evals.queues.review`` as ``source="human"``
scores in the project's score store — where ``align`` measures judges
against them. Nothing goes to Studio's own ``reviews.jsonl``: a review is
in one place, never counted twice.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

#: Items a queue page lists.
SHOWN = 300


def queue_specs(root: Path) -> List[Any]:
    """The project's ``[[queue]]`` declarations; none on an operonx
    without review queues."""
    try:
        from operonx.app import Application
    except ImportError:
        return []
    return list(getattr(Application.load(Path(root) / "operonx.toml").manifest, "queues", ()) or ())


def _spec_row(spec: Any) -> Dict[str, Any]:
    return {
        "name": spec.name,
        "description": getattr(spec, "description", "") or "",
        "rubric": dict(spec.rubric or {}),
        "reviewers": spec.reviewers,
    }


def _item_row(item: Any, who: List[str]) -> Dict[str, Any]:
    return {
        "item_id": item.item_id,
        "target": item.target,
        "trace_id": item.trace_id,
        "session_id": item.session_id,
        "source": item.source,
        "reason": item.reason,
        "added_at": item.added_at,
        "reviewed_by": who,
    }


def _rubric_answers(raw: Any, rubric: Dict[str, str]) -> Dict[str, Any]:
    """The rubric's answers, each as its declared type; blanks dropped."""
    out: Dict[str, Any] = {}
    for name, kind in (rubric or {}).items():
        value = (raw or {}).get(name)
        if value is None or value == "":
            continue
        if kind == "bool":
            out[name] = value if isinstance(value, bool) else str(value).lower() in ("true", "yes", "1")
        elif kind == "numeric":
            out[name] = float(value)
        else:
            out[name] = str(value)
    return out


#: The ids that name what an item points at, per target (operonx's own).
_IDS = ("trace_id", "session_id", "op_id", "experiment_id", "case_id")


def _key(target: str, ids: Dict[str, Any]) -> tuple:
    return (target, *[ids.get(k) for k in _IDS])


def _reviewers(store: Any, queue: str) -> Dict[tuple, set]:
    """Who reviewed what in *queue*: the ``review`` scores people wrote."""
    from operonx.telemetry.scores import ScoreFilter

    out: Dict[tuple, set] = {}
    for s in store.scores(ScoreFilter(score_name="review", source="human"), limit=1_000_000):
        if s.queue == queue:
            out.setdefault(_key(s.target, {k: getattr(s, k, None) for k in _IDS}), set()).add(str(s.author))
    return out


def register(
    app: Any,
    *,
    watcher_of: Callable[[str], Any],
    conversation_of: Callable[[str, Any, str], Any],
    reviewer_of: Callable[[Request], str],
    scores_of: Callable[[Path], Any],
) -> None:
    """The review-queue routes. ``conversation_of(pid, watcher, run)`` is the
    run-review payload (summary, turns); ``scores_of(root)`` the project's
    score store holder (``.store``)."""

    def _project(pid: str):
        watcher = watcher_of(pid)
        if watcher is None:
            return None, None, JSONResponse({"error": "unknown project"}, status_code=404)
        scores = scores_of(watcher.root)
        if getattr(scores, "store", None) is None:
            reason = (getattr(scores, "info", None) or {}).get("reason") or "no score store"
            return watcher, None, JSONResponse({"error": f"reviews are scores, and {reason}"}, status_code=409)
        return watcher, scores.store, None

    def _spec(watcher: Any, name: str) -> Optional[Any]:
        return next((s for s in queue_specs(watcher.root) if s.name == name), None)

    @app.get("/api/p/{pid}/review/queues")
    def review_queues(pid: str) -> JSONResponse:
        from operonx.app.evals.queues import pending, queue_items

        watcher = watcher_of(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        try:
            specs = queue_specs(watcher.root)
        except Exception as exc:  # noqa: BLE001 — a manifest that does not load is reported
            return JSONResponse({"queues": [], "error": f"{type(exc).__name__}: {exc}"})
        qdir = Path(watcher.root) / ".operonx" / "queues"
        store = getattr(scores_of(watcher.root), "store", None)
        out = []
        for spec in specs:
            row = _spec_row(spec)
            row["total"] = len(queue_items(qdir, spec.name))
            row["waiting"] = len(pending(store, qdir, spec)) if store is not None else row["total"]
            out.append(row)
        return JSONResponse({"queues": out})

    @app.get("/api/p/{pid}/review/queues/{name}")
    def review_queue_items(pid: str, name: str, open: str = "", done: bool = False) -> JSONResponse:
        """A queue's items still waiting (``done=true``: every item), with
        who reviewed each, and the conversation of ``open`` (else the first)."""
        from operonx.app.evals.queues import pending, queue_items

        watcher, store, refusal = _project(pid)
        if refusal is not None:
            return refusal
        spec = _spec(watcher, name)
        if spec is None:
            return JSONResponse({"error": f"no queue {name!r} in operonx.toml"}, status_code=404)
        qdir = Path(watcher.root) / ".operonx" / "queues"
        waiting = pending(store, qdir, spec)
        if done:
            seen = _reviewers(store, name)
            rows = [_item_row(i, sorted(seen.get(_key(i.target, i.ids()), ()))) for i in queue_items(qdir, name)]
        else:
            rows = [_item_row(i, who) for i, who in waiting]
        rows = rows[:SHOWN]
        detail = None
        first = next((r for r in rows if r["item_id"] == open), rows[0] if rows else None)
        if first is not None and first["trace_id"]:
            got = conversation_of(pid, watcher, first["trace_id"])
            if not isinstance(got, JSONResponse):
                detail = {"item_id": first["item_id"], **got}
        return JSONResponse({"queue": _spec_row(spec), "items": rows, "waiting": len(waiting), "detail": detail})

    @app.post("/api/p/{pid}/review/queues/{name}/review")
    def review_queue_item(pid: str, name: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        from operonx.app.evals.queues import queue_items, review

        watcher, store, refusal = _project(pid)
        if refusal is not None:
            return refusal
        spec = _spec(watcher, name)
        if spec is None:
            return JSONResponse({"error": f"no queue {name!r} in operonx.toml"}, status_code=404)
        qdir = Path(watcher.root) / ".operonx" / "queues"
        item = next((i for i in queue_items(qdir, name) if i.item_id == body.get("item_id")), None)
        if item is None:
            return JSONResponse({"error": f"no item {body.get('item_id')!r} in queue {name}"}, status_code=404)
        labels = body.get("labels") or []
        if isinstance(labels, str):
            labels = labels.split(",")
        try:
            rows = review(
                store,
                author=reviewer_of(request),
                verdict=body.get("verdict") or None,
                labels=labels,
                note=str(body.get("note") or ""),
                rubric=_rubric_answers(body.get("rubric"), dict(spec.rubric or {})),
                queue=name,
                target=item.target,
                **item.ids(),
            )
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"saved": len(rows), "item_id": item.item_id})
