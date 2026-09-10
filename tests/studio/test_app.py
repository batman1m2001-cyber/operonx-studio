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
    # a FuncOp ships its body — the inspector's collapsed code block
    assert "def shout" in (node.get("code") or "")


def test_pages_fingerprint_their_assets(client, project):
    """Assets cache forever under a content-hashed URL; only the small
    HTML page revalidates. Over a tunnel that is the difference between
    one round trip and one per asset."""
    page = client.get("/")
    assert page.headers["cache-control"] == "no-cache"
    import re
    m = re.search(r"/static/studio\.css\?v=([0-9a-f]{10})", page.text)
    assert m, "asset URLs must carry the version fingerprint"
    pid = _open(client, project)
    proj = client.get(f"/p/{pid}")
    assert f"/static/studio.js?v={m.group(1)}" in proj.text
    asset = client.get(f"/static/studio.js?v={m.group(1)}")
    assert "immutable" in asset.headers["cache-control"]
    bare = client.get("/static/studio.js")
    assert bare.headers["cache-control"] == "no-cache"


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


def test_trace_op_drilldown_ships_inputs_and_outputs(client, project, tmp_path):
    """The trace consumer records what actually went into and came out of
    every execution; a viewer that shows only averages is hiding evidence.
    The drill-down must ship those values exactly as recorded — the write
    side already bounds payload size via its own media_threshold config,
    so nothing here may re-truncate them."""
    traces = tmp_path / "traces"
    run = traces / "call-007"
    run.mkdir(parents=True)
    long_text = "x" * 5000   # e.g. an LLM prompt the consumer chose to keep inline
    records = [
        {"op_name": "a", "duration_ms": 1.0, "status": "ok",
         "inputs": {"text": "hello"}, "outputs": {"loud": "HELLO"}},
        {"op_name": "other", "duration_ms": 9.0, "status": "ok",
         "inputs": {}, "outputs": {}},
        {"op_name": "a", "duration_ms": 2.0, "status": "error", "error": "kaboom",
         "inputs": {"text": long_text}, "outputs": None},
    ]
    (run / "nodes.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8")
    (project / "operonx.toml").write_text(
        (project / "operonx.toml").read_text()
        + f'\n[studio]\ntraces = "{traces}"\n', encoding="utf-8")

    pid = _open(client, project)
    data = client.get(f"/api/p/{pid}/trace/call-007/op/a").json()
    assert data["op"] == "a" and data["total"] == 2 and data["showing"] == 2
    first, second = data["executions"]
    assert first["outputs"] == {"loud": "HELLO"}
    assert second["error"] == "kaboom"
    assert second["inputs"]["text"] == long_text, "values must arrive as recorded"

    # limit bounds the record count, keeping the LAST executions
    limited = client.get(f"/api/p/{pid}/trace/call-007/op/a", params={"limit": 1}).json()
    assert limited["total"] == 2 and limited["showing"] == 1
    assert limited["executions"][0]["status"] == "error"

    # an op with no records answers honestly instead of erroring
    empty = client.get(f"/api/p/{pid}/trace/call-007/op/ghost").json()
    assert empty["total"] == 0 and empty["executions"] == []


def test_a_graphop_drilldown_finds_its_members_records(client, project, tmp_path):
    """A GraphOp never executes under its own name — its members do,
    carrying the container in their dotted path. Clicking the container
    must surface the members' executions, labelled with who ran, instead
    of a wrong 'no records'."""
    traces = tmp_path / "traces"
    run = traces / "call-042"
    run.mkdir(parents=True)
    records = [
        {"op_name": "recognize", "op_full_name": "engine.asr.recognize",
         "duration_ms": 12.0, "status": "ok",
         "inputs": {"speech_audio": "[frames]"}, "outputs": {"transcript": "alo"}},
        {"op_name": "embed", "op_full_name": "engine.asr.embed",
         "duration_ms": 3.0, "status": "ok",
         "inputs": {}, "outputs": {"embedding": [0.1]}},
        {"op_name": "tts", "op_full_name": "engine.tts",
         "duration_ms": 8.0, "status": "ok", "inputs": {}, "outputs": {}},
    ]
    (run / "nodes.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8")
    (project / "operonx.toml").write_text(
        (project / "operonx.toml").read_text()
        + f'\n[studio]\ntraces = "{traces}"\n', encoding="utf-8")

    pid = _open(client, project)
    data = client.get(f"/api/p/{pid}/trace/call-042/op/asr").json()
    assert data["total"] == 2, "both members belong to the container"
    assert [e["op"] for e in data["executions"]] == ["recognize", "embed"]
    assert data["executions"][0]["outputs"] == {"transcript": "alo"}
    # and the leaf op still matches by its own name only
    leaf = client.get(f"/api/p/{pid}/trace/call-042/op/tts").json()
    assert leaf["total"] == 1 and leaf["executions"][0]["op"] == "tts"


