"""The studio app: home, open, new, per-project IR, edits, traces.

Everything runs against a scratch registry file and scratch projects, so
these tests never touch ``~/.operonx`` and never depend on a project that
exists outside the test.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit


PROJECT_MAIN = '''
from operonx.core import graph, op, START, END

@op
def shout(text: str = "hi", times: int = 1):
    return {"loud": text.upper() * times}

@graph
def flow():
    a = shout(text="hello", times=2)
    START >> a >> END
'''

MANIFEST = '''
[project]
name = "scratch-demo"

[[graph]]
name  = "flow"
entry = "main:flow"
'''


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "main.py").write_text(PROJECT_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    recents = Recents(state_file=tmp_path / "studio.json")
    return TestClient(build_studio_app(recents))


def _open(client: TestClient, root: Path) -> str:
    res = client.post("/api/open", json={"path": str(root)})
    assert res.status_code == 200, res.text
    return res.json()["id"]


def test_home_and_empty_recents(client):
    assert client.get("/").status_code == 200
    assert client.get("/api/projects").json() == {"projects": []}


def test_open_requires_a_manifest(client, tmp_path):
    bare = tmp_path / "not_a_project"
    bare.mkdir()
    res = client.post("/api/open", json={"path": str(bare)})
    assert res.status_code == 400
    assert "operonx.toml" in res.json()["error"]


def test_open_then_listed_then_forgotten(client, project):
    pid = _open(client, project)
    listed = client.get("/api/projects").json()["projects"]
    assert [p["id"] for p in listed] == [pid]
    assert listed[0]["name"] == "scratch-demo"

    client.post("/api/forget", json={"id": pid})
    assert client.get("/api/projects").json()["projects"] == []


def test_recents_survive_a_restart(tmp_path, project):
    state = tmp_path / "studio.json"
    first = TestClient(build_studio_app(Recents(state_file=state)))
    pid = _open(first, project)
    # a new app instance over the same state file — a studio restart
    second = TestClient(build_studio_app(Recents(state_file=state)))
    assert [p["id"] for p in second.get("/api/projects").json()["projects"]] == [pid]


def test_fs_browser_marks_projects(client, project):
    res = client.get("/api/fs", params={"path": str(project.parent)})
    data = res.json()
    row = next(d for d in data["dirs"] if d["name"] == "demo")
    assert row["is_project"] is True


def test_new_project_scaffolds_and_opens(client, tmp_path):
    res = client.post("/api/new", json={"path": str(tmp_path), "name": "fresh"})
    assert res.status_code == 200, res.text
    root = Path(res.json()["root"])
    assert (root / "operonx.toml").is_file()
    # and it is now a recent, so the studio can reopen it
    assert any(p["root"] == str(root)
               for p in client.get("/api/projects").json()["projects"])


def test_ir_extracts_and_carries_layout(client, project):
    pid = _open(client, project)
    data = client.get(f"/api/p/{pid}/ir").json()
    assert data.get("error") is None, data
    (graph,) = data["graphs"]
    assert graph["name"] == "flow"
    (node,) = [n for n in graph["nodes"] if n["name"] == "a"]
    # layout coordinates are attached to the IR node
    assert isinstance(node["x"], (int, float))
    # and the literal binding the inspector edits is present
    literals = {i["name"] for i in node["inputs"] if i["binding"]["kind"] == "literal"}
    assert {"text", "times"} <= literals


def test_a_broken_project_reports_instead_of_500(client, tmp_path):
    root = tmp_path / "broken"
    root.mkdir()
    (root / "main.py").write_text("import does_not_exist\n", encoding="utf-8")
    (root / "operonx.toml").write_text(
        '[project]\nname="broken"\n[[graph]]\nname="g"\nentry="main:g"\n',
        encoding="utf-8")
    pid = _open(client, root)
    data = client.get(f"/api/p/{pid}/ir").json()
    assert "does_not_exist" in (data.get("error") or "")


def test_set_param_previews_a_diff_then_applies(client, project):
    """The inspector's whole edit path, end to end.

    dry_run defaults on and returns the diff; applying writes the source;
    the next extraction sees the new literal. The file's comment and its
    neighbouring argument survive, because the edit is a token splice, not
    a rewrite.
    """
    pid = _open(client, project)

    preview = client.post(f"/api/p/{pid}/edit", json={
        "graph": "flow", "action": "set_param",
        "op_name": "a", "param": "times", "value": 5,
    }).json()
    assert preview["applied"] is False and preview["changed"] is True
    assert "times=5" in preview["diff"]
    assert "times=2" in (project / "main.py").read_text()   # not yet written

    applied = client.post(f"/api/p/{pid}/edit", json={
        "graph": "flow", "action": "set_param",
        "op_name": "a", "param": "times", "value": 5, "dry_run": False,
    }).json()
    assert applied["applied"] is True
    text = (project / "main.py").read_text()
    assert "times=5" in text and 'text="hello"' in text

    fresh = client.get(f"/api/p/{pid}/ir").json()
    (node,) = [n for n in fresh["graphs"][0]["nodes"] if n["name"] == "a"]
    binding = next(i["binding"] for i in node["inputs"] if i["name"] == "times")
    assert binding["value"] == 5


def test_edit_refuses_wiring_with_a_reason(client, project):
    pid = _open(client, project)
    res = client.post(f"/api/p/{pid}/edit", json={
        "graph": "flow", "action": "set_param",
        "op_name": "a", "param": "missing", "value": 1,
    })
    assert res.status_code == 400
    assert "missing" in res.json()["error"]


def test_traces_unconfigured_says_so(client, project):
    pid = _open(client, project)
    assert client.get(f"/api/p/{pid}/traces").json() == {
        "configured": False, "runs": []}


def test_traces_lists_runs_and_summarises_one(client, project, tmp_path):
    traces = tmp_path / "traces"
    run = traces / "call-001"
    run.mkdir(parents=True)
    records = [
        {"op_name": "a", "duration_ms": 4.0, "status": "ok"},
        {"op_name": "a", "duration_ms": 8.0, "status": "ok"},
        {"op_name": "a", "duration_ms": 6.0, "status": "error", "error": "kaboom"},
    ]
    (run / "nodes.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8")
    manifest = (project / "operonx.toml").read_text()
    (project / "operonx.toml").write_text(
        manifest + f'\n[studio]\ntraces = "{traces}"\n', encoding="utf-8")

    pid = _open(client, project)
    listing = client.get(f"/api/p/{pid}/traces").json()
    assert listing["configured"] and [r["run"] for r in listing["runs"]] == ["call-001"]

    summary = client.get(f"/api/p/{pid}/trace/call-001").json()
    agg = summary["ops"]["a"]
    assert agg["runs"] == 3 and agg["errors"] == 1
    assert agg["max_ms"] == 8.0
    assert agg["last_error"] == "kaboom"


def test_trace_run_names_cannot_walk_out_of_the_root(client, project, tmp_path):
    (project / "operonx.toml").write_text(
        (project / "operonx.toml").read_text()
        + f'\n[studio]\ntraces = "{tmp_path / "traces"}"\n', encoding="utf-8")
    (tmp_path / "traces").mkdir()
    pid = _open(client, project)
    res = client.get(f"/api/p/{pid}/trace/..%2F..%2Fetc")
    assert res.status_code == 404


# ── the semantics a normal workflow tool does not have ──────────────────

LOOP_MAIN = '''
from operonx.core import graph, op, START, END, PARENT
from operonx.core.ops.flow.branch_op import if_

@op
def feed(items: list):
    for item in items:
        yield {"item": item}

@op
def work(item: str = ""):
    return {"out": item}

@op
def gather(outs: list):
    return {"n": len(outs)}

@graph
def streaming(items):
    src = feed(items=items)
    fan = work(item=src["item"].parallel())
    done = gather(outs=fan["out"].collect())
    START >> src >> fan >> done >> END

@op
def think(x: int = 0):
    return {"x": x + 1}

@op
def proceed():
    return {"go": True}

@graph
def agent():
    PARENT.declare(x=0)
    t = think(x=PARENT["x"])
    t["x"] >> PARENT["x"]
    again = proceed()
    START >> t
    t >> if_(PARENT["x"] >= 3, END).else_(again)
    again >> t
'''

LOOP_MANIFEST = '''
[project]
name = "semantics"
[[graph]]
name = "streaming"
entry = "main:streaming"
[[graph]]
name = "agent"
entry = "main:agent"
'''


@pytest.fixture()
def semantics_project(tmp_path: Path) -> Path:
    root = tmp_path / "semantics"
    root.mkdir()
    (root / "main.py").write_text(LOOP_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(LOOP_MANIFEST, encoding="utf-8")
    return root


def test_generators_and_consume_modes_reach_the_canvas(client, semantics_project):
    """A generator dispatches per yield; parallel and collect change the
    run's shape. A canvas that hides any of them draws a different system
    than the one that runs."""
    pid = _open(client, semantics_project)
    data = client.get(f"/api/p/{pid}/ir").json()
    graph = next(g for g in data["graphs"] if g["name"] == "streaming")
    by_name = {n["name"]: n for n in graph["nodes"]}

    assert by_name["src"]["is_gen"] is True
    assert by_name["fan"]["is_gen"] is False

    fan_in = next(i for i in by_name["fan"]["inputs"] if i["name"] == "item")
    assert fan_in["binding"]["consume"] == {"mode": "parallel"}
    done_in = next(i for i in by_name["done"]["inputs"] if i["name"] == "outs")
    assert done_in["binding"]["consume"] == {"mode": "collect"}


def test_a_synthetic_loop_is_opened_back_up_for_display(client, semantics_project):
    """The compiler rewrites an authored cycle into one hidden GraphOp,
    which extracts as a single opaque node with zero edges — correct for
    the scheduler, a lie for the person who wrote the cycle. The canvas
    payload reverses it: members back as nodes, the authored back-edge
    back as an edge marked `back`, every member tagged with its loop."""
    pid = _open(client, semantics_project)
    data = client.get(f"/api/p/{pid}/ir").json()
    graph = next(g for g in data["graphs"] if g["name"] == "agent")

    names = {n["name"] for n in graph["nodes"]}
    assert {"t", "again"} <= names, f"loop members missing: {names}"
    assert not any(n.startswith("__loop_") for n in names), "the hidden box leaked"

    members = [n for n in graph["nodes"] if n.get("loop")]
    assert members and all(m["loop"]["mode"] == "synthetic" for m in members)
    assert all(m["loop"]["max_iterations"] == 1000 for m in members)

    backs = [(e["src"].split(".")[-1], e["dst"].split(".")[-1])
             for e in graph["edges"] if e["back"]]
    assert backs == [("again", "t")], (
        f"the AUTHORED return edge must be the back edge, got {backs}")

    # and the members are laid out forward: t strictly left of again
    by_name = {n["name"]: n for n in graph["nodes"]}
    assert by_name["t"]["x"] < by_name["again"]["x"], (
        "layout let the DFS pick the back edge instead of the author")
