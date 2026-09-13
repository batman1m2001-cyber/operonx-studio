"""Local daemon: serve a project's graph view and reload it as you edit.

**Extraction runs in a subprocess, never in this process.** Two constraints
force it, and both are load-bearing rather than defensive:

* Extraction imports the project's own modules. Re-extracting after an edit
  in the same interpreter would hand back the *cached* module, so the page
  would show stale structure while claiming to be live — the exact class of
  lie the viewer exists to avoid. A fresh process re-imports from disk.
* ``ResourceHub._instance`` is a class-level singleton and top-level module
  names collide across projects, so one process handles one project.
* The subprocess runs the **project's** interpreter, not ours, so one studio
  installation can serve projects whose dependencies it does not share.

It also means a project that raises on import reports the error in the page
instead of killing the server.

Change detection is mtime polling rather than a filesystem-watch library:
one fewer dependency, works the same over a network mount, and at these
project sizes a scan is cheaper than the extraction it guards.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, Optional, Set, Tuple

from operonx_studio.envstatus import env_status
from operonx_studio.render import render_html

__all__ = ["ProjectWatcher", "build_app", "serve"]

# Where a project keeps its interpreter. Extraction imports the project's
# own modules, so it must run under the interpreter that has the project's
# dependencies — callbot needs scipy, which the studio's environment has no
# reason to carry.
VENV_PYTHON = (".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe")

WATCH_SUFFIXES = {".py", ".toml", ".yaml", ".yml"}
WATCH_NAMES = {".env", ".env.example"}
SKIP_DIRS = {"__pycache__", ".venv", "venv", ".git", "node_modules", ".ruff_cache", ".pytest_cache"}

_POLL_SECONDS = 0.7

# Injected only when serving. A static file must stay inert.
_LIVE_RELOAD = """
<script>
(function () {
  var since = window.__OPERONX_STAMP__ || 0;
  setInterval(function () {
    fetch('api/stamp').then(function (r) { return r.json(); }).then(function (d) {
      if (since && d.stamp !== since) location.reload();
      since = d.stamp;
    }).catch(function () { /* daemon stopped; keep showing the last good page */ });
  }, 1000);
})();
</script>
"""


@dataclass
class ExtractResult:
    """One extraction attempt — the IR, or why it failed."""

    ir: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    stamp: float = 0.0

    @property
    def ok(self) -> bool:
        return self.ir is not None




@dataclass
class ProjectWatcher:
    """Tracks a project's files and re-extracts when any of them changes.

    Extraction costs seconds — it imports the whole project under its own
    interpreter (the callbot: 3.8s) — so the last good result is persisted
    to ``~/.operonx/ircache`` keyed on the file fingerprint. A restarted
    studio serves yesterday's picture instantly when nothing changed, and
    ``refresh_swr`` serves the stale picture immediately while a fresh
    extraction runs in the background; the stamp poll delivers the update.
    """

    root: Path
    cache: Any = None      # a studio cache; defaults to the process-wide one
    _fingerprint: Tuple = field(default=(), init=False)
    _last: ExtractResult = field(default_factory=ExtractResult, init=False)
    _extracting: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        import threading

        from operonx_studio.cache import studio_cache

        if self.cache is None:
            self.cache = studio_cache()
        self._lock = threading.Lock()
        self._load_cache()

    # ── the IR cache: memory → redis (when configured) → disk ───────

    def _cache_key(self) -> str:
        import hashlib

        digest = hashlib.sha1(str(self.root.resolve()).encode()).hexdigest()[:12]
        # bump the prefix when the EXTRACTOR changes shape — the cached
        # entry is validated by project-file fingerprints only, so a new
        # extractor field would otherwise be masked by warm caches
        return f"ir5:{digest}"

    def _load_cache(self) -> None:
        raw = self.cache.get_json(self._cache_key())
        if not raw:
            return
        try:
            cached_fp = tuple(tuple(entry) for entry in raw["fingerprint"])
        except (KeyError, TypeError):
            return
        if cached_fp != self.fingerprint():
            return  # the project moved on while the studio was away
        self._fingerprint = cached_fp
        self._last = ExtractResult(ir=raw.get("ir"), error=raw.get("error"),
                                   stamp=float(raw.get("stamp") or 0.0))

    def _save_cache(self) -> None:
        self.cache.set_json(self._cache_key(), {
            "fingerprint": [list(entry) for entry in self._fingerprint],
            "ir": self._last.ir,
            "error": self._last.error,
            "stamp": self._last.stamp,
        })

    def watched_files(self) -> Set[Path]:
        """Every file whose change should re-extract.

        Walks with SKIP_DIRS *pruned*, not filtered after the fact —
        ``rglob`` still descends into ``.venv`` and ``.git`` before the
        filter drops their entries, which on a real project is tens of
        thousands of stat calls on EVERY stamp poll. Measured on the
        callbot: 240ms per poll unpruned, ~2ms pruned.
        """
        import os

        found: Set[Path] = set()
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fname in filenames:
                path = Path(dirpath) / fname
                if path.suffix in WATCH_SUFFIXES or path.name in WATCH_NAMES:
                    found.add(path)
        return found

    def fingerprint(self) -> Tuple:
        """Sorted (path, mtime, size) — cheap and stable across runs."""
        out = []
        for path in sorted(self.watched_files()):
            try:
                stat = path.stat()
            except OSError:
                continue
            out.append((str(path), stat.st_mtime_ns, stat.st_size))
        return tuple(out)

    def changed(self) -> bool:
        current = self.fingerprint()
        if current != self._fingerprint:
            self._fingerprint = current
            return True
        return False

    def interpreter(self) -> str:
        """The Python that will run extraction.

        A project's own virtualenv if it has one, else ours. This is what
        lets a single studio installation serve projects whose dependencies
        it does not share: the project's interpreter supplies ``operonx`` and
        everything the project imports, while ``operonx_project`` is injected
        through ``PYTHONPATH`` — it is pure Python, so it needs no install
        in the target environment.
        """
        for candidate in VENV_PYTHON:
            path = self.root / candidate
            if path.exists():
                return str(path)
        return sys.executable

    def _child_env(self) -> Dict[str, str]:
        """Environment for the extractor: the toolkit, and nothing else.

        Only the directory containing ``operonx_project`` is added. An
        earlier version injected our whole ``sys.path``, which was harmless
        while the child was our own interpreter and actively destructive
        once it became the project's: another environment's ``site-packages``
        ahead of the child's own path shadows its dependencies and can break
        the import of the standard library itself.

        The path is absolute because the child runs with ``cwd`` set to the
        project, where a relative entry would resolve to the wrong place.
        """
        import operonx_project

        toolkit = str(Path(operonx_project.__file__).resolve().parent.parent)
        env = dict(os.environ)
        # An inherited PYTHONPATH is kept — a user may have set it for this
        # project — but every entry is absolutised and existing-checked
        # first. A relative entry would resolve against the project
        # directory once `cwd` changes and silently import the wrong thing.
        inherited = [
            str(Path(entry).resolve())
            for entry in env.get("PYTHONPATH", "").split(os.pathsep)
            if entry and Path(entry).is_dir()
        ]
        ordered = [toolkit] + [e for e in inherited if e != toolkit]
        env["PYTHONPATH"] = os.pathsep.join(ordered)
        return env

    def extract(self) -> ExtractResult:
        """Run extraction in a fresh interpreter and parse the result."""
        code = (
            "import json,sys;"
            "from operonx_project.manifest import Manifest;"
            "from operonx_project.extract import extract_project;"
            "sys.stdout.write(json.dumps(extract_project(Manifest.load(sys.argv[1]))))"
        )
        proc = subprocess.run(
            [self.interpreter(), "-c", code, str(self.root)],
            capture_output=True,
            text=True,
            cwd=str(self.root),
            env=self._child_env(),
        )
        stamp = time.time()
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip().splitlines()
            self._last = ExtractResult(
                error="\n".join(detail[-12:]) or "extraction failed", stamp=stamp
            )
            return self._last
        try:
            self._last = ExtractResult(ir=json.loads(proc.stdout), stamp=stamp)
        except json.JSONDecodeError as exc:
            self._last = ExtractResult(error=f"extractor returned invalid JSON: {exc}", stamp=stamp)
        self._save_cache()
        return self._last

    def refresh(self, force: bool = False) -> ExtractResult:
        if force or self.changed() or self._last.stamp == 0.0:
            return self.extract()
        return self._last

    def refresh_swr(self) -> ExtractResult:
        """Stale-while-revalidate: the last good picture NOW, the fresh one
        via the stamp poll.

        Blocks only when there is nothing at all to show. Otherwise a
        change kicks one background extraction and the caller gets the
        previous result immediately — the canvas appears in milliseconds
        and repaints itself seconds later, which beats staring at nothing
        for the duration of a project import.
        """
        if self._last.stamp == 0.0:
            # Nothing to show yet — the cold path stays blocking. If a
            # prewarm already started the work, wait for it instead of
            # running the same extraction twice.
            if self._extracting:
                for _ in range(300):
                    if not self._extracting:
                        break
                    time.sleep(0.1)
                return self._last
            self.changed()
            return self.extract()
        if self.changed():
            self._kick_background_extract()
        return self._last

    def _kick_background_extract(self) -> None:
        import threading

        with self._lock:
            if self._extracting:
                return
            self._extracting = True

        def run() -> None:
            try:
                self.extract()
            finally:
                self._extracting = False

        threading.Thread(target=run, name=f"extract:{self.root.name}", daemon=True).start()

    @property
    def last(self) -> ExtractResult:
        return self._last


def _error_page(root: Path, message: str, stamp: float) -> str:
    """Show the failure in the page rather than a dead server."""
    import html as _html

    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>operonx studio · extraction failed</title>
<style>
body {{ font:14px/1.6 ui-sans-serif,system-ui,sans-serif; margin:0;
  background:linear-gradient(140deg,#faf2d2,#eed88f); color:#3d3626; }}
main {{ max-width:860px; margin:56px auto; padding:0 24px; }}
h1 {{ font-size:17px; margin:0 0 6px; color:#a1770a; }}
p {{ color:#9a8a68; margin:0 0 18px; }}
pre {{ background:#fffdf6; border:1px solid #e7dbb4; border-radius:9px; padding:16px;
  overflow:auto; font-size:12px; color:#cf3f36; white-space:pre-wrap; }}
</style></head><body><main>
<h1>Could not build {_html.escape(root.name)}</h1>
<p>The page reloads automatically once the project builds again.</p>
<pre>{_html.escape(message)}</pre>
</main>
<script>window.__OPERONX_STAMP__ = {stamp!r};</script>
{_LIVE_RELOAD}
</body></html>"""


