"""Services control — P9.

Gates: services are grouped into listeners (one process per host and
port); a listener is started from the studio in the project's interpreter
and comes up (asked of the port itself), answers its route, and stops —
its whole process group; a port something else holds is refused, as is
stopping what the studio did not start; and the log is there to read.
"""

from __future__ import annotations

import json
import socket
import time
import urllib.request
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents
from operonx_studio.services import listeners_of, probe_port

pytestmark = pytest.mark.unit

MAIN = '''
from operonx.core import END, START, graph, op
from operonx.app.serve import egress, ingress


@op(bound="sync")
def double(item=None) -> dict:
    return {"out": {"n": int(item["n"]) * 2}}


@graph
def flow():
    src = ingress()
    d = double(item=src["item"])
    out = egress(item=d["out"])
    START >> src >> d >> out >> END
'''


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def project(tmp_path: Path):
    port = _free_port()
    root = tmp_path / "svc"
    root.mkdir()
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(f'''
[project]
name = "svc-demo"

[[serve]]
name  = "double"
kind  = "http"
path  = "/double"
host  = "127.0.0.1"
port  = {port}
graph = "main:flow"
''', encoding="utf-8")
    return root, port


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def test_services_group_into_listeners():
    got = listeners_of([
        {"name": "a", "host": "0.0.0.0", "port": 80},
        {"name": "b", "host": "0.0.0.0", "port": 80},
        {"name": "c", "host": "0.0.0.0", "port": 81},
        {"name": "d"},  # no port: nothing to listen on
    ])
    assert [(x.key, [s["name"] for s in x.services]) for x in got] == [("0.0.0.0:80", ["a", "b"]),
                                                                       ("0.0.0.0:81", ["c"])]


def test_start_answer_stop(client, project):
    root, port = project
    pid = client.post("/api/open", json={"path": str(root)}).json()["id"]
    (lst,) = client.get(f"/api/p/{pid}/services").json()["listeners"]
    key = lst["key"]
    assert key == f"127.0.0.1:{port}" and lst["services"] == ["double"] and not lst["running"]
    assert client.post(f"/api/p/{pid}/services/stop", json={"key": key}).status_code == 409

    started = client.post(f"/api/p/{pid}/services/start", json={"key": key}).json()
    assert started["cmd"][-2:] == ["--only", "double"]
    try:
        end = time.monotonic() + 60
        while time.monotonic() < end and not probe_port("127.0.0.1", port):
            time.sleep(0.2)
        state = client.get(f"/api/p/{pid}/services").json()["listeners"][0]
        assert state["running"] and state["managed"], client.get(f"/api/p/{pid}/services/log",
                                                                params={"key": key}).json()["log"]
        req = urllib.request.Request(f"http://127.0.0.1:{port}/double", data=json.dumps({"n": 21}).encode(),
                                     headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as res:
            assert json.loads(res.read()) == {"n": 42}
        assert client.post(f"/api/p/{pid}/services/start", json={"key": key}).status_code == 409
    finally:
        assert client.post(f"/api/p/{pid}/services/stop", json={"key": key}).json() == {"stopped": key}
    assert not probe_port("127.0.0.1", port)
    assert "double" in client.get(f"/api/p/{pid}/services/log", params={"key": key}).json()["log"]


def test_a_port_someone_else_holds_is_refused(client, project):
    root, port = project
    pid = client.post("/api/open", json={"path": str(root)}).json()["id"]
    with socket.socket() as s:
        s.bind(("127.0.0.1", port))
        s.listen(1)
        got = client.post(f"/api/p/{pid}/services/start", json={"key": f"127.0.0.1:{port}"})
        assert got.status_code == 409 and "already taken" in got.json()["error"]
        state = client.get(f"/api/p/{pid}/services").json()["listeners"][0]
        assert state["running"] and not state["managed"]  # up, but not ours to stop
