"""The studio reads runs only through the project's RunStore — P1.

Gates: which store a project gets (declared store, named store, a
``[studio] traces`` directory, the default ``.operonx/runs``), that the
Runs list filters and pages through it, and that retention is read from
and written to ``operonx.toml`` — previewed before anything is deleted,
applied when saved, never touching another line of the file.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx.core.workflow_trace import OpExecution, WorkflowTrace
from operonx.telemetry.consumers.local import LocalConsumer
from operonx.telemetry.runs.files import FilesRunStore
from operonx.telemetry.runs.sqlite import SqliteRunStore

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents
from operonx_studio.runs import (
    _store_spec,
    project_runs,
    read_retention,
    write_retention,
)

pytestmark = pytest.mark.unit

MANIFEST = '[project]\nname = "runs-demo"\n\n[[graph]]\nname = "flow"\nentry = "main:flow"\n'
MAIN = "from operonx.core import graph, op, START, END\n\n@op\ndef a(x: int = 1):\n    return {'y': x}\n\n@graph\ndef flow():\n    s = a()\n    START >> s >> END\n"
NOW = time.time()


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def _trace(tid, *, age_days=0.0, error=False, **meta):
    start = 100.0
    node = OpExecution(
        op_id=f"g.a#{tid}", op_name="a", op_full_name="g.a", ctx=("main",),
        start_time=start, end_time=start + 0.01, inputs={}, outputs={"y": 1},
        upstreams=[], status="error" if error else "ok", error="Boom" if error else None,
    )
    return WorkflowTrace(trace_id=tid, workflow_name="flow", started_at=start, ended_at=start + 0.01,
                         nodes=[node], metadata=meta, wall_started_at=NOW - age_days * 86400)


def _seed(root: Path, expired: bool = False):
    """Four runs. With ``expired`` the service and playground runs are past
    the default retention (30 d / 7 d); without, every run is inside it.
    The job run is 400 days old either way — jobs are kept forever."""
    runs = root / ".operonx" / "runs"
    store = FilesRunStore(root=runs, refresh_every=0)
    store.consume(_trace("call-new", origin="service", service="call", session_id="0912"))
    store.consume(_trace("call-old", age_days=45 if expired else 20, origin="service", service="call",
                         error=True))
    store.consume(_trace("item-old", age_days=400, origin="job", job="qc", job_run="R1", key="k1"))
    store.consume(_trace("play-old", age_days=10 if expired else 3, origin="playground", service="call"))
    return store


# -- which store --------------------------------------------------------------------


def test_default_is_the_projects_runs_dir(project):
    spec, source = _store_spec(project)
    assert spec == {"backend": "files", "root": str(project / ".operonx" / "runs")}
    assert source.endswith(".operonx/runs")


def test_a_declared_default_store_wins_and_relative_paths_anchor_at_the_project(project):
    (project / "resources.yaml").write_text("run_store:\n  default:\n    backend: sqlite\n    path: data/runs.sqlite\n")
    spec, source = _store_spec(project)
    assert spec["backend"] == "sqlite" and spec["path"] == str(project / "data" / "runs.sqlite")
    assert source == "run_store:default (sqlite)"


def test_studio_runs_names_a_store(project, monkeypatch):
    monkeypatch.setenv("T_RUNS", "/srv/runs")
    (project / "resources.yaml").write_text(
        "run_store:\n  default:\n    backend: sqlite\n  shared:\n    backend: files\n    root: ${T_RUNS}\n")
    (project / "operonx.toml").write_text(MANIFEST + '\n[studio]\nruns = "run_store:shared"\n')
    spec, source = _store_spec(project)
    assert spec == {"backend": "files", "root": "/srv/runs"} and source.startswith("run_store:shared")


def test_a_traces_dir_is_read_as_a_files_store(project, tmp_path):
    (project / "operonx.toml").write_text(MANIFEST + f'\n[studio]\ntraces = "{tmp_path / "t"}"\n')
    spec, _ = _store_spec(project)
    assert spec == {"backend": "files", "root": str(tmp_path / "t")}


def test_the_store_reopens_when_its_configuration_changes(project):
    first = project_runs(project, sweep=False)
    assert isinstance(first.store, FilesRunStore)
    assert project_runs(project, sweep=False) is first  # cached
    time.sleep(0.01)
    (project / "resources.yaml").write_text("run_store:\n  default:\n    backend: sqlite\n")
    again = project_runs(project, sweep=False)
    assert again is not first and isinstance(again.store, SqliteRunStore)


# -- the Runs list -------------------------------------------------------------------


def test_runs_filter_search_order_and_page(client, project):
    _seed(project)
    pid = _open(client, project)

    def ids(**params):
        return [r["run"] for r in client.get(f"/api/p/{pid}/runs", params=params).json()["runs"]]

    assert ids() == ["call-new", "play-old", "call-old", "item-old"]
    assert ids(origin="service") == ["call-new", "call-old"]
    assert ids(origin="service", status="error") == ["call-old"]
    assert ids(q="k1") == ["item-old"]
    assert ids(meta="session_id:0912") == ["call-new"]
    assert ids(since=NOW - 86400) == ["call-new"]
    assert ids(order="started_asc") == ["item-old", "call-old", "play-old", "call-new"]
    page = client.get(f"/api/p/{pid}/runs", params={"limit": 2}).json()
    assert page["total"] == 4 and page["next"] == "2" and len(page["runs"]) == 2
    bad = client.get(f"/api/p/{pid}/runs", params={"order": "loudest"})
    assert bad.status_code == 400


def test_a_run_opens_and_deletes_through_the_store(client, project):
    _seed(project)
    pid = _open(client, project)
    tree = client.get(f"/api/p/{pid}/trace/call-old/tree").json()
    assert tree["summary"]["status"] == "error" and tree["summary"]["first_error"] == "a: Boom"
    assert client.post(f"/api/p/{pid}/trace/call-old/delete").json() == {"ok": True}
    assert client.get(f"/api/p/{pid}/trace/call-old").status_code == 404
    assert client.post(f"/api/p/{pid}/trace/call-old/delete").status_code == 404


def test_runs_a_plain_local_consumer_wrote_show_up(client, project):
    LocalConsumer(config={"root": project / ".operonx" / "runs"}).consume(
        _trace("written-elsewhere", origin="service", service="call"))
    pid = _open(client, project)
    assert [r["run"] for r in client.get(f"/api/p/{pid}/runs").json()["runs"]] == ["written-elsewhere"]


# -- retention ------------------------------------------------------------------------


def test_retention_defaults_and_overrides(project):
    assert read_retention(project) == {"service": 30, "job": None, "eval": None, "playground": 7, "adhoc": 30}
    (project / "operonx.toml").write_text(
        MANIFEST + '\n[studio.retention]\nservice = 14\njob = "forever"\nbogus = 3\nadhoc = -1\n')
    got = read_retention(project)
    assert got["service"] == 14 and got["job"] is None and "bogus" not in got and got["adhoc"] == 30


def test_write_retention_replaces_only_its_own_table(project):
    body = MANIFEST + '\n[studio]\ntraces = "x"\n\n[studio.retention]\nservice = 30\n\n[[serve]]\nname = "k"\n'
    (project / "operonx.toml").write_text(body)
    write_retention(project, {"service": 10, "job": None, "playground": 2.5})
    text = (project / "operonx.toml").read_text()
    assert text.count("[studio.retention]") == 1
    assert 'service = 10\njob = "forever"\nplayground = 2.5\n' in text
    assert '[studio]\ntraces = "x"' in text and '[[serve]]\nname = "k"' in text
    assert read_retention(project)["playground"] == 2.5
    with pytest.raises(ValueError):
        write_retention(project, {"service": -3})


def test_write_retention_appends_when_absent(project):
    write_retention(project, {"service": 5})
    assert (project / "operonx.toml").read_text().endswith("[studio.retention]\nservice = 5\n")
    assert read_retention(project)["service"] == 5


def test_settings_preview_then_save_applies_the_policy(client, project):
    _seed(project, expired=True)
    pid = _open(client, project)
    # opening the project swept with the defaults: the 45-day service run
    # and the 10-day playground run were past 30 d / 7 d; the job is kept
    settings = client.get(f"/api/p/{pid}/settings").json()
    assert settings["backend"] == "files" and settings["runs"] == 2
    assert settings["last_sweep"] == {"service": 1, "playground": 1, "adhoc": 0}
    assert settings["retention"]["job"] is None
    preview = client.post(f"/api/p/{pid}/settings/retention/preview",
                          json={"retention": {"job": 30, "service": "forever"}}).json()["preview"]
    assert preview["job"]["runs"] == 1 and preview["job"]["bytes"] > 0
    assert preview["service"] == {"runs": 0, "bytes": 0}
    assert client.get(f"/api/p/{pid}/runs").json()["total"] == 2  # a preview deletes nothing
    saved = client.post(f"/api/p/{pid}/settings/retention", json={"retention": {"job": 30}}).json()
    assert saved["retention"]["job"] == 30 and saved["deleted"]["job"] == 1
    assert [r["run"] for r in client.get(f"/api/p/{pid}/runs").json()["runs"]] == ["call-new"]
    assert "job = 30" in (project / "operonx.toml").read_text()
    bad = client.post(f"/api/p/{pid}/settings/retention", json={"retention": {"job": -1}})
    assert bad.status_code == 400


def test_the_sweep_runs_once_a_day_unless_forced(project):
    _seed(project, expired=True)
    pr = project_runs(project, sweep=False)
    first = pr.sweep()
    assert first["service"] == 1
    FilesRunStore(root=project / ".operonx" / "runs", refresh_every=0).consume(
        _trace("call-older", age_days=60, origin="service", service="call"))
    assert pr.sweep() is first  # within the day: not again
    assert pr.sweep(force=True)["service"] == 1


def test_home_cards_count_runs_through_the_store(client, project):
    _seed(project)
    pid = _open(client, project)
    health = client.get("/api/projects/health").json()["health"][pid]
    assert health["runs"] >= 2 and health["newest"] == pytest.approx(NOW, abs=5)
    assert json.loads(json.dumps(health))  # plain JSON


def test_the_automatic_sweep_can_be_switched_off(project, monkeypatch):
    _seed(project, expired=True)
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    pr = project_runs(project, sweep=False)
    assert pr.sweep() == {} and pr.store.count() == 4  # nothing deleted
    assert pr.sweep(force=True)["service"] == 1  # an explicit save still applies
