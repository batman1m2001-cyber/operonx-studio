"""A run waiting for a person, answered from the studio (Operon
docs/N8N_LANGGRAPH_GAP_PLAN.md S1, S2).

A real bridge under a ``[durable]`` project: a request parks on an
``InterruptOp``; the run is listed under the Waiting filter with its
question; ``POST runs/answer`` resumes it, and its page then holds the whole
run — the steps before the question and after it; answering again is
refused (409), and a body that is not an answer is refused (400). A failed
run is run again from its failed op after the fix: charged once, its page
the failed attempt and the retry in one run.
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
from pathlib import Path

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


CHARGED = Path(__file__).parent / "charged.txt"


@op
async def charge(order: str) -> dict:
    with CHARGED.open("a") as f:  # a side effect that must not happen twice
        f.write(order + "\\n")
    return {"receipt": f"R-{order}"}


@op
async def ship(receipt: str) -> dict:
    if (Path(__file__).parent / "broken").exists():
        raise RuntimeError("the courier is down")
    return {"done": f"{receipt}: shipped"}


@graph
def order(order):
    c = charge(order=order)
    s = ship(receipt=c["receipt"])
    START >> c >> s >> END


APP = Application(
    "refunds",
    services=[
        Service("refund", http("POST", "/refund", port=8932), graph=refund),
        Service("order", http("POST", "/order", port=8932), graph=order),
    ],
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


def test_a_failed_run_is_run_again_from_its_failure(client, project):
    (project / "broken").write_text("", encoding="utf-8")
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.post(f"/api/p/{pid}/play/open", json={
        "service": "order", "toy": "form", "wait": True, "end": True,
        "send": [{"kind": "json", "value": {"order": "A1"}}]}).json()
    run_id = got["events"][-1]["trace_id"]
    (failed,) = _runs(client, pid, status="error")
    assert failed["trace_id"] == run_id
    tree = client.get(f"/api/p/{pid}/trace/{run_id}/tree").json()
    assert tree["summary"]["metadata"]["durable"] is True  # the page offers the retry

    (project / "broken").unlink()  # fixed
    done = client.post(f"/api/p/{pid}/runs/retry", json={"run_id": run_id})
    assert done.status_code == 200 and done.json()["status"] == "ok", done.text
    assert (project / "charged.txt").read_text().split() == ["A1"]  # charged once
    for _ in range(60):
        tree = client.get(f"/api/p/{pid}/trace/{run_id}/tree").json()
        if tree["summary"]["status"] == "ok":
            break
        time.sleep(0.1)
    assert tree["summary"]["status"] == "ok"
    rows = [(r["op"], r["status"]) for r in tree["rows"]]
    assert rows == [("c", "ok"), ("s", "retried"), ("s", "ok")]

    again = client.post(f"/api/p/{pid}/runs/retry", json={"run_id": run_id}).json()
    assert again["status"] == "error" and "no op of the run failed" in again["error"]
    assert client.post(f"/api/p/{pid}/runs/retry", json={}).status_code == 400


def test_a_step_is_changed_and_the_run_continues_from_it(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.post(f"/api/p/{pid}/play/open", json={
        "service": "order", "toy": "form", "wait": True, "end": True,
        "send": [{"kind": "json", "value": {"order": "B2"}}]}).json()
    run_id = got["events"][-1]["trace_id"]

    forked = client.post(f"/api/p/{pid}/runs/fork",
                         json={"run_id": run_id, "at": "c", "ctx": "main", "outputs": {"receipt": "R-X"}})
    assert forked.status_code == 200 and forked.json()["status"] == "ok", forked.text
    new_id = forked.json()["run_id"]
    assert new_id.startswith(run_id + "~")
    assert (project / "charged.txt").read_text().split() == ["B2"]  # charged once

    for _ in range(60):
        tree = client.get(f"/api/p/{pid}/trace/{new_id}/tree")
        if tree.status_code == 200:
            break
        time.sleep(0.1)
    tree = tree.json()
    assert tree["summary"]["status"] == "ok"
    assert tree["summary"]["metadata"]["forked_from"] == run_id
    assert [r["op"] for r in tree["rows"]] == ["c", "s"]
    original = client.get(f"/api/p/{pid}/trace/{run_id}/tree").json()
    assert original["summary"]["status"] == "ok" and len(original["rows"]) == 2  # unchanged

    bad = client.post(f"/api/p/{pid}/runs/fork",
                      json={"run_id": run_id, "at": "c", "outputs": {"nope": 1}})
    assert bad.status_code == 400 and "has no output 'nope'" in bad.json()["error"]