def test_trace_run_names_cannot_walk_out_of_the_root(client, project, tmp_path):
    (project / "operonx.toml").write_text(
        (project / "operonx.toml").read_text()
        + f'\n[studio]\ntraces = "{tmp_path / "traces"}"\n', encoding="utf-8")
    (tmp_path / "traces").mkdir()
    pid = _open(client, project)
    res = client.get(f"/api/p/{pid}/trace/..%2F..%2Fetc")
    assert res.status_code == 404


# ── the Langfuse trace source ───────────────────────────────────────────


LF_TRACES = {"data": [
    {"id": "call-abc", "timestamp": "2026-09-01T10:00:00Z", "name": "callbot"},
]}
LF_DETAIL = {"observations": [
    {"name": "stt", "startTime": "2026-09-01T10:00:00Z", "endTime": "2026-09-01T10:00:01Z",
     "level": "DEFAULT", "statusMessage": None,
     "metadata": {"op_full_name": "engine.stt", "status": "ok", "duration_ms": 1000.0},
     "input": {"speech_audio": "[frames]"}, "output": {"transcript": "alo"}},
    {"name": "stt", "startTime": "2026-09-01T10:00:02Z", "endTime": "2026-09-01T10:00:02Z",
     "level": "ERROR", "statusMessage": "kaboom",
     "metadata": {"op_full_name": "engine.stt", "status": "error", "duration_ms": 250.0},
     "input": {}, "output": None},
    {"name": "tts", "startTime": "2026-09-01T10:00:03Z", "endTime": "2026-09-01T10:00:03Z",
     "level": "DEFAULT", "metadata": {"op_full_name": "engine.tts", "status": "ok",
                                      "duration_ms": 40.0},
     "input": {"text": "chào"}, "output": {"audio": "$media_ref"}},
]}


@pytest.fixture()
def langfuse_project(project, monkeypatch):
    """A project declaring a Langfuse source, with the API faked at the
    fetch seam — everything above `_lf_get` (auth, routing, mapping,
    aggregation) runs for real."""
    from operonx_studio import app as app_module

    (project / "operonx.toml").write_text(
        (project / "operonx.toml").read_text()
        + '\n[studio.langfuse]\nhost = "https://lf.example"\n'
          'public_key = "pk"\nsecret_key = "sk"\n', encoding="utf-8")

    def fake_get(cfg, path, **params):
        assert cfg["host"] == "https://lf.example" and cfg["public"] == "pk"
        if path == "/api/public/traces":
            return LF_TRACES
        if path == "/api/public/traces/call-abc":
            return LF_DETAIL
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(app_module, "_lf_get", fake_get)
    return project


def test_langfuse_runs_join_the_listing(client, langfuse_project):
    pid = _open(client, langfuse_project)
    data = client.get(f"/api/p/{pid}/traces").json()
    assert data["configured"] and data["langfuse"] == "https://lf.example"
    (run,) = data["runs"]
    assert run["run"] == "lf:call-abc" and run["source"] == "langfuse"
    assert run["name"] == "callbot"


def test_a_langfuse_trace_paints_like_a_local_one(client, langfuse_project):
    """The consumer shipped op_name/status/duration to Langfuse verbatim;
    read back, the same aggregate shape reaches the canvas."""
    pid = _open(client, langfuse_project)
    summary = client.get(f"/api/p/{pid}/trace/lf:call-abc").json()
    stt = summary["ops"]["stt"]
    assert stt["runs"] == 2 and stt["errors"] == 1
    assert stt["total_ms"] == 1250.0 and stt["last_error"] == "kaboom"
    assert summary["ops"]["tts"]["runs"] == 1


