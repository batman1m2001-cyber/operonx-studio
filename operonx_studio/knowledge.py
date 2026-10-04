"""Knowledge — a project's knowledge bases, found by asking, read through the studio.

A knowledge base built with operonx-kb serves an admin app as one of the
project's ``asgi`` services (``Service("kb_admin", asgi("/kb", ...),
app=kb_admin_app(...))``). The studio never imports operonx-kb, as it never
imports a project: it asks every running ``asgi`` service for
``GET <path>/.well-known/operonx-kb``, and one that answers
``{"api": "operonx-kb/1", ...}`` is a knowledge base. The contract is
versioned, so the two repos release apart; a service speaking another version
is listed with the reason it cannot be read.

The Knowledge tab's requests go through one proxy route per method, under the
studio's own access table: looking (GET) is a viewer's, querying (POST) an
editor's — a query runs the project's code and spends its answer model's money.
The proxy reaches only a service the project declares, at the host and port its
IR says, and only one that answered as a knowledge base: it is not a way to
reach anything else on the machine.
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from .services import probe_port

__all__ = ["KB_API", "WELL_KNOWN", "kb_service", "register"]

#: The admin contract this studio speaks (operonx-kb ``operonx_kb.admin.API``).
KB_API = "operonx-kb/1"
WELL_KNOWN = "/.well-known/operonx-kb"
#: How long the proxy waits: a query runs searches and an answer model.
PROXY_TIMEOUT = 180.0
PROBE_TIMEOUT = 1.5
#: A proxied path: segments of letters, digits and ``_ . - :``, never ``..``.
_PATH = re.compile(r"(?:[A-Za-z0-9_.:-]+/)*[A-Za-z0-9_.:-]+")


def _target(host: str) -> str:
    return "127.0.0.1" if host in ("", "0.0.0.0", "::") else host


def _base(service: Dict[str, Any]) -> str:
    return f"http://{_target(str(service.get('host') or ''))}:{int(service['port'])}" + \
        str(service.get("path") or "/").rstrip("/")


def kb_service(service: Dict[str, Any], probe: Callable[[str, int], bool] = probe_port) -> Dict[str, Any]:
    """What one ``asgi`` service of the IR is: running or not, and when it runs, a
    knowledge base (``kb``) or not, with its collections and what a query may ask."""
    out: Dict[str, Any] = {"name": service.get("name"), "path": service.get("path") or "/",
                           "key": f"{service.get('host') or '0.0.0.0'}:{service.get('port')}",
                           "running": bool(service.get("port")) and probe(str(service.get("host") or ""), int(service["port"])),
                           "kb": False}
    if not out["running"]:
        return out
    try:
        with urllib.request.urlopen(_base(service) + WELL_KNOWN, timeout=PROBE_TIMEOUT) as res:
            said = json.loads(res.read(200_000).decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return out          # a 404, a non-JSON page: some other app, not a knowledge base
    api = said.get("api") if isinstance(said, dict) else None
    if api == KB_API:
        out.update(kb=True, api=api, collections=list(said.get("collections") or []),
                   answer=bool(said.get("answer")), rerank=bool(said.get("rerank")))
    elif isinstance(api, str) and api.startswith("operonx-kb/"):
        out.update(api=api, error=f"it speaks {api}; this studio reads {KB_API} — upgrade the one that is older")
    return out


def register(app: Any, *, watcher_of: Callable[[str], Any]) -> None:
    """The Knowledge routes. ``watcher_of(pid)`` is the project's watcher (its IR)."""
    seen: Dict[str, Set[str]] = {}       # pid -> services that answered as a knowledge base
    lock = threading.Lock()

    def _asgi(watcher: Any) -> List[Dict[str, Any]]:
        services = (watcher.refresh_swr().ir or {}).get("services") or []
        return [s for s in services if s.get("kind") == "asgi" and s.get("port")]

    def _found(pid: str, svc: Dict[str, Any]) -> Dict[str, Any]:
        got = kb_service(svc)
        with lock:
            if got["kb"]:
                seen.setdefault(pid, set()).add(str(svc.get("name")))
            got["seen"] = str(svc.get("name")) in seen.get(pid, set())
        return got

    @app.get("/api/p/{pid}/knowledge")
    def knowledge(pid: str) -> JSONResponse:
        """The project's knowledge bases: every ``asgi`` service that answers the
        contract now, or did since the studio started (stopped since: ``running`` false)."""
        watcher = watcher_of(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        found = [_found(pid, s) for s in _asgi(watcher)]
        return JSONResponse({"api": KB_API, "services": [s for s in found if s["kb"] or s["seen"] or s.get("error")]})

    def _service(pid: str, name: str) -> Tuple[Optional[Dict[str, Any]], Optional[JSONResponse]]:
        watcher = watcher_of(pid)
        if watcher is None:
            return None, JSONResponse({"error": "unknown project"}, status_code=404)
        svc = next((s for s in _asgi(watcher) if s.get("name") == name), None)
        if svc is None:
            return None, JSONResponse({"error": f"{pid} declares no asgi service {name!r}"}, status_code=404)
        if not probe_port(str(svc.get("host") or ""), int(svc["port"])):
            return None, JSONResponse({"error": f"{name} is not running — start it in Services", "not_running": True},
                                      status_code=503)
        with lock:
            known = name in seen.get(pid, set())
        if not known and not _found(pid, svc)["kb"]:
            return None, JSONResponse({"error": f"{name} does not answer {WELL_KNOWN} as {KB_API}: "
                                                "it is not a knowledge base"}, status_code=404)
        return svc, None

    def _forward(pid: str, name: str, path: str, request: Request, body: Optional[bytes]) -> Response:
        if not _PATH.fullmatch(path) or ".." in path.split("/"):
            return JSONResponse({"error": f"not a knowledge-base path: {path!r}"}, status_code=400)
        svc, refused = _service(pid, name)
        if refused is not None:
            return refused
        url = f"{_base(svc)}/{path}" + (f"?{request.url.query}" if request.url.query else "")
        req = urllib.request.Request(url, data=body, method=request.method,
                                     headers={"content-type": "application/json"} if body is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as res:
                status, data, headers = res.status, res.read(), res.headers
        except urllib.error.HTTPError as exc:   # the knowledge base's own refusal: passed on as it said it
            status, data, headers = exc.code, exc.read(), exc.headers
        except (urllib.error.URLError, OSError) as exc:
            return JSONResponse({"error": f"{name} did not answer: {getattr(exc, 'reason', exc)}"}, status_code=502)
        keep = {k: headers[k] for k in ("cache-control",) if headers.get(k)}
        return Response(data, status_code=status, media_type=headers.get("content-type") or "application/json",
                        headers=keep)

    @app.get("/api/p/{pid}/kb/{service}/{path:path}")
    def kb_read(pid: str, service: str, path: str, request: Request) -> Response:
        """A GET to the knowledge base ``service``: lists, documents, pages, page images, chunks."""
        return _forward(pid, service, path, request, None)

    @app.post("/api/p/{pid}/kb/{service}/{path:path}")
    async def kb_write(pid: str, service: str, path: str, request: Request) -> Response:
        """A POST to the knowledge base ``service``: a query, an eval case."""
        body = await request.body()
        return await asyncio.to_thread(_forward, pid, service, path, request, body or b"{}")
