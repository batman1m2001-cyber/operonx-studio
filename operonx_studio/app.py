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
import subprocess
import re
import os
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


def build_studio_app(recents: Optional[Recents] = None):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from fastapi.staticfiles import StaticFiles

    recents = recents if recents is not None else Recents()
    watchers: Dict[str, ProjectWatcher] = {}

    import hashlib

    from fastapi.middleware.gzip import GZipMiddleware
    from fastapi.responses import HTMLResponse

    app = FastAPI(title="operonx studio", docs_url=None, redoc_url=None)
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
        return digest.hexdigest()[:10]

    asset_v = _asset_version()

    def _page(name: str) -> HTMLResponse:
        text = (STATIC / name).read_text(encoding="utf-8")
        # every local asset the page names gets the content version
        text = re.sub(r'(/static/[A-Za-z0-9_.-]+\.(?:js|css))(?=["\'])',
                      lambda m: f"{m.group(1)}?v={asset_v}", text)
        return HTMLResponse(text, headers={"Cache-Control": "no-cache"})

    @app.middleware("http")
    async def _cache_headers(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static"):
            response.headers["Cache-Control"] = (
                "public, max-age=31536000, immutable"
                if "v" in request.query_params else "no-cache")
        return response

    # ── authentication ──────────────────────────────────────────────
    # The studio rides a public tunnel; an open door there is an open
    # door to the filesystem browser and the param editor. Simple by
    # design: one user/pass (root/123 unless configured), a signed
    # session cookie that survives restarts, and an off switch.
    #
    #   OPERONX_STUDIO_USER=...   (default "root")
    #   OPERONX_STUDIO_PASS=...   (default "123")
    #   OPERONX_STUDIO_AUTH=off   (no auth at all — trusted networks)
    auth: Optional[Dict[str, str]] = None
    if os.environ.get("OPERONX_STUDIO_AUTH", "").lower() not in ("off", "0", "false"):
        import hmac as _hmac

        _user = os.environ.get("OPERONX_STUDIO_USER", "root")
        _pass = os.environ.get("OPERONX_STUDIO_PASS", "123")
        _key = hashlib.sha256(f"oxstudio:{_user}:{_pass}".encode()).digest()
        auth = {"user": _user, "pass": _pass,
                "token": _hmac.new(_key, b"session-v1", hashlib.sha256).hexdigest()}

    @app.middleware("http")
    async def _guard(request, call_next):
        if auth is not None:
            path = request.url.path
            is_open = (path == "/login" or path == "/api/login"
                       or path.startswith("/static"))
            if not is_open and request.cookies.get("oxsession") != auth["token"]:
                if path.startswith("/api/"):
                    return JSONResponse({"error": "authentication required"},
                                        status_code=401)
                from fastapi.responses import RedirectResponse

                return RedirectResponse("/login", status_code=302)
        return await call_next(request)

    @app.get("/login")
    def login_page() -> HTMLResponse:
        return _page("login.html")

    @app.post("/api/login")
    def login(body: Dict[str, Any]) -> JSONResponse:
        if auth is None:
            return JSONResponse({"ok": True})
        import hmac as _hmac

        good = (_hmac.compare_digest(str(body.get("username") or ""), auth["user"])
                and _hmac.compare_digest(str(body.get("password") or ""), auth["pass"]))
        if not good:
            return JSONResponse({"error": "wrong username or password"}, status_code=401)
        response = JSONResponse({"ok": True})
        response.set_cookie("oxsession", auth["token"], httponly=True,
                            samesite="lax", max_age=30 * 86400)
        return response

    @app.get("/logout")
    def logout():
        from fastapi.responses import RedirectResponse

        response = RedirectResponse("/login", status_code=302)
        response.delete_cookie("oxsession")
        return response

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
    def home():
        return _page("home.html")

    @app.get("/api/projects")
    def projects() -> JSONResponse:
        return JSONResponse({"projects": [r.as_dict() for r in recents.ordered()]})

    @app.get("/api/projects/health")
    def projects_health() -> JSONResponse:
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
        return JSONResponse({"health": out})

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
        return _page("project.html")

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

    @app.get("/api/p/{pid}/ir")
    def project_ir(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        result = watcher.refresh_swr()
        ref = recents.get(pid)
        if not result.ok:
            return JSONResponse({
                "name": ref.name if ref else pid,
                "root": str(watcher.root),
                "error": result.error,
                "stamp": result.stamp,
            })
        ir = result.ir
        placed = [_placed(g) for g in ir.get("graphs") or []]
        _declared_roles(watcher.root, placed, ir.get("services") or [])
        return JSONResponse({
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
        })

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
    ) -> JSONResponse:
        """Runs by filter, one page at a time — the Runs screen's list.
        ``meta=key:value,key:value`` matches metadata; ``q`` searches ids,
        keys and metadata."""
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
        return JSONResponse({"runs": [_row(s) for s in page.items], "next": page.next_cursor,
                             "total": page.total, "source": pr.source})

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
        return JSONResponse({
            "total": total,
            "errors": sum(g["errors"] for g in counted),
            "services": list(folders["service"].values()),
            "jobs": list(folders["job"].values()),
            "evals": list(folders["eval"].values()),
            "runbooks": list(runbooks.values()),
            "playground": list(folders["playground"].values()),
            "adhoc": list(folders["adhoc"].values()),
            "source": pr.source,
        })

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
        return JSONResponse({"preview": out})

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
    def jobs(pid: str) -> JSONResponse:
        """Every [[job]] with its last run, if any — the Jobs list."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        out = []
        for job in _jobs_of(watcher):
            runs = _job_runs(job)
            last = runs[0] if runs else None
            out.append({**job, "runs": len(runs),
                        "last": ({k: last.get(k) for k in ("run_id", "status", "started", "ended", "counts")}
                                 if last else None)})
        return JSONResponse({"jobs": out})

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
        path = _run_dir(job, run_id) if job else None
        if path is None:
            return JSONResponse({"error": "unknown run"}, status_code=404)
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
        return JSONResponse({"run": data, "items": items, "log": tail, "path": str(path)})

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

    @app.post("/api/p/{pid}/chat")
    async def project_chat(pid: str, body: Dict[str, Any]) -> Any:
        from . import chat as _chat

        cwd, context = _chat_briefing(pid)
        if cwd is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        message = str(body.get("message") or "").strip()
        if not message:
            return JSONResponse({"error": "empty message"}, status_code=400)
        # What the user is LOOKING at rides along with every message, so
        # "why is this slow?" needs no op name typed — the studio knows.
        view = body.get("view") or {}
        if isinstance(view, dict):
            lines = []
            if view.get("node"):
                lines.append(f"- selected op: `{str(view['node'])[:120]}`"
                             + (f" ({str(view.get('kind'))[:40]})" if view.get("kind") else ""))
            if view.get("run"):
                lines.append(f"- run painted on the canvas: `{str(view['run'])[:120]}`")
            if view.get("tab"):
                lines.append(f"- open tab: {str(view['tab'])[:20]}")
            if lines:
                context += ("\n\n## What the user is looking at right now\n"
                            + "\n".join(lines))
        turn = _chat.start_turn(message, cwd=cwd, context=context,
                                session=str(body.get("session") or "") or None)
        return JSONResponse({"turn": turn})

    @app.post("/api/chat")
    async def home_chat(body: Dict[str, Any]) -> Any:
        """The assistant on the home page — no project selected, so the
        briefing is the roster: every project the studio knows about."""
        from . import chat as _chat

        message = str(body.get("message") or "").strip()
        if not message:
            return JSONResponse({"error": "empty message"}, status_code=400)
        roster = "\n".join(f"- {r.name}: {r.root}" for r in recents.ordered()
                           if r.exists)
        context = ("# Studio briefing\nNo project is open. Projects this "
                   "studio knows:\n" + (roster or "(none yet)"))
        turn = _chat.start_turn(message, cwd=Path.home(), context=context,
                                session=str(body.get("session") or "") or None)
        return JSONResponse({"turn": turn})

    @app.get("/api/chat/turn/{turn_id}")
    async def chat_turn_events(turn_id: str, cursor: int = 0) -> JSONResponse:
        from . import chat as _chat

        got = await _chat.poll_turn(turn_id, max(0, cursor))
        if got is None:
            return JSONResponse({"error": "unknown turn"}, status_code=404)
        return JSONResponse(got)

    @app.post("/api/chat/turn/{turn_id}/stop")
    async def chat_turn_stop(turn_id: str) -> JSONResponse:
        from . import chat as _chat

        if not _chat.stop_turn(turn_id):
            return JSONResponse({"error": "unknown turn"}, status_code=404)
        return JSONResponse({"ok": True})

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
