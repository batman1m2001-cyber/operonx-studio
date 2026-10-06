"""Evals and datasets, through the studio — P7.

Gates: an eval and its dataset are listed (cases, expectations, who uses
it); an eval is run the way a job is (detached, its record read back) and
its run shows case by case what flipped against the run before — a fix is
``fixed``; a dataset is read and appended to (deduped, names checked); a
one-message playground run becomes a case whose expected output is what
the door sent back; and the assistant's ``run_eval`` reports the pass rate
before → after with the flipped cases.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio import mcp
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = '''
from operonx.core import END, START, graph, op
from operonx.app.serve import egress, ingress


@op(bound="sync")
def classify(text: str = "") -> dict:
    label = "refund" if "money back" in text else "other"
    return {"label": label}


@graph
def classify_flow():
    src = ingress()
    c = classify(text=src["item"])
    out = egress(item=c["label"])
    START >> src >> c >> out >> END


def label_is(output=None, expected=None):
    return {"passed": output == expected, "reason": f"got {output!r}"}


from operonx.app import Application, Eval, Service, http  # noqa: E402

APP = Application(
    "evals-demo",
    services=[Service("classify", http("POST", "/classify", port=8932), graph=classify_flow)],
    jobs=[Eval("labels", graph=classify_flow, dataset="dataset:labels", evaluators=[label_is])],
    trace=["trace_local:default"],
)
'''

MANIFEST = '''
[project]
name = "evals-demo"
app  = "main:APP"

[resources]
overlay = "resources.yaml"
'''

CASES = [
    {"id": "a", "input": "I want my money back", "expected": "refund"},
    {"id": "b", "input": "hello there", "expected": "other"},
    {"id": "c", "input": "please refund me", "expected": "refund"},   # wrong until the fix
]


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    (root / "datasets").mkdir(parents=True)
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    (root / "resources.yaml").write_text("trace_local:\n  default: {}\n", encoding="utf-8")
    (root / "datasets" / "labels.jsonl").write_text("".join(json.dumps(c) + "\n" for c in CASES))
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def _run_eval(client, pid, name="labels", timeout=90.0) -> dict:
    before = {r["run_id"] for r in _eval(client, pid, name)["runs"]}
    assert client.post(f"/api/p/{pid}/jobs/{name}/run", json={}).status_code == 200
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        fresh = [r for r in _eval(client, pid, name)["runs"] if r["run_id"] not in before]
        if fresh and fresh[0]["status"] != "running":
            return fresh[0]
        time.sleep(0.3)
    raise AssertionError("the eval did not finish")


def _eval(client, pid, name):
    return next(e for e in client.get(f"/api/p/{pid}/evals").json()["evals"] if e["name"] == name)


def test_evals_and_datasets_are_listed(client, project):
    pid = _open(client, project)
    got = client.get(f"/api/p/{pid}/evals").json()
    (ev,) = got["evals"]
    assert ev["kind"] == "eval" and ev["dataset"].endswith("datasets/labels.jsonl")
    assert [e.rsplit(":", 1)[-1] for e in ev["evaluators"]] == ["label_is"]
    assert ev["record_dir"] == str(project / "evals") and ev["runs"] == []
    (ds,) = got["datasets"]
    assert (ds["name"], ds["cases"], ds["expected"], ds["used_by"]) == ("labels", 3, 3, ["labels"])


def test_run_twice_and_see_what_the_fix_fixed(client, project):
    pid = _open(client, project)
    first = _run_eval(client, pid)
    assert first["status"] == "failed" and first["eval"]["passed"] == 2 and first["eval"]["cases"] == 3
    detail = client.get(f"/api/p/{pid}/evals/labels/runs/{first['run_id']}").json()
    assert detail["against"] is None and detail["flips"] == {}
    c = next(i for i in detail["items"] if i["key"] == "c")
    assert not c["verdict"]["passed"] and c["verdict"]["checks"]["label_is"]["reason"] == "got 'other'"
    assert c["trace_id"]

    main = project / "main.py"
    main.write_text(main.read_text().replace('if "money back" in text', 'if "money back" in text or "refund" in text'))
    second = _run_eval(client, pid)
    assert second["status"] == "ok" and second["eval"]["pass_rate"] == 1.0
    detail = client.get(f"/api/p/{pid}/evals/labels/runs/{second['run_id']}").json()
    assert detail["against"] == first["run_id"] and detail["flips"] == {"c": "fixed"}
    assert detail["against_eval"]["passed"] == 2
    # against any earlier run, explicitly
    again = client.get(f"/api/p/{pid}/evals/labels/runs/{first['run_id']}",
                       params={"against": second["run_id"]}).json()
    assert again["flips"] == {"c": "regressed"}

    # one round trip: the list carries the run the screen opens
    listed = client.get(f"/api/p/{pid}/evals").json()["detail"]
    assert listed["name"] == "labels" and listed["run_id"] == second["run_id"] and listed["flips"] == {"c": "fixed"}
    asked = client.get(f"/api/p/{pid}/evals", params={"name": "labels", "run": first["run_id"],
                                                      "against": second["run_id"]}).json()["detail"]
    assert {k: asked[k] for k in again} == again

    # the runs are the eval's own in the run store
    runs = client.get(f"/api/p/{pid}/runs", params={"origin": "eval"}).json()["runs"]
    assert len(runs) == 6 and {r["name"] for r in runs} == {"labels"}


def test_datasets_are_read_and_appended(client, project):
    pid = _open(client, project)
    got = client.get(f"/api/p/{pid}/datasets/labels").json()
    assert got["total"] == 3 and [r["id"] for r in got["rows"]] == ["a", "b", "c"]
    added = client.post(f"/api/p/{pid}/datasets/labels/rows",
                        json={"rows": [{"id": "d", "input": "x", "expected": "other"}, {"id": "a", "input": "dup"}]})
    assert added.json()["added"] == ["d"] and added.json()["skipped"] == 1
    fresh = client.post(f"/api/p/{pid}/datasets/new-set/rows", json={"rows": [{"input": "y"}]}).json()
    assert Path(fresh["path"]) == project / "datasets" / "new-set.jsonl"
    assert client.post(f"/api/p/{pid}/datasets/../x/rows", json={"rows": [{"input": 1}]}).status_code in (400, 404)
    assert client.post(f"/api/p/{pid}/datasets/bad name/rows", json={"rows": [{"input": 1}]}).status_code == 400
    assert client.post(f"/api/p/{pid}/datasets/labels/rows", json={}).status_code == 400


def test_a_playground_run_becomes_a_case(client, project):
    pid = _open(client, project)
    got = client.post(f"/api/p/{pid}/play/open", json={
        "service": "classify", "toy": "form", "wait": True, "end": True,
        "send": [{"kind": "json", "value": "can I have my money back"}]}).json()
    run = got["events"][-1]["trace_id"]
    added = client.post(f"/api/p/{pid}/datasets/labels/rows",
                        json={"from_run": run, "expected": True, "tags": ["from-playground"]}).json()
    (case_id,) = added["added"]
    row = next(r for r in client.get(f"/api/p/{pid}/datasets/labels").json()["rows"] if r["id"] == case_id)
    assert row["input"] == "can I have my money back" and row["expected"] == "refund"
    assert row["from"] == {"run": run, "service": "classify"} and row["tags"] == ["from-playground"]


def test_the_assistant_runs_an_eval_and_hears_what_flipped(client, project):
    pid = _open(client, project)

    class S(mcp.Studio):
        def call(self, path, body=None, **params):
            url = f"/api/p/{pid}{path}"
            res = client.post(url, json=body, params=params) if body is not None else client.get(url, params=params)
            assert res.status_code < 400, res.text
            return res.json()

    studio = S("http://testserver", pid)
    first = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": {"name": "run_eval", "arguments": {"name": "labels"}}}, studio)
    text = first["result"]["content"][0]["text"]
    assert "passed 2/3 (66.7%)" in text and "no earlier run" in text and "still failing: c" in text

    main = project / "main.py"
    main.write_text(main.read_text().replace('if "money back" in text', 'if "money back" in text or "refund" in text'))
    second = mcp.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                         "params": {"name": "run_eval", "arguments": {"name": "labels"}}}, studio)
    text = second["result"]["content"][0]["text"]
    assert "passed 3/3 (100.0%)" in text and "before (" in text and "2/3 (66.7%)" in text
    assert "  fixed: c — label_is: got 'refund'" in text
    shown = client.get(f"/api/p/{pid}/ui/actions").json()["actions"]
    assert [a["kind"] for a in shown][-1] == "open_eval"
