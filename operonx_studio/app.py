"""The studio application: many projects, one daemon.

``daemon.py`` serves one project chosen on the command line. This is the
app around it: a home screen for opening, creating and revisiting
projects, and a per-project canvas. Each opened project keeps its own
:class:`~operonx_studio.daemon.ProjectWatcher`, so the property that makes
the studio trustworthy is untouched — extraction always runs in a
subprocess under the *project's* interpreter, never in this one.

Traces are read, never written. A project that wants the Runs and Traces
tabs populated declares where its trace consumer writes::

    [studio]
    traces = "/tmp/educa_reminder_traces"

The expected shape is what a local trace consumer produces: one directory
per run, holding ``nodes.jsonl`` with one record per op execution
(``op_name``, ``duration_ms``, ``status``, ``error``, …). No declaration
means the tabs say so instead of guessing.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import tomllib as _toml
except ModuleNotFoundError:  # pragma: no cover — 3.10
    import tomli as _toml  # type: ignore[no-redef]

from operonx_studio.daemon import ProjectWatcher
from operonx_studio.layout import layout_graph
from operonx_studio.registry import MANIFEST, ProjectRef, Recents

__all__ = ["build_studio_app", "serve_studio"]

STATIC = Path(__file__).parent / "static"


# ── project-side helpers ────────────────────────────────────────────────


def _studio_table(root: Path) -> Dict[str, Any]:
    """The manifest's ``[studio]`` table, or nothing."""
    try:
        raw = _toml.loads((root / MANIFEST).read_text(encoding="utf-8"))
        return dict(raw.get("studio") or {})
    except Exception:  # noqa: BLE001
        return {}


def _traces_root(root: Path) -> Optional[Path]:
    declared = _studio_table(root).get("traces")
    if not declared:
        return None
    path = Path(str(declared)).expanduser()
    if not path.is_absolute():
        path = root / path
    return path


def _inline_synthetic_loops(graph: Dict[str, Any]) -> Dict[str, Any]:
    """Open the compiler's hidden loop boxes back up, for the canvas.

    An agent while-loop is authored as a cycle — ``g >> s`` after
    ``s >> g`` — and the compiler rewrites it into one hidden ``GraphOp``
    (``__loop_0__``) so the scheduler sees a DAG. Correct for execution,
    a lie for a viewer: the extraction of such a graph is one opaque node
    and zero edges, which tells the person who *wrote the cycle* nothing.

    The interior survives (the hidden node carries its subgraph, and
    ``rewritten_from`` records the authored back-edges and the seam), so
    this reverses the rewrite for display only: members come back as
    nodes, the back-edge comes back as an edge marked ``back``, and every
    member is tagged with its loop so the canvas can badge it. The
    scheduler never sees any of this.
    """
    loops = graph.get("loops") or {}
    rewritten = graph.get("rewritten_from") or {}
    if not any(v.get("synthetic") for v in loops.values()):
        return graph

    nodes: list = []
    edges = list(graph.get("edges") or [])
    hidden: Dict[str, Dict[str, Any]] = {}

    for node in graph.get("nodes") or []:
        meta = loops.get(node["id"])
        if not (meta and meta.get("synthetic") and node.get("graph")):
            nodes.append(node)
            continue
        seam = rewritten.get(node["name"], {})
        hidden[node["name"]] = {"meta": meta, "seam": seam}
        inner = node["graph"]
        for member in inner.get("nodes") or []:
            member = dict(member)
            member["loop"] = {
                "group": node["name"],
                "mode": "synthetic",
                "max_iterations": meta.get("max_iterations"),
            }
            nodes.append(member)
        edges.extend(inner.get("edges") or [])
        for src, dst in meta.get("back_edges") or []:
            edges.append({"from": src, "to": dst, "type": "back",
                          "soft": False, "origin": "back_edge"})

    # Reconnect the seam: edges that touched the hidden box now touch the
    # members the rewrite recorded as its entry and exits.
    fixed = []
    for e in edges:
        e = dict(e)
        for box, info in hidden.items():
            seam = info["seam"]
            if e["to"] == box:
                e["to"] = seam.get("entry") or e["to"]
            if e["from"] == box:
                exits = seam.get("exits") or []
                e["from"] = exits[0][0] if exits else e["from"]
        if e["from"] not in hidden and e["to"] not in hidden:
            fixed.append(e)

    out = dict(graph)
    out["nodes"] = nodes
    out["edges"] = fixed
    # entries/exits may name the hidden box; map them to the seam too
    for key in ("entries", "exits"):
        names = []
        for name in out.get(key) or []:
            info = hidden.get(name)
            if info is None:
                names.append(name)
            elif key == "entries":
                names.append(info["seam"].get("entry") or name)
            else:
                names.extend(x for x, _ in (info["seam"].get("exits") or [(name, None)]))
        out[key] = names
    return out


