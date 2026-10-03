"""Script runs, their names and their structured errors, in the Runs screen (W1).

A script run with ``trace="project"`` inside a project lands in its store (C14),
names it after its graph (C13), and writes the run's ``$errors`` records
— ``{type, message, count, first_ctx}`` — into ``meta.json`` (C12). The
run view reads them from ``/tree`` as ``errors``, each with the trace
``op_id`` of the execution that failed first, so the page can link to it.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from operonx.core import END, PARENT, START, GraphOp, Operon, graph, op
from operonx.core.workflow_trace import OpExecution, WorkflowTrace, project_root, set_project_root
from operonx.telemetry.runs.files import FilesRunStore

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit


@op
def each(orders: list):
    for order in orders:
        yield {"order": order}


@op
def enrich(order: dict):
    if order["amount"] < 0:
        raise ValueError(f"order {order['id']} has a negative amount")
    return {"row": order["id"]}


@graph
def analytics(orders):
    e = each(orders=orders)
    en = enrich(order=e["order"])
    START >> e >> en >> END


@pytest.fixture()
def project(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "demo"
    (root / "scripts").mkdir(parents=True)
    (root / "operonx.toml").write_text('[project]\nname = "demo"\n', encoding="utf-8")
    monkeypatch.chdir(root / "scripts")
    monkeypatch.delenv("OPERONX_RUNS_DIR", raising=False)
    before = project_root()
    set_project_root(None)
    yield root
    set_project_root(before)


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def test_a_script_run_is_listed_under_its_graph_with_its_errors(client, project):
    orders = [{"id": 1, "amount": 5}, {"id": 100, "amount": -1}, {"id": 200, "amount": -2}]
    # not held in a variable: the run is named after its graph (C13)
    run = Operon(analytics, params={"orders": None}, trace="project").run(inputs={"orders": orders})
    out = asyncio.run(run)
    assert out["$errors"]["analytics.en"]["count"] == 2

    pid = _open(client, project)
    (run,) = client.get(f"/api/p/{pid}/runs").json()["runs"]
    assert run["origin"] == "adhoc" and run["workflow"] == "analytics" and run["status"] == "error"

    tree = client.get(f"/api/p/{pid}/trace/{run['run']}/tree").json()
    (err,) = tree["errors"]
    assert err["op"] == "analytics.en" and err["name"] == "en"
    assert (err["type"], err["count"]) == ("ValueError", 2)
    assert err["message"].rstrip().endswith("order 100 has a negative amount")
    assert err["op_id"] == f"analytics.en#{err['first_ctx']}"
    row = next(r for r in tree["rows"] if r["id"] == err["op_id"])
    assert row["status"] == "error"


def test_an_error_no_node_shows_is_still_listed(client, project):
    """A structured LLM step returns `error` and its node is `ok`; only
    the run's record knows."""
    node = OpExecution(op_id="flow.ex#main", op_name="ex", op_full_name="flow.ex", ctx=("main",),
                       start_time=100.0, end_time=100.5, inputs={}, outputs={"error": "Parse error"})
    trace = WorkflowTrace(trace_id="r1", workflow_name="flow", started_at=100.0, ended_at=100.5,
                          nodes=[node], wall_started_at=time.time(),
                          errors={"flow.ex": {"type": "ParserError", "count": 1, "first_ctx": "main",
                                              "message": "ParserError: Parse error (json): x"}})
    FilesRunStore(root=project / ".operonx" / "runs", refresh_every=0).consume(trace)
    pid = _open(client, project)
    (run,) = client.get(f"/api/p/{pid}/runs").json()["runs"]
    assert run["status"] == "error" and run["first_error"] == "ex: ParserError: Parse error (json): x"
    (err,) = client.get(f"/api/p/{pid}/trace/r1/tree").json()["errors"]
    assert err["op_id"] == "flow.ex#main" and err["type"] == "ParserError"


def test_a_run_from_before_structured_errors_has_none(client, project):
    node = OpExecution(op_id="flow.a#main", op_name="a", op_full_name="flow.a", ctx=("main",),
                       start_time=100.0, end_time=100.1, inputs={}, outputs={}, status="error",
                       error="Traceback…\nValueError: x")
    trace = WorkflowTrace(trace_id="old", workflow_name="flow", started_at=100.0, ended_at=100.1,
                          nodes=[node], wall_started_at=time.time())
    store = FilesRunStore(root=project / ".operonx" / "runs", refresh_every=0)
    store.consume(trace)
    meta = next((project / ".operonx" / "runs").rglob("meta.json"))

    m = json.loads(meta.read_text())
    m.pop("errors", None)
    m.pop("status", None)
    meta.write_text(json.dumps(m))
    pid = _open(client, project)
    assert client.get(f"/api/p/{pid}/trace/old/tree").json()["errors"] == []