def test_langfuse_drilldown_carries_inputs_and_outputs(client, langfuse_project):
    pid = _open(client, langfuse_project)
    data = client.get(f"/api/p/{pid}/trace/lf:call-abc/op/stt").json()
    assert data["total"] == 2
    first, second = data["executions"]
    assert first["outputs"] == {"transcript": "alo"}
    assert second["status"] == "error" and second["error"] == "kaboom"


def test_a_langfuse_outage_degrades_to_a_note(client, langfuse_project, monkeypatch):
    """The local run list must not die with someone else's server."""
    from operonx_studio import app as app_module

    def broken(cfg, path, **params):
        raise OSError("connection refused")

    monkeypatch.setattr(app_module, "_lf_get", broken)
    pid = _open(client, langfuse_project)
    data = client.get(f"/api/p/{pid}/traces").json()
    assert data["configured"] and "connection refused" in data["langfuse_error"]
    res = client.get(f"/api/p/{pid}/trace/lf:call-abc")
    assert res.status_code == 502


def test_langfuse_env_interpolation(tmp_path, monkeypatch):
    from operonx_studio.app import _langfuse_cfg

    (tmp_path / "operonx.toml").write_text(
        '[project]\nname="x"\n[studio.langfuse]\n'
        'host = "${T_LF_HOST}"\npublic_key = "${T_LF_PK:pk-default}"\n'
        'secret_key = "sk-literal"\n', encoding="utf-8")
    monkeypatch.setenv("T_LF_HOST", "https://lf.internal/")
    cfg = _langfuse_cfg(tmp_path)
    assert cfg == {"host": "https://lf.internal", "public": "pk-default",
                   "secret": "sk-literal"}
    # an unset, defaultless variable leaves the source unconfigured
    monkeypatch.delenv("T_LF_HOST")
    assert _langfuse_cfg(tmp_path) is None


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


def test_branch_routes_reach_the_canvas(client, semantics_project):
    """A branch's whole meaning is which condition routes where. The op
    stores its cases with human descriptions; a canvas drawing identical
    unlabeled arrows out of a router hides the program's logic."""
    pid = _open(client, semantics_project)
    data = client.get(f"/api/p/{pid}/ir").json()
    graph = next(g for g in data["graphs"] if g["name"] == "agent")
    router = next(n for n in graph["nodes"] if n.get("routes"))
    conds = {r["condition"]: r["target"] for r in router["routes"]}
    assert "x >= 3" in conds
    assert conds.get("else") == "again", conds


def test_trace_listing_carries_activity_summaries(client, project, tmp_path):
    """A run row that says only name/date/KB tells the user nothing about
    what happened. The listing aggregates each local run once, cached on
    the file's mtime."""
    traces = tmp_path / "traces"
    run = traces / "call-009"
    run.mkdir(parents=True)
    records = [
        {"op_name": "a", "duration_ms": 5.0, "status": "ok",
         "start_time": 100.0, "end_time": 100.005},
        {"op_name": "b", "duration_ms": 7.0, "status": "error", "error": "x",
         "start_time": 100.01, "end_time": 102.5},
    ]
    (run / "nodes.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8")
    (project / "operonx.toml").write_text(
        (project / "operonx.toml").read_text()
        + f'\n[studio]\ntraces = "{traces}"\n', encoding="utf-8")
    pid = _open(client, project)
    (row,) = client.get(f"/api/p/{pid}/traces").json()["runs"]
    assert row["ops"] == 2 and row["records"] == 2 and row["errors"] == 1
    assert row["wall_s"] == 2.5


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


def test_manifest_declared_boundary_ops_become_doors(client, project):
    """A project with stream-level teardown writes its own ingress/egress
    over current_session(); no function-identity check can see those. The
    manifest names them and the studio tags them like library doors."""
    manifest = (project / "operonx.toml").read_text()
    (project / "operonx.toml").write_text(
        manifest + '\n[studio]\ningress = ["a"]\n', encoding="utf-8")
    pid = _open(client, project)
    data = client.get(f"/api/p/{pid}/ir").json()
    (node,) = [n for n in data["graphs"][0]["nodes"] if n["name"] == "a"]
    assert node["serve_role"] == "ingress"


NESTED_MAIN = '''
from operonx.core import graph, op, START, END

@op
def double(x: int = 1):
    return {"result": x * 2}

@graph
def double_flow(val):
    step = double(x=val)
    START >> step >> END

@graph
def quad(val):
    d1 = double_flow(val=val)
    d2 = double_flow(val=d1["result"])
    START >> d1 >> d2 >> END
'''

