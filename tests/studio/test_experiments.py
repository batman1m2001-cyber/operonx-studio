"""Experiments, compare and the dataset editor, through the studio — E6.

An eval run is an experiment (operonx.app.evals): the studio lists a
project's experiments from its score store (``project_score_store`` —
files, SQLite or ClickHouse) and its job records, shows one with its
gate and its cases, compares two with operonx's own ``compare``, and
edits a dataset's cases through operonx's ``Dataset.update``. Nothing
here computes a statistic: every number on these pages is operonx's.

Gates: one hop per page (the list carries the summaries, the detail the
cases with their trials, the compare everything it shows); an experiment
only the store holds (run in CI) is listed and opened; a store that cannot
be opened is said, and the records are still read; a dataset edit changes
one line of the JSONL and nothing else.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from operonx.app.evals import compare, load_experiment
from operonx.telemetry.scores import open_score_store

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = '''
import itertools

from operonx.core import END, START, graph, op

_wobble = itertools.count()


@op(bound="sync")
def classify_text(text: str = "") -> dict:
    t = text.lower()
    if "great, another" in t:          # the model wobbles: right two times in three
        label = "refund" if next(_wobble) % 3 != 2 else "other"
    else:
        label = "refund" if "money back" in t else "other"
    return {"label": label, "cost_usd": 0.0001, "usage": {"prompt_tokens": 40, "completion_tokens": 2}}


@graph
def flow(text: str = ""):
    classify = classify_text(text=text)
    START >> classify >> END
'''

CHECKS = '''
from operonx.app.evals import exact, trajectory

label = trajectory.op_output("classify", exact("label"), name="label")


def tone(output=None):
    return {"passed": True, "reason": "courteous", "cost_usd": 0.0002}


tone.eval_kind = "judge"
'''

MANIFEST = '''
[project]
name = "experiments-demo"

[[graph]]
name  = "flow"
entry = "main:flow"

[[job]]
name       = "labels"
graph      = "main:flow"
dataset    = "dataset:labels"
item_input = "text"
evaluators = ["checks:label", "checks:tone"]
repeats    = 3
concurrency = 1

[job.gate]
baseline  = "latest"
tolerance = 0.1
'''

CASES = [
    {"id": "a", "input": "I want my money back", "expected": {"label": "refund"}, "tags": ["critical"]},
    {"id": "b", "input": "hello there", "expected": {"label": "other"}, "split": "dev"},
    {"id": "c", "input": "please refund me", "expected": {"label": "refund"}},  # wrong until the fix
    {"id": "d", "input": "Great, another broken kettle", "expected": {"label": "refund"}},  # flaky
    {"id": "e", "input": "thanks!", "expected": {"label": "other"}},
]


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    (root / "datasets").mkdir(parents=True)
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "checks.py").write_text(CHECKS, encoding="utf-8")
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    (root / "datasets" / "labels.jsonl").write_text("".join(json.dumps(c) + "\n" for c in CASES))
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    monkeypatch.delenv("OPERONX_RUNS_DIR", raising=False)
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def _runs(client, pid):
    return next(e for e in client.get(f"/api/p/{pid}/evals").json()["evals"] if e["name"] == "labels")["runs"]


def _experiment(client, pid, timeout=120.0, **body) -> str:
    """Run the eval through the studio (``operonx eval run``) and wait for its record."""
    before = {r["run_id"] for r in _runs(client, pid)}
    res = client.post(f"/api/p/{pid}/evals/labels/run", json=body)
    assert res.status_code == 200, res.text
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        fresh = [r for r in _runs(client, pid) if r["run_id"] not in before]
        if fresh and fresh[0]["status"] != "running":
            return fresh[0]["run_id"]
        time.sleep(0.3)
    log = res.json().get("log")
    raise AssertionError(f"the experiment did not finish: {Path(log).read_text() if log else ''}")


def _fix(root: Path) -> None:
    main = root / "main.py"
    main.write_text(main.read_text().replace('"money back" in t', '"money back" in t or "refund" in t'))


def _break(root: Path) -> None:
    main = root / "main.py"
    main.write_text(main.read_text().replace('"money back" in t or "refund" in t', '"refund" in t'))


@pytest.fixture()
def three(client, project):
    """Three experiments: v1 (c fails, d flaky), v2 (c fixed), v3 (a regressed)."""
    pid = _open(client, project)
    ids = [_experiment(client, pid, variant="v1")]
    _fix(project)
    ids.append(_experiment(client, pid, variant="v2"))
    _break(project)
    ids.append(_experiment(client, pid, variant="v3"))
    return pid, ids


def _store(project: Path):
    return open_score_store({"backend": "files", "root": str(project / ".operonx" / "runs" / "scores")})


# ── the list ─────────────────────────────────────────────────────────────


def test_the_list_carries_each_experiments_verdict_ci_fingerprint_and_cost(client, project, three):
    pid, ids = three
    got = client.get(f"/api/p/{pid}/evals").json()
    assert got["scores"]["openable"] and got["scores"]["source"] == "default: files under the runs root"
    (ev,) = got["evals"]
    rows = ev["experiments"]
    assert [r["id"] for r in rows] == ids[::-1]  # newest first
    v1, v2, v3 = rows[2], rows[1], rows[0]
    assert (v1["variant"], v2["variant"], v3["variant"]) == ("v1", "v2", "v3")
    # the numbers are operonx's: the record's summary, as written
    record = load_experiment(ids[2], record_dirs=[project / "evals"])
    assert v3["verdict"] == record.gate["verdict"] == "regressed"
    assert v3["pass"] == record.metrics["pass"] and set(v3["pass"]) >= {"mean", "ci_lo", "ci_hi", "n", "method"}
    assert v3["reasons"] == record.gate["reasons"] and v3["baseline"] == ids[1]
    fp = record.fingerprint
    assert v3["fingerprint"]["dataset_version"] == fp["dataset_version"]
    assert v3["fingerprint"]["graph_hash"] == fp["graph_hash"] != v2["fingerprint"]["graph_hash"]
    # cost split: the system's own calls vs what judging cost
    assert v1["cost_usd"] == pytest.approx(15 * 0.0001) and v1["judge_cost_usd"] == pytest.approx(15 * 0.0002)
    assert v1["repeats"] == 3 and v1["cases"] == 5 and v1["flaky"] == 1
    assert v1["source"] == "record"


def test_an_experiment_only_the_store_holds_is_listed_and_opened(client, project, three):
    pid, ids = three
    record = project / "evals" / "labels" / ids[1]
    record.rename(project / "elsewhere")  # ran in CI: this machine has only the store's rows
    rows = client.get(f"/api/p/{pid}/experiments", params={"eval": "labels"}).json()["experiments"]
    assert [r["id"] for r in rows] == ids[::-1]
    assert next(r for r in rows if r["id"] == ids[1])["source"] == "store"
    one = client.get(f"/api/p/{pid}/experiments/{ids[1]}").json()
    assert one["experiment"]["source"] == "store" and len(one["cases"]) == 5
    c = next(x for x in one["cases"] if x["case"] == "c")
    # the store keeps no expected value: it is read from the dataset, unchanged since
    assert c["expected"] == {"label": "refund"} and c["input"] == "please refund me" and not c["case_changed"]


def test_a_store_that_cannot_be_opened_is_said_and_the_records_still_read(client, project, three):
    pid, ids = three
    (project / "operonx.toml").write_text(MANIFEST + '\n[evals]\nscores = "score_store:shared"\n')
    got = client.get(f"/api/p/{pid}/evals").json()
    assert not got["scores"]["openable"] and "score_store" in got["scores"]["reason"]
    assert [r["id"] for r in got["evals"][0]["experiments"]] == ids[::-1]
    assert {r["source"] for r in got["evals"][0]["experiments"]} == {"record"}


# ── one experiment ───────────────────────────────────────────────────────


def test_an_experiment_with_its_gate_metrics_and_cases(client, project, three):
    pid, ids = three
    got = client.get(f"/api/p/{pid}/experiments/{ids[2]}").json()
    record = load_experiment(ids[2], record_dirs=[project / "evals"])
    assert got["gate"]["verdict"] == "regressed" and got["gate"]["reasons"] == record.gate["reasons"]
    assert got["gate"]["comparison"]["baseline"] == ids[1]
    assert [m["name"] for m in got["metrics"]][0] == "pass"
    assert {m["name"]: {k: m[k] for k in ("mean", "ci_lo", "ci_hi")} for m in got["metrics"]} == {
        k: {x: v[x] for x in ("mean", "ci_lo", "ci_hi")} for k, v in record.metrics.items()}
    cases = {c["case"]: c for c in got["cases"]}
    a = cases["a"]
    assert a["stability"] == "stable_fail" and a["flip"] == "regressed" and a["passes"] == 0 and a["trials"] == 3
    assert a["failed_checks"] == ["label"] and a["tags"] == ["critical"]
    # the blame: the op the failing check names, an execution of the case's trace
    assert a["blame"]["check"] == "label" and a["blame"]["op"].startswith("flow.classify")
    assert a["blame"]["trace_id"] == a["runs"][0]["trace_id"]
    assert [r["repeat"] for r in a["runs"]] == [0, 1, 2]
    assert a["runs"][0]["checks"]["label"]["reason"]
    assert cases["d"]["stability"] == "flaky" and cases["d"]["passes"] == 2
    assert cases["b"]["stability"] == "stable_pass" and cases["b"]["blame"] is None
    assert got["experiment"]["flaky"] == 1 and got["reliability"]["flaky"] == 1


def test_a_case_drills_down_to_its_runs_and_its_history(client, project, three):
    pid, ids = three
    got = client.get(f"/api/p/{pid}/experiments/{ids[2]}/cases/a").json()
    assert got["input"] == "I want my money back" and got["expected"] == {"label": "refund"}
    assert [r["output"]["label"] for r in got["runs"]] == ["other"] * 3
    assert got["blame"]["op"].startswith("flow.classify")
    # the case across the eval's experiments, oldest first: passed, passed, failed
    assert [(h["experiment"], h["passes"], h["trials"]) for h in got["history"]] == [
        (ids[0], 3, 3), (ids[1], 3, 3), (ids[2], 0, 3)]
    assert client.get(f"/api/p/{pid}/experiments/{ids[2]}/cases/zz").status_code == 404
    assert client.get(f"/api/p/{pid}/experiments/nope/cases/a").status_code == 404


# ── compare ──────────────────────────────────────────────────────────────


def test_compare_is_operonxs_compare(client, project, three):
    pid, ids = three
    got = client.get(f"/api/p/{pid}/experiments/compare", params={"a": ids[1], "b": ids[2]}).json()
    a = load_experiment(ids[1], record_dirs=[project / "evals"])
    b = load_experiment(ids[2], record_dirs=[project / "evals"])
    want = compare(a, b, tolerance=0.1)  # the tolerance B's gate was run with
    assert got["tolerance"] == {"value": 0.1, "from": f"the gate {ids[2]} ran with"}
    assert got["verdict"] == want["verdict"] and got["comparison"] == want["comparison"]
    assert got["warnings"] == want["warnings"] and got["reasons"] == want["reasons"]
    classes = {c["case"]: c["class"] for c in got["cases"]}
    assert classes["a"] == "regressed" and classes["d"] == "noise" and classes["b"] == "same"
    assert (got["a"]["id"], got["b"]["id"]) == (ids[1], ids[2])
    # v1 → v2: c fixed; and no tolerance → compared, not judged
    loose = client.get(f"/api/p/{pid}/experiments/compare",
                       params={"a": ids[0], "b": ids[1], "tolerance": ""}).json()
    assert loose["verdict"] is None and loose["tolerance"] is None
    assert {c["case"]: c["class"] for c in loose["cases"]}["c"] == "fixed"
    assert loose["comparison"]["tests"][0]["metric"] == "pass" and "verdict" not in loose["comparison"]["tests"][0]
    # an inconclusive comparison says so, with the reason operonx gives
    tight = client.get(f"/api/p/{pid}/experiments/compare",
                       params={"a": ids[0], "b": ids[1], "tolerance": "0.01"}).json()
    assert tight["verdict"] == compare(load_experiment(ids[0], record_dirs=[project / "evals"]),
                                       a, tolerance=0.01)["verdict"]
    assert client.get(f"/api/p/{pid}/experiments/compare", params={"a": ids[0], "b": "nope"}).status_code == 404
    assert client.get(f"/api/p/{pid}/experiments/compare",
                      params={"a": ids[0], "b": ids[1], "tolerance": "x"}).status_code == 400


# ── datasets ─────────────────────────────────────────────────────────────


def test_the_dataset_page_has_its_version_and_each_cases_history(client, project, three):
    pid, ids = three
    got = client.get(f"/api/p/{pid}/datasets/labels").json()
    assert got["version"] and got["total"] == 5 and got["splits"] == {"dev": 1}
    assert [e["id"] for e in got["experiments"]] == ids  # oldest first: the strip's columns
    hist = got["history"]
    assert [h["passes"] for h in hist["a"]] == [3, 3, 0]
    assert [h["stability"] for h in hist["c"]] == ["stable_fail", "stable_pass", "stable_pass"]
    assert all(h["stability"] == "flaky" for h in hist["d"])
    listed = client.get(f"/api/p/{pid}/datasets").json()["datasets"]
    assert listed[0]["name"] == "labels" and listed[0]["version"] == got["version"]


def test_a_case_is_edited_through_operonxs_dataset(client, project):
    pid = _open(client, project)
    path = project / "datasets" / "labels.jsonl"
    before = path.read_text().splitlines(keepends=True)
    res = client.patch(f"/api/p/{pid}/datasets/labels/rows/c",
                       json={"expected": {"label": "other"}, "tags": ["edited"], "split": "test"})
    assert res.status_code == 200, res.text
    row = res.json()["row"]
    assert row == {"id": "c", "input": "please refund me", "expected": {"label": "other"},
                   "tags": ["edited"], "split": "test"}
    after = path.read_text().splitlines(keepends=True)
    assert after[:2] == before[:2] and after[3:] == before[3:] and json.loads(after[2]) == row
    # archive: out of every run, still on the page
    assert client.patch(f"/api/p/{pid}/datasets/labels/rows/c", json={"status": "archived"}).status_code == 200
    got = client.get(f"/api/p/{pid}/datasets/labels").json()
    assert got["total"] == 5 and got["active"] == 4
    assert next(r for r in got["rows"] if r["id"] == "c")["status"] == "archived"
    # what operonx refuses, the studio refuses with operonx's reason
    bad = client.patch(f"/api/p/{pid}/datasets/labels/rows/c", json={"input": "x"})
    assert bad.status_code == 400 and "a different input is a different case" in bad.json()["error"]
    assert client.patch(f"/api/p/{pid}/datasets/labels/rows/zz", json={"note": "n"}).status_code == 404
    assert client.patch(f"/api/p/{pid}/datasets/nope/rows/a", json={"note": "n"}).status_code == 404


# ── running one ──────────────────────────────────────────────────────────


def test_a_run_from_the_studio_is_an_experiment_in_the_store(client, project):
    pid = _open(client, project)
    eid = _experiment(client, pid, repeats=2, cases=["a", "d"], variant="rerun ×2")
    # the record is written first; the store's rows follow within the run's scores_timeout
    end = time.monotonic() + 15
    while len(load_experiment(eid, store=_store(project)).items) < 4 and time.monotonic() < end:
        time.sleep(0.2)
    got = load_experiment(eid, store=_store(project))
    assert got.source == "store" and got.summary["variant"] == "rerun ×2"
    assert sorted({i["case"] for i in got.items}) == ["a", "d"] and len(got.items) == 4
    assert client.post(f"/api/p/{pid}/evals/labels/run", json={"repeats": 0}).status_code == 400
    assert client.post(f"/api/p/{pid}/evals/labels/run", json={"cases": ["../x"]}).status_code == 400
    assert client.post(f"/api/p/{pid}/evals/nope/run", json={}).status_code == 404
    # a store the project names but cannot open: refused up front, unless asked to run without it
    (project / "operonx.toml").write_text(MANIFEST + '\n[evals]\nscores = "score_store:shared"\n')
    refused = client.post(f"/api/p/{pid}/evals/labels/run", json={})
    assert refused.status_code == 400 and "score store" in refused.json()["error"]
