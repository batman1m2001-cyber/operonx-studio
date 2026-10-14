"""A run waiting for a person, answered from the studio (Operon
docs/N8N_LANGGRAPH_GAP_PLAN.md S1).

A real bridge under a ``[durable]`` project: a request parks on an
``InterruptOp``; the run is listed under the Waiting filter with its
question; ``POST runs/answer`` resumes it, and its page then holds the whole
run — the steps before the question and after it; answering again is
refused (409), and a body that is not an answer is refused (400).
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = '''
from operonx.app import Application, Service, http
from operonx.core import END, START, InterruptOp, graph, op


@op
async def plan(amount: int) -> dict:
    return {"plan": f"refund {amount}"}


@op
async def pay(response: str, plan: str) -> dict:
    return {"done": f"{plan}: {response}"}


@graph
def refund(amount):
    p = plan(amount=amount)
    ask = InterruptOp(payload=p["plan"])
    a = pay(response=ask["response"], plan=p["plan"])
    START >> p >> ask >> a >> END


APP = Application(
    "refunds",
    services=[Service("refund", http("POST", "/refund", port=8932), graph=refund)],
    resources=None,
    src=["."],
)
'''

MANIFEST = '''
[project]
name = "refunds"
src = ["."]
app = "main:APP"

[durable]
journal = "sqlite:.operonx/journal.db"
'''


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "refunds"
    root.mkdir()
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    monkeypatch.delenv("OPERONX_RUNS_DIR", raising=False)
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _runs(client, pid, **params):
    # the files store rescans at most every 2 s
    for _ in range(60):
        runs = client.get(f"/api/p/{pid}/runs", params=params).json()["runs"]
        if runs:
            return runs
        time.sleep(0.1)
    return []


def test_a_waiting_run_is_listed_answered_and_read_whole(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.post(f"/api/p/{pid}/play/open", json={
        "service": "refund", "toy": "form", "wait": True, "end": True,
        "send": [{"kind": "json", "value": {"amount": 30}}]}).json()
    (out,) = [e for e in got["events"] if e["t"] == "out"]
    parked = out["msg"]["value"]
    run_id, question = parked["run_id"], parked["interrupted"][0]
    assert question["payload"] == "refund 30"

    (waiting,) = _runs(client, pid, status="interrupted")
    assert waiting["trace_id"] == run_id
    tree = client.get(f"/api/p/{pid}/trace/{run_id}/tree").json()
    assert tree["summary"]["status"] == "interrupted"
    asked = tree["summary"]["metadata"]["interrupted"]
    assert [q["id"] for q in asked] == [question["id"]]

    assert client.post(f"/api/p/{pid}/runs/answer", json={"run_id": run_id}).status_code == 400
    done = client.post(f"/api/p/{pid}/runs/answer",
                       json={"run_id": run_id, "answers": {question["id"]: "approve"}})
    assert done.status_code == 200 and done.json()["status"] == "ok", done.text

    for _ in range(60):  # the store rescans; the run is read again, not cached
        tree = client.get(f"/api/p/{pid}/trace/{run_id}/tree").json()
        if tree["summary"]["status"] == "ok":
            break
        time.sleep(0.1)
    assert tree["summary"]["status"] == "ok"
    ops = [r["op"] for r in tree["rows"]]
    assert ops.index("p") < ops.index("ask") < ops.index("a")  # the whole run, in order
    assert ops.count("ask") == 2  # the question as it stopped, then answered
    assert _runs(client, pid, status="interrupted") == []

    again = client.post(f"/api/p/{pid}/runs/answer",
                        json={"run_id": run_id, "answers": {question["id"]: "deny"}})
    assert again.status_code == 409 and "not waiting" in again.json()["error"]