NESTED_MANIFEST = '''
[project]
name = "nested"
[[graph]]
name = "quad"
entry = "main:quad"
'''


def test_a_graphop_ships_its_inner_graph_laid_out(client, tmp_path):
    """A GraphOp is a container the canvas can open in place. A box that
    opens onto an unplaced pile of ops would be worse than one that stays
    shut — so the nested graph arrives with coordinates, recursively."""
    root = tmp_path / "nested"
    root.mkdir()
    (root / "main.py").write_text(NESTED_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(NESTED_MANIFEST, encoding="utf-8")
    pid = _open(client, root)
    data = client.get(f"/api/p/{pid}/ir").json()
    assert data.get("error") is None, data

    graph = next(g for g in data["graphs"] if g["name"] == "quad")
    subs = [n for n in graph["nodes"] if n.get("graph")]
    assert len(subs) == 2, f"expected two GraphOp containers, got {len(subs)}"
    for sub in subs:
        inner = sub["graph"]
        assert inner["nodes"], "inner graph lost its nodes"
        for m in inner["nodes"]:
            assert isinstance(m.get("x"), (int, float)), "inner node not laid out"
    # a plain op carries no payload — the container is the exception
    plain = [n for n in graph["nodes"] if not n.get("graph")]
    assert all(n.get("subgraph_ops") is None for n in plain)


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

    # and the members are laid out forward: top-down, t strictly above
    by_name = {n["name"]: n for n in graph["nodes"]}
    assert by_name["t"]["y"] < by_name["again"]["y"], (
        "layout let the DFS pick the back edge instead of the author")


def _traced(project: Path, tmp_path: Path, run: str, records: list) -> None:
    traces = tmp_path / "traces"
    d = traces / run
    d.mkdir(parents=True, exist_ok=True)
    (d / "nodes.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8")
    manifest = (project / "operonx.toml").read_text()
    if "[studio]" not in manifest:
        (project / "operonx.toml").write_text(
            manifest + f'\n[studio]\ntraces = "{traces}"\n', encoding="utf-8")


def test_delete_removes_a_run_and_only_inside_the_root(client, project, tmp_path):
    _traced(project, tmp_path, "call-a", [{"op_name": "a", "duration_ms": 1.0}])
    pid = _open(client, project)
    assert [r["run"] for r in client.get(f"/api/p/{pid}/traces").json()["runs"]] == ["call-a"]

    # traversal out of the traces root must be refused, not resolved
    evil = client.post(f"/api/p/{pid}/trace/..%2F..%2Fsomething/delete")
    assert evil.status_code == 404

    assert client.post(f"/api/p/{pid}/trace/call-a/delete").json() == {"ok": True}
    assert client.get(f"/api/p/{pid}/traces").json()["runs"] == []
    assert not (tmp_path / "traces" / "call-a").exists()


def test_timeline_orders_spans_from_run_start(client, project, tmp_path):
    _traced(project, tmp_path, "call-t", [
        {"op_name": "b", "start_time": 105.0, "duration_ms": 50.0, "status": "ok"},
        {"op_name": "a", "start_time": 100.0, "duration_ms": 20.0, "status": "ok"},
        {"op_name": "a", "start_time": 100.5, "duration_ms": 30.0,
         "status": "error", "error": "kaboom"},
    ])
    pid = _open(client, project)
    data = client.get(f"/api/p/{pid}/trace/call-t/timeline").json()
    assert data["total"] == 3
    spans = data["spans"]
    assert [s["op"] for s in spans] == ["a", "a", "b"]
    assert spans[0]["start"] == 0.0 and spans[2]["start"] == 5.0
    assert spans[1]["error"] == "kaboom"


def test_projects_health_reports_shape_and_traces(client, project, tmp_path):
    _traced(project, tmp_path, "call-h", [{"op_name": "a", "duration_ms": 1.0}])
    pid = _open(client, project)
    client.get(f"/api/p/{pid}/ir")   # ensure extraction has happened
    health = client.get("/api/projects/health").json()["health"]
    info = health[pid]
    assert info["ok"] is True
    assert info["graphs"] == 1 and info["ops"] >= 1
    assert info["runs"] == 1 and info["newest"] > 0
