"""Knowledge — a project's knowledge bases, found by asking and read through the studio.

Gates: an ``asgi`` service that answers ``/.well-known/operonx-kb`` with
``operonx-kb/1`` is listed with its collections, any other app is not, and one
speaking another version is listed with why it cannot be read; a knowledge base
that stopped stays listed as stopped; the proxy passes paths, queries, bodies,
images and the knowledge base's own refusals through unchanged, reaches only a
declared knowledge-base service, and keeps the access table: a viewer reads, an
editor queries.
"""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.knowledge import KB_API
from operonx_studio.registry import Recents
from operonx_studio.services import probe_port

pytestmark = pytest.mark.unit

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fake_kb(api: str = KB_API) -> FastAPI:
    """The admin contract's shape, enough to see what the proxy passes through."""
    app = FastAPI()

    @app.get("/.well-known/operonx-kb")
    def well_known():
        return {"api": api, "collections": ["handbook"], "answer": True, "rerank": False}

    @app.get("/collections/{c}/documents")
    def documents(c: str, request: Request):
        return {"collection": c, "query": dict(request.query_params)}

    @app.get("/versions/{v}/pages/{n}/image")
    def image(v: str, n: int):
        return Response(PNG, media_type="image/png", headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.post("/collections/{c}/query")
    async def query(c: str, request: Request):
        body = await request.json()
        if not body.get("query"):
            return JSONResponse({"error": "the body needs a non-empty 'query'"}, status_code=400)
        return {"collection": c, "asked": body, "searches": [], "answer": None}

    return app


def not_a_kb() -> FastAPI:
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    return app


class Served:
    """An ASGI app on a real port, in a thread, as `operonx serve` would run it."""

    def __init__(self, app, port: int):
        import uvicorn

        self.port = port
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        end = time.monotonic() + 15
        while not probe_port("127.0.0.1", self.port):
            assert time.monotonic() < end, "the fake service did not come up"
            time.sleep(0.05)
        return self

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=10)


APPS = """
from operonx.core import END, START, graph, op

APP = None   # the admin apps are served by the tests themselves


@op
def echo(x=None) -> dict:
    return {"x": x}


@graph
def flow(x):
    e = echo(x=x)
    START >> e >> END
"""


@pytest.fixture()
def project(tmp_path: Path):
    """A project declaring two asgi services: a knowledge base and some other admin app."""
    root = tmp_path / "kbproj"
    root.mkdir()
    (root / "apps.py").write_text(APPS, encoding="utf-8")
    kb_port, other_port = _free_port(), _free_port()
    (root / "operonx.toml").write_text(f'''
[project]
name = "kb-demo"

[[graph]]
name  = "flow"
entry = "apps:flow"

[[serve]]
name = "kb_admin"
kind = "asgi"
path = "/kb"
host = "127.0.0.1"
port = {kb_port}
app  = "apps:APP"

[[serve]]
name = "admin"
kind = "asgi"
path = "/"
host = "127.0.0.1"
port = {other_port}
app  = "apps:APP"
''', encoding="utf-8")
    return root, kb_port, other_port


def mounted(app: FastAPI, path: str) -> FastAPI:
    """``app`` under ``path``, the way operonx's serve layer mounts an asgi service."""
    outer = FastAPI()
    outer.mount(path, app)
    return outer


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def test_a_knowledge_base_is_found_by_asking_and_other_apps_are_not(client, project):
    root, kb_port, other_port = project
    pid = _open(client, root)
    assert client.get(f"/api/p/{pid}/knowledge").json() == {"api": KB_API, "services": []}
    with Served(mounted(fake_kb(), "/kb"), kb_port), Served(not_a_kb(), other_port):
        got = client.get(f"/api/p/{pid}/knowledge").json()
        (kb,) = got["services"]
        assert kb["name"] == "kb_admin" and kb["running"] and kb["kb"] and kb["path"] == "/kb"
        assert kb["collections"] == ["handbook"] and kb["answer"] is True and kb["rerank"] is False
    # stopped since: still listed, as stopped, so the tab can say how to start it
    (kb,) = client.get(f"/api/p/{pid}/knowledge").json()["services"]
    assert kb["name"] == "kb_admin" and not kb["running"] and kb["seen"]