def _placed(graph: Dict[str, Any]) -> Dict[str, Any]:
    """One IR graph plus its layout, as the canvas consumes it.

    A ``GraphOp``'s nested graph rides along *recursively laid out* — the
    node is a container the canvas can open in place, and a box that opens
    onto an unplaced pile of ops would be worse than one that stays shut.
    Synthetic loop boxes are already inlined by the time we recurse, so
    only author-written subgraphs become containers.
    """
    graph = _inline_synthetic_loops(graph)
    layout = layout_graph(graph)
    nodes_by_id = {n["id"]: n for n in graph.get("nodes") or []}

    def _subgraph(node_id: str) -> Optional[Dict[str, Any]]:
        inner = nodes_by_id.get(node_id, {}).get("graph")
        if not inner or not inner.get("nodes"):
            return None
        return _placed(inner)

    return {
        "name": graph.get("name"),
        "entries": graph.get("entries") or [],
        "exits": graph.get("exits") or [],
        "width": layout.width,
        "height": layout.height,
        "nodes": [
            {
                "id": n.id,
                "name": n.name,
                "kind": n.kind,
                "x": n.x,
                "y": n.y,
                **{k: nodes_by_id.get(n.id, {}).get(k) for k in
                   ("bound", "start", "end", "outputs", "inputs", "source",
                    "loop", "is_gen", "transient")},
                "subgraph_ops": len((nodes_by_id.get(n.id, {}).get("graph") or {}).get("nodes") or []) or None,
                "graph": _subgraph(n.id),
            }
            for n in layout.nodes
        ],
        "edges": [
            {"src": e.src, "dst": e.dst, "type": e.type, "soft": e.soft,
             "origin": e.origin, "back": bool(getattr(e, "back", False))}
            for e in layout.edges
        ],
        "loops": graph.get("loops") or {},
    }


