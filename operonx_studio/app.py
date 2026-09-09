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
                    "loop", "is_gen", "transient", "serve_role", "code",
                    "resource", "routes")},
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


# ── trace records: one shape, two sources ───────────────────────────────
# The studio never invents trace data — it reads what a consumer recorded.
# `LocalConsumer` writes `<run>/nodes.jsonl`; `LangfuseConsumer` ships the
# same executions to Langfuse as spans. Both normalise to one record shape
# here, and the aggregate + drill-down work over that.


def _local_records(run_dir: Path):
    with (run_dir / "nodes.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


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
            "inputs": rec.get("inputs"),
            "outputs": rec.get("outputs"),
        })
    return {"run": run_name, "op": op_name, "total": total,
            "showing": len(keep), "executions": list(keep)}


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
        })
        agg["runs"] += 1
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


# ── the Langfuse source ─────────────────────────────────────────────────


def _langfuse_cfg(root: Path) -> Optional[Dict[str, str]]:
    """The `[studio.langfuse]` table, env-interpolated, or nothing.

        [studio.langfuse]
        host       = "${LANGFUSE_HOST}"
        public_key = "${LANGFUSE_PUBLIC_KEY}"
        secret_key = "${LANGFUSE_SECRET_KEY}"

    Values may be literal or `${VAR}` / `${VAR:default}`. Keys never land
    in the IR or the page — they authenticate server-side fetches only.
    """
    import re

    table = _studio_table(root).get("langfuse")
    if not isinstance(table, dict):
        return None

    def env(value: Any) -> str:
        value = str(value or "")
        m = re.fullmatch(r"\$\{([A-Za-z0-9_]+)(?::([^}]*))?\}", value)
        if m:
            return os.environ.get(m.group(1)) or (m.group(2) or "")
        return value

    host = env(table.get("host")).rstrip("/")
    public = env(table.get("public_key"))
    secret = env(table.get("secret_key"))
    if not (host and public and secret):
        return None
    return {"host": host, "public": public, "secret": secret}


