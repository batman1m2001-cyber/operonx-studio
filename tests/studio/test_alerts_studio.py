"""Alerts in the studio — P9.

Gates: a rule is saved into the project (named, its webhook kept when an
edit leaves it out, bad rules refused), listed with its number right now
and its webhook masked, checked — firing once, sent to the webhook, the
state kept so the next check does not send again — test-sent on request,
and deleted.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx.core.workflow_trace import OpExecution, WorkflowTrace
from operonx.telemetry.runs.files import FilesRunStore

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit


def _run(tid, error):
    node = OpExecution(op_id=f"g.a#{tid}", op_name="a", op_full_name="g.a", ctx=("main",), start_time=1.0,
                       end_time=1.1, inputs={}, outputs={}, upstreams=[], status="error" if error else "ok",
                       error="boom" if error else None)
    return WorkflowTrace(trace_id=tid, workflow_name="flow", started_at=1.0, ended_at=1.1, nodes=[node],
                         metadata={"origin": "service", "service": "call"}, wall_started_at=time.time() - 30)


@pytest.fixture()
def hook():
    got = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            got.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}/hooks/secret-token", got
    srv.shutdown()


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    monkeypatch.setenv("OPERONX_STUDIO_ALERTS", "off")
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def test_a_rule_fires_once_and_is_sent(client, tmp_path, hook):
    url, got = hook
    root = tmp_path / "al"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "al"\n', encoding="utf-8")
    store = FilesRunStore(root=root / ".operonx" / "runs", refresh_every=0)
    for i in range(6):
        store.consume(_run(f"r{i}", error=i < 3))
    pid = client.post("/api/open", json={"path": str(root)}).json()["id"]

    rule = {"name": "call errors", "origin": "service", "target": "call", "metric": "error_rate",
            "threshold": 0.2, "window_min": 15, "min_runs": 3, "webhook": url}
    assert client.post(f"/api/p/{pid}/alerts", json=rule).json() == {"saved": "call errors"}
    assert client.post(f"/api/p/{pid}/alerts", json={**rule, "name": "x/../y"}).status_code == 400
    assert client.post(f"/api/p/{pid}/alerts", json={**rule, "name": "b", "metric": "vibes"}).status_code == 400
    assert client.post(f"/api/p/{pid}/alerts", json={**rule, "name": "c", "webhook": "ftp://x"}).status_code == 400

    listed = client.get(f"/api/p/{pid}/alerts").json()["alerts"]
    (a,) = listed
    assert a["now"]["value"] == pytest.approx(0.5) and a["now"]["firing"] and a["last"] is None
    assert a["webhook"] == f"{url.split('/hooks')[0]}/…" and "secret-token" not in json.dumps(listed)

    assert client.post(f"/api/p/{pid}/alerts/check").json()["sent"] == [{"alert": "call errors", "kind": "firing", "status": 204}]
    assert got[0]["state"] == "firing" and "error rate 50.0% (> 20.0%)" in got[0]["text"]
    assert client.post(f"/api/p/{pid}/alerts/check").json()["sent"] == []  # still firing: no repeat yet
    assert client.get(f"/api/p/{pid}/alerts").json()["alerts"][0]["last"]["firing"]

    # an edit without a webhook keeps the one it had
    client.post(f"/api/p/{pid}/alerts", json={**rule, "webhook": "", "threshold": 0.9})
    assert json.loads((root / ".operonx" / "alerts.json").read_text())["alerts"][0]["webhook"] == url
    assert client.post(f"/api/p/{pid}/alerts/call errors/test").json() == {"status": 204}
    assert got[-1]["state"] == "test"
    assert client.delete(f"/api/p/{pid}/alerts/call errors").json() == {"deleted": "call errors"}
    assert client.get(f"/api/p/{pid}/alerts").json()["alerts"] == []