def _op_executions(run_dir: Path, op_name: str, limit: int = 50) -> Dict[str, Any]:
    """Every recorded execution of one op in one run — the drill-down
    under the aggregate, inputs and outputs included.

    Values ship exactly as the trace consumer wrote them: the write side
    already bounds payload size behind its own ``media_threshold`` config,
    so no second limit is applied here. What is bounded is the record
    count — the last ``limit`` executions, because a callbot op can run
    once per audio packet.
    """
    from collections import deque

    keep: deque = deque(maxlen=limit)
    total = 0
    # A GraphOp never executes under its own name — its members do, and
    # they carry the container in their dotted path ("engine.asr.recognize"
    # is a member of "asr"). Matching the path segment as well as the leaf
    # name makes clicking a container show its members' executions instead
    # of a wrong "no records".
    marker = f".{op_name}."
    with (run_dir / "nodes.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            name = rec.get("op_name") or rec.get("op_full_name") or "?"
            full = rec.get("op_full_name") or ""
            if name != op_name and marker not in full and not full.startswith(op_name + "."):
                continue
            total += 1
            keep.append({
                "op": name,
                "start_time": rec.get("start_time"),
                "duration_ms": rec.get("duration_ms"),
                "status": rec.get("status"),
                "error": rec.get("error"),
                "ctx": rec.get("ctx"),
                "inputs": rec.get("inputs"),
                "outputs": rec.get("outputs"),
            })
    return {"run": run_dir.name, "op": op_name, "total": total,
            "showing": len(keep), "executions": list(keep)}


def _summarise_run(run_dir: Path, limit: int = 20000) -> Dict[str, Any]:
    """Per-op aggregates for one recorded run.

    Aggregated server-side because a call's ``nodes.jsonl`` can hold tens
    of thousands of per-item records — the callbot writes one per audio
    packet — and the canvas needs per-op numbers, not the firehose.
    """
    per_op: Dict[str, Dict[str, Any]] = {}
    records = 0
    with (run_dir / "nodes.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            if records >= limit:
                break
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            records += 1
            name = rec.get("op_name") or rec.get("op_full_name") or "?"
            agg = per_op.setdefault(name, {
                "runs": 0, "errors": 0, "total_ms": 0.0, "max_ms": 0.0, "last_error": None,
            })
            agg["runs"] += 1
            duration = float(rec.get("duration_ms") or 0.0)
            agg["total_ms"] += duration
            agg["max_ms"] = max(agg["max_ms"], duration)
            if rec.get("status") not in (None, "ok"):
                agg["errors"] += 1
                agg["last_error"] = rec.get("error") or rec.get("status")
    return {"run": run_dir.name, "records": records, "ops": per_op,
            "truncated": records >= limit}


# ── the app ─────────────────────────────────────────────────────────────


def build_studio_app(recents: Optional[Recents] = None):
    from fastapi import FastAPI
    from fastapi.responses import FileResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles

    recents = recents if recents is not None else Recents()
    watchers: Dict[str, ProjectWatcher] = {}

    app = FastAPI(title="operonx studio", docs_url=None, redoc_url=None)
    app.state.recents = recents
    app.state.watchers = watchers

    @app.middleware("http")
    async def _fresh_pages(request, call_next):
        """Pages and static assets revalidate on every load (ETag makes it
        a 304, not a re-download). A studio serving yesterday's JS after a
        deploy shows yesterday's features and gets called a liar."""
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith("/static") or path.startswith("/p/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    def _watcher(pid: str) -> Optional[ProjectWatcher]:
        if pid in watchers:
            return watchers[pid]
        ref = recents.get(pid)
        if ref is None or not ref.exists:
            return None
        watchers[pid] = ProjectWatcher(root=ref.root)
        return watchers[pid]

    # ── home ────────────────────────────────────────────────────────────

    @app.get("/")
    def home() -> FileResponse:
        return FileResponse(STATIC / "home.html")

    @app.get("/api/projects")
    def projects() -> JSONResponse:
        return JSONResponse({"projects": [r.as_dict() for r in recents.ordered()]})

    @app.post("/api/open")
    def open_project(body: Dict[str, Any]) -> JSONResponse:
        root = Path(str(body.get("path") or "")).expanduser()
        if not root.is_dir():
            return JSONResponse({"error": f"not a directory: {root}"}, status_code=400)
        if not (root / MANIFEST).is_file():
            return JSONResponse(
                {"error": f"no {MANIFEST} in {root} — open a project root, or create one"},
                status_code=400,
            )
        ref = recents.touch(root)
        return JSONResponse({"id": ref.id, "name": ref.name})

    @app.post("/api/forget")
    def forget(body: Dict[str, Any]) -> JSONResponse:
        pid = str(body.get("id") or "")
        watchers.pop(pid, None)
        recents.forget(pid)
        return JSONResponse({"ok": True})

    @app.post("/api/new")
    def new_project(body: Dict[str, Any]) -> JSONResponse:
        """Scaffold a standard operonx project and open it.

        The scaffold is `operonx_project.scaffold` — the same one
        ``operonx-new`` runs — so a project born in the studio and one born
        on the command line are byte-for-byte the same shape.
        """
        from operonx_project.scaffold import ScaffoldError, scaffold

        parent = Path(str(body.get("path") or "")).expanduser()
        name = str(body.get("name") or "").strip()
        if not name:
            return JSONResponse({"error": "a project needs a name"}, status_code=400)
        if not parent.is_dir():
            return JSONResponse({"error": f"not a directory: {parent}"}, status_code=400)
        root = parent / name
        if root.exists():
            return JSONResponse({"error": f"{root} already exists"}, status_code=400)
        try:
            scaffold(root, name=name, with_llm=bool(body.get("with_llm")))
        except ScaffoldError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        ref = recents.touch(root)
        return JSONResponse({"id": ref.id, "name": ref.name, "root": str(root)})

    @app.get("/api/fs")
    def fs(path: str = "~") -> JSONResponse:
        """Directory listing for the open-project browser.

        The studio is a local daemon, so the server *is* the machine whose
        directories the user wants to browse — no upload dance, no native
        dialog. Directories only; a file cannot be a project.
        """
        base = Path(path).expanduser()
        try:
            base = base.resolve()
            entries = sorted(
                (e for e in base.iterdir() if e.is_dir() and not e.name.startswith(".")),
                key=lambda e: e.name.lower(),
            )
        except (PermissionError, FileNotFoundError, NotADirectoryError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({
            "path": str(base),
            "parent": str(base.parent) if base.parent != base else None,
            "dirs": [
                {"name": e.name, "path": str(e), "is_project": (e / MANIFEST).is_file()}
                for e in entries
            ],
        })

    # ── one project ─────────────────────────────────────────────────────

    @app.get("/p/{pid}")
    def project_page(pid: str) -> Any:
        if _watcher(pid) is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        return FileResponse(STATIC / "project.html")

    @app.get("/api/p/{pid}/ir")
    def project_ir(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        result = watcher.refresh()
        ref = recents.get(pid)
        if not result.ok:
            return JSONResponse({
                "name": ref.name if ref else pid,
                "root": str(watcher.root),
                "error": result.error,
                "stamp": result.stamp,
            })
        ir = result.ir
        return JSONResponse({
            "name": ir.get("project"),
            "description": ir.get("description", ""),
            "root": str(watcher.root),
            "stamp": result.stamp,
            "graphs": [_placed(g) for g in ir.get("graphs") or []],
            "serves": ir.get("serves") or [],
            "resources": ir.get("resources") or {},
            "traces_configured": _traces_root(watcher.root) is not None,
        })

    @app.get("/api/p/{pid}/stamp")
    def project_stamp(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        result = watcher.refresh()
        return JSONResponse({"stamp": result.stamp, "ok": result.ok})

    @app.post("/api/p/{pid}/edit")
    def project_edit(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """A typed edit — ``set_param`` from the inspector rides this.

        ``dry_run`` defaults to true and the response always carries the
        diff, so the inspector shows exactly what will change before it
        does. Applying writes the file; the watcher notices the mtime and
        the canvas refreshes itself — no second update path.
        """
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)

        from operonx_project.apply import PlanError, apply_plan, plan_edit
        from operonx_project.manifest import Manifest, ManifestError
        from operonx_project.pyedit import PyEditError

        graph = body.get("graph")
        action = body.get("action")
        if not graph or not action:
            return JSONResponse({"error": "graph and action are required"}, status_code=400)
        arguments = {k: v for k, v in body.items() if k not in {"graph", "action", "dry_run"}}
        try:
            manifest = Manifest.load(watcher.root)
            plan = plan_edit(manifest, graph, action, **arguments)
        except (PlanError, ManifestError, PyEditError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        except TypeError as exc:
            return JSONResponse({"error": f"bad arguments for {action!r}: {exc}"}, status_code=400)

        payload: Dict[str, Any] = {
            "graph": plan.graph,
            "action": plan.action,
            "file": str(plan.file),
            "changed": plan.changed,
            "diff": plan.diff,
        }
        if body.get("dry_run", True):
            payload["applied"] = False
            return JSONResponse(payload)
        try:
            apply_plan(plan)
        except OSError as exc:
            return JSONResponse({"error": f"could not write: {exc}"}, status_code=500)
        payload["applied"] = True
        return JSONResponse(payload)

    # ── traces ──────────────────────────────────────────────────────────

    @app.get("/api/p/{pid}/traces")
    def traces(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        root = _traces_root(watcher.root)
        if root is None:
            return JSONResponse({"configured": False, "runs": []})
        if not root.is_dir():
            return JSONResponse({"configured": True, "missing": str(root), "runs": []})
        runs: List[Dict[str, Any]] = []
        for entry in root.iterdir():
            nodes = entry / "nodes.jsonl"
            if not nodes.is_file():
                continue
            stat = nodes.stat()
            runs.append({
                "run": entry.name,
                "mtime": stat.st_mtime,
                "size": stat.st_size,
            })
        runs.sort(key=lambda r: -r["mtime"])
        return JSONResponse({"configured": True, "root": str(root), "runs": runs[:200]})

    @app.get("/api/p/{pid}/trace/{run}")
    def trace(pid: str, run: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        root = _traces_root(watcher.root)
        if root is None:
            return JSONResponse({"error": "no [studio] traces configured"}, status_code=404)
        run_dir = (root / run).resolve()
        # The run name came from a URL; it must not walk out of the root.
        if root.resolve() not in run_dir.parents:
            return JSONResponse({"error": "no such run"}, status_code=404)
        if not (run_dir / "nodes.jsonl").is_file():
            return JSONResponse({"error": "no such run"}, status_code=404)
        return JSONResponse(_summarise_run(run_dir))

    @app.get("/api/p/{pid}/trace/{run}/op/{op_name}")
    def trace_op(pid: str, run: str, op_name: str, limit: int = 50) -> JSONResponse:
        """One op's executions in one run — the drill-down under the
        aggregate, with the recorded inputs and outputs. Same run-name
        containment rule as the summary endpoint above."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        root = _traces_root(watcher.root)
        if root is None:
            return JSONResponse({"error": "no [studio] traces configured"}, status_code=404)
        run_dir = (root / run).resolve()
        if root.resolve() not in run_dir.parents:
            return JSONResponse({"error": "no such run"}, status_code=404)
        if not (run_dir / "nodes.jsonl").is_file():
            return JSONResponse({"error": "no such run"}, status_code=404)
        return JSONResponse(_op_executions(run_dir, op_name, limit=max(1, min(limit, 200))))

    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
    return app


def serve_studio(host: str = "127.0.0.1", port: int = 8765,
                 open_path: Optional[Path] = None) -> None:
    """Run the studio. ``open_path`` pre-opens one project, for `operonx-studio .`."""
    import uvicorn

    recents = Recents()
    if open_path is not None:
        recents.touch(Path(open_path).resolve())
    uvicorn.run(build_studio_app(recents), host=host, port=port, log_level="warning")