def _lf_get(cfg: Dict[str, str], path: str, **params: Any) -> Any:
    import base64
    import urllib.parse
    import urllib.request

    url = cfg["host"] + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    token = base64.b64encode(f"{cfg['public']}:{cfg['secret']}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {token}"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def _iso_epoch(stamp: Any) -> float:
    from datetime import datetime

    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _lf_records(cfg: Dict[str, str], trace_id: str):
    """One Langfuse trace's observations, as normal trace records.

    `LangfuseConsumer._span_create` wrote what we need back verbatim:
    span name = op_name, metadata carries op_full_name / status /
    duration_ms, statusMessage the error, input/output the payloads.
    A finished trace never changes, so the fetched detail rides the
    studio cache — clicking around a Langfuse run costs one remote call,
    not one per node.
    """
    from operonx_studio.cache import studio_cache

    key = f"lf:trace:{cfg['host']}:{trace_id}"
    detail = studio_cache().get_json(key)
    if detail is None:
        detail = _lf_get(cfg, f"/api/public/traces/{trace_id}")
        studio_cache().set_json(key, detail, ttl=600)
    for obs in detail.get("observations") or []:
        meta = obs.get("metadata") or {}
        duration = meta.get("duration_ms")
        if duration is None and obs.get("startTime") and obs.get("endTime"):
            duration = (_iso_epoch(obs["endTime"]) - _iso_epoch(obs["startTime"])) * 1000.0
        status = meta.get("status") or ("error" if obs.get("level") == "ERROR" else "ok")
        yield {
            "op_name": obs.get("name"),
            "op_full_name": meta.get("op_full_name") or obs.get("name"),
            "start_time": _iso_epoch(obs.get("startTime")),
            "duration_ms": duration or 0.0,
            "status": status,
            "error": obs.get("statusMessage"),
            "ctx": meta.get("ctx"),
            "inputs": obs.get("input"),
            "outputs": obs.get("output"),
        }


def _lf_runs(cfg: Dict[str, str], limit: int = 50) -> List[Dict[str, Any]]:
    listing = _lf_get(cfg, "/api/public/traces", limit=limit, orderBy="timestamp.DESC")
    return [
        {
            "run": f"lf:{t['id']}",
            "mtime": _iso_epoch(t.get("timestamp")),
            "size": None,
            "source": "langfuse",
            "name": t.get("name"),
        }
        for t in listing.get("data") or []
        if t.get("id")
    ]


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
        for asset in ("studio.css", "studio.js", "values.js", "chat.js",
                      "home.css", "home.js"):
            text = text.replace(f"/static/{asset}", f"/static/{asset}?v={asset_v}")
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

    def _declared_roles(root: Path, graphs: List[Dict[str, Any]]) -> None:
        """Boundary ops the manifest names outright.

        A project with stream-level teardown writes its own ingress/egress
        over `current_session()` — the extension point, not a workaround —
        and no function-identity check can see those. `[studio]`'s
        `ingress`/`egress` lists name such ops so they still draw as doors:

            [studio]
            ingress = ["recv"]
            egress  = ["played"]
        """
        table = _studio_table(root)
        declared = {str(n): role
                    for role in ("ingress", "egress")
                    for n in (table.get(role) or [])}
        if not declared:
            return
        for g in graphs:
            for n in g.get("nodes") or []:
                if not n.get("serve_role") and n["name"] in declared:
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
        _declared_roles(watcher.root, placed)
        return JSONResponse({
            "name": ir.get("project"),
            "description": ir.get("description", ""),
            "root": str(watcher.root),
            "stamp": result.stamp,
            "graphs": placed,
            "serves": ir.get("serves") or [],
            "resources": ir.get("resources") or {},
            "traces_configured": _traces_root(watcher.root) is not None,
        })

    @app.get("/api/p/{pid}/stamp")
    def project_stamp(pid: str) -> JSONResponse:
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        result = watcher.refresh_swr()
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

    # Per-run activity summaries for the listing: memory first, then the
    # shared studio cache (redis/disk), keyed on the nodes.jsonl mtime so
    # a changed run recomputes and an unchanged one costs nothing —
    # anywhere, across restarts. The trace dir itself stays read-only.
    from operonx_studio.cache import studio_cache

    cache = studio_cache()
    summary_cache: Dict[str, Any] = {}

    def _activity(entry: Path, nodes_mtime: float) -> Dict[str, Any]:
        cached = summary_cache.get(str(entry))
        if cached and cached[0] == nodes_mtime:
            return cached[1]
        key = f"tracesum:{entry}:{nodes_mtime}"
        brief = cache.get_json(key)
        if brief is None:
            s = _summarise_run(_local_records(entry), entry.name)
            brief = {"ops": len(s["ops"]), "records": s["records"],
                     "errors": s["errors"], "wall_s": s["wall_s"]}
            cache.set_json(key, brief, ttl=14 * 86400)
        summary_cache[str(entry)] = (nodes_mtime, brief)
        return brief

    @app.get("/api/p/{pid}/traces")
    def traces(pid: str, local_only: int = 0) -> JSONResponse:
        """Runs from every configured trace source, one list.

        The studio reads what a consumer recorded — nothing else. A
        `[studio] traces` dir lists LocalConsumer runs; a
        `[studio.langfuse]` table lists the traces LangfuseConsumer
        shipped. A Langfuse outage degrades to a note, never a 500 —
        the local list must not die with someone else's server.
        ``local_only`` exists for the follow-latest poll, which must not
        hammer a remote API every few seconds.
        """
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        root = _traces_root(watcher.root)
        lf = _langfuse_cfg(watcher.root)
        if root is None and lf is None:
            return JSONResponse({"configured": False, "runs": []})

        payload: Dict[str, Any] = {"configured": True}
        runs: List[Dict[str, Any]] = []
        if root is not None:
            if not root.is_dir():
                payload["missing"] = str(root)
            else:
                payload["root"] = str(root)
                for entry in root.iterdir():
                    # `latest` is LocalConsumer's alias symlink, not a run;
                    # listing it would show every run twice.
                    if entry.is_symlink():
                        continue
                    nodes = entry / "nodes.jsonl"
                    if not nodes.is_file():
                        continue
                    stat = nodes.stat()
                    runs.append({
                        "run": entry.name,
                        "mtime": stat.st_mtime,
                        "size": stat.st_size,
                        "source": "local",
                        **_activity(entry, stat.st_mtime),
                    })
        if lf is not None and not local_only:
            payload["langfuse"] = lf["host"]
            try:
                runs.extend(_lf_runs(lf))
            except Exception as exc:  # noqa: BLE001 — someone else's server
                payload["langfuse_error"] = str(exc)
        runs.sort(key=lambda r: -(r["mtime"] or 0))
        payload["runs"] = runs[:200]
        return JSONResponse(payload)

    def _local_run_dir(pid: str, run: str):
        """Resolve a local run's directory, or a JSONResponse explaining why not."""
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
        return run_dir

    def _lf_for(pid: str, run: str):
        """Langfuse config + trace id for an `lf:` run, or an error response."""
        watcher = _watcher(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        cfg = _langfuse_cfg(watcher.root)
        if cfg is None:
            return JSONResponse({"error": "no [studio.langfuse] configured"}, status_code=404)
        return cfg, run[3:]

    @app.get("/api/p/{pid}/trace/{run}")
    def trace(pid: str, run: str) -> JSONResponse:
        if run.startswith("lf:"):
            got = _lf_for(pid, run)
            if isinstance(got, JSONResponse):
                return got
            cfg, trace_id = got
            try:
                return JSONResponse(_summarise_run(_lf_records(cfg, trace_id), run))
            except Exception as exc:  # noqa: BLE001 — someone else's server
                return JSONResponse({"error": f"langfuse: {exc}"}, status_code=502)
        run_dir = _local_run_dir(pid, run)
        if isinstance(run_dir, JSONResponse):
            return run_dir
        return JSONResponse(_summarise_run(_local_records(run_dir), run_dir.name))

    @app.get("/api/p/{pid}/trace/{run}/op/{op_name}")
    def trace_op(pid: str, run: str, op_name: str, limit: int = 50) -> JSONResponse:
        """One op's executions in one run — the drill-down under the
        aggregate, with the recorded inputs and outputs. Same run-name
        containment rule as the summary endpoint above."""
        limit = max(1, min(limit, 200))
        if run.startswith("lf:"):
            got = _lf_for(pid, run)
            if isinstance(got, JSONResponse):
                return got
            cfg, trace_id = got
            try:
                return JSONResponse(
                    _op_executions(_lf_records(cfg, trace_id), run, op_name, limit=limit))
            except Exception as exc:  # noqa: BLE001 — someone else's server
                return JSONResponse({"error": f"langfuse: {exc}"}, status_code=502)
        run_dir = _local_run_dir(pid, run)
        if isinstance(run_dir, JSONResponse):
            return run_dir
        return JSONResponse(
            _op_executions(_local_records(run_dir), run_dir.name, op_name, limit=limit))

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
        traces = _traces_root(watcher.root)
        if traces is not None:
            lines.append(f"Traces directory: {traces}")
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

    @app.post("/api/p/{pid}/chat")
    async def project_chat(pid: str, body: Dict[str, Any]) -> Any:
        from . import chat as _chat

        cwd, context = _chat_briefing(pid)
        if cwd is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        message = str(body.get("message") or "").strip()
        if not message:
            return JSONResponse({"error": "empty message"}, status_code=400)
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