def test_another_contract_version_is_listed_with_the_reason(client, project):
    root, kb_port, _ = project
    pid = _open(client, root)
    with Served(mounted(fake_kb(api="operonx-kb/2"), "/kb"), kb_port):
        (kb,) = client.get(f"/api/p/{pid}/knowledge").json()["services"]
        assert not kb["kb"] and kb["api"] == "operonx-kb/2" and KB_API in kb["error"]
        res = client.get(f"/api/p/{pid}/kb/kb_admin/collections")
        assert res.status_code == 404 and "not a knowledge base" in res.json()["error"]


def test_the_proxy_passes_paths_queries_bodies_images_and_refusals_through(client, project):
    root, kb_port, _ = project
    pid = _open(client, root)
    with Served(mounted(fake_kb(), "/kb"), kb_port):
        got = client.get(f"/api/p/{pid}/kb/kb_admin/collections/handbook/documents",
                         params={"q": "nghỉ phép", "page": 2}).json()
        assert got == {"collection": "handbook", "query": {"q": "nghỉ phép", "page": "2"}}
        img = client.get(f"/api/p/{pid}/kb/kb_admin/versions/ver_1/pages/3/image")
        assert img.status_code == 200 and img.content == PNG
        assert img.headers["content-type"] == "image/png" and "immutable" in img.headers["cache-control"]
        body = {"query": "Nghỉ phép năm bao nhiêu ngày?", "modes": ["hybrid"], "answer": True}
        got = client.post(f"/api/p/{pid}/kb/kb_admin/collections/handbook/query", json=body).json()
        assert got["asked"] == body
        refused = client.post(f"/api/p/{pid}/kb/kb_admin/collections/handbook/query", json={})
        assert refused.status_code == 400 and refused.json() == {"error": "the body needs a non-empty 'query'"}


def test_the_proxy_reaches_only_a_running_declared_knowledge_base(client, project):
    root, kb_port, other_port = project
    pid = _open(client, root)
    res = client.get(f"/api/p/{pid}/kb/kb_admin/collections")
    assert res.status_code == 503 and res.json()["not_running"] is True
    with Served(mounted(fake_kb(), "/kb"), kb_port), Served(not_a_kb(), other_port):
        res = client.get(f"/api/p/{pid}/kb/elsewhere/collections")
        assert res.status_code == 404 and "no asgi service 'elsewhere'" in res.json()["error"]
        res = client.get(f"/api/p/{pid}/kb/admin/health")
        assert res.status_code == 404 and "not a knowledge base" in res.json()["error"]
        res = client.get(f"/api/p/{pid}/kb/kb_admin/collections/a b")
        assert res.status_code == 400 and "not a knowledge-base path" in res.json()["error"]
        assert client.get(f"/api/p/{pid}/kb/kb_admin/versions/..%2F..%2Fetc").status_code == 400


def test_a_viewer_reads_a_knowledge_base_and_an_editor_queries_it(team, project):
    root, kb_port, _ = project
    c = team.client
    pid = c.post("/api/open", json={"path": str(root)}).json()["id"]
    viewer = team.person("vee", "viewer")
    editor = team.person("eddie", "editor")
    with Served(mounted(fake_kb(), "/kb"), kb_port):
        team.use(viewer["token"])
        assert c.get(f"/api/p/{pid}/knowledge").json()["services"][0]["kb"]
        assert c.get(f"/api/p/{pid}/kb/kb_admin/collections/handbook/documents").status_code == 200
        res = c.post(f"/api/p/{pid}/kb/kb_admin/collections/handbook/query", json={"query": "q"})
        assert res.status_code == 403
        team.use(editor["token"])
        res = c.post(f"/api/p/{pid}/kb/kb_admin/collections/handbook/query", json={"query": "q"})
        assert res.status_code == 200 and res.json()["asked"] == {"query": "q"}
