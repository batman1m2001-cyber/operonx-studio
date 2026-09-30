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

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import tomllib as _toml
except ModuleNotFoundError:  # pragma: no cover — 3.10
    import tomli as _toml  # type: ignore[no-redef]

try:  # a module-level name: FastAPI resolves route annotations from here
    from fastapi import Request
except ImportError:  # pragma: no cover — fastapi is a dependency
    Request = Any  # type: ignore[misc,assignment]

from operonx_studio.daemon import ProjectWatcher
from operonx_studio.layout import layout_graph
from operonx_studio.registry import MANIFEST, ProjectRef, Recents

__all__ = ["build_studio_app", "serve_studio"]

STATIC = Path(__file__).parent / "static"
_LOG = logging.getLogger(__name__)


# ── project-side helpers ────────────────────────────────────────────────


def _studio_table(root: Path) -> Dict[str, Any]:
    """The manifest's ``[studio]`` table, or nothing."""
    try:
        raw = _toml.loads((root / MANIFEST).read_text(encoding="utf-8"))
        return dict(raw.get("studio") or {})
    except Exception:  # noqa: BLE001
        return {}


#: A job run directory: a UTC stamp to the microsecond, nothing a path could hide in.
_RUN_ID = re.compile(r"^[0-9]{8}T[0-9]{6}-[0-9]{6}$")


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
        # `member["x"] >> PARENT["y"]` writes — the true output links
        "exports": graph.get("exports") or [],
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
                    "loop", "is_gen", "transient", "serve_role", "code",
                    "resource", "routes", "description", "show_keys")},
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


# ── trace records: one shape, every store ───────────────────────────────
# The studio never invents trace data — it reads what a consumer recorded,
# through the project's RunStore (operonx_studio.runs). Every store hands
# back the same rows (the shape `nodes.jsonl` holds; Langfuse observations
# are mapped to it by operonx), and the helpers below work over those.


def _op_executions(records, run_name: str, op_name: str, limit: int = 50) -> Dict[str, Any]:
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
    for rec in records:
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
            "wall_start": rec.get("wall_start"),
            "inputs": rec.get("inputs"),
            "outputs": rec.get("outputs"),
        })
    return {"run": run_name, "op": op_name, "total": total,
            "showing": len(keep), "executions": list(keep)}


def _flow_records(records, run_name: str, cap: int = 3000) -> Dict[str, Any]:
    """Every execution of one run, light: timing, ctx, status and
    provenance — no recorded values (the panel fetches those per op).
    One shape for local and Langfuse records; upstream refs normalise
    to {"from": op_id, "from_key", "to_key"}.
    """
    out: List[Dict[str, Any]] = []
    t0: Optional[float] = None
    for rec in records:
        start = rec.get("start_time")
        if start is None:
            continue
        t0 = start if t0 is None or start < t0 else t0
        ups = []
        for u in rec.get("upstreams") or []:
            src = u.get("from_op_id") or u.get("from")
            if src:
                ups.append({"from": src, "from_key": u.get("from_key"),
                            "to_key": u.get("to_key")})
        ctx = rec.get("ctx")
        if isinstance(ctx, list):
            ctx = ".".join(str(c) for c in ctx)
        out.append({
            "id": rec.get("op_id") or f"{rec.get('op_full_name')}#{ctx}",
            "op": rec.get("op_name"),
            "full": rec.get("op_full_name"),
            "ctx": ctx,
            "start": start,
            "dur_ms": rec.get("duration_ms") or 0.0,
            "status": rec.get("status"),
            "error": rec.get("error"),
            "upstreams": ups,
            # a generator's yield record contains everything dispatched for
            # that item (operonx ≥ 1.6 writes the flag; older runs get None)
            "is_yield": rec.get("is_yield"),
            "wall_start": rec.get("wall_start"),
            "_stream": bool((rec.get("outputs") or {}).get("_transient_stream")),
        })
    out.sort(key=lambda r: r["start"])
    for r in out:
        r["start_ms"] = round((r.pop("start") - (t0 or 0.0)) * 1000.0, 3)
    turns = _turns_of(out)
    for r in out:
        r.pop("_stream", None)
    return {"run": run_name, "total": len(out), "executions": out[:cap], "turns": turns}


def _tree_records(records, run_name: str) -> Dict[str, Any]:
    """The run as the tree Langfuse gets: operonx's own `build_tree` over
    the recorded rows, so the studio and Langfuse never disagree on a
    parent. Rows come out depth-first, siblings by start time, each with
    what a tree row prints (name, kind, timing, status) and what the
    inspector needs (ctx, upstreams, outputs bounded to card size)."""
    from operonx.core.workflow_trace import OpExecution, UpstreamRef, WorkflowTrace
    from operonx.telemetry.consumers.langfuse import build_tree

    execs: List[OpExecution] = []
    raw_by_id: Dict[str, Dict[str, Any]] = {}
    for rec in records:
        start = rec.get("start_time")
        if start is None:
            continue
        ctx = rec.get("ctx")
        ctx_t = tuple(ctx) if isinstance(ctx, list) else tuple((ctx or "main").split("."))
        op_id = rec.get("op_id") or f"{rec.get('op_full_name')}#{'.'.join(ctx_t)}"
        ups = []
        for u in rec.get("upstreams") or []:
            src = u.get("from_op_id") or u.get("from")
            if src:
                ups.append(UpstreamRef(from_op_id=src, from_op_name=u.get("from_op_name") or "",
                                       from_op_full_name=u.get("from_op_full_name") or "",
                                       from_key=u.get("from_key") or "", to_key=u.get("to_key") or ""))
        dur = float(rec.get("duration_ms") or 0.0)
        execs.append(OpExecution(
            op_id=op_id, op_name=rec.get("op_name") or "?", op_full_name=rec.get("op_full_name") or rec.get("op_name") or "?",
            ctx=ctx_t, start_time=float(start), end_time=float(start) + dur / 1000.0,
            inputs={}, outputs=rec.get("outputs") if isinstance(rec.get("outputs"), dict) else {},
            upstreams=ups, status=rec.get("status") or "ok", error=rec.get("error"),
            op_type=rec.get("op_type") or "", is_yield=bool(rec.get("is_yield")),
        ))
        raw_by_id[op_id] = rec
    if not execs:
        return {"run": run_name, "total_ms": 0.0, "rows": [], "turns": []}
    t0 = min(e.start_time for e in execs)
    t1 = max(e.end_time for e in execs)
    trace = WorkflowTrace(trace_id=run_name, workflow_name=run_name, started_at=t0, ended_at=t1, nodes=execs)
    nodes = build_tree(trace)
    children: Dict[Optional[str], List[str]] = {}
    for n in nodes.values():
        children.setdefault(n["parent"], []).append(n["id"])
    rows: List[Dict[str, Any]] = []

    def emit(nid: str, depth: int) -> None:
        n = nodes[nid]
        rec = n["record"]
        row: Dict[str, Any] = {
            "id": nid, "parent": n["parent"], "depth": depth, "kind": n["kind"], "name": n["name"],
            "op": rec.op_name if rec else None, "ctx": n["ctx"],
            "start_ms": round((n["start"] - t0) * 1000.0, 3),
            "dur_ms": round((n["end"] - n["start"]) * 1000.0, 3),
            "kids": len(children.get(nid, [])),
        }
        if rec is not None:
            row.update({
                "status": rec.status, "error": rec.error, "is_yield": rec.is_yield, "op_type": rec.op_type,
                "wall_start": raw_by_id.get(nid, {}).get("wall_start"),
                "upstreams": [{"from": u.from_op_id, "from_key": u.from_key, "to_key": u.to_key} for u in rec.upstreams],
                "outputs": _printable_outputs(rec.outputs),
            })
        rows.append(row)
        for k in sorted(children.get(nid, []), key=lambda k: nodes[k]["start"]):
            emit(k, depth + 1)

    roots = sorted(children.get(None, []), key=lambda k: (len(nodes[k]["ctx"].split(".")) > 1, nodes[k]["start"]))
    for r in roots:
        emit(r, 0)
    flat = [{"op": r["op"], "ctx": r["ctx"], "start_ms": r["start_ms"], "dur_ms": r["dur_ms"],
             "is_yield": r.get("is_yield"), "_stream": bool((r.get("outputs") or {}).get("_transient_stream"))}
            for r in rows if r["kind"] == "record"]
    return {"run": run_name, "total_ms": round((t1 - t0) * 1000.0, 3), "rows": rows, "turns": _turns_of(flat)}


