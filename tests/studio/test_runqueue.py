"""The run queue of a durable service, in the Services tab (PLATFORM_PAGES_PLAN S3):
counts by status, the rows worth a look, and a failed run sent back by hand."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytest.importorskip("operonx.app.queue")
from operonx.app.queue import SqliteQueue  # noqa: E402

pytestmark = pytest.mark.unit

MAIN = '''
from operonx.core import END, START, graph, op
from operonx.app.serve import ingress


@op(bound="sync")
def keep(item=None) -> dict:
    return {"kept": item}


@graph
def flow():
    src = ingress()
    k = keep(item=src["item"])
    START >> src >> k >> END
'''


@pytest.fixture()
def project(tmp_path: Path):
    root = tmp_path / "rq"
    root.mkdir()
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(
        '[project]\nname = "rq"\n\n'
        '[[serve]]\nname = "orders"\nkind = "webhook"\ngraph = "main:flow"\npath = "/orders"\n'
        'port = 8899\nqueue = "runs.db"\n\n'
        '[[serve]]\nname = "plain"\nkind = "http"\ngraph = "main:flow"\npath = "/plain"\nport = 8899\n',
        encoding="utf-8",
    )
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def test_a_queued_service_shows_its_rows_and_a_failed_one_is_retried(client, project):
    queue = SqliteQueue(project / "runs.db")
    waiting = queue.put("orders", {"n": 1}, thread_id="t")
    busy = queue.put("orders", {"n": 2})
    dead = queue.put("orders", {"n": 3}, max_attempts=1)
    queue.claim("orders", "w1")  # `waiting` runs

    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.get(f"/api/p/{pid}/services/queues").json()
    (q,) = got["queues"]  # only the service declared with queue=
    assert q["service"] == "orders" and q["counts"]["queued"] == 2 and q["counts"]["running"] == 1
    shown = {r["id"] for part in ("running", "queued", "ended_badly") for r in q[part]}
    assert {waiting.id, busy.id, dead.id} <= shown

    # a run whose only attempt lapsed fails; a person sends it back
    queue.finish(waiting.id, "w1")
    queue.claim("orders", "w2")  # `busy`
    queue.finish(busy.id, "w2")
    queue.claim("orders", "dead-worker", lease_s=0.05)  # `dead`, its worker then dies
    time.sleep(0.1)
    assert queue.claim("orders", "w3") is None  # its only attempt lapsed: failed
    assert queue.get(dead.id).status == "failed"
    row = client.get(f"/api/p/{pid}/services/queues").json()["queues"][0]["ended_badly"][0]
    assert row["error"]
    retried = client.post(f"/api/p/{pid}/services/queues/requeue", json={"service": "orders", "id": row["id"]})
    assert retried.json() == {"requeued": row["id"], "service": "orders"}
    assert queue.get(row["id"]).status == "queued"
    again = client.post(f"/api/p/{pid}/services/queues/requeue", json={"service": "orders", "id": row["id"]})
    assert again.status_code == 409


def test_no_queued_service_no_section(client, tmp_path):
    root = tmp_path / "plain"
    root.mkdir()
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(
        '[project]\nname = "plain"\n\n[[serve]]\nname = "p"\nkind = "http"\ngraph = "main:flow"\n'
        'path = "/p"\nport = 8898\n',
        encoding="utf-8",
    )
    pid = client.post("/api/open", json={"path": str(root)}).json()["id"]
    assert client.get(f"/api/p/{pid}/services/queues").json() == {"queues": []}