def page_for(watcher: ProjectWatcher, result: ExtractResult) -> str:
    """Render whatever the last extraction produced, success or failure."""
    if not result.ok:
        return _error_page(watcher.root, result.error or "unknown error", result.stamp)
    ir = result.ir or {}
    env = (ir.get("resources") or {}).get("env") or {}
    status = env_status(watcher.root, env.get("required") or [], (env.get("optional") or {}).keys())
    page = render_html(ir, env_status=status)
    # Both flags are injected here rather than baked into the template: a
    # file written by `operonx-studio PATH` may be shared or committed, and
    # it must neither poll a daemon that is not there nor offer buttons that
    # call an API it cannot reach.
    flags = (
        f"<script>window.__OPERONX_STAMP__ = {result.stamp!r};"
        f"window.__OPERONX_EDITABLE__ = true;</script>"
    )
    return page.replace("</body>", f"{flags}{_LIVE_RELOAD}</body>")


def build_app(root: Path):
    """FastAPI app serving one project. Import kept local to the ``serve`` extra."""
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse, JSONResponse

    watcher = ProjectWatcher(root=Path(root).resolve())
    app = FastAPI(title="operonx studio", docs_url=None, redoc_url=None)

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        return HTMLResponse(page_for(watcher, watcher.refresh()))

    @app.get("/api/stamp")
    def stamp() -> JSONResponse:
        """Polled by the page; re-extracts only when a watched file moved."""
        return JSONResponse({"stamp": watcher.refresh().stamp, "ok": watcher.last.ok})

    @app.get("/api/ir")
    def ir() -> JSONResponse:
        result = watcher.refresh()
        if not result.ok:
            return JSONResponse({"error": result.error}, status_code=503)
        return JSONResponse(result.ir)

    @app.post("/api/edit")
    def edit(body: Dict[str, Any]) -> JSONResponse:
        """Plan a typed edit, and apply it only when asked.

        ``dry_run`` defaults to **true**: a request that forgets the flag
        previews rather than writes. The response always carries the diff,
        so a UI can show the change before it happens — which is what "code
        is the source of truth" has to mean in practice.

        Applying writes the file; the watcher notices on its next poll and
        the page reloads itself, so there is no separate refresh path to
        keep in step.
        """
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
        except TypeError as exc:  # wrong arguments for the action
            return JSONResponse({"error": f"bad arguments for {action!r}: {exc}"}, status_code=400)

        payload = {
            "graph": plan.graph,
            "action": plan.action,
            "file": str(plan.file.relative_to(watcher.root)),
            "changed": plan.changed,
            "diff": plan.diff,
            "applied": False,
        }
        if body.get("dry_run", True):
            return JSONResponse(payload)
        try:
            payload["applied"] = apply_plan(plan)
        except PlanError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        return JSONResponse(payload)

    return app


def _watch_forever(watcher: ProjectWatcher) -> Iterator[None]:  # pragma: no cover
    while True:
        watcher.refresh()
        time.sleep(_POLL_SECONDS)
        yield


def serve(root: Path, host: str = "127.0.0.1", port: int = 8765) -> int:  # pragma: no cover
    """Run the daemon. Binds loopback only — this reads local source."""
    try:
        import uvicorn
    except ModuleNotFoundError:
        print(
            "operonx-studio serve needs the web stack:\n  pip install operonx-studio[serve]",
            file=sys.stderr,
        )
        return 1
    print(f"operonx-studio: serving {root} at http://{host}:{port}")
    uvicorn.run(build_app(root), host=host, port=port, log_level="warning")
    return 0