def _turns_of(execs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The run's top-level dispatch groups, from ctx alone.

    Everything dispatched for one level-1 yield shares the ctx prefix
    ``main.[i]``: that is a turn. It is named after the yield record at
    that ctx (``bot_prompts [1]``) when the stream recorded it, else after
    the root-level transient stream that did not (``audio_in [357]``) —
    the same rule the Langfuse consumer uses for its stand-in span.
    """
    stream = next((e["op"] for e in execs if e.get("_stream") and "." not in (e["ctx"] or "")), None)
    groups: Dict[str, Dict[str, Any]] = {}
    for e in execs:
        parts = (e["ctx"] or "").split(".")
        if len(parts) < 2:
            continue
        key = ".".join(parts[:2])
        g = groups.setdefault(key, {"key": key, "label": None, "start_ms": e["start_ms"],
                                    "end_ms": e["start_ms"] + (e["dur_ms"] or 0.0), "count": 0})
        g["count"] += 1
        g["end_ms"] = max(g["end_ms"], e["start_ms"] + (e["dur_ms"] or 0.0))
        if g["label"] is None and e.get("is_yield") and e["ctx"] == key:
            g["label"] = f"{e['op']} [{parts[1].strip('[]')}]"
    for key, g in groups.items():
        if g["label"] is None:
            idx = key.split(".")[1].strip("[]")
            g["label"] = f"{stream} [{idx}]" if stream else key
    return sorted(groups.values(), key=lambda g: g["start_ms"])


_PRINTABLE_STR = 200


def _printable_outputs(outputs: Any) -> Optional[Dict[str, Any]]:
    """One record's outputs cut down to what fits on a card.

    Scalars stay. Strings are cut at 200 characters. The trace
    consumer's own markers (``$media``, ``$media_ref``,
    ``$unserializable``) stay whole, they are already small. A list
    becomes ``{"$len": n}`` and any other dict ``{"$keys": [...]}``:
    a card prints a size, never a payload, and the inspector fetches
    the full value per op when asked.
    """
    if not isinstance(outputs, dict):
        return None
    out: Dict[str, Any] = {}
    for key, value in outputs.items():
        if isinstance(value, str):
            out[key] = value if len(value) <= _PRINTABLE_STR else value[:_PRINTABLE_STR]
        elif value is None or isinstance(value, (bool, int, float)):
            out[key] = value
        elif isinstance(value, dict):
            if any(m in value for m in ("$media", "$media_ref", "$unserializable")):
                out[key] = value
            else:
                out[key] = {"$keys": list(value.keys())[:5]}
        elif isinstance(value, (list, tuple)):
            out[key] = {"$len": len(value)}
        else:
            out[key] = {"$type": type(value).__name__}
    return out


def _summarise_run(records, run_name: str, limit: int = 20000) -> Dict[str, Any]:
    """Per-op aggregates for one recorded run.

    Aggregated server-side because a call's record stream can hold tens
    of thousands of per-item entries — the callbot writes one per audio
    packet — and the canvas needs per-op numbers, not the firehose.
    """
    per_op: Dict[str, Dict[str, Any]] = {}
    count = 0
    t_first: Optional[float] = None
    t_last: Optional[float] = None
    for rec in records:
        if count >= limit:
            break
        count += 1
        name = rec.get("op_name") or rec.get("op_full_name") or "?"
        agg = per_op.setdefault(name, {
            "runs": 0, "errors": 0, "total_ms": 0.0, "max_ms": 0.0, "last_error": None,
            "last": None,
        })
        agg["runs"] += 1
        # The last execution's outputs, bounded to what a card can print:
        # the canvas shows the op's show_keys values without a second
        # fetch. Records arrive in write order, so the last one wins.
        agg["last"] = _printable_outputs(rec.get("outputs"))
        duration = float(rec.get("duration_ms") or 0.0)
        agg["total_ms"] += duration
        agg["max_ms"] = max(agg["max_ms"], duration)
        start, end = rec.get("start_time"), rec.get("end_time")
        if isinstance(start, (int, float)):
            t_first = start if t_first is None else min(t_first, start)
        if isinstance(end, (int, float)):
            t_last = end if t_last is None else max(t_last, end)
        if rec.get("status") not in (None, "ok"):
            agg["errors"] += 1
            agg["last_error"] = rec.get("error") or rec.get("status")
    wall_s = (t_last - t_first) if (t_first is not None and t_last is not None) else None
    return {"run": run_name, "records": count, "ops": per_op,
            "wall_s": round(wall_s, 2) if wall_s is not None else None,
            "errors": sum(a["errors"] for a in per_op.values()),
            "truncated": count >= limit}


def _studio_manifest(root: Path) -> Dict[str, Any]:
    """The whole operonx.toml, or nothing."""
    try:
        return _toml.loads((root / MANIFEST).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _per_token(per_million: float) -> Any:
    """USD per 1M tokens as the per-token number resources files hold —
    0 stays the integer 0 (a declared zero), the rest a plain decimal."""
    if per_million == 0:
        return 0
    return float(f"{per_million / 1_000_000:.12g}")


def _dir_size(path: Path) -> int:
    """Bytes under *path* (a run directory), best-effort."""
    total = 0
    for current, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(current) / name).stat().st_size
            except OSError:
                pass
    return total


# ── the app ─────────────────────────────────────────────────────────────


#: Starter kinds that ask the assistant to change or run something — a
#: viewer's assistant has read reach only (TEAM_PLAN D10), so it never
#: offers them.
VIEWER_CANNOT = frozenset({"setup", "try"})


def build_studio_app(recents: Optional[Recents] = None):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from fastapi.staticfiles import StaticFiles

    recents = recents if recents is not None else Recents()
    watchers: Dict[str, ProjectWatcher] = {}

    import hashlib

    from fastapi import Depends
    from fastapi.middleware.gzip import GZipMiddleware
    from fastapi.responses import HTMLResponse

    from .access import AccessDenied, authorize, is_open_path, level_of, recorded, unclassified

    async def _authorize(request: Request) -> None:
        # what the activity log needs (§2.6), noted before the table decides,
        # so a refusal is recorded as well as a change
        route = getattr(request.scope.get("route"), "path", None)
        level = level_of(request.method, route)
        detail: Dict[str, Any] = {}
        if request.method not in ("GET", "HEAD", "OPTIONS") and \
                recorded(request.method, route, level, 200):
            from .users import audit_detail

            try:
                detail = audit_detail(json.loads(await request.body() or b"{}"))
            except ValueError:
                detail = {}
        if "uid" in request.path_params and "username" not in detail:
            # whom an admin acted on, by name: after a delete there is no one to look up
            target = users.user(str(request.path_params["uid"]))
            if target is not None:
                detail["username"] = target["username"]
        request.state.audit = {"route": route or request.url.path, "level": level,
                               "params": {k: str(v)[:200] for k, v in request.path_params.items()},
                               "detail": detail}
        authorize(request)

    # Every route passes the access table (operonx_studio/access.py) before
    # its handler runs. No /openapi.json: it is not an APIRoute, so the
    # table could not guard it, and nothing reads it.
    app = FastAPI(title="operonx studio", docs_url=None, redoc_url=None, openapi_url=None,
                  dependencies=[Depends(_authorize)])
    app.state.recents = recents
    app.state.watchers = watchers
    # IR payloads carry every binding, source snippet and layout — tens to
    # hundreds of KB of very compressible JSON, often over a slow tunnel.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # Cache-busting without staleness: pages reference their assets as
    # /static/x.js?v=<content hash>, so assets cache forever and a deploy
    # changes the URL. Only the two small HTML pages revalidate per load —
    # one round trip instead of one per asset, which over a tunnel is the
    # difference the user feels.
    def _asset_version() -> str:
        digest = hashlib.sha1()
        for f in sorted(STATIC.glob("*")):
            stat = f.stat()
            digest.update(f"{f.name}:{stat.st_mtime_ns}:{stat.st_size};".encode())
        # what is served is also what these make of the files: a new
        # minifier or dark-theme rule is a new version too
        for f in (Path(__file__).parent / "minify.py", Path(__file__).parent / "theme.py"):
            if f.is_file():
                digest.update(f"{f.name}:{f.stat().st_mtime_ns};".encode())
        return digest.hexdigest()[:10]

    # One script per page. Through the tunnel every extra request is
    # another ~0.75 s wave: the project page's 16 scripts took 2.4-2.9 s
    # of a 3.9 s open (measured, docs/REFACTOR_PHASE2.md P1). A page's
    # <script src="/static/…"> tags are served as ONE bundle, in page
    # order — classic scripts share one global scope, so the
    # concatenation is the same program. Everything is rebuilt when any
    # static file changes, so editing a .js still needs no restart.
    _SCRIPT_TAG = re.compile(r'[ \t]*<script src="/static/([A-Za-z0-9_.-]+\.js)"></script>\n?')
    pages: Dict[str, Tuple[str, str, bytes]] = {}   # page -> (asset version, html, bundle)
    # Served small: comments, indentation and blank lines go, token for token
    # the same program (operonx_studio/minify.py; the project bundle 155 ->
    # 117 KB gzipped). OPERONX_STUDIO_MINIFY=off serves it readable.
    minify = os.environ.get("OPERONX_STUDIO_MINIFY", "on").strip().lower() not in ("off", "0", "false", "no")

    def _built(name: str) -> Tuple[str, bytes]:
        version = _asset_version()
        got = pages.get(name)
        if got is not None and got[0] == version:
            return got[1], got[2]
        text = (STATIC / name).read_text(encoding="utf-8")
        scripts = _SCRIPT_TAG.findall(text)
        bundle = b""
        if scripts:
            parts = ['"use strict";\n']
            for script in scripts:
                parts.append(f"\n/* ── {script} ── */\n")
                parts.append((STATIC / script).read_text(encoding="utf-8"))
                parts.append("\n;\n")
            joined = "".join(parts)
            if minify:
                from .minify import strip_js

                joined = strip_js(joined)
            bundle = joined.encode("utf-8")
            tag = (f'<script src="/static/bundle/{Path(name).stem}.js'
                   f'?v={hashlib.sha1(bundle).hexdigest()[:10]}"></script>\n')
            first = text.index("<script src=\"/static/")
            text = text[:first] + tag + _SCRIPT_TAG.sub("", text[first:])
        # every local asset the page names gets the content version
        text = re.sub(r'(/static/[A-Za-z0-9_.-]+\.css)(?=["\'])',
                      lambda m: f"{m.group(1)}?v={version}", text)
        pages[name] = (version, text, bundle)
        return text, bundle

    def _page(name: str, boot: str = "", request: Any = None) -> HTMLResponse:
        """A page, its scripts bundled; ``boot`` (inline markup, e.g. a
        JSON data island) goes in just before the bundle. With *request*,
        who is signed in rides along too (``#me-boot``): the account menu
        draws at once, never a flash of the wrong name."""
        text, _ = _built(name)
        who = getattr(getattr(request, "state", None), "user", None) if request is not None else None
        if who is not None:
            # the role before the first paint: a viewer never sees an edit control flash (§2.5)
            text = re.sub(r"<body([^>]*)>", lambda m: f'<body{m.group(1)} data-role="{who["role"]}">', text, count=1)
            me = {"user": {k: who[k] for k in ("id", "username", "name", "role")}, "auth": auth_on}
            boot = ('<script id="me-boot" type="application/json">'
                    + json.dumps(me).replace("</", "<\\/") + "</script>" + boot)
        if boot:
            at = text.find("<script src=")
            text = text[:at] + boot + "\n" + text[at:] if at >= 0 else text + boot
        return HTMLResponse(text, headers={"Cache-Control": "no-cache"})

    styles: Dict[str, Tuple[str, bytes]] = {}       # stylesheet -> (asset version, served bytes)

    @app.get("/static/{name}.css")
    def stylesheet(name: str) -> Any:
        """A stylesheet, minified (rcssmin) unless OPERONX_STUDIO_MINIFY=off."""
        from fastapi.responses import Response

        path = STATIC / f"{name}.css"
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not path.is_file():
            return JSONResponse({"error": "no such stylesheet"}, status_code=404)
        version = _asset_version()
        got = styles.get(name)
        if got is None or got[0] != version:
            text = path.read_text(encoding="utf-8")
            if name == "studio":
                # the dark theme: every colour-setting rule's dark twin, in
                # place (operonx_studio/theme.py), then the hand-tuned part
                from .theme import with_dark

                text = with_dark(text)
                dark = STATIC / "studio-dark.css"
                if dark.is_file():
                    text += "\n" + dark.read_text(encoding="utf-8")
            if minify:
                try:
                    from .minify import strip_css

                    text = strip_css(text)
                except ImportError:       # rcssmin missing: served as written
                    pass
            got = styles[name] = (version, text.encode("utf-8"))
        return Response(got[1], media_type="text/css; charset=utf-8")

    @app.get("/static/bundle/{stem}.js")
    def page_bundle(stem: str) -> Any:
        from fastapi.responses import Response

        if not re.fullmatch(r"[a-z]+", stem) or not (STATIC / f"{stem}.html").is_file():
            return JSONResponse({"error": "no such bundle"}, status_code=404)
        _, bundle = _built(f"{stem}.html")
        return Response(bundle, media_type="application/javascript; charset=utf-8")

    @app.middleware("http")
    async def _cache_headers(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static"):
            response.headers["Cache-Control"] = (
                "public, max-age=31536000, immutable"
                if "v" in request.query_params else "no-cache")
        return response

    # ── authentication: people, sessions, the agent's token ─────────────
    # The studio rides a public tunnel; an open door there is an open door
    # to the filesystem browser and the param editor. Accounts live in
    # <state>/users.sqlite (operonx_studio/users.py); the middleware below
    # resolves who is asking (request.state.user) and the access table
    # decides what they may do (operonx_studio/access.py).
    #
    #   OPERONX_STUDIO_USER/PASS   the first admin, read once on a start with no accounts
    #   OPERONX_STUDIO_AUTH=off    no sign-in: everyone is the first admin (trusted networks, the tests)
    from .users import (
        AgentTokens,
        PasswordError,
        Throttle,
        UserStore,
        check_password,
        password_problem,
    )

    auth_on = os.environ.get("OPERONX_STUDIO_AUTH", "").lower() not in ("off", "0", "false")
    users = UserStore(recents.state_file.parent / "users.sqlite")
    agents = AgentTokens()
    throttle = Throttle()
    app.state.users = users
    app.state.agents = agents
    if auth_on:
        from . import chat as _chat_first

        users.ensure_first_admin(os.environ.get("OPERONX_STUDIO_USER", "root"),
                                 os.environ.get("OPERONX_STUDIO_PASS", "123"),
                                 claude_home=str(_chat_first.claude_home()))

    #: who everyone is with auth off and no accounts yet
    LOCAL = {"id": "local", "username": "local", "name": "local", "role": "admin", "must_change": False,
             "disabled": False, "machine_login": True}

    def _person(user: Dict[str, Any], via: str) -> Dict[str, Any]:
        """What a request carries about who sent it: never the hash."""
        return {"id": user["id"], "username": user["username"], "name": user.get("name") or user["username"],
                "role": user["role"], "must_change": bool(user.get("must_change")), "via": via}

    #: what someone who must choose a password may still reach
    _MUST_CHANGE_OK = ("/api/me", "/api/me/password", "/api/logout")

    def _cookie(response: Any, request: Any, token: str) -> None:
        # Secure when the tunnel says the browser spoke https to it
        secure = (request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"
                  or request.url.scheme == "https")
        response.set_cookie("oxsession", token, httponly=True, samesite="lax", secure=secure,
                            max_age=30 * 86400)

    def _same_origin(request: Any) -> bool:
        """A state change from another site's page is refused (decision D15).
        No Origin (curl, the assistant's tools, old browsers on same-origin
        GETs) is not a browser request from elsewhere."""
        origin = request.headers.get("origin")
        if origin is None:
            return True
        from urllib.parse import urlsplit

        host = urlsplit(origin).netloc.lower()
        allowed = {h.strip().lower() for h in (request.headers.get("host", ""),
                                               request.headers.get("x-forwarded-host", "")) if h.strip()}
        return bool(host) and host in allowed

    def _client(request: Any) -> str:
        """Who is knocking, for the throttle. Behind the tunnel every request
        comes from loopback, so a loopback peer's X-Forwarded-For is trusted;
        anyone else's is not (it would let them pick their own key)."""
        peer = request.client.host if request.client else ""
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd and peer in ("127.0.0.1", "::1", "localhost"):
            return fwd.split(",")[0].strip()
        return peer

    def _log_activity(request: Any, status: int, route: Optional[str] = None) -> None:
        """One activity row for this request, if it is one the log keeps."""
        note = getattr(request.state, "audit", None) or {"route": route or request.url.path, "level": None,
                                                         "params": {}, "detail": {}}
        if not recorded(request.method, note["route"], note["level"], status) or note["route"] == "/api/login":
            return                      # a sign-in is recorded by its handler, with the name it tried
        who = getattr(request.state, "user", None) or {}
        try:
            users.audit(user=who.get("id"), username=who.get("username"), via=who.get("via") or "web",
                        method=request.method, route=note["route"], status=status,
                        pid=note["params"].get("pid"), params=note["params"], detail=note["detail"])
        except Exception:  # noqa: BLE001 — the log never breaks a request
            pass

    @app.middleware("http")
    async def _guard(request, call_next):
        path = request.url.path
        if request.method not in ("GET", "HEAD", "OPTIONS") and not _same_origin(request):
            _log_activity(request, 403, route=path)
            return JSONResponse({"error": "cross-site request refused"}, status_code=403)
        if not auth_on:
            admin = users.first_admin()
            request.state.user = _person(admin, "web") if admin else dict(LOCAL, via="web")
            response = await call_next(request)
            _log_activity(request, response.status_code)
            return response
        user, session, touched = None, None, False
        token = request.cookies.get("oxsession") or ""
        if token:
            uid = agents.resolve(token)
            if uid is not None:
                got = users.cached_user(uid)
                if got is not None and not got["disabled"]:
                    user = _person(got, "assistant")
            else:
                got, session, touched = users.resolve(token)
                if got is not None:
                    user = _person(got, "web")
        request.state.user = user
        request.state.session = session
        if user is None and not is_open_path(path):
            if path.startswith("/api/"):
                return JSONResponse({"error": "authentication required"}, status_code=401)
            from fastapi.responses import RedirectResponse

            return RedirectResponse("/login", status_code=302)
        if user is not None and user["must_change"] and not is_open_path(path) and path not in _MUST_CHANGE_OK:
            if path.startswith("/api/"):
                _log_activity(request, 403, route=path)
                return JSONResponse({"error": "choose a new password first", "must_change": True},
                                    status_code=403)
            from fastapi.responses import RedirectResponse

            return RedirectResponse("/login", status_code=302)
        response = await call_next(request)
        _log_activity(request, response.status_code)
        if touched:
            # the session's 30 days moved on; so does the browser's copy
            _cookie(response, request, token)
        return response

    @app.exception_handler(AccessDenied)
    async def _denied(request, exc: AccessDenied):
        if not request.url.path.startswith("/api/"):
            # a page someone may not open sends them somewhere they may
            from fastapi.responses import RedirectResponse

            return RedirectResponse("/login" if exc.status == 401 else "/", status_code=302)
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.get("/login")
    def login_page(request: Request) -> HTMLResponse:
        # someone signed in with a temporary or default password lands on
        # the "choose your password" step, without a flash of the form
        me = getattr(request.state, "user", None)
        boot = ""
        if auth_on and me is not None and me["must_change"] and me["via"] == "web":
            boot = ('<script id="login-boot" type="application/json">'
                    + json.dumps({"step": "password", "username": me["username"]}).replace("</", "<\\/")
                    + "</script>")
        return _page("login.html", boot)

    @app.post("/api/login")
    def login(body: Dict[str, Any], request: Request) -> JSONResponse:
        if not auth_on:
            return JSONResponse({"ok": True, "must_change": False})
        username = str(body.get("username") or "").strip().lower()[:64]
        password = str(body.get("password") or "")[:1024]
        keys = (f"user:{username}", f"addr:{_client(request)}")
        # A password reset in another process (`--reset-password`) cannot
        # reach this in-memory throttle; the stored hash can. A name locked
        # under a password that has since changed is let through, once.
        known = users.by_name(username)
        if known is not None and throttle.password_changed(keys[0], known["pw"]):
            throttle.clear(*keys)
        wait = throttle.locked(*keys)
        if wait > 0:
            secs = int(wait) + 1
            return JSONResponse({"error": f"Too many attempts — try again in {secs} s", "retry_after": secs},
                                status_code=429, headers={"Retry-After": str(secs)})
        user = users.check(username, password)

        def note(status: int, who: Optional[Dict[str, Any]]) -> None:
            users.audit(user=who["id"] if who else None, username=who["username"] if who else None, via="web",
                        method="POST", route="/api/login", status=status, detail={"username": username[:64]})

        if user is None:
            throttle.fail(*keys, pw=known["pw"] if known else None)
            # a wrong password is recorded against the person it tried (an admin
            # filters by them); a name no one has, against no one
            note(401, users.by_name(username))
            return JSONResponse({"error": "Wrong username or password."}, status_code=401)
        if user["disabled"]:
            # only someone who knew the password learns this
            note(403, user)
            return JSONResponse({"error": "This account is disabled — ask an admin"}, status_code=403)
        note(200, user)
        throttle.clear(*keys)
        token = users.start_session(user["id"], label=request.headers.get("user-agent", ""))
        response = JSONResponse({"ok": True, "must_change": user["must_change"],
                                 "user": _person(user, "web")})
        _cookie(response, request, token)
        return response

    def _end_this_session(request: Any) -> None:
        token = request.cookies.get("oxsession") or ""
        if token and agents.resolve(token) is None:
            users.end_session(token)

    @app.get("/logout")
    def logout(request: Request):
        from fastapi.responses import RedirectResponse

        _end_this_session(request)
        response = RedirectResponse("/login", status_code=302)
        response.delete_cookie("oxsession")
        return response

    @app.post("/api/logout")
    def api_logout(request: Request) -> JSONResponse:
        _end_this_session(request)
        response = JSONResponse({"ok": True})
        response.delete_cookie("oxsession")
        return response

    def _me_out(user: Dict[str, Any]) -> Dict[str, Any]:
        return {k: user.get(k) for k in ("id", "username", "name", "role", "must_change", "disabled",
                                          "machine_login", "claude_email", "created", "last_seen")}

    @app.get("/api/me")
    def me(request: Request) -> JSONResponse:
        who = request.state.user
        row = users.user(who["id"]) if who["id"] != "local" else None
        return JSONResponse({"user": {**(_me_out(row) if row else {}), **who}, "auth": auth_on})

    @app.post("/api/me/password")
    def me_password(body: Dict[str, Any], request: Request) -> JSONResponse:
        """Choose your own password. The current one is asked for, except on
        the first sign-in with a temporary one (you just typed it). Your
        other sessions end; this one stays."""
        who = request.state.user
        row = users.user(who["id"]) if who["id"] != "local" else None
        if row is None:
            return JSONResponse({"error": "There are no accounts yet — auth is off"}, status_code=400)
        new = str(body.get("new") or "")
        if not row["must_change"] and not check_password(str(body.get("current") or ""), row["pw"]):
            return JSONResponse({"error": "Your current password is not right"}, status_code=400)
        problem = password_problem(new, row["username"])
        if problem is None and check_password(new, row["pw"]):
            problem = "Choose a password different from the one you have."
        if problem:
            return JSONResponse({"error": problem}, status_code=400)
        users.set_password(row["id"], new, must_change=False)
        ended = users.end_sessions(row["id"], keep=getattr(request.state, "session", None))
        return JSONResponse({"ok": True, "ended_sessions": ended})

    # ── people (admins): the Team page and its API ──

    @app.get("/team")
    def team_page(request: Request) -> HTMLResponse:
        return _page("team.html", "", request)

    def _stop_turns_of(uid: str) -> int:
        stopped = 0
        for turn in list(relay.turns.values()):
            if turn.owner == uid and not turn.done:
                relay.stop(turn.id, reason="access")
                stopped += 1
        return stopped

    def _user_out(user: Dict[str, Any], counts: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        return {**_me_out(user), "sessions": (counts or {}).get(user["id"], 0)}

    def _target(uid: str, request: Any) -> Any:
        row = users.user(uid)
        if row is None:
            return JSONResponse({"error": "no such person"}, status_code=404)
        return row

    @app.get("/api/admin/activity")
    def admin_activity(user: str = "", pid: str = "", before: int = 0, limit: int = 200) -> JSONResponse:
        """What was changed and refused, newest first (§2.6); filtered by
        person and project; ``before`` an id pages back. Kept 180 days."""
        rows = users.activity(user=user or None, pid=pid or None, before=before or None, limit=limit)
        for r in rows:
            ref = recents.get(r["pid"]) if r.get("pid") else None
            r["project"] = ref.name if ref else None
        return JSONResponse({"rows": rows, "days": 180})

    @app.get("/api/admin/users")
    def admin_users() -> JSONResponse:
        counts = users.session_counts()
        return JSONResponse({"users": [_user_out(u, counts) for u in users.users()], "roles": ["admin", "editor", "viewer"]})

    @app.post("/api/admin/users")
    def admin_add(body: Dict[str, Any]) -> JSONResponse:
        """Someone new, with a temporary password shown once."""
        try:
            user, password = users.create(str(body.get("username") or ""), name=str(body.get("name") or ""),
                                          role=str(body.get("role") or "editor"), must_change=True)
        except PasswordError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"user": _user_out(user), "password": password})

    @app.patch("/api/admin/users/{uid}")
    async def admin_update(uid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        row = _target(uid, request)
        if isinstance(row, JSONResponse):
            return row
        me_id = request.state.user["id"]
        update: Dict[str, Any] = {}
        if "name" in body:
            update["name"] = str(body.get("name") or "").strip()[:80]
        if "role" in body and body["role"] != row["role"]:
            if uid == me_id:
                return JSONResponse({"error": "You can't change your own role"}, status_code=400)
            if body["role"] not in ("admin", "editor", "viewer"):
                return JSONResponse({"error": "A role is admin, editor or viewer"}, status_code=400)
            update["role"] = body["role"]
        if "disabled" in body and bool(body["disabled"]) != row["disabled"]:
            if uid == me_id:
                return JSONResponse({"error": "You can't disable yourself"}, status_code=400)
            update["disabled"] = bool(body["disabled"])
        rank = {"viewer": 0, "editor": 1, "admin": 2}
        demoted = "role" in update and rank[update["role"]] < rank[row["role"]]
        disabled = bool(update.get("disabled"))
        if (demoted or disabled) and row["role"] == "admin" and not row["disabled"] and users.active_admins() <= 1:
            return JSONResponse({"error": "They are the last active admin"}, status_code=400)
        user = users.update(uid, **update)
        stopped = 0
        if demoted or disabled:
            # decision D16: a demotion or a disable holds from the next request
            users.end_sessions(uid)
            agents.revoke_user(uid)
            stopped = _stop_turns_of(uid)
        return JSONResponse({"user": _user_out(user), "stopped_turns": stopped})

    @app.post("/api/admin/users/{uid}/password")
    def admin_reset(uid: str, request: Request) -> JSONResponse:
        """A temporary password, shown once; they choose their own at the
        next sign-in, and every session of theirs ends now."""
        row = _target(uid, request)
        if isinstance(row, JSONResponse):
            return row
        if uid == request.state.user["id"]:
            return JSONResponse({"error": "Change your own password from your account"}, status_code=400)
        password = users.reset_password(uid)
        agents.revoke_user(uid)
        return JSONResponse({"user": _user_out(users.user(uid)), "password": password})

    @app.delete("/api/admin/users/{uid}")
    async def admin_delete(uid: str, request: Request) -> JSONResponse:
        """Someone leaves: their sessions and turns end, their conversations
        are deleted, their own Claude sign-in is signed out and removed."""
        row = _target(uid, request)
        if isinstance(row, JSONResponse):
            return row
        if uid == request.state.user["id"]:
            return JSONResponse({"error": "You can't delete yourself"}, status_code=400)
        if row["role"] == "admin" and not row["disabled"] and users.active_admins() <= 1:
            return JSONResponse({"error": "They are the last active admin"}, status_code=400)
        users.end_sessions(uid)
        agents.revoke_user(uid)
        stopped = _stop_turns_of(uid)
        for sid in chat_store.owned_by(uid):
            chat_store.delete_session(sid)
        await _forget_claude_home(row)
        users.delete(uid)
        return JSONResponse({"deleted": uid, "stopped_turns": stopped})

    async def _forget_claude_home(row: Dict[str, Any]) -> None:
        """Sign their own Claude directory out, then remove it — only when
        it lies inside this studio's state directory: a directory the
        studio did not make (a real ~/.claude named by an env variable) is
        never touched."""
        import shutil

        from . import chat as _chat_mod

        home = Path(_claude_of(row["id"])["home"]).resolve()
        state = recents.state_file.parent.resolve()
        if state not in home.parents or not home.is_dir():
            return
        binary = _chat_mod.find_claude()
        if binary is not None:
            env = _chat_mod.base_env()
            env["CLAUDE_CONFIG_DIR"] = str(home)
            proc = await asyncio.create_subprocess_exec(
                binary, "auth", "logout", env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            try:
                await asyncio.wait_for(proc.wait(), timeout=30)
            except asyncio.TimeoutError:
                proc.kill()
        shutil.rmtree(home, ignore_errors=True)

    def _watcher(pid: str) -> Optional[ProjectWatcher]:
        if pid in watchers:
            return watchers[pid]
        ref = recents.get(pid)
        if ref is None or not ref.exists:
            return None
        watchers[pid] = ProjectWatcher(root=ref.root)
        return watchers[pid]

    def _prewarm() -> None:
        """Extract every recent project before anyone asks.

        One at a time — seventeen simultaneous interpreter imports would
        be a load spike, and the point is warmth, not a race. Projects
        whose disk-cached IR still matches their files cost nothing here.
        """
        import threading
        import time as _time

        def run() -> None:
            for ref in recents.ordered():
                try:
                    if not ref.exists:
                        continue
                    watcher = watchers.setdefault(ref.id, ProjectWatcher(root=ref.root))
                    if watcher.last.stamp != 0.0 and not watcher.changed():
                        continue
                    watcher._kick_background_extract()
                    while watcher._extracting:
                        _time.sleep(0.2)
                except Exception:  # noqa: BLE001 — warmth is best-effort
                    continue

        threading.Thread(target=run, name="prewarm", daemon=True).start()

    _prewarm()

    # ── home ────────────────────────────────────────────────────────────

    @app.get("/")
    def home(request: Request):
        # the list and its signal ride in the page: two tunnel round trips
        # (~1.5 s) traded for ~0.2 s of server time (measured, 25 projects)
        boot = json.dumps({"projects": [r.as_dict() for r in recents.ordered()],
                           "health": _projects_health(),
                           "sessions": [_session_out(x) for x in
                                        chat_store.sessions(None, owner=request.state.user["id"], limit=6)]},
                          separators=(",", ":"), default=str)
        return _page("home.html", '<script id="home-boot" type="application/json">'
                     + boot.replace("</", "<\\/") + "</script>", request)

    @app.get("/api/projects")
    def projects() -> JSONResponse:
        return JSONResponse({"projects": [r.as_dict() for r in recents.ordered()]})

    @app.get("/api/projects/health")
    def projects_health() -> JSONResponse:
        return JSONResponse({"health": _projects_health()})

    def _projects_health() -> Dict[str, Any]:
        """Per-card signal for the home page: is the project extractable,
        how big is it, has it run lately. Reads only what is already
        warm (prewarmed watchers, cached IR, a directory listing) — this
        must never make the home page wait on seventeen extractions."""
        out: Dict[str, Any] = {}
        for ref in recents.ordered():
            if not ref.exists:
                continue
            info: Dict[str, Any] = {}
            watcher = watchers.get(ref.id)
            if watcher is None:
                watcher = watchers[ref.id] = ProjectWatcher(root=ref.root)
            last = watcher.last
            if last.stamp:
                info["ok"] = last.ok
                if last.ok and last.ir:
                    graphs = last.ir.get("graphs") or []
                    info["graphs"] = len(graphs)
                    info["ops"] = sum(len(g.get("nodes") or []) for g in graphs)
                elif last.error:
                    info["error"] = str(last.error).strip().splitlines()[-1][:200]
            try:
                from operonx_studio.runs import project_runs as _pr

                store = _pr(ref.root, sweep=False).store
                newest = store.list_runs(limit=1)
                if newest.items:
                    info["runs"] = newest.total if newest.total is not None else store.count()
                    info["newest"] = newest.items[0].started_at
            except Exception:  # noqa: BLE001 — a card's signal is best-effort
                pass
            out[ref.id] = info
        return out

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
        template = str(body.get("template") or "")
        if template and template != "blank":
            from operonx_project.templates import TEMPLATES, TemplateError, create

            try:
                create(root, template, name=name)
            except TemplateError as exc:
                return JSONResponse({"error": str(exc)}, status_code=400)
            ref = recents.touch(root)
            # the first minutes: its eval and jobs run now, so Runs and Evals
            # open on something green instead of an empty page
            first = TEMPLATES[template].get("first_runs") or []
            if first:
                watcher = _watcher(ref.id)
                py = watcher.interpreter() if watcher else sys.executable
                logs = root / ".operonx" / "first-runs.log"
                logs.parent.mkdir(parents=True, exist_ok=True)
                script = " && ".join(f'"{py}" -m operonx.cli.run {n}' for n in first)
                with logs.open("ab") as fh:
                    subprocess.Popen(["/bin/sh", "-c", script], cwd=str(root), stdout=fh, stderr=subprocess.STDOUT,
                                     env=watcher._child_env() if watcher else dict(os.environ), start_new_session=True)
            return JSONResponse({"id": ref.id, "name": ref.name, "root": str(root), "template": template,
                                 "first_runs": first})
        try:
            scaffold(root, name=name, with_llm=bool(body.get("with_llm")))
        except ScaffoldError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        ref = recents.touch(root)
        return JSONResponse({"id": ref.id, "name": ref.name, "root": str(root)})

    def _templates() -> List[Dict[str, Any]]:
        from operonx_project.templates import describe

        return [{"id": "blank", "title": "A blank project",
                 "description": "One small graph behind an HTTP door — the smallest start."}, *describe()]

    @app.get("/api/templates")
    def templates_list() -> JSONResponse:
        return JSONResponse({"templates": _templates()})

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
    def project_page(pid: str, request: Request) -> Any:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        # The graph rides in the page when the watcher already has it, so
        # the canvas draws without a second round trip (the IR fetch was
        # 1.2-1.5 s of a tunnel open, after every script). A cold project
        # is never blocked on here: the page fetches /ir and shows its
        # loading state instead of a blank tab.
        boot = ""
        if watcher.last.stamp != 0.0:
            payload = json.dumps(_ir_payload(pid, watcher), separators=(",", ":"))
            boot = ('<script id="ir-boot" type="application/json">'
                    + payload.replace("</", "<\\/") + "</script>")
        return _page("project.html", boot, request)

    def _declared_roles(
        root: Path, graphs: List[Dict[str, Any]], services: List[Dict[str, Any]] = ()
    ) -> None:
        """Boundary ops the application names outright.

        Each service's ``ingress``/``egress`` (declared on the service in
        Python or ``[[serve]]``) marks those ops in that service's graphs —
        ``<graph>`` or ``<graph>[<variant>]``.

        A project with stream-level teardown writes its own ingress/egress
        over `current_session()` — the extension point, not a workaround —
        and no function-identity check can see those. `[studio]`'s
        `ingress`/`egress` lists name such ops so they still draw as doors:

            [studio]
            ingress = ["recv"]
            egress  = ["played"]
        """
        for sv in services or ():
            base = str(sv.get("graph") or "").rpartition(":")[2]
            roles = {str(n): role for role in ("ingress", "egress") for n in (sv.get(role) or [])}
            if not base or not roles:
                continue
            for g in graphs:
                if g.get("name") != base and not str(g.get("name", "")).startswith(base + "["):
                    continue
                for n in g.get("nodes") or []:
                    if not n.get("serve_role") and n["name"] in roles:
                        n["serve_role"] = roles[n["name"]]
        table = _studio_table(root)
        declared = {str(n): role
                    for role in ("ingress", "egress")
                    for n in (table.get(role) or [])}
        if not declared:
            return
        for g in graphs:
            for n in g.get("nodes") or []:
                if not n.get("serve_role") and n["name"] in declared:
                    # a manifest-declared door is a real op wearing a door's
                    # frame; it keeps the show keys it declared
                    n["serve_role"] = declared[n["name"]]

    def _ir_payload(pid: str, watcher: ProjectWatcher) -> Dict[str, Any]:
        result = watcher.refresh_swr()
        ref = recents.get(pid)
        if not result.ok:
            return {
                "name": ref.name if ref else pid,
                "root": str(watcher.root),
                "error": result.error,
                "stamp": result.stamp,
            }
        ir = result.ir
        placed = [_placed(g) for g in ir.get("graphs") or []]
        _declared_roles(watcher.root, placed, ir.get("services") or [])
        return {
            "name": ir.get("project"),
            "description": ir.get("description", ""),
            "root": str(watcher.root),
            "stamp": result.stamp,
            "graphs": placed,
            "serves": ir.get("serves") or [],
            "application": bool(ir.get("application")),
            "services": ir.get("services") or ir.get("serves") or [],
            "jobs": ir.get("jobs") or [],
            "resources": ir.get("resources") or {},
            "traces_configured": True,
        }

    @app.get("/api/p/{pid}/ir")
    def project_ir(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        return JSONResponse(_ir_payload(pid, watcher))

    @app.get("/api/p/{pid}/stamp")
    def project_stamp(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        result = watcher.refresh_swr()
        return JSONResponse({"stamp": result.stamp, "ok": result.ok})

    @app.get("/api/p/{pid}/env-health")
    def project_env_health(pid: str) -> JSONResponse:
        """Whether each env variable the resource files demand is satisfied.

        Checked by NAME only — against the project's ``.env`` and the
        server's own environment. Values never enter a response: this is
        a health light, not a secrets viewer.
        """
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        result = watcher.refresh_swr()
        ir = result.ir if result.ok else {}
        contract = ((ir or {}).get("resources") or {}).get("env") or {}
        defined: set = set()
        env_path = watcher.root / ".env"
        if env_path.is_file():
            for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name = line.split("=", 1)[0].strip()
                if name.startswith("export "):
                    name = name[len("export "):].strip()
                if name:
                    defined.add(name)
        status: Dict[str, str] = {}
        for name in contract.get("required") or []:
            status[name] = "set" if (name in defined or name in os.environ) else "missing"
        for name in (contract.get("optional") or {}):
            status[name] = "set" if (name in defined or name in os.environ) else "default"
        return JSONResponse({"env": status, "dotenv": env_path.is_file()})

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

    # ── runs ────────────────────────────────────────────────────────────
    # Every route below reads the project's RunStore (operonx_studio.runs):
    # the store the project's own services and jobs write into, opened from
    # configuration. `lf:`-prefixed ids come from the read-only Langfuse
    # source. The per-run helpers above (`_tree_records`, `_flow_records`,
    # `_op_executions`, `_summarise_run`) work on a record's rows, whatever
    # store they came from.

    from operonx.telemetry.runs import RunFilter

    from operonx_studio.runs import LF_PREFIX, project_runs, read_retention, write_retention

    def _runs(pid: str):
        watcher = _watcher(pid)
        if watcher is None:
            return None
        return project_runs(watcher.root)

    def _record(pid: str, run: str):
        """(rows, record) for one run, or a JSONResponse saying why not."""
        pr = _runs(pid)
        if pr is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        store, rid = pr.split(run)
        if store is None:
            return JSONResponse({"error": "no Langfuse source configured"}, status_code=404)
        try:
            rec = store.get_run(rid)
        except Exception as exc:  # noqa: BLE001 — a remote store may be away
            return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=502)
        if rec is None:
            return JSONResponse({"error": "no such run"}, status_code=404)
        return rec.nodes, rec

    def _row(s, source: str = "local") -> Dict[str, Any]:
        """A run summary as the list rows the UI reads."""
        d = s.to_dict()
        d.update({
            "run": (LF_PREFIX + s.trace_id) if source == "langfuse" else s.trace_id,
            "mtime": s.started_at,
            "source": source,
            "records": s.executions,
            "wall_s": round(s.duration_ms / 1000.0, 2) if s.duration_ms else None,
        })
        return d

    def _filter_from(params: Dict[str, Any]) -> RunFilter:
        def num(key):
            try:
                return float(params[key]) if params.get(key) not in (None, "") else None
            except (TypeError, ValueError):
                return None

        meta = {}
        for pair in str(params.get("meta") or "").split(","):
            k, sep, v = pair.partition(":")
            if sep and k.strip():
                meta[k.strip()] = v.strip()
        return RunFilter(
            origin=params.get("origin") or None,
            name=params.get("name") or None,
            status=params.get("status") or None,
            since=num("since"),
            until=num("until"),
            version=params.get("version") or None,
            job_run=params.get("job_run") or None,
            runbook_run=params.get("runbook_run") or None,
            metadata=meta,
            search=params.get("q") or None,
        )

    @app.get("/api/p/{pid}/traces")
    def traces(pid: str, local_only: int = 0) -> JSONResponse:
        """The newest runs, from the project's store — plus, unless
        ``local_only``, the Langfuse source's newest (a run present in
        both is one row: the store wins, the Langfuse copy is a badge)."""
        pr = _runs(pid)
        if pr is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        payload: Dict[str, Any] = {"configured": True, "root": pr.source}
        runs = [_row(s) for s in pr.store.list_runs(limit=200).items]
        if pr.remote is not None and not local_only:
            payload["langfuse"] = pr.remote.config.get("host")
            try:
                local_ids = {r["run"] for r in runs}
                for s in pr.remote.list_runs(limit=50).items:
                    if s.trace_id in local_ids:
                        next(r for r in runs if r["run"] == s.trace_id)["also_langfuse"] = True
                        continue
                    runs.append(_row(s, "langfuse"))
            except Exception as exc:  # noqa: BLE001 — someone else's server
                payload["langfuse_error"] = str(exc)
        runs.sort(key=lambda r: -(r["mtime"] or 0))
        payload["runs"] = runs[:200]
        return JSONResponse(payload)

    @app.get("/api/p/{pid}/runs")
    def runs_list(
        pid: str, origin: str = "", name: str = "", status: str = "", since: str = "",
        until: str = "", version: str = "", job_run: str = "", runbook_run: str = "",
        meta: str = "", q: str = "", order: str = "", limit: str = "", cursor: str = "",
        with_origins: str = "",
    ) -> JSONResponse:
        """Runs by filter, one page at a time — the Runs screen's list.
        ``meta=key:value,key:value`` matches metadata; ``q`` searches ids,
        keys and metadata. ``with_origins`` adds the folder tree for the
        same range, so the screen opens in one round trip."""
        pr = _runs(pid)
        if pr is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        params = {k: v for k, v in dict(
            origin=origin, name=name, status=status, since=since, until=until, version=version,
            job_run=job_run, runbook_run=runbook_run, meta=meta, q=q, order=order,
            limit=limit, cursor=cursor).items() if v}
        try:
            limit = max(1, min(int(params.get("limit") or 100), 1000))
        except ValueError:
            limit = 100
        try:
            page = pr.store.list_runs(_filter_from(params), order=params.get("order") or "started_desc",
                                      limit=limit, cursor=params.get("cursor") or None)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        out: Dict[str, Any] = {"runs": [_row(s) for s in page.items], "next": page.next_cursor,
                               "total": page.total, "source": pr.source}
        if with_origins:
            got = _origins(pid, since, until)
            out["origins"] = None if isinstance(got, JSONResponse) else got
        return JSONResponse(out)

    @app.get("/api/p/{pid}/runs/groups")
    def runs_groups(pid: str, by: str = "origin,name", origin: str = "", name: str = "",
                    status: str = "", since: str = "", until: str = "", runbook: str = "",
                    runbook_run: str = "", job_run: str = "") -> JSONResponse:
        """Runs counted per group (``by`` = comma-separated fields)."""
        pr = _runs(pid)
        if pr is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        where = _filter_from({k: v for k, v in dict(origin=origin, name=name, status=status,
                              since=since, until=until, runbook_run=runbook_run,
                              job_run=job_run).items() if v})
        if runbook:
            where.metadata["runbook"] = runbook
        try:
            return JSONResponse({"groups": pr.store.groups(where, by=[b for b in by.split(",") if b])})
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    @app.get("/api/p/{pid}/runs/origins")
    def runs_origins(pid: str, since: str = "", until: str = "") -> JSONResponse:
        got = _origins(pid, since, until)
        return got if isinstance(got, JSONResponse) else JSONResponse(got)

    def _origins(pid: str, since: str = "", until: str = "") -> Any:
        """The Runs screen's tree: every service, job, runbook the
        application declares (so an idle one still shows, with 0), plus
        whatever the store holds beyond them, counted in the range."""
        watcher = _watcher(pid)
        pr = _runs(pid)
        if pr is None or watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        where = _filter_from({k: v for k, v in dict(since=since, until=until).items() if v})
        try:
            counted = pr.store.groups(where, by=["origin", "name"])
            books = pr.store.groups(RunFilter(origin="job", since=where.since, until=where.until),
                                    by=["runbook", "runbook_run"])
        except Exception as exc:  # noqa: BLE001 — a store that cannot answer says so
            return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=502)
        result = watcher.refresh_swr()
        ir = result.ir if result.ok else {}

        def blank(name: str, **extra: Any) -> Dict[str, Any]:
            return {"name": name, "runs": 0, "errors": 0, "last_started": None, **extra}

        folders: Dict[str, Dict[str, Dict[str, Any]]] = {o: {} for o in
                                                        ("service", "job", "eval", "playground", "adhoc")}
        for sv in (ir or {}).get("services") or []:
            if sv.get("kind") == "asgi":
                continue
            folders["service"][sv["name"]] = blank(sv["name"], kind=sv.get("kind"), path=sv.get("path"))
        runbooks: Dict[str, Dict[str, Any]] = {}
        for j in (ir or {}).get("jobs") or []:
            if j.get("kind") == "runbook":
                runbooks[j["name"]] = blank(j["name"], schedule=j.get("schedule"))
            else:
                folders["job"][j["name"]] = blank(j["name"], session=j.get("session"))
        for g in counted:
            origin = g["origin"] if g["origin"] in folders else "adhoc"
            row = folders[origin].setdefault(g["name"] or "?", blank(g["name"] or "?"))
            row.update(runs=row["runs"] + g["runs"], errors=row["errors"] + g["errors"],
                       last_started=max(x for x in (row["last_started"], g["last_started"]) if x is not None))
        for g in books:  # a runbook counts its RUNS (each groups many traces)
            if not g.get("runbook"):
                continue
            row = runbooks.setdefault(g["runbook"], blank(g["runbook"]))
            row.update(runs=row["runs"] + 1, errors=row["errors"] + (1 if g["errors"] else 0),
                       traces=row.get("traces", 0) + g["runs"],
                       last_started=max(x for x in (row["last_started"], g["last_started"]) if x is not None))
        total = sum(g["runs"] for g in counted)
        return {
            "total": total,
            "errors": sum(g["errors"] for g in counted),
            "services": list(folders["service"].values()),
            "jobs": list(folders["job"].values()),
            "evals": list(folders["eval"].values()),
            "runbooks": list(runbooks.values()),
            "playground": list(folders["playground"].values()),
            "adhoc": list(folders["adhoc"].values()),
            "source": pr.source,
        }

    @app.get("/api/p/{pid}/monitor")
    def monitor_view(pid: str, origin: str = "", name: str = "", since: str = "", until: str = "",
                     buckets: int = 24, playground: int = 1) -> JSONResponse:
        """One service's or job's health over a range (see monitor.py); a
        service's playground sessions are counted in unless ``playground=0``."""
        from operonx_studio.monitor import monitor

        watcher = _watcher(pid)
        pr = _runs(pid)
        if pr is None or watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        key_ops: List[str] = []
        if origin == "service" and name:
            result = watcher.refresh_swr()
            for sv in ((result.ir or {}) if result.ok else {}).get("services") or []:
                if sv.get("name") == name:
                    key_ops = list(sv.get("key_ops") or [])
        try:
            data = monitor(pr.store, origin=origin or None, name=name or None,
                           since=float(since) if since else None, until=float(until) if until else None,
                           buckets=buckets, key_ops=key_ops, with_playground=bool(playground))
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        data["key_ops"] = key_ops
        return JSONResponse(data)

    @app.get("/api/p/{pid}/trace/{run}")
    def trace(pid: str, run: str) -> JSONResponse:
        got = _record(pid, run)
        if isinstance(got, JSONResponse):
            return got
        rows, rec = got
        out = _summarise_run(rows, run)
        out["summary"] = rec.summary.to_dict()
        return JSONResponse(out)

    @app.post("/api/p/{pid}/trace/{run}/delete")
    def trace_delete(pid: str, run: str) -> JSONResponse:
        """Remove one recorded run. Langfuse rows live on someone else's
        server — the studio never reaches into those."""
        if run.startswith(LF_PREFIX):
            return JSONResponse({"error": "langfuse traces are read-only here"}, status_code=400)
        pr = _runs(pid)
        if pr is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        if not pr.store.delete_runs(RunFilter(trace_ids=[run])):
            return JSONResponse({"error": "no such run"}, status_code=404)
        return JSONResponse({"ok": True})

    @app.get("/api/p/{pid}/trace/{run}/flow")
    def trace_flow(pid: str, run: str) -> JSONResponse:
        """Every execution, light — timing, ctx, status, provenance."""
        got = _record(pid, run)
        return got if isinstance(got, JSONResponse) else JSONResponse(_flow_records(got[0], run))

    def _rollups_of(rows, rec) -> List[Dict[str, Any]]:
        """Per-op numbers for one run — operonx's own `summarize`, so the
        run view and the store's rollups can never disagree."""
        from operonx.telemetry.runs import summarize

        _, rolls = summarize(rec.summary.trace_id, rows, rec.meta)
        out = []
        for r in sorted(rolls, key=lambda r: -r.total_ms):
            d = r.to_dict()
            d.pop("samples", None)
            out.append(d)
        return out

    @app.get("/api/p/{pid}/trace/{run}/tree")
    def trace_tree(pid: str, run: str) -> JSONResponse:
        """The run as a tree (operonx's ctx rules), with its summary and
        per-op rollups — what the run header and the lenses read."""
        got = _record(pid, run)
        if isinstance(got, JSONResponse):
            return got
        out = _tree_records(got[0], run)
        out["summary"] = got[1].summary.to_dict()
        out["rollups"] = _rollups_of(got[0], got[1])
        return JSONResponse(out)

    @app.get("/api/p/{pid}/compare")
    def compare_runs(pid: str, a: str, b: str) -> JSONResponse:
        """Two runs side by side: each summary, and per op the time and
        cost in each and the difference — ops that ran in only one show
        with the other side empty."""
        sides = []
        for run in (a, b):
            got = _record(pid, run)
            if isinstance(got, JSONResponse):
                return got
            sides.append((got[1].summary.to_dict(), {r["op"]: r for r in _rollups_of(*got)}))
        (sa, ra), (sb, rb) = sides
        ops = []
        for op in sorted(set(ra) | set(rb), key=lambda o: -max(ra.get(o, {}).get("total_ms", 0),
                                                              rb.get(o, {}).get("total_ms", 0))):
            x, y = ra.get(op), rb.get(op)
            row: Dict[str, Any] = {"op": op, "a": x, "b": y}
            if x and y:
                row["d_ms"] = y["total_ms"] - x["total_ms"]
                row["d_count"] = y["count"] - x["count"]
                # a cost change needs both prices: unpriced is unknown, not $0
                if x.get("cost_usd") is not None and y.get("cost_usd") is not None:
                    row["d_cost"] = y["cost_usd"] - x["cost_usd"]
            ops.append(row)
        return JSONResponse({"a": sa, "b": sb, "ops": ops,
                             "d_ms": (sb["duration_ms"] or 0) - (sa["duration_ms"] or 0)})

    @app.get("/api/p/{pid}/trace/{run}/timeline")
    def trace_timeline(pid: str, run: str) -> JSONResponse:
        """The run as a waterfall: every execution's offset and duration."""
        got = _record(pid, run)
        if isinstance(got, JSONResponse):
            return got
        spans: List[Dict[str, Any]] = []
        t0 = None
        for rec in got[0]:
            start = rec.get("start_time")
            if start is None:
                continue
            start = float(start)
            t0 = start if t0 is None else min(t0, start)
            spans.append({
                "op": rec.get("op_name") or rec.get("op_full_name") or "?",
                "start": start,
                "dur_ms": float(rec.get("duration_ms") or 0.0),
                "status": rec.get("status") or "ok",
                "error": rec.get("error"),
            })
        spans.sort(key=lambda s: s["start"])
        for s in spans:
            s["start"] = round(s.pop("start") - (t0 or 0.0), 4)
        return JSONResponse({"run": run, "total": len(spans), "spans": spans[:3000]})

    @app.get("/api/p/{pid}/trace/{run}/op/{op_name}")
    def trace_op(pid: str, run: str, op_name: str, limit: int = 50) -> JSONResponse:
        """One op's executions in one run, with recorded inputs and outputs."""
        got = _record(pid, run)
        if isinstance(got, JSONResponse):
            return got
        return JSONResponse(_op_executions(got[0], run, op_name, limit=max(1, min(limit, 200))))

    # ── resources: prices ────────────────────────────────────────────────

    @app.post("/api/p/{pid}/resources/price")
    def resource_price(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Set an LLM resource's prices (USD per 1M tokens in / out) in the
        project's resources file. ``apply`` false (the default) returns the
        diff only — the page shows it before anything is written."""
        import difflib

        from operonx_studio.yamledit import YamlEditError, set_fields

        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        name = str(body.get("resource") or "")
        try:
            per_in = float(body.get("input_per_1m"))
            per_out = float(body.get("output_per_1m"))
        except (TypeError, ValueError):
            return JSONResponse({"error": "prices must be numbers (USD per 1M tokens)"}, status_code=400)
        if per_in < 0 or per_out < 0:
            return JSONResponse({"error": "prices cannot be negative"}, status_code=400)
        overlay = ((_studio_manifest(watcher.root).get("resources") or {}).get("overlay")
                   or "resources.yaml")
        path = watcher.root / str(overlay)
        if not path.is_file():
            return JSONResponse({"error": f"no resources file at {path}"}, status_code=404)
        text = path.read_text(encoding="utf-8")
        fields = {"cost_per_input_token": _per_token(per_in), "cost_per_output_token": _per_token(per_out)}
        try:
            new = set_fields(text, "llm", name, fields)
        except YamlEditError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        diff = "".join(difflib.unified_diff(text.splitlines(keepends=True), new.splitlines(keepends=True),
                                            fromfile=str(overlay), tofile=str(overlay), n=2))
        applied = False
        if body.get("apply") and new != text:
            path.write_text(new, encoding="utf-8")
            applied = True
        return JSONResponse({"file": str(path), "diff": diff, "changed": new != text, "applied": applied,
                             "fields": fields})

    # ── settings: retention ──────────────────────────────────────────────

    @app.get("/api/p/{pid}/settings")
    def settings(pid: str) -> JSONResponse:
        """What Settings shows: where runs are kept and for how long."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        pr = project_runs(watcher.root)  # the first open sweeps, as every route's does
        return JSONResponse({
            "store": pr.source,
            "backend": pr.spec.get("backend"),
            "writable": pr.store.writable,
            "langfuse": pr.remote.config.get("host") if pr.remote is not None else None,
            "retention": read_retention(watcher.root),
            "last_sweep": pr.last_sweep,
            "swept_at": pr.swept_at or None,
            "runs": pr.store.count(),
            # what the current policy would delete, so the screen needs no
            # second round trip to say so
            "preview": _retention_preview(watcher, _policy_from({"retention": read_retention(watcher.root)})),
        })

    def _policy_from(body: Dict[str, Any]) -> Dict[str, Optional[float]]:
        raw = body.get("retention") or {}
        policy: Dict[str, Optional[float]] = {}
        for origin, value in raw.items():
            if value is None or value == "forever":
                policy[origin] = None
            else:
                days = float(value)
                if days < 0:
                    raise ValueError(f"{origin}: days must be 0 or more")
                policy[origin] = days
        return policy

    @app.post("/api/p/{pid}/settings/retention/preview")
    def retention_preview(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """How many runs, and how much disk, a policy would free — before
        anything is saved or deleted."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        try:
            policy = _policy_from(body)
        except (TypeError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"preview": _retention_preview(watcher, policy)})

    def _retention_preview(watcher: ProjectWatcher, policy: Dict[str, Optional[float]]) -> Dict[str, Any]:
        pr = project_runs(watcher.root, sweep=False)
        now = time.time()
        out: Dict[str, Any] = {}
        for origin, days in policy.items():
            if days is None:
                out[origin] = {"runs": 0, "bytes": 0}
                continue
            where = RunFilter(origin=origin, until=now - days * 86400.0)
            runs, size, cursor = 0, 0, None
            while True:
                page = pr.store.list_runs(where, limit=500, cursor=cursor)
                for s in page.items:
                    runs += 1
                    if s.location and pr.spec.get("backend") == "files":
                        size += _dir_size(Path(pr.spec["root"]) / s.location)
                cursor = page.next_cursor
                if not cursor:
                    break
            out[origin] = {"runs": runs, "bytes": size}
        return out

    @app.post("/api/p/{pid}/settings/retention")
    def retention_save(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Save the policy to operonx.toml and apply it now."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        try:
            policy = {**read_retention(watcher.root), **_policy_from(body)}
            write_retention(watcher.root, policy)
        except (TypeError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        except OSError as exc:
            return JSONResponse({"error": f"could not write operonx.toml: {exc}"}, status_code=500)
        pr = project_runs(watcher.root, sweep=False)
        deleted = pr.sweep(force=True)
        return JSONResponse({"retention": read_retention(watcher.root), "deleted": deleted})

    # ── the assistant ───────────────────────────────────────────────────
    # The ✦ panel is a real Claude Code session on this machine (chat.py
    # spawns the CLI headless). The studio's contribution is context: the
    # packaged operonx knowledge doc plus the briefing built here — who
    # the project is, its graphs and op kinds, where the traces live, and
    # a fresh IR dump the agent can read instead of re-deriving structure.

    def _chat_briefing(pid: str) -> tuple[Optional[Path], str]:
        watcher, ref = _watcher(pid), recents.get(pid)
        if watcher is None or ref is None:
            return None, ""
        lines = [f"# Project briefing: {ref.name}",
                 f"Root (your working directory): {watcher.root}"]
        pr = project_runs(watcher.root, sweep=False)
        lines.append(f"Runs are kept in: {pr.source} "
                     "(operonx.telemetry.runs.open_run_store; run directories hold nodes.jsonl)")
        lines.append(
            "\n## Working in the studio\n"
            "You have studio tools (mcp__studio__*): list_runs, open_run, op_values, monitor, "
            "compare_runs, select_op, run_job, rerun_op, play, run_eval, set_llm_price. Prefer them to reading "
            "run files: they answer from the run store, and what you open appears on the user's screen.\n"
            "To check a change: rerun_op re-runs the op a recorded run failed or was slow in, in the "
            "current code; play drives a service through its real door like a client would; run_eval runs an "
            "eval and reports pass rate before → after with the cases that flipped. Evals are "
            "operonx.app.evals.Eval (a job with a dataset and evaluators); datasets are JSONL files under "
            "datasets/ ({\"id\", \"input\", \"expected\", \"tags\"} per line) you may add cases to.\n"
            "In your replies, link to studio things with markdown links the page turns into buttons: "
            "[text](studio:run/<run id>), [text](studio:op/<op name>), [text](studio:tab/<flow|traces|"
            "monitor|jobs|resources|settings>), [text](studio:monitor/<service|job>/<name>), "
            "[text](studio:eval/<eval name>). "
            "Name runs and ops by link rather than pasting ids.\n"
            "Code edits you make are shown to the user as a diff with Keep / Undo; keep each turn's "
            "change focused. After changing code, check it (tests, a job run, or the relevant run) and "
            "report the numbers before and after.")
        result = watcher.refresh_swr()
        if result.ok and result.ir:
            import tempfile

            dump = Path(tempfile.gettempdir()) / "operonx-studio" / f"{pid}-ir.json"
            try:
                dump.parent.mkdir(parents=True, exist_ok=True)
                dump.write_text(json.dumps(result.ir), encoding="utf-8")
                lines.append(f"Extracted IR dump (JSON, may lag edits): {dump}")
            except OSError:
                pass
            for g in result.ir.get("graphs") or []:
                ops = ", ".join(
                    f"{n.get('name')}({n.get('kind')})"
                    for n in (g.get("nodes") or [])[:40])
                lines.append(f"Graph `{g.get('name')}`: {ops}")
        elif result.error:
            lines.append(f"NOTE: extraction currently fails: {result.error}")
        return watcher.root, "\n".join(lines)

    # ── jobs: the records the jobs already write, and a way to start one ──
    # The studio reads `run.json` / `items.jsonl` under each job's record_dir
    # — nothing else — and starts a job the way a cron would: `operonx-run
    # <name>` under the project's own interpreter, detached, its output in
    # a log beside the records. It never imports the project.

    def _jobs_of(watcher: ProjectWatcher) -> List[Dict[str, Any]]:
        result = watcher.refresh_swr()
        return list((result.ir or {}).get("jobs") or []) if result.ok else []

    def _job(watcher: ProjectWatcher, name: str) -> Optional[Dict[str, Any]]:
        return next((j for j in _jobs_of(watcher) if j.get("name") == name), None)

    def _job_runs(job: Dict[str, Any]) -> List[Dict[str, Any]]:
        base = Path(job["record_dir"]) / job["name"]
        runs: List[Dict[str, Any]] = []
        if not base.is_dir():
            return runs
        for entry in sorted(base.iterdir(), reverse=True):
            meta = entry / "run.json"
            if not entry.is_dir() or not meta.is_file():
                continue
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            data["path"] = str(entry)
            runs.append(data)
        return runs

    def _run_dir(job: Dict[str, Any], run_id: str) -> Optional[Path]:
        if not _RUN_ID.match(run_id):
            return None
        path = Path(job["record_dir"]) / job["name"] / run_id
        return path if (path / "run.json").is_file() else None

    @app.get("/api/p/{pid}/jobs")
    def jobs(pid: str, open: str = "", run: str = "") -> JSONResponse:
        """Every [[job]] with its last run, if any — the Jobs list.

        ``detail`` carries what the screen shows next to the list — the
        opened job's runs and its run (``open``/``run``, else the first
        job and its newest run) — so the screen is one round trip, not
        three (2.3 s through the tunnel, measured)."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        out = []
        runs_of: Dict[str, List[Dict[str, Any]]] = {}
        for job in _jobs_of(watcher):
            runs = runs_of[job["name"]] = _job_runs(job)
            last = runs[0] if runs else None
            out.append({**job, "runs": len(runs),
                        "last": ({k: last.get(k) for k in ("run_id", "status", "started", "ended", "counts")}
                                 if last else None)})
        detail = None
        picked = next((j for j in out if j["name"] == open), out[0] if out else None)
        if picked is not None:
            job = _job(watcher, picked["name"])
            runs = runs_of[picked["name"]]
            shown = next((r for r in runs if r.get("run_id") == run), runs[0] if runs else None)
            one = _job_run_payload(job, shown["run_id"]) if (job and shown) else None
            detail = {"name": picked["name"], "runs": runs,
                      "run_id": shown.get("run_id") if shown else None, "one": one}
        return JSONResponse({"jobs": out, "detail": detail})

    @app.get("/api/p/{pid}/jobs/{name}/runs")
    def job_runs(pid: str, name: str) -> JSONResponse:
        watcher = _watcher(pid)
        job = _job(watcher, name) if watcher else None
        if job is None:
            return JSONResponse({"error": f"unknown job {name!r}"}, status_code=404)
        return JSONResponse({"job": job, "runs": _job_runs(job)})

    @app.get("/api/p/{pid}/jobs/{name}/runs/{run_id}")
    def job_run(pid: str, name: str, run_id: str) -> JSONResponse:
        """One run: run.json plus its items (a job) or its tree (a runbook)."""
        watcher = _watcher(pid)
        job = _job(watcher, name) if watcher else None
        got = _job_run_payload(job, run_id) if job else None
        if got is None:
            return JSONResponse({"error": "unknown run"}, status_code=404)
        return JSONResponse(got)

    def _job_run_payload(job: Dict[str, Any], run_id: str) -> Optional[Dict[str, Any]]:
        path = _run_dir(job, run_id)
        if path is None:
            return None
        data = json.loads((path / "run.json").read_text(encoding="utf-8"))
        items: List[Dict[str, Any]] = []
        items_file = path / "items.jsonl"
        if items_file.is_file():
            with items_file.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        try:
                            items.append(json.loads(line))
                        except ValueError:
                            continue
        log = path / ".studio.log"
        tail = ""
        if log.is_file():
            try:
                tail = log.read_text(encoding="utf-8", errors="replace")[-4000:]
            except OSError:
                tail = ""
        return {"run": data, "items": items, "log": tail, "path": str(path)}

    @app.post("/api/p/{pid}/jobs/{name}/run")
    async def job_start(pid: str, name: str, body: Dict[str, Any]) -> JSONResponse:
        """Start a job the way a cron does: `operonx-run <name>`, detached,
        under the project's interpreter, its output in a log the run page
        shows. The record it writes is what every other route reads."""
        watcher = _watcher(pid)
        job = _job(watcher, name) if watcher else None
        if job is None:
            return JSONResponse({"error": f"unknown job {name!r}"}, status_code=404)
        resume = bool((body or {}).get("resume"))
        if resume and job.get("session") == "stream":
            return JSONResponse({"error": "a stream job cannot resume"}, status_code=400)
        cmd = [watcher.interpreter(), "-m", "operonx.cli.run", name]
        if resume:
            cmd.append("--resume")
        logs = Path(job["record_dir"]) / job["name"] / ".studio"
        logs.mkdir(parents=True, exist_ok=True)
        log = logs / f"{time.strftime('%Y%m%dT%H%M%S')}.log"
        env = dict(os.environ)
        env.setdefault("PYTHONUNBUFFERED", "1")
        with log.open("ab") as fh:
            proc = subprocess.Popen(cmd, cwd=str(watcher.root), stdout=fh, stderr=subprocess.STDOUT,
                                    env=env, start_new_session=True)
        return JSONResponse({"started": name, "pid": proc.pid, "resume": resume, "log": str(log)})

    # ── services control: listeners, up or down, started from here ──────
    from .services import ServiceProcs, listeners_of, probe_port

    procs = ServiceProcs()
    import atexit as _atexit

    _atexit.register(procs.stop_all)  # what the studio started ends with it

    def _listeners(watcher: ProjectWatcher):
        result = watcher.refresh_swr()
        services = [s for s in ((result.ir or {}).get("services") or []) if s.get("kind")]
        return listeners_of(services)

    def _health(host: str, port: int) -> Optional[Dict[str, Any]]:
        """GET /health on a running listener — the admin route most apps mount."""
        import urllib.error
        import urllib.request

        target = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(f"http://{target}:{port}/health", timeout=1.0) as res:
                body = res.read(2000).decode("utf-8", "replace")
                return {"status": res.status, "ms": round((time.perf_counter() - t0) * 1000, 1), "body": body[:300]}
        except urllib.error.HTTPError as exc:
            return {"status": exc.code, "ms": round((time.perf_counter() - t0) * 1000, 1)}
        except Exception:  # noqa: BLE001 — a websocket-only port has no /health, and that is fine
            return None

    @app.get("/api/p/{pid}/services")
    def services_list(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        out = []
        for lst in _listeners(watcher):
            st = procs.state(pid, lst)
            st["detail"] = lst.services
            # only a listener with an http route can have /health; a 404 says it has none
            web = any(x.get("kind") in ("http", "asgi") for x in lst.services)
            health = _health(lst.host, lst.port) if st["running"] and web else None
            st["health"] = health if health and health.get("status") != 404 else None
            out.append(st)
        return JSONResponse({"listeners": out})

    def _listener(pid: str, key: str):
        watcher = _watcher(pid)
        if watcher is None:
            return None, None
        return watcher, next((x for x in _listeners(watcher) if x.key == key), None)

    @app.post("/api/p/{pid}/services/start")
    def services_start(pid: str, body: Dict[str, Any]) -> JSONResponse:
        watcher, lst = _listener(pid, str(body.get("key") or ""))
        if lst is None:
            return JSONResponse({"error": "no such listener"}, status_code=404)
        try:
            got = procs.start(pid, lst, interpreter=watcher.interpreter(), root=watcher.root,
                              env=watcher._child_env())
        except RuntimeError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        return JSONResponse(got)

    @app.post("/api/p/{pid}/services/stop")
    def services_stop(pid: str, body: Dict[str, Any]) -> JSONResponse:
        key = str(body.get("key") or "")
        if not procs.stop(pid, key):
            return JSONResponse({"error": "the studio did not start anything running there — stop it where "
                                          "it was started"}, status_code=409)
        return JSONResponse({"stopped": key})

    @app.get("/api/p/{pid}/services/log")
    def services_log(pid: str, key: str) -> JSONResponse:
        return JSONResponse({"key": key, "log": procs.log_tail(pid, key)})

    # ── the review queue: runs read as conversations, judged, labelled ──
    from .review import ReviewLog, conversation

    def _reviewer(request: Any) -> str:
        return request.state.user["username"]

    def _egress_ops(watcher: ProjectWatcher) -> set:
        names: set = set()

        def walk(g: Any) -> None:
            for n in (g or {}).get("nodes") or []:
                if n.get("serve_role") == "egress":
                    names.add(n.get("name"))
                walk(n.get("graph"))

        for g in (watcher.refresh_swr().ir or {}).get("graphs") or []:
            walk(g)
        return names

    @app.get("/api/p/{pid}/review/queue")
    def review_queue(pid: str, origin: str = "", name: str = "", status: str = "", verdict: str = "unreviewed",
                     label: str = "", limit: int = 50, open: str = "") -> JSONResponse:
        """Runs to read, newest first, with their reviews; ``verdict`` is
        unreviewed | good | bad | all. ``detail`` is the conversation the
        screen opens (``open`` if it is in the queue, else the first): one
        round trip instead of two."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        pr = project_runs(watcher.root)
        f = RunFilter(origin=origin or None, name=name or None, status=status or None)
        page = pr.store.list_runs(f, "started_desc", 500, None)
        reviews = ReviewLog(watcher.root).latest()
        out, counts = [], {"unreviewed": 0, "good": 0, "bad": 0}
        for s in page.items:
            rev = reviews.get(s.trace_id)
            v = (rev or {}).get("verdict")
            counts["unreviewed" if not v else v] += 1
            if verdict == "unreviewed" and v:
                continue
            if verdict in ("good", "bad") and v != verdict:
                continue
            if label and label not in ((rev or {}).get("labels") or []):
                continue
            out.append({**_row(s), "review": rev})
        shown = out[: max(1, min(limit, 500))]
        detail = None
        first = next((r for r in shown if r["run"] == open), shown[0] if shown else None)
        if first is not None:
            got = _review_payload(pid, watcher, first["run"])
            if not isinstance(got, JSONResponse):
                detail = {"run": first["run"], **got}
        return JSONResponse({"runs": shown, "counts": counts, "total": page.total, "detail": detail})

    def _review_payload(pid: str, watcher: ProjectWatcher, run: str) -> Any:
        got = _record(pid, run)
        if isinstance(got, JSONResponse):
            return got
        rows, rec = got
        return {"summary": _row(rec.summary),
                "turns": conversation(rows, rec.summary.metadata or {}, _egress_ops(watcher)),
                "review": ReviewLog(watcher.root).get(run)}

    @app.get("/api/p/{pid}/review/run/{run}")
    def review_run(pid: str, run: str) -> JSONResponse:
        watcher = _watcher(pid)
        got = _review_payload(pid, watcher, run)
        return got if isinstance(got, JSONResponse) else JSONResponse(got)

    @app.post("/api/p/{pid}/review/run/{run}")
    def review_save(pid: str, run: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        labels = body.get("labels") or []
        if isinstance(labels, str):
            labels = [x for x in labels.split(",")]
        try:
            rec = ReviewLog(watcher.root).put(run, verdict=body.get("verdict") or None, labels=labels,
                                              note=str(body.get("note") or ""), user=_reviewer(request))
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(rec)

    @app.post("/api/p/{pid}/review/run/{run}/dataset")
    def review_to_dataset(pid: str, run: str, body: Dict[str, Any]) -> JSONResponse:
        """A reviewed run becomes a case: what the user said is the input;
        the review's labels and note ride along. The expected output is left
        for whoever fixes it — a bad answer is not one."""
        from operonx.app.evals import Dataset

        watcher = _watcher(pid)
        name = str(body.get("dataset") or "")
        if watcher is None or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name):
            return JSONResponse({"error": "a dataset name is letters, digits, _ . -"}, status_code=400)
        got = _record(pid, run)
        if isinstance(got, JSONResponse):
            return got
        rows, rec = got
        said = [t["text"] for t in conversation(rows, rec.summary.metadata or {}, _egress_ops(watcher))
                if t["who"] == "user"]
        if not said:
            return JSONResponse({"error": "nothing the user said was recorded in this run"}, status_code=400)
        review = ReviewLog(watcher.root).get(run) or {}
        row: Dict[str, Any] = {"input": said[0] if len(said) == 1 else said,
                               "tags": sorted(set((review.get("labels") or []) + ([f"review:{review['verdict']}"]
                                                                                   if review.get("verdict") else []))),
                               "from": {"run": run, "origin": rec.summary.origin, "name": rec.summary.name}}
        if review.get("note"):
            row["note"] = review["note"]
        found = next((d for d in _datasets(watcher) if d["name"] == name), None)
        path = Path(found["path"]) if found else watcher.root / "datasets" / f"{name}.jsonl"
        added = Dataset(path).add([row])
        return JSONResponse({"added": added, "path": str(path)})

    # ── the prompt workbench: an LLM op's prompt, tried on real inputs ──
    # Samples are the op's recorded executions. An input with the same
    # value in every sample is the prompt (editable); one that varies is
    # the case's data. Trying an edit is re-running the op (the playground
    # bridge) with it; saving writes it back where the text lives, when it
    # lives there verbatim — otherwise the assistant is asked to.

    PROMPT_SUFFIXES = {".yaml", ".yml", ".py", ".txt", ".md", ".json", ".jinja", ".j2", ".toml"}

    @app.get("/api/p/{pid}/prompts/{op}/samples")
    def prompt_samples(pid: str, op: str, limit: int = 20) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        pr = project_runs(watcher.root)
        samples: List[Dict[str, Any]] = []
        cursor = None
        for _ in range(20):  # pages of runs, newest first, until enough samples
            page = pr.store.list_runs(None, "started_desc", 100, cursor)
            for s in page.items:
                if s.origin not in ("service", "job", "playground", "eval") or not (s.service or s.job):
                    continue
                if (s.metadata or {}).get("toy") == "rerun":
                    continue  # the workbench's own tries are not samples of real inputs
                if not any(r.op == op for r in pr.store.rollups(RunFilter(trace_ids=[s.trace_id]))):
                    continue
                rec = pr.store.get_run(s.trace_id)
                for row in (rec.nodes if rec else []):
                    if row.get("op_name") != op:
                        continue
                    outs = row.get("outputs") or {}
                    samples.append({"run": s.trace_id, "origin": s.origin, "name": s.name, "started": s.started_at,
                                    "inputs": row.get("inputs") or {}, "status": row.get("status") or "ok",
                                    "error": row.get("error"),
                                    "content": outs.get("content"), "usage": outs.get("usage"),
                                    "cost_usd": outs.get("cost_usd"), "duration_ms": row.get("duration_ms")})
                    break
                if len(samples) >= limit:
                    break
            cursor = page.next_cursor
            if len(samples) >= limit or not cursor:
                break

        def placeholder(v: Any) -> bool:
            return isinstance(v, str) and v.startswith("<") and v.endswith(">")

        keys = sorted({k for smp in samples for k in smp["inputs"]})
        constant, varying = {}, []
        for k in keys:
            vals = [smp["inputs"].get(k) for smp in samples]
            if all(json.dumps(x, sort_keys=True, default=str) == json.dumps(vals[0], sort_keys=True, default=str)
                   for x in vals) and not placeholder(vals[0]):
                constant[k] = vals[0]
            else:
                varying.append(k)
        return JSONResponse({"op": op, "samples": samples, "constant": constant, "varying": varying})

    @app.post("/api/p/{pid}/prompts/save")
    def prompt_save(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Write an edited prompt back where the original text lives — found
        verbatim in exactly one project file; ``apply`` false (the default)
        answers with the diff."""
        import difflib

        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        original, updated = str(body.get("original") or ""), str(body.get("updated") or "")
        if len(original.strip()) < 8 or original == updated:
            return JSONResponse({"error": "nothing to save"}, status_code=400)
        from .daemon import SKIP_DIRS

        def candidates():
            # prompts live in text files the watcher does not track (.txt, .md, .j2…)
            for dirpath, dirnames, filenames in os.walk(watcher.root):
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
                for fname in filenames:
                    path = Path(dirpath) / fname
                    if path.suffix in PROMPT_SUFFIXES and path.stat().st_size < 2_000_000:
                        yield path

        hits = []
        for path in sorted(candidates()):
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            n = text.count(original)
            if n:
                hits.append((path, text, n))
        if len(hits) != 1 or hits[0][2] != 1:
            where = ", ".join(str(h[0].relative_to(watcher.root)) for h in hits) or "no file"
            return JSONResponse({"error": f"the prompt's text is not in exactly one place verbatim ({where})",
                                 "found": [str(h[0].relative_to(watcher.root)) for h in hits]}, status_code=409)
        path, text, _ = hits[0]
        new = text.replace(original, updated, 1)
        rel = str(path.relative_to(watcher.root))
        diff = "".join(difflib.unified_diff(text.splitlines(True), new.splitlines(True), f"a/{rel}", f"b/{rel}"))
        if body.get("apply"):
            path.write_text(new, encoding="utf-8")
        return JSONResponse({"file": rel, "diff": diff, "applied": bool(body.get("apply"))})

    # ── alerts: thresholds per service or job, checked in the background ──
    # The rules live in the project (.operonx/alerts.json) and their last
    # state beside them; operonx.telemetry.runs.alerts does the judging from
    # the run store's summaries. Webhooks are only ever called by a rule the
    # user wrote, or by the Test button.
    from operonx.telemetry.runs.alerts import (
        METRICS,
        Alert,
        AlertState,
        deliver,
        evaluate,
        message,
        step,
    )

    def _alerts_file(root: Path) -> Path:
        return root / ".operonx" / "alerts.json"

    def _alerts(root: Path) -> List[Alert]:
        f = _alerts_file(root)
        if not f.is_file():
            return []
        try:
            return [Alert.from_dict(d) for d in json.loads(f.read_text(encoding="utf-8")).get("alerts") or []]
        except (ValueError, TypeError):
            return []

    def _save_alerts(root: Path, alerts: List[Alert]) -> None:
        f = _alerts_file(root)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"alerts": [a.to_dict() for a in alerts]}, indent=2), encoding="utf-8")

    def _states(root: Path) -> Dict[str, AlertState]:
        f = root / ".operonx" / "alerts-state.json"
        try:
            raw = json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}
            return {k: AlertState(**v) for k, v in raw.items()}
        except (ValueError, TypeError):
            return {}

    def _save_states(root: Path, states: Dict[str, AlertState]) -> None:
        import dataclasses

        f = root / ".operonx" / "alerts-state.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({k: dataclasses.asdict(v) for k, v in states.items()}, indent=2), encoding="utf-8")

    def _project_name(pid: str, watcher: ProjectWatcher) -> str:
        ref = recents.get(pid)
        return ref.name if ref is not None and ref.name else watcher.root.name

    def _check_project(pid: str, now: Optional[float] = None) -> List[Dict[str, Any]]:
        """Evaluate every enabled rule, send what changed, keep the state."""
        watcher = _watcher(pid)
        if watcher is None:
            return []
        rules = [a for a in _alerts(watcher.root) if a.enabled]
        if not rules:
            return []
        store = project_runs(watcher.root, sweep=False).store
        states = _states(watcher.root)
        base = os.environ.get("OPERONX_STUDIO_URL", "").rstrip("/")
        sent = []
        for a in rules:
            cur = evaluate(store, a, now)
            kind = step(a, states.get(a.name), cur)
            states[a.name] = cur
            if kind and a.webhook:
                link = f"{base}/p/{pid}" if base else ""
                try:
                    code = deliver(a.webhook, message(a, cur, kind, project=_project_name(pid, watcher), link=link))
                    sent.append({"alert": a.name, "kind": kind, "status": code})
                except Exception as exc:  # noqa: BLE001 — a dead webhook is reported, the check goes on
                    cur.extra["delivery_error"] = f"{type(exc).__name__}: {exc}"
                    sent.append({"alert": a.name, "kind": kind, "error": str(exc)})
        _save_states(watcher.root, states)
        return sent

    if os.environ.get("OPERONX_STUDIO_ALERTS", "on").lower() != "off":
        import threading as _threading

        def _alert_loop() -> None:
            while True:
                time.sleep(60)
                for ref in list(recents.ordered()):
                    try:
                        _check_project(ref.id)
                    except Exception:  # noqa: BLE001 — one project's trouble never stops the others
                        pass

        _threading.Thread(target=_alert_loop, name="studio-alerts", daemon=True).start()

    @app.get("/api/p/{pid}/alerts")
    def alerts_list(pid: str) -> JSONResponse:
        """Every rule with its number right now and what was last sent."""
        import dataclasses

        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        store = project_runs(watcher.root, sweep=False).store
        states = _states(watcher.root)
        out = []
        for a in _alerts(watcher.root):
            now = dataclasses.asdict(evaluate(store, a))
            last = states.get(a.name)
            out.append({**a.to_dict(), "webhook_set": bool(a.webhook), "webhook": _mask(a.webhook), "now": now,
                        "last": dataclasses.asdict(last) if last else None})
        return JSONResponse({"alerts": out, "metrics": list(METRICS)})

    def _mask(url: str) -> str:
        """A webhook URL is a secret: show where it goes, not its token."""
        if not url:
            return ""
        from urllib.parse import urlsplit

        u = urlsplit(url)
        return f"{u.scheme}://{u.netloc}/…" if u.path.strip("/") else f"{u.scheme}://{u.netloc}"

    @app.post("/api/p/{pid}/alerts")
    def alerts_save(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Create or replace a rule by name; ``webhook`` left out keeps the one it had."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        name = str(body.get("name") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_. -]{1,60}", name):
            return JSONResponse({"error": "an alert's name is letters, digits, spaces, _ . -"}, status_code=400)
        rules = _alerts(watcher.root)
        old = next((a for a in rules if a.name == name), None)
        data = {k: v for k, v in body.items() if k != "webhook" or v}
        if old is not None and not data.get("webhook"):
            data["webhook"] = old.webhook
        if data.get("webhook") and not str(data["webhook"]).startswith(("http://", "https://")):
            return JSONResponse({"error": "a webhook is an http(s) URL"}, status_code=400)
        if not data.get("op"):
            data["op"] = None
        try:
            rule = Alert.from_dict(data)
        except (TypeError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        rules = [a for a in rules if a.name != name] + [rule]
        _save_alerts(watcher.root, rules)
        return JSONResponse({"saved": name})

    @app.delete("/api/p/{pid}/alerts/{name}")
    def alerts_delete(pid: str, name: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        rules = _alerts(watcher.root)
        _save_alerts(watcher.root, [a for a in rules if a.name != name])
        return JSONResponse({"deleted": name})

    @app.post("/api/p/{pid}/alerts/{name}/test")
    def alerts_test(pid: str, name: str) -> JSONResponse:
        """Send a TEST message to the rule's webhook — the user asked to."""
        watcher = _watcher(pid)
        rule = next((a for a in _alerts(watcher.root) if a.name == name), None) if watcher else None
        if rule is None or not rule.webhook:
            return JSONResponse({"error": "no such alert, or it has no webhook"}, status_code=404)
        st = evaluate(project_runs(watcher.root, sweep=False).store, rule)
        try:
            code = deliver(rule.webhook, message(rule, st, "test", project=_project_name(pid, watcher)))
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=502)
        return JSONResponse({"status": code})

    @app.post("/api/p/{pid}/alerts/check")
    def alerts_check(pid: str) -> JSONResponse:
        return JSONResponse({"sent": _check_project(pid)})

    # ── evals and datasets ───────────────────────────────────────────────
    # An eval is a job (operonx.app.evals): its records are job records
    # whose items carry verdicts and whose run.json carries the pass rate.
    # Datasets are JSONL files in the project; the studio reads and appends
    # them with operonx's own Dataset, never a copy of its rules.

    def _dataset_file(root: Path, ref: str) -> Path:
        text = str(ref or "")
        if text.startswith("dataset:"):
            return root / "datasets" / f"{text.partition(':')[2]}.jsonl"
        path = Path(text)
        return path if path.is_absolute() else root / path

    def _datasets(watcher: ProjectWatcher) -> List[Dict[str, Any]]:
        from operonx.app.evals import Dataset

        found: Dict[str, Dict[str, Any]] = {}
        folder = watcher.root / "datasets"
        paths = sorted(folder.glob("*.jsonl")) if folder.is_dir() else []
        evals = [j for j in _jobs_of(watcher) if j.get("kind") == "eval"]
        paths += [_dataset_file(watcher.root, e.get("dataset") or "") for e in evals]
        for path in paths:
            key = str(path.resolve())
            if key in found or not path.name:
                continue
            try:
                rows = Dataset(path).rows()
                error = None
            except ValueError as exc:
                rows, error = [], str(exc)
            tags: Dict[str, int] = {}
            for r in rows:
                for t in r.get("tags") or []:
                    tags[str(t)] = tags.get(str(t), 0) + 1
            found[key] = {"name": path.stem, "path": str(path), "exists": path.is_file(), "cases": len(rows),
                          "expected": sum(1 for r in rows if r.get("expected") is not None), "tags": tags,
                          "error": error,
                          "used_by": [e["name"] for e in evals
                                      if _dataset_file(watcher.root, e.get("dataset") or "").resolve() == path.resolve()]}
        return list(found.values())

    def _eval_runs(job: Dict[str, Any], limit: int = 30) -> List[Dict[str, Any]]:
        return [{k: r.get(k) for k in ("run_id", "status", "started", "ended", "counts", "eval", "error")}
                for r in _job_runs(job)[:limit]]

    @app.get("/api/p/{pid}/evals")
    def evals_list(pid: str, name: str = "", run: str = "", against: str = "") -> JSONResponse:
        """Every eval with its recent runs (newest first), and every dataset.

        ``detail`` is the run the screen opens beside the list (``name`` and
        ``run``, else the first eval's newest finished run): one round trip
        instead of two."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        evals = [{**j, "runs": _eval_runs(j)} for j in _jobs_of(watcher) if j.get("kind") == "eval"]
        detail = None
        picked = next((e for e in evals if e["name"] == name), evals[0] if evals else None)
        if picked is not None:
            done = [r for r in picked["runs"] if r.get("status") != "running"]
            shown = next((r for r in done if r["run_id"] == run), done[0] if done else None)
            job = _job(watcher, picked["name"])
            if shown is not None and job is not None:
                got = _eval_run_payload(job, shown["run_id"], against)
                if got is not None:
                    detail = {"name": picked["name"], "run_id": shown["run_id"], "against_asked": against, **got}
        return JSONResponse({"evals": evals, "datasets": _datasets(watcher), "detail": detail})

    @app.get("/api/p/{pid}/evals/{name}/runs/{run_id}")
    def eval_run(pid: str, name: str, run_id: str, against: str = "") -> JSONResponse:
        """One eval run, case by case, with what changed since *against*
        (by default the run before it): ``fixed`` and ``regressed`` cases."""
        watcher = _watcher(pid)
        job = _job(watcher, name) if watcher else None
        if job is None or job.get("kind") != "eval":
            return JSONResponse({"error": f"unknown eval {name!r}"}, status_code=404)
        got = _eval_run_payload(job, run_id, against)
        if got is None:
            return JSONResponse({"error": "unknown run"}, status_code=404)
        return JSONResponse(got)

    def _eval_run_payload(job: Dict[str, Any], run_id: str, against: str) -> Optional[Dict[str, Any]]:
        runs = _job_runs(job)
        ids = [r["run_id"] for r in runs]
        if run_id not in ids:
            return None

        def items_of(rid: str) -> List[Dict[str, Any]]:
            path = _run_dir(job, rid) if rid else None
            items: List[Dict[str, Any]] = []
            if path is None or not (path / "items.jsonl").is_file():
                return items
            with (path / "items.jsonl").open("r", encoding="utf-8") as fh:
                for line in fh:
                    try:
                        items.append(json.loads(line))
                    except ValueError:
                        continue
            return items

        if not against:
            older = [r for r in runs[ids.index(run_id) + 1:] if r.get("status") != "running"]
            against = older[0]["run_id"] if older else ""
        items = items_of(run_id)
        before = {i["key"]: i for i in items_of(against)} if against in ids else {}
        flips = {}
        for it in items:
            was = before.get(it["key"])
            if was is None or "verdict" not in was or "verdict" not in it:
                continue
            a, b = bool(was["verdict"].get("passed")), bool(it["verdict"].get("passed"))
            if a != b:
                flips[it["key"]] = "fixed" if b else "regressed"
        run = next(r for r in runs if r["run_id"] == run_id)
        prev = next((r for r in runs if r["run_id"] == against), None)
        return {"run": run, "items": items, "against": against or None,
                "against_eval": (prev or {}).get("eval"), "flips": flips,
                "new_cases": [i["key"] for i in items if before and i["key"] not in before]}

    @app.get("/api/p/{pid}/datasets/{name}")
    def dataset_rows(pid: str, name: str, limit: int = 500) -> JSONResponse:
        from operonx.app.evals import Dataset

        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        found = next((d for d in _datasets(watcher) if d["name"] == name), None)
        path = Path(found["path"]) if found else watcher.root / "datasets" / f"{name}.jsonl"
        try:
            rows = Dataset(path).rows()
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        try:
            shown = str(path.resolve().relative_to(watcher.root.resolve()))
        except ValueError:
            shown = str(path)
        return JSONResponse({"name": name, "path": str(path), "shown": shown, "total": len(rows),
                             "rows": rows[: max(1, min(limit, 5000))]})

    @app.post("/api/p/{pid}/datasets/{name}/rows")
    def dataset_add(pid: str, name: str, body: Dict[str, Any]) -> JSONResponse:
        """Append cases (deduped by id). ``from_run`` builds one from a
        recorded playground run: what was sent is the input, and with
        ``expected`` what the door sent back is the expected output."""
        from operonx.app.evals import Dataset

        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", name):
            return JSONResponse({"error": "a dataset name is letters, digits, _ . -"}, status_code=400)
        rows = list(body.get("rows") or [])
        run = str(body.get("from_run") or "")
        if run:
            got = _record(pid, run)
            if isinstance(got, JSONResponse):
                return got
            from operonx_studio.review import sent_script

            md = got[1].summary.metadata or {}
            script = [m for m in sent_script(md) if m.get("kind") in ("text", "json")]
            if len(script) != 1:
                return JSONResponse({"error": "a case is one input: pick a run that sent exactly one "
                                              "message (a multi-turn session is not one case)"}, status_code=400)
            msg = script[0]
            row: Dict[str, Any] = {"input": msg.get("value") if msg["kind"] == "json" else msg.get("text"),
                                   "from": {"run": run, "service": got[1].summary.service}}
            if body.get("expected"):
                egress = set()

                def walk(g: Any) -> None:
                    for n in (g or {}).get("nodes") or []:
                        if n.get("serve_role") == "egress":
                            egress.add(n.get("name"))
                        walk(n.get("graph"))

                for g in (watcher.refresh_swr().ir or {}).get("graphs") or []:
                    walk(g)
                sent = [r.get("inputs", {}).get("item") for r in got[0] if r.get("op_name") in egress]
                sent = [s for s in sent if not (isinstance(s, str) and "transient" in s)]
                if not sent:
                    return JSONResponse({"error": "this run's reply was not recorded, so it can't be the "
                                                  "expected output"}, status_code=400)
                row["expected"] = sent[0] if len(sent) == 1 else sent
            if body.get("tags"):
                row["tags"] = [str(t) for t in body["tags"]]
            rows.append(row)
        if not rows:
            return JSONResponse({"error": "no cases to add"}, status_code=400)
        found = next((d for d in _datasets(watcher) if d["name"] == name), None)
        path = Path(found["path"]) if found else watcher.root / "datasets" / f"{name}.jsonl"
        try:
            added = Dataset(path).add(rows)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"added": added, "path": str(path), "skipped": len(rows) - len(added)})

    # ── the assistant's hands: UI actions and undo ──────────────────────
    # The studio tool server (operonx_studio.mcp) posts what it opened;
    # the page polls and shows it, so the user watches the agent work.
    # keyed by (project, person): what one person's assistant opens shows on
    # that person's screen only (the agent token says whose turn it is)
    ui_actions: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    # bumped whenever something a waiting pulse cares about happens. A
    # plain counter, not an asyncio.Event: an Event binds to one event
    # loop, and a waiter checking an int every 100 ms costs nothing.
    bells: Dict[str, int] = {}

    def _ring(pid: str) -> None:
        bells[pid] = bells.get(pid, 0) + 1

    @app.post("/api/p/{pid}/ui/action")
    async def ui_action(pid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        kind = str(body.get("kind") or "")
        if kind not in ("open_run", "open_monitor", "compare", "select_op", "open_jobs", "open_tab", "open_eval"):
            return JSONResponse({"error": f"unknown action {kind!r}"}, status_code=400)
        queue = ui_actions.setdefault((pid, request.state.user["id"]), [])
        seq = (queue[-1]["seq"] + 1) if queue else 1
        queue.append({"seq": seq, "kind": kind, "args": dict(body.get("args") or {}), "at": time.time()})
        del queue[:-50]
        _ring(pid)
        return JSONResponse({"seq": seq})

    # ── the pulse: one held request per open page ──────────────────────
    # It replaced a /stamp + /ui/actions pair polled every 1.5 s — about
    # 1.2 requests a second per tab, forever, and an assistant action
    # reaching the screen up to 3 s late through the tunnel. The pulse
    # answers as soon as the code changed, the assistant opened
    # something, or (when the page follows the newest run) a run
    # arrived; otherwise after `hold` seconds (under the tunnel's ~10 s
    # cap). File checks are shared: at most one per project per second,
    # however many tabs wait.
    checked: Dict[str, Tuple[float, float, bool]] = {}   # pid -> (monotonic, stamp, ok)

    async def _stamp_now(pid: str, watcher: ProjectWatcher) -> Tuple[float, bool]:
        now = time.monotonic()
        got = checked.get(pid)
        if got is not None and now - got[0] < 1.0:
            return got[1], got[2]
        result = await asyncio.to_thread(watcher.refresh_swr)
        checked[pid] = (time.monotonic(), result.stamp, result.ok)
        return result.stamp, result.ok

    async def _newest_run(pid: str) -> Optional[Dict[str, Any]]:
        def look() -> Optional[Dict[str, Any]]:
            pr = _runs(pid)
            if pr is None:
                return None
            items = pr.store.list_runs(limit=1).items
            if not items:
                return None
            s0 = items[0]
            return {"run": s0.trace_id, "origin": s0.origin, "name": s0.service or s0.job or s0.name,
                    "status": s0.status}
        try:
            return await asyncio.to_thread(look)
        except Exception:  # noqa: BLE001 — following is best-effort
            return None

    @app.get("/api/p/{pid}/pulse")
    async def pulse(request: Request, pid: str, stamp: float = 0.0, ui: int = -1, follow: str = "",
                    chat: Optional[int] = None, hold: float = 8.0) -> JSONResponse:
        """``stamp``: the IR the page has; ``ui``: the last assistant action
        it performed (-1: none yet — answer at once with the latest seq);
        ``follow``: the newest run it knows, when it follows new runs;
        ``chat``: the last assistant turn ending it has heard of (-1: none
        yet — answer at once with the latest; absent: not listening)."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        me = request.state.user["id"]
        end = time.monotonic() + max(0.0, min(hold, 8.0))
        while True:
            rung = bells.get(pid, 0)
            cur, ok = await _stamp_now(pid, watcher)
            queue = ui_actions.get((pid, me), [])
            last = queue[-1]["seq"] if queue else 0
            info = await _newest_run(pid) if follow else None
            newest = info["run"] if info else None
            listening = chat is not None and chat >= 0
            ended = [f for f in relay.finished
                     if f["scope"] == pid and f["seq"] > chat and f.get("owner") == me] if listening else []
            changed = (abs(cur - stamp) > 1e-6 or ui < 0 or last > ui or (follow and newest and newest != follow)
                       or (chat is not None and chat < 0) or bool(ended))
            left = end - time.monotonic()
            if changed or left <= 0:
                return JSONResponse({"stamp": cur, "ok": ok, "ui_last": last,
                                     "actions": [a for a in queue if a["seq"] > ui] if ui >= 0 else [],
                                     "newest": newest, "newest_info": info,
                                     "chat_last": relay.finished_seq, "chat_ended": ended,
                                     "assistant_rate": _rate_of(me),
                                     # a role changed while the page is open reloads it
                                     "role": request.state.user["role"]})
            until = time.monotonic() + min(1.0 if not follow else 2.0, left)
            while time.monotonic() < until and bells.get(pid, 0) == rung:
                await asyncio.sleep(0.1)

    @app.get("/api/p/{pid}/ui/actions")
    def ui_actions_since(request: Request, pid: str, after: int = 0) -> JSONResponse:
        queue = ui_actions.get((pid, request.state.user["id"]), [])
        return JSONResponse({"actions": [a for a in queue if a["seq"] > after],
                             "last": queue[-1]["seq"] if queue else 0})

    @app.post("/api/p/{pid}/chat/undo")
    def chat_undo(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Put back what an assistant turn (or the whole conversation)
        changed: the files as they were in that turn's snapshot."""
        from . import chat as _chat

        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        sha = str(body.get("sha") or "")
        if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
            return JSONResponse({"error": "bad snapshot"}, status_code=400)
        files = [str(f) for f in body.get("files") or [] if ".." not in str(f)]
        new_files = [str(f) for f in body.get("new_files") or [] if ".." not in str(f)]
        done = _chat.undo(watcher.root, sha, files, new_files)
        return JSONResponse({"restored": done})

    # ── the playground: toys on a service's doors ───────────────────────
    # A bridge process per project (operonx.app.play, in the project's own
    # interpreter) runs the sessions; these routes relay to it and the
    # page polls what it says by cursor, like the assistant.
    from .play import BridgeError, Bridges

    play = Bridges()

    async def _play(pid: str):
        watcher = _watcher(pid)
        if watcher is None:
            return None, JSONResponse({"error": "unknown project"}, status_code=404)
        try:
            return await play.get(pid, watcher), None
        except BridgeError as exc:
            bridge = play.peek(pid)
            return None, JSONResponse({"error": str(exc), "log": bridge.status()["log"] if bridge else []},
                                      status_code=503)

    async def _wait_for(bridge: Any, cursor: int, pred, timeout: float) -> List[Dict[str, Any]]:
        """Events from *cursor* until one matches *pred* (or the time is up)."""
        seen: List[Dict[str, Any]] = []
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            got = await bridge.poll(cursor)
            cursor = got["cursor"]
            seen.extend(got["events"])
            if any(pred(e) for e in got["events"]):
                break
        return seen

    def _rerun_target(summary: Any) -> Optional[Dict[str, Any]]:
        """Where a recorded run's graph lives: its service or its job."""
        if summary.job:
            return {"job": summary.job}
        if summary.service:
            return {"service": summary.service, "variant": summary.variant}
        return None

    @app.post("/api/p/{pid}/play/warm")
    async def play_warm(pid: str) -> JSONResponse:
        """Start the project's bridge ahead of the Playground (the page asks
        when the pointer nears the Playground, or a project with doors has
        been open a moment); answers at once."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        return JSONResponse({"state": play.warm(pid, watcher)})

    @app.get("/api/p/{pid}/play/doors")
    async def play_doors(pid: str, service: str = "") -> JSONResponse:
        """The services' doors — plus what the screen asks for next, so it
        opens in one round trip: the event cursor, and the recent sessions
        of ``service`` (else of the first door a toy can drive)."""
        bridge, err = await _play(pid)
        if err is not None:
            return err
        try:
            got = await bridge.ask({"op": "describe"}, timeout=60)
        except (BridgeError, asyncio.TimeoutError) as exc:
            return JSONResponse({"error": str(exc) or "the bridge did not answer",
                                 "log": bridge.status()["log"]}, status_code=503)
        cursor = bridge.base + len(bridge.events)     # past the answer just given
        doors = got.get("doors") or []
        shown = next((d for d in doors if d.get("service") == service), None) \
            or next((d for d in doors if d.get("toys")), doors[0] if doors else None)
        recent = None
        if shown is not None:
            pr = _runs(pid)
            if pr is not None:
                page = await asyncio.to_thread(pr.store.list_runs, RunFilter(origin="playground", name=shown["service"]),
                                               "started_desc", 8)
                recent = {"service": shown["service"], "runs": [_row(r) for r in page.items]}
        return JSONResponse({"doors": doors, "bridge": bridge.status(), "cursor": cursor, "recent": recent})

    @app.get("/api/p/{pid}/play/events")
    async def play_events(pid: str, cursor: Optional[int] = None) -> JSONResponse:
        """What the bridge said since *cursor*; without one, just the cursor."""
        bridge = play.peek(pid)
        if bridge is None:
            return JSONResponse({"events": [], "cursor": 0, "alive": False, "live": []})
        if cursor is None:
            return JSONResponse({"events": [], "cursor": bridge.base + len(bridge.events),
                                 "alive": bridge.alive, "live": sorted(bridge.live)})
        return JSONResponse(await bridge.poll(max(0, int(cursor))))

    @app.post("/api/p/{pid}/play/open")
    async def play_open(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Open a session on a service's door. ``replay_of`` fills the
        service, the connection query and the messages from a recorded run
        — a playground session, or a real one of a service that records
        (``Service(replay=True)``); ``wait`` holds the answer until the
        session ends."""
        import uuid as _uuid

        msg: Dict[str, Any] = {"op": "open", "sid": _uuid.uuid4().hex[:12]}
        replay = str(body.get("replay_of") or "")
        if replay:
            got = _record(pid, replay)
            if isinstance(got, JSONResponse):
                return got
            from operonx_studio.review import sent_query, sent_script

            md = got[1].summary.metadata or {}
            if not ("playground_script" in md or "replay_script" in md) or not got[1].summary.service:
                return JSONResponse({"error": "this run did not record what was sent — a playground session "
                                              "does, and so does a service declared with replay=True"},
                                    status_code=400)
            # text and JSON go again; audio, bytes and oversized messages were only counted
            msg.update({"service": got[1].summary.service, "toy": md.get("toy"),
                        "query": sent_query(md), "variant": got[1].summary.variant,
                        "send": [{k: v for k, v in m.items() if k != "at"} for m in sent_script(md)
                                 if m.get("kind") in ("text", "json")],
                        "end": True, "replay_of": replay})
        for key in ("service", "toy", "variant"):
            if body.get(key):
                msg[key] = str(body[key])
        if isinstance(body.get("conditions"), dict):
            msg["conditions"] = body["conditions"]
        if body.get("remote"):
            msg["remote"] = True
        if isinstance(body.get("query"), dict):
            msg["query"] = {str(k): str(v) for k, v in body["query"].items()}
        if isinstance(body.get("send"), list):
            msg["send"] = body["send"]
        if "end" in body:
            msg["end"] = bool(body["end"])
        if not msg.get("service"):
            return JSONResponse({"error": "which service?"}, status_code=400)
        bridge, err = await _play(pid)
        if err is not None:
            return err
        cursor = bridge.base + len(bridge.events)
        await bridge.send(msg)
        out: Dict[str, Any] = {"sid": msg["sid"], "cursor": cursor}
        if body.get("wait"):
            events = await _wait_for(bridge, cursor, lambda e: e.get("sid") == msg["sid"]
                                     and e.get("t") in ("ended", "refused"), float(body.get("timeout") or 120))
            out["events"] = [e for e in events if e.get("sid") == msg["sid"]]
        return JSONResponse(out)

    @app.post("/api/p/{pid}/play/simulate")
    async def play_simulate(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Simulated users: *count* conversations at once, each an LLM
        persona holding a session for up to *turns* turns. Their messages
        arrive as ``said`` events, the service's as ``out`` events."""
        import uuid as _uuid

        persona, llm = str(body.get("persona") or "").strip(), str(body.get("llm") or "").strip()
        if not persona or not llm or not body.get("service"):
            return JSONResponse({"error": "a simulated user needs a service, a persona and an llm"}, status_code=400)
        count = max(1, min(int(body.get("count") or 1), 10))
        bridge, err = await _play(pid)
        if err is not None:
            return err
        cursor = bridge.base + len(bridge.events)
        sids = []
        for _ in range(count):
            sid = _uuid.uuid4().hex[:12]
            sids.append(sid)
            await bridge.send({"op": "simulate", "sid": sid, "service": str(body["service"]), "persona": persona,
                               "llm": llm, "turns": int(body.get("turns") or 6),
                               "first": "service" if body.get("first") == "service" else "user",
                               "query": body.get("query") if isinstance(body.get("query"), dict) else {},
                               "conditions": body.get("conditions") if isinstance(body.get("conditions"), dict) else {},
                               "remote": bool(body.get("remote")), "quiet_ms": body.get("quiet_ms") or 1200})
        return JSONResponse({"sids": sids, "cursor": cursor})

    @app.post("/api/p/{pid}/play/send")
    async def play_send(pid: str, body: Dict[str, Any]) -> JSONResponse:
        bridge = play.peek(pid)
        sid = str(body.get("sid") or "")
        if bridge is None or sid not in bridge.live:
            return JSONResponse({"error": "no such open session"}, status_code=404)
        msg = body.get("msg")
        if not isinstance(msg, dict) or msg.get("kind") not in ("text", "json", "bytes", "audio"):
            return JSONResponse({"error": "a message is {kind: text|json|bytes|audio, …}"}, status_code=400)
        await bridge.send({"op": "send", "sid": sid, "msg": msg})
        return JSONResponse({"ok": True})

    @app.post("/api/p/{pid}/play/end")
    async def play_end(pid: str, body: Dict[str, Any]) -> JSONResponse:
        bridge = play.peek(pid)
        if bridge is not None and bridge.alive:
            await bridge.send({"op": "end", "sid": str(body.get("sid") or "")})
        return JSONResponse({"ok": True})

    @app.get("/api/p/{pid}/play/rerun-plan")
    def play_rerun_plan(pid: str, run: str, op: str) -> JSONResponse:
        """What re-running *op* of *run* would use: where its graph lives,
        each execution's recorded inputs (values the graph never kept are
        named, so the page asks for them) and what it did then."""
        got = _record(pid, run)
        if isinstance(got, JSONResponse):
            return got
        target = _rerun_target(got[1].summary)
        if target is None:
            return JSONResponse({"error": "this run's graph is not a declared service or job, "
                                          "so there is nothing to re-run it in"}, status_code=400)
        execs = [r for r in got[0] if r.get("op_name") == op]
        if not execs:
            return JSONResponse({"error": f"no op {op!r} in this run"}, status_code=404)

        def missing(value: Any) -> bool:
            return (isinstance(value, str) and value.startswith("<") and "transient" in value) or \
                (isinstance(value, dict) and ("$unserializable" in value or "$media_ref" in value))

        return JSONResponse({"target": target, "op": op, "executions": [{
            "ctx": r.get("ctx"), "inputs": r.get("inputs") or {},
            "missing": sorted(k for k, v in (r.get("inputs") or {}).items() if missing(v)),
            "outputs": r.get("outputs") or {}, "status": r.get("status") or "ok",
            "error": r.get("error"), "duration_ms": r.get("duration_ms"),
        } for r in execs[:50]]})

    @app.post("/api/p/{pid}/play/rerun")
    async def play_rerun(pid: str, body: Dict[str, Any]) -> JSONResponse:
        """Re-run one op with given (or recorded) inputs. ``wait`` returns the
        result; otherwise it arrives as a ``rerun`` event with this ``rid``."""
        import uuid as _uuid

        run, op = str(body.get("run") or ""), str(body.get("op") or "")
        target: Optional[Dict[str, Any]] = None
        inputs = body.get("inputs")
        if run:
            got = _record(pid, run)
            if isinstance(got, JSONResponse):
                return got
            target = _rerun_target(got[1].summary)
            if inputs is None:
                first = next((r for r in got[0] if r.get("op_name") == op), None)
                inputs = (first or {}).get("inputs") or {}
        for key in ("service", "job"):
            if body.get(key):
                target = {key: str(body[key])}
        if target is None or not op:
            return JSONResponse({"error": "re-run needs an op and a run (or a service or job)"}, status_code=400)
        if not isinstance(inputs, dict):
            return JSONResponse({"error": "inputs must be an object"}, status_code=400)
        bridge, err = await _play(pid)
        if err is not None:
            return err
        msg = {"op": "rerun", "id": _uuid.uuid4().hex[:12], "op_name": op, "inputs": inputs,
               "of": run or None, **{k: v for k, v in target.items() if v is not None}}
        if body.get("wait"):
            try:
                return JSONResponse(await bridge.ask(msg, timeout=float(body.get("timeout") or 180)))
            except (BridgeError, asyncio.TimeoutError) as exc:
                return JSONResponse({"error": str(exc) or "the re-run did not finish in time"}, status_code=504)
        await bridge.send(msg)
        return JSONResponse({"rid": msg["id"]})

    @app.post("/api/p/{pid}/play/restart")
    async def play_restart(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        try:
            bridge = await play.restart(pid, watcher)
        except BridgeError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse({"bridge": bridge.status()})

    def _view_lines(view: Any) -> str:
        """What the user is LOOKING at rides along with every message, so
        "why is this slow?" needs no op name typed — the studio knows."""
        if not isinstance(view, dict):
            return ""
        lines = []
        if view.get("node"):
            lines.append(f"- selected op: `{str(view['node'])[:120]}`"
                         + (f" ({str(view.get('kind'))[:40]})" if view.get("kind") else ""))
        if view.get("run"):
            lines.append(f"- run painted on the canvas: `{str(view['run'])[:120]}`")
        if view.get("tab"):
            lines.append(f"- open tab: {str(view['tab'])[:20]}")
        if view.get("lens") and view.get("run"):
            lines.append(f"- the run is painted with the {str(view['lens'])[:12]} lens")
        if view.get("exec"):
            lines.append(f"- selected execution in the run: `{str(view['exec'])[:120]}`")
        if view.get("runs_filter"):
            lines.append(f"- Runs screen filter: {str(view['runs_filter'])[:200]}")
        if view.get("monitor"):
            lines.append(f"- Monitor showing: {str(view['monitor'])[:120]}")
        return ("\n\n## What the user is looking at right now\n" + "\n".join(lines)) if lines else ""

    def _studio_mcp(pid: str, request: Request) -> Dict[str, Any]:
        """The studio's own tools (operonx_studio.mcp), wired to this studio."""
        import sys as _sys

        server = request.scope.get("server") or ("127.0.0.1", 8765)
        host = "127.0.0.1" if server[0] in ("0.0.0.0", "::", None) else server[0]
        # a token for this turn's owner alone, revoked when the turn ends
        # (decision D12); the shared login cookie it replaced never expired
        ttl = (float(os.environ.get("OPERONX_STUDIO_CHAT_MAX_MIN") or 60) + 5) * 60
        token = agents.issue(request.state.user["id"], ttl)
        env = {"OPERONX_STUDIO_URL": f"http://{host}:{server[1]}", "OPERONX_STUDIO_PID": pid,
               "OPERONX_STUDIO_TOKEN": token}
        if os.environ.get("PYTHONPATH"):
            env["PYTHONPATH"] = os.environ["PYTHONPATH"]
        return {"type": "stdio", "command": _sys.executable, "args": ["-m", "operonx_studio.mcp"], "env": env}

    def _busy() -> Optional[JSONResponse]:
        """At most OPERONX_STUDIO_CHAT_MAX_TURNS turns run at once across the
        studio (default 6, decision D14): each is a Claude Code process."""
        try:
            cap = int(os.environ.get("OPERONX_STUDIO_CHAT_MAX_TURNS") or 6)
        except ValueError:
            cap = 6
        if relay.running() >= max(1, cap):
            return JSONResponse({"error": f"The studio is busy — {cap} assistant turns are running. "
                                          "Try again when one ends."}, status_code=429)
        return None

    def _revoker(mcp: Dict[str, Any]):
        """Ends the turn's agent token (run when the turn ends)."""
        token = ((mcp or {}).get("env") or {}).get("OPERONX_STUDIO_TOKEN") or ""
        return lambda: agents.revoke(token)

    def _home_briefing() -> str:
        roster = "\n".join(f"- {r.name}: {r.root}" for r in recents.ordered() if r.exists)
        return ("# Studio briefing\nNo project is open. Projects this studio knows:\n" + (roster or "(none yet)")
                + "\n\nYou have studio tools here too: list_projects, and new_project(name, template, path) "
                "which creates a working project from a template and adds it to the studio. Templates: "
                + "; ".join(f"{t['id']} — {t['title']}: {t['description']}" for t in _templates())
                + "\nLink a project for the user as [name](studio:project/<id>); the page opens it.")

    # ── the assistant: sessions and turns (operonx_studio.assistant) ─────
    # Conversations persist server-side (SQLite beside studio.json), so a
    # reload, another device or a studio restart finds them as they were.
    from fastapi.responses import StreamingResponse

    from .assistant import (
        EFFORTS,
        IMAGE_TYPES,
        MAX_ATTACHMENT_BYTES,
        MAX_ATTACHMENTS,
        MODEL_INFO,
        MODELS,
        ChatStore,
        Relay,
        valid_model,
    )

    chat_store = ChatStore(recents.state_file.parent / "assistant.sqlite")
    app.state.chat_store = chat_store
    # conversations from before owners (or from an auth-off studio) are the
    # first admin's: today's single login is that admin (decision D3)
    _first = users.first_admin()
    chat_store.adopt(_first["id"] if _first else "local")
    relay = Relay(chat_store)
    relay.on_finish = _ring      # a waiting pulse on that project hears it

    def _name_of(uid: Optional[str]) -> str:
        user = users.cached_user(uid) if uid and uid != "local" else None
        return (user or {}).get("name") or (user or {}).get("username") or "someone"

    relay.name_of = _name_of

    def _assistant_changed(turn: Any, files: List[str]) -> None:
        """The assistant's file edits go in the log when its turn ends (§2.6)."""
        users.audit(user=turn.owner, via="assistant", method="EDIT", route="assistant:changes", status=200,
                    pid=turn.scope if turn.scope != "home" else None,
                    detail={"files": [str(f)[:200] for f in files[:50]]})

    relay.on_changes = _assistant_changed
    users.prune_audit()

    def _my_defaults(me: str) -> Dict[str, Any]:
        """A person's own default model and effort. The first admin — today's
        single login — starts from what the studio-wide setting was."""
        got = chat_store.get_meta(f"defaults:{me}", None)
        if got is None:
            first = users.first_admin()
            got = chat_store.get_meta("defaults", {}) if (first and first["id"] == me) or me == "local" else {}
        return dict(got or {})

    def _scope_ok(scope: str) -> bool:
        return scope == "home" or (recents.get(scope) is not None and _watcher(scope) is not None)

    def _scope_name(scope: str) -> str:
        ref = recents.get(scope)
        return "Home" if scope == "home" else (ref.name if ref else scope)

    def _viewer(request: Any) -> bool:
        return request.state.user["role"] == "viewer"

    def _limits(request: Any) -> Dict[str, Any]:
        """How far this person's assistant reaches (§2.5): a viewer's reads,
        whatever OPERONX_STUDIO_CHAT_MODE says, is denied the studio's state,
        ~/.claude and .env files, and gets no project tool servers. The agent
        token carries the role too, so the studio refuses its mutating tools."""
        if not _viewer(request):
            return {}
        from . import chat as _chat_mod

        return {"reach": "read", "deny": _chat_mod.viewer_deny(recents.state_file.parent)}

    def _turn_env(scope: str, view: Any, request: Request) -> Any:
        if scope == "home":
            cwd = Path.home()
            if _viewer(request):
                # never the server's home: an empty directory of their own
                cwd = recents.state_file.parent / "users" / request.state.user["id"] / "home"
                cwd.mkdir(parents=True, exist_ok=True, mode=0o700)
            return cwd, _home_briefing(), _studio_mcp("home", request)
        cwd, context = _chat_briefing(scope)
        if cwd is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        return cwd, context + _view_lines(view or {}), _studio_mcp(scope, request)

    def _project_mcp(scope: str) -> Dict[str, Any]:
        """A project's own tool servers, from its ``.mcp.json``: they join the
        studio's in a turn. The host's personal connectors never do
        (``--strict-mcp-config`` stays on)."""
        owner = _watcher(scope) if scope != "home" else None
        if owner is None:
            return {}
        try:
            raw = json.loads((Path(owner.root) / ".mcp.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        servers = raw.get("mcpServers") if isinstance(raw, dict) else None
        if not isinstance(servers, dict):
            return {}
        return {str(k): v for k, v in servers.items()
                if isinstance(v, dict) and k != "studio" and re.fullmatch(r"[\w-]{1,64}", str(k))}

    def _assistant_defaults(scope: str, me: str) -> Dict[str, Any]:
        """A new conversation's model and effort: the project's
        ``[studio.assistant]`` if it sets them, else the studio's own default
        (the menu's "Use for new conversations"), else the CLI's."""
        studio = _my_defaults(me)
        owner = _watcher(scope) if scope != "home" else None
        project = dict((_studio_table(Path(owner.root)).get("assistant") or {}) if owner is not None else {})
        out = {}
        for key, ok in (("model", valid_model), ("effort", lambda e: e is None or e in EFFORTS)):
            for src in (project, studio):
                v = src.get(key)
                if v and ok(v):
                    out[key] = v
                    break
        return out

    def _session_out(sess: Dict[str, Any]) -> Dict[str, Any]:
        return {**sess, "scope_name": _scope_name(sess["scope"])}

    @app.get("/api/assistant/sessions")
    def assistant_sessions(request: Request, scope: str = "", q: str = "", archived: str = "0",
                           limit: int = 100) -> JSONResponse:
        """Newest first; ``scope`` a project id or ``home`` (empty: every
        scope); ``archived`` 0 | 1 | all; ``q`` searches titles and text."""
        arch = None if archived == "all" else archived in ("1", "true")
        rows = chat_store.sessions(scope or None, owner=request.state.user["id"], q=q, archived=arch, limit=limit)
        return JSONResponse({"sessions": [_session_out(r) for r in rows], "models": list(MODELS)})

    @app.post("/api/assistant/sessions")
    def assistant_new(body: Dict[str, Any], request: Request) -> JSONResponse:
        scope = str(body.get("scope") or "home")
        if not _scope_ok(scope):
            return JSONResponse({"error": "unknown project"}, status_code=404)
        me = request.state.user["id"]
        pick = _assistant_defaults(scope, me)
        model = (body["model"] or None) if "model" in body else pick.get("model")
        effort = (body["effort"] or None) if "effort" in body else pick.get("effort")
        if not valid_model(model):
            return JSONResponse({"error": f"model is one of {', '.join(MODELS)}, or a full claude-… id"}, status_code=400)
        if effort is not None and effort not in EFFORTS:
            return JSONResponse({"error": f"effort is one of {', '.join(EFFORTS)}"}, status_code=400)
        return JSONResponse({"session": _session_out(chat_store.create_session(scope, owner=me, model=model,
                                                                                    effort=effort))})

    @app.get("/api/assistant/models")
    def assistant_models(request: Request, scope: str = "home") -> JSONResponse:
        """What the model menu offers: each model with what it is good for,
        what the CLI resolves it to and its context window (as last seen);
        the effort levels; and the defaults a new conversation takes."""
        resolved = dict(chat_store.get_meta("resolved", {}) or {})
        windows = dict(chat_store.get_meta("windows", {}) or {})
        models = []
        for m in MODEL_INFO:
            full = resolved.get(m["id"]) or m["full"]
            models.append({**m, "full": full, "window": windows.get(full) or m["window"]})
        default_full = resolved.get("default")
        return JSONResponse({"models": models, "efforts": list(EFFORTS),
                             "default": {"full": default_full, "window": windows.get(default_full) if default_full else None},
                             "studio_defaults": _my_defaults(request.state.user["id"]),
                             "new": _assistant_defaults(scope if _scope_ok(scope) else "home",
                                                        request.state.user["id"])})

    # ── each person's Claude sign-in (docs/TEAM_PLAN.md §2.4) ────────────
    # Everyone's assistant runs under their own Claude account, in their own
    # config directory; only the machine login's owner falls back to this
    # machine's login (decision D8). Who that is, their directory and
    # whether it is signed in come from here.

    def _claude_of(uid: str) -> Dict[str, Any]:
        """A person's sign-in: ``{"home": their directory, "machine": may they
        fall back to this machine's login}``. The directory is the one the
        account names (the first admin keeps the single-login one, D3), else
        ``<state>/users/<uid>/claude``."""
        from . import chat as _chat_mod

        row = users.cached_user(uid) if uid != "local" else None
        if row is None:            # auth off with no accounts: the single-login studio
            return {"home": _chat_mod.claude_home(), "machine": True}
        home = Path(row["claude_home"]) if row.get("claude_home") else \
            recents.state_file.parent / "users" / uid / "claude"
        return {"home": home, "machine": bool(row.get("machine_login"))}

    # who a person's Claude runs as: `claude auth status --json`, read at
    # most every 30 s per person (it spawns the CLI)
    _account_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}

    async def _account(me: str, fresh: bool = False) -> Dict[str, Any]:
        """Who *me*'s assistant runs as: their own sign-in (``source: studio``),
        this machine's for its owner (``machine``), or nobody yet (``none``)."""
        got = _account_cache.get(me)
        if not fresh and got is not None and time.monotonic() - got[0] < 30:
            return dict(got[1], login=_login_state(me))
        from . import chat as _chat_mod

        claude = _claude_of(me)
        own = await asyncio.to_thread(_chat_mod.home_signed_in, claude["home"], fresh)
        env = _chat_mod._spawn_env(**claude)
        binary = _chat_mod.find_claude()
        out: Dict[str, Any] = {"logged_in": None}
        if env is None:
            out = {"logged_in": False}
        elif binary is not None:
            try:
                proc = await asyncio.create_subprocess_exec(
                    binary, "auth", "status", "--json", env=env,
                    stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                raw, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
                got_ = json.loads(raw.decode() or "{}")
                # what the card shows; never a token or an id
                out = {"logged_in": bool(got_.get("loggedIn")), "method": got_.get("authMethod"),
                       "email": got_.get("email"), "org": got_.get("orgName"), "plan": got_.get("subscriptionType"),
                       "provider": got_.get("apiProvider")}
            except Exception:  # noqa: BLE001 — no account line is better than a broken card
                out = {"logged_in": None}
        out.update(source="studio" if own else ("machine" if env is not None else "none"),
                   home=str(claude["home"]))
        if own and out.get("email") and me != "local":
            # the Team page shows which Claude account each person uses — never a token
            row = users.cached_user(me)
            if row is not None and row.get("claude_email") != out["email"]:
                users.update(me, claude_email=out["email"])
        _account_cache[me] = (time.monotonic(), out)
        return dict(out, login=_login_state(me))

    def _rate_of(me: str) -> Optional[Dict[str, Any]]:
        """The plan's limits for *me*'s account, as last reported: an
        account's, shared by its conversations — never another person's."""
        from . import chat as _chat_mod

        key = _chat_mod.account_key(**_claude_of(me))
        return chat_store.get_meta(f"last_rate:{key}", None) if key else None

    # ── signing in (docs/ASSISTANT_NEXT_PLAN.md §3, per person since P4) ──
    # `claude auth login` in the person's own config directory, driven over
    # pipes: it prints the sign-in link, then reads the code the page shows
    # after signing in. One at a time per person; ten minutes at most. The
    # code is written to the CLI and never kept or logged; the token stays
    # the CLI's.
    logins: Dict[str, Any] = {}

    # which sign-in the first admin's assistant runs under, known before the
    # first turn needs it (the check spawns the CLI: ~0.5 s)
    import threading as _threading

    from . import chat as _chat_boot

    _first_admin = users.first_admin()
    _threading.Thread(target=_chat_boot.home_signed_in, daemon=True,
                      args=(_claude_of(_first_admin["id"] if _first_admin else "local")["home"],)).start()

    def _login_state(me: str) -> Optional[Dict[str, Any]]:
        for lid, lg in logins.items():
            if lg["owner"] == me and lg["proc"].returncode is None:
                return {"id": lid, "method": lg["method"], "url": lg["url"], "started": lg["started"]}
        return None

    def _login_or_404(lid: str, request: Any) -> Any:
        """The sign-in, if it is the asker's: someone else's is not there."""
        lg = logins.get(lid)
        if lg is None or lg["owner"] != request.state.user["id"] or lg["proc"].returncode is not None:
            return JSONResponse({"error": "That sign-in has ended — start again"}, status_code=404)
        return lg

    async def _end_login(lid: str) -> None:
        lg = logins.pop(lid, None)
        if lg is None:
            return
        if lg["timer"] is not None:
            lg["timer"].cancel()
        if lg["proc"].returncode is None:
            lg["proc"].kill()
            try:
                await asyncio.wait_for(lg["proc"].wait(), timeout=5)
            except asyncio.TimeoutError:
                pass

    @app.post("/api/assistant/login")
    async def assistant_login(body: Dict[str, Any], request: Request) -> JSONResponse:
        from . import chat as _chat_mod

        me = request.state.user["id"]
        method = str(body.get("method") or "claudeai")
        if method not in ("claudeai", "console", "sso"):
            return JSONResponse({"error": "method is claudeai, console or sso"}, status_code=400)
        for lid in [k for k, v in logins.items() if v["owner"] == me]:   # yours replaces yours, no one else's
            await _end_login(lid)
        binary = _chat_mod.find_claude()
        if binary is None:
            return JSONResponse({"error": "No claude binary found on this machine"}, status_code=500)
        home = Path(_claude_of(me)["home"])
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(home, 0o700)
        env = _chat_mod.base_env()
        env["CLAUDE_CONFIG_DIR"] = str(home)
        env["BROWSER"] = "true"          # never a browser on the studio's own machine: the page opens the link
        flags = {"claudeai": ["--claudeai"], "console": ["--console"], "sso": ["--sso"]}[method]
        proc = await asyncio.create_subprocess_exec(
            binary, "auth", "login", *flags, env=env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        seen = b""
        url = None
        try:
            end = time.monotonic() + 20
            while time.monotonic() < end and url is None:
                chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=max(0.1, end - time.monotonic()))
                if not chunk:
                    break
                seen += chunk
                m = re.search(rb"https://\S+", seen)
                if m and m.end() < len(seen):          # whole: something follows it
                    url = m.group(0).decode()
        except asyncio.TimeoutError:
            pass
        if url is None:
            proc.kill()
            tail = seen.decode(errors="replace").strip()[-300:]
            return JSONResponse({"error": "The sign-in did not start" + (f": {tail}" if tail else "")}, status_code=502)
        import uuid as _uuid

        lid = _uuid.uuid4().hex[:12]
        loop = asyncio.get_running_loop()
        logins[lid] = {"proc": proc, "method": method, "url": url, "started": time.time(), "owner": me,
                       "timer": loop.call_later(600, lambda: asyncio.ensure_future(_end_login(lid)))}
        _account_cache.pop(me, None)
        return JSONResponse({"login_id": lid, "url": url, "method": method})

    @app.post("/api/assistant/login/{lid}/code")
    async def assistant_login_code(lid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        from . import chat as _chat_mod

        lg = _login_or_404(lid, request)
        if isinstance(lg, JSONResponse):
            return lg
        me = request.state.user["id"]
        code = str(body.get("code") or "").strip()
        if not code or len(code) > 2000 or "\n" in code:
            return JSONResponse({"error": "Paste the code the sign-in page showed"}, status_code=400)
        proc = lg["proc"]
        proc.stdin.write(code.encode() + b"\n")
        await proc.stdin.drain()
        said = b""
        try:
            said, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            pass
        rc = proc.returncode
        await _end_login(lid)
        signed = await asyncio.to_thread(_chat_mod.home_signed_in, _claude_of(me)["home"], True)
        account = await _account(me, fresh=True)
        if rc == 0 and signed:
            return JSONResponse({"ok": True, "account": account})
        # the CLI's own words ("Login failed: …"), never the code
        last = [ln for ln in (said or b"").decode(errors="replace").splitlines() if ln.strip()]
        why = (last[-1] if last else "the sign-in did not finish").replace(code, "…")[:300]
        return JSONResponse({"ok": False, "error": why, "account": account}, status_code=400)

    @app.delete("/api/assistant/login/{lid}")
    async def assistant_login_cancel(lid: str, request: Request) -> JSONResponse:
        if lid not in logins or logins[lid]["owner"] != request.state.user["id"]:
            return JSONResponse({"error": "That sign-in has ended — start again"}, status_code=404)
        await _end_login(lid)
        _account_cache.pop(request.state.user["id"], None)
        return JSONResponse({"cancelled": lid})

    @app.post("/api/assistant/logout")
    async def assistant_logout(request: Request) -> JSONResponse:
        """Sign your own Claude sign-in out. Never this machine's, nor
        anyone else's: the machine login's owner goes back to it."""
        from . import chat as _chat_mod

        me = request.state.user["id"]
        home = Path(_claude_of(me)["home"])
        binary = _chat_mod.find_claude()
        if binary is not None and home.is_dir():
            env = _chat_mod.base_env()
            env["CLAUDE_CONFIG_DIR"] = str(home)
            proc = await asyncio.create_subprocess_exec(
                binary, "auth", "logout", env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            try:
                await asyncio.wait_for(proc.wait(), timeout=30)
            except asyncio.TimeoutError:
                proc.kill()
        await asyncio.to_thread(_chat_mod.home_signed_in, home, True)
        return JSONResponse({"account": await _account(me, fresh=True)})

    @app.get("/api/assistant/account")
    async def assistant_account(request: Request, fresh: int = 0) -> JSONResponse:
        return JSONResponse({"account": await _account(request.state.user["id"], fresh=bool(fresh))})

    @app.get("/api/assistant/usage")
    async def assistant_usage(request: Request) -> JSONResponse:
        """Your plan's limits as last reported (they are your account's,
        shared by your conversations), with when; and your account."""
        me = request.state.user["id"]
        rate = _rate_of(me)
        return JSONResponse({"rate": rate, "as_of": (rate or {}).get("at"), "account": await _account(me)})

    @app.put("/api/assistant/defaults")
    def assistant_set_defaults(body: Dict[str, Any], request: Request) -> JSONResponse:
        """The studio's own default model and effort for new conversations
        (a project's ``[studio.assistant]`` still wins for its own)."""
        model = body.get("model") or None
        effort = body.get("effort") or None
        if not valid_model(model):
            return JSONResponse({"error": f"model is one of {', '.join(MODELS)}, or a full claude-… id"}, status_code=400)
        if effort is not None and effort not in EFFORTS:
            return JSONResponse({"error": f"effort is one of {', '.join(EFFORTS)}"}, status_code=400)
        me = request.state.user["id"]
        chat_store.set_meta(f"defaults:{me}", {k: v for k, v in (("model", model), ("effort", effort)) if v})
        return JSONResponse({"studio_defaults": _my_defaults(me)})

    def _session_or_404(sid: str, request: Any) -> Any:
        """The conversation, if it is the asker's. Someone else's answers
        exactly like one that does not exist (admins included, D7)."""
        sess = chat_store.session(sid)
        if sess is None or sess.get("owner") != request.state.user["id"]:
            return JSONResponse({"error": "no such conversation"}, status_code=404)
        return sess

    def _turn_or_404(tid: str, request: Any) -> Any:
        turn = relay.turns.get(tid)
        if turn is None or turn.owner != request.state.user["id"]:
            return JSONResponse({"error": "unknown turn"}, status_code=404)
        return turn

    @app.get("/api/assistant/sessions/{sid}")
    def assistant_session(sid: str, request: Request) -> JSONResponse:
        """A conversation as it stands: its items, and — when a turn is
        running — that turn's live items and the cursor to follow it from."""
        sess = _session_or_404(sid, request)
        if isinstance(sess, JSONResponse):
            return sess
        items = chat_store.items(sid)
        running = relay.running_items(sid)
        if running is not None:
            items = [it for it in items if it.get("turn") != running["id"]] + running.pop("items")
        mode = _limits(request).get("reach") or os.environ.get("OPERONX_STUDIO_CHAT_MODE", "full").strip().lower() or "full"
        if sess["scope"] == "home":
            where = str(recents.state_file.parent / "users" / request.state.user["id"] / "home") \
                if _viewer(request) else str(Path.home())
        else:
            owner = _watcher(sess["scope"])
            where = str(owner.root) if owner is not None else ""
        return JSONResponse({"session": _session_out(sess), "items": items, "running": running,
                             "models": list(MODELS),
                             "agent": {"reach": mode, "cwd": where,
                                       "model": os.environ.get("OPERONX_STUDIO_CHAT_MODEL") or None}})

    @app.patch("/api/assistant/sessions/{sid}")
    def assistant_patch(sid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        sess = _session_or_404(sid, request)
        if isinstance(sess, JSONResponse):
            return sess
        update: Dict[str, Any] = {}
        if "title" in body:
            title = re.sub(r"\s+", " ", str(body.get("title") or "")).strip()[:120]
            if not title:
                return JSONResponse({"error": "a title cannot be empty"}, status_code=400)
            update.update(title=title, title_source="user")
        if "archived" in body:
            update["archived"] = bool(body["archived"])
        if "model" in body:
            model = body.get("model") or None
            if not valid_model(model):
                return JSONResponse({"error": f"model is one of {', '.join(MODELS)}, or a full claude-… id"},
                                    status_code=400)
            update["model"] = model
        if "effort" in body:
            effort = body.get("effort") or None
            if effort is not None and effort not in EFFORTS:
                return JSONResponse({"error": f"effort is one of {', '.join(EFFORTS)}"}, status_code=400)
            update["effort"] = effort
        chat_store.update_session(sid, **update)
        return JSONResponse({"session": _session_out(chat_store.session(sid))})

    @app.post("/api/assistant/sessions/{sid}/attachments")
    def assistant_attach(sid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        """An image for a message: base64 in, a reference out. The browser has
        already resized it (a 1568 px long edge); the bytes are kept beside
        the store, named by their content, and deleted with the conversation."""
        import base64 as _b64
        import binascii

        sess = _session_or_404(sid, request)
        if isinstance(sess, JSONResponse):
            return sess
        mime = str(body.get("mime") or "")
        if mime not in IMAGE_TYPES:
            return JSONResponse({"error": "images only: PNG, JPEG, GIF or WebP"}, status_code=400)
        try:
            data = _b64.b64decode(str(body.get("data") or ""), validate=True)
        except (binascii.Error, ValueError):
            return JSONResponse({"error": "the image is not valid base64"}, status_code=400)
        if not data:
            return JSONResponse({"error": "an empty image"}, status_code=400)
        if len(data) > MAX_ATTACHMENT_BYTES:
            return JSONResponse({"error": f"the image is over {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB"},
                                status_code=413)
        dims = [int(body[k]) if isinstance(body.get(k), (int, float)) and body[k] > 0 else None for k in ("w", "h")]
        ref = chat_store.put_attachment(sid, data, mime=mime, name=str(body.get("name") or ""), w=dims[0], h=dims[1])
        return JSONResponse({"attachment": ref})

    @app.get("/api/assistant/sessions/{sid}/attachments/{aid}")
    def assistant_attachment(sid: str, aid: str, request: Request) -> Any:
        from fastapi.responses import FileResponse

        if isinstance(_session_or_404(sid, request), JSONResponse):
            return JSONResponse({"error": "no such attachment"}, status_code=404)
        ref = chat_store.attachment(sid, aid)
        path = chat_store.attachment_path(sid, ref) if ref else None
        if ref is None or path is None or not path.is_file():
            return JSONResponse({"error": "no such attachment"}, status_code=404)
        # named by its content: it never changes under the same address
        return FileResponse(str(path), media_type=ref["mime"],
                            headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.delete("/api/assistant/sessions/{sid}")
    async def assistant_delete(sid: str, request: Request) -> JSONResponse:
        sess = _session_or_404(sid, request)
        if isinstance(sess, JSONResponse):
            return sess
        if sess.get("running_turn"):
            relay.stop(sess["running_turn"])
        chat_store.delete_session(sid)
        return JSONResponse({"deleted": sid})

    @app.post("/api/assistant/sessions/{sid}/turns")
    async def assistant_turn(sid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        """Send a message. ``retry_of`` (regenerate) or ``edit_of`` (a new
        text for an earlier message) name a turn: it and everything after
        it leave the transcript, and the conversation forks from just
        before it."""
        sess = _session_or_404(sid, request)
        if isinstance(sess, JSONResponse):
            return sess
        message = str(body.get("message") or "").strip()
        fork_from: Optional[str] = ""
        ids = body.get("attachments")
        redo = str(body.get("retry_of") or body.get("edit_of") or "")
        if redo:
            old = chat_store.turn(redo)
            if old is None or old["session"] != sid:
                return JSONResponse({"error": "no such turn in this conversation"}, status_code=404)
            edit = bool(body.get("edit_of")) and (bool(message) or bool(ids))
            message = message if edit else old["message"]
            # a retry sends the same images again; an edit sends what it has now
            if not (edit and isinstance(ids, list)):
                ids = [a.get("id") for a in old.get("attachments") or []]
            fork_from = old["claude_before"]
        refs = []
        if ids is not None and not isinstance(ids, list):
            return JSONResponse({"error": "attachments is a list of ids"}, status_code=400)
        for aid in ids or []:
            ref = chat_store.attachment(sid, str(aid))
            if ref is None:
                return JSONResponse({"error": f"no attachment {aid} in this conversation"}, status_code=400)
            if ref not in refs:
                refs.append(ref)
        if len(refs) > MAX_ATTACHMENTS:
            return JSONResponse({"error": f"at most {MAX_ATTACHMENTS} images a message"}, status_code=400)
        if not message and not refs:
            return JSONResponse({"error": "empty message"}, status_code=400)
        env = _turn_env(sess["scope"], body.get("view"), request)
        if isinstance(env, JSONResponse):
            return env
        cwd, context, mcp = env
        busy = _busy()
        if busy is not None:
            _revoker(mcp)()
            return busy
        if redo:
            running = sess.get("running_turn")
            if running and running in relay.turns and not relay.turns[running].done:
                return JSONResponse({"error": "this conversation is already working on something"}, status_code=409)
            chat_store.hide_from(sid, redo)
        try:
            turn = relay.start(sid, message, cwd=cwd, context=context, mcp=mcp, fork_from=fork_from,
                               view=body.get("view") if isinstance(body.get("view"), dict) else None,
                               attachments=refs, extra_mcp={} if _viewer(request) else _project_mcp(sess["scope"]),
                               owner=request.state.user["id"], on_end=[_revoker(mcp)],
                               claude=_claude_of(request.state.user["id"]), **_limits(request))
        except RuntimeError as exc:
            _revoker(mcp)()
            return JSONResponse({"error": str(exc)}, status_code=409)
        return JSONResponse({"turn": turn.id, "cursor": 0})

    @app.post("/api/assistant/sessions/{sid}/compact")
    async def assistant_compact(sid: str, request: Request) -> JSONResponse:
        sess = _session_or_404(sid, request)
        if isinstance(sess, JSONResponse):
            return sess
        if not sess.get("claude_session"):
            return JSONResponse({"error": "nothing to compact yet"}, status_code=400)
        env = _turn_env(sess["scope"], None, request)
        if isinstance(env, JSONResponse):
            return env
        cwd, context, mcp = env
        busy = _busy()
        if busy is not None:
            _revoker(mcp)()
            return busy
        try:
            turn = relay.start(sid, "/compact", cwd=cwd, context=context, mcp=mcp, kind="compact",
                               owner=request.state.user["id"], on_end=[_revoker(mcp)],
                               claude=_claude_of(request.state.user["id"]), **_limits(request))
        except RuntimeError as exc:
            _revoker(mcp)()
            return JSONResponse({"error": str(exc)}, status_code=409)
        return JSONResponse({"turn": turn.id, "cursor": 0})

    @app.post("/api/assistant/sessions/{sid}/items/{seq}")
    def assistant_item(sid: str, seq: int, body: Dict[str, Any], request: Request) -> JSONResponse:
        """Record what the user did with a changes card: kept, or undone."""
        if isinstance(_session_or_404(sid, request), JSONResponse):
            return JSONResponse({"error": "no such item"}, status_code=404)
        state = body.get("state")
        if state not in ("kept", "undone"):
            return JSONResponse({"error": "state is kept or undone"}, status_code=400)
        extra = {"restored": int(body["restored"])} if isinstance(body.get("restored"), int) else {}
        item = chat_store.patch_item(sid, seq, state=state, **extra)
        if item is None:
            return JSONResponse({"error": "no such item"}, status_code=404)
        return JSONResponse({"item": item})

    @app.post("/api/assistant/import")
    def assistant_import(body: Dict[str, Any], request: Request) -> JSONResponse:
        """A conversation the old panel kept in the browser, carried over
        once: its items become a session that continues the same Claude
        session."""
        scope = str(body.get("scope") or "home")
        log = body.get("log")
        if not _scope_ok(scope) or not isinstance(log, list) or not log:
            return JSONResponse({"error": "nothing to import"}, status_code=400)
        from .assistant import title_from

        first = next((str(x.get("text") or "") for x in log if isinstance(x, dict) and x.get("w") == "me"), "")
        sess = chat_store.create_session(scope, owner=request.state.user["id"],
                                         title=title_from(first) if first else "Earlier conversation",
                                         title_source="first", claude_session=str(body.get("session") or "") or None)
        kinds = {"me": "user", "bot": "text", "tool": "tool", "changes": "changes", "err": "error", "meta": "note"}
        items = []
        for x in log[:2000]:
            if not isinstance(x, dict) or x.get("w") not in kinds:
                continue
            item: Dict[str, Any] = {"seq": len(items) + 1, "turn": None, "kind": kinds[x["w"]], "imported": True}
            if x["w"] == "tool":
                item.update(name=x.get("name"), label=f"{x.get('name') or 'tool'} {x.get('hint') or ''}".strip(),
                            status="ok")
            elif x["w"] == "changes":
                item.update({k: x.get(k) for k in ("sha", "files", "diff", "state", "restored") if k in x})
            else:
                item["text"] = str(x.get("text") or "")
            items.append(item)
        chat_store.put_items(sess["id"], items)
        return JSONResponse({"session": _session_out(chat_store.session(sess["id"])), "items": len(items)})

    @app.get("/api/p/{pid}/assistant/suggest")
    def assistant_suggest(pid: str, request: Request, node: str = "") -> JSONResponse:
        """Starters built from the project's own state, most pressing first:
        what failed today, an eval that dropped, what is missing, what the
        user is pointing at — so an empty conversation offers the next
        useful thing instead of a blank box."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        out: List[Dict[str, Any]] = []

        def add(label: str, prompt: str, kind: str, why: str = "") -> None:
            out.append({"label": label, "prompt": prompt, "kind": kind, "why": why})

        if node:
            add(f"Explain {node}", f"Explain what the op `{node}` does, what feeds it and what it feeds.", "op")
            add(f"Why is {node} slow?", f"Look at recent runs: how long does `{node}` take, and why? "
                                       "Suggest a fix if there is one.", "op")
        pr = project_runs(watcher.root, sweep=False)
        try:
            day = pr.store.groups(RunFilter(since=time.time() - 86400), by=["origin", "name"])
        except Exception:  # noqa: BLE001 — a starter is best-effort
            day = []
        for g in sorted(day, key=lambda g: -(g.get("errors") or 0))[:2]:
            if g.get("errors") and g.get("name"):
                n = g["errors"]
                add(f"Why did {n} run{'s' if n > 1 else ''} of {g['name']} fail today?",
                    f"{n} of today's {g['runs']} {g['origin']} runs of `{g['name']}` failed. Find out why, group the "
                    "failures by cause, and tell me what to fix first.", "failure",
                    f"{n} failed in the last 24 h")
        ir = watcher.refresh_swr().ir or {}
        jobs = ir.get("jobs") or []
        evals = [j for j in _jobs_of(watcher) if j.get("kind") == "eval"]
        for ev in evals[:2]:
            runs = [r for r in _eval_runs(ev, 2) if r.get("status") != "running"]
            now_rate = ((runs[0].get("eval") or {}).get("pass_rate") if runs else None)
            then_rate = ((runs[1].get("eval") or {}).get("pass_rate") if len(runs) > 1 else None)
            if now_rate is not None and then_rate is not None and now_rate < then_rate:
                add(f"Why did {ev['name']} drop to {round(100 * now_rate)}%?",
                    f"The eval `{ev['name']}` went from {round(100 * then_rate)}% to {round(100 * now_rate)}%. "
                    "Which cases regressed, and why?", "eval", "the last run passed fewer cases")
        services = [sv for sv in ir.get("services") or [] if sv.get("kind") != "asgi"]
        if services and not evals:
            name = services[0]["name"]
            add(f"Set up an eval for {name}", f"Set up an eval for the `{name}` service: a small dataset of real "
                                               "cases from its runs, evaluators that check what matters, and run it.",
                "setup", "no evals yet")
        if services:
            name = services[0]["name"]
            add(f"Try {name} and report", f"Drive the `{name}` service through the playground with a few "
                                           "realistic messages and tell me how it did.", "try")
        add("Explain this project", "Explain this project in plain words: what it does, its main flow step by "
                                    "step, and where the risky parts are.", "learn")
        if not jobs and services:
            add("Add a nightly job", f"Add a job that runs `{services[0]['name']}`'s graph over a batch of saved "
                                     "cases every night and records the results.", "setup")
        # a viewer's assistant only reads: never offer to build or drive
        if (getattr(request.state, "user", None) or {}).get("role") == "viewer":
            out = [s_ for s_ in out if s_["kind"] not in VIEWER_CANNOT]
        # the most pressing first, at most six, no two alike
        seen, uniq = set(), []
        for s_ in out:
            if s_["label"] not in seen:
                seen.add(s_["label"])
                uniq.append(s_)
        return JSONResponse({"suggestions": uniq[:6]})

    @app.get("/api/assistant/turns/{tid}")
    async def assistant_poll(tid: str, request: Request, cursor: int = 0) -> JSONResponse:
        if isinstance(_turn_or_404(tid, request), JSONResponse):
            return JSONResponse({"error": "unknown turn"}, status_code=404)
        got = await relay.poll(tid, max(0, cursor))
        if got is None:
            return JSONResponse({"error": "unknown turn"}, status_code=404)
        return JSONResponse(got)

    @app.get("/api/assistant/turns/{tid}/stream")
    async def assistant_stream(tid: str, request: Request, cursor: int = 0, window: float = 20.0) -> Any:
        """The turn's events from *cursor* as NDJSON, as they happen, for up
        to ``window`` seconds; the page reconnects from its cursor."""
        if isinstance(_turn_or_404(tid, request), JSONResponse):
            return JSONResponse({"error": "unknown turn"}, status_code=404)
        return StreamingResponse(relay.stream(tid, max(0, cursor), max(1.0, min(window, 25.0))),
                                 media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/api/assistant/turns/{tid}/stop")
    async def assistant_stop(tid: str, request: Request) -> JSONResponse:   # on the loop: stop() schedules a kill
        if isinstance(_turn_or_404(tid, request), JSONResponse) or not relay.stop(tid):
            return JSONResponse({"error": "unknown turn"}, status_code=404)
        return JSONResponse({"ok": True})

    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
    # closed by default: a route the table has no rule for answers 403
    for method, path in unclassified(app.routes):
        _LOG.warning("operonx studio: %s %s has no access rule (operonx_studio/access.py) — it answers 403",
                     method, path)
    return app


def serve_studio(host: str = "127.0.0.1", port: int = 8765,
                 open_path: Optional[Path] = None) -> None:
    """Run the studio. ``open_path`` pre-opens one project, for `operonx-studio .`."""
    import uvicorn

    recents = Recents()
    if open_path is not None:
        recents.touch(Path(open_path).resolve())
    uvicorn.run(build_studio_app(recents), host=host, port=port, log_level="warning")
