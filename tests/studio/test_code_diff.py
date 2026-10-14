"""Compare runs: what changed in the code between them — git diff between
the commits the two runs recorded (Operon docs/N8N_LANGGRAPH_GAP_PLAN.md S5)."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx.core.workflow_trace import OpExecution, WorkflowTrace
from operonx.telemetry.consumers.local import LocalConsumer
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True,
                          env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                               "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin"}).stdout.strip()


def _run(root: Path, trace_id: str, version: str, dirty: bool = False) -> None:
    node = OpExecution(op_id="g.a#main", op_name="a", op_full_name="g.a", ctx=("main",), start_time=1.0,
                       end_time=1.01, inputs={}, outputs={"x": 1})
    trace = WorkflowTrace(trace_id=trace_id, workflow_name="g", started_at=1.0, ended_at=1.02, nodes=[node],
                          metadata={"version": version, "version_dirty": dirty}, wall_started_at=time.time())
    LocalConsumer(config={"root": str(root / ".operonx" / "runs")}).consume(trace)


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "shop"\n', encoding="utf-8")
    (root / "main.py").write_text("PRICE = 120\n", encoding="utf-8")
    (root / ".gitignore").write_text(".operonx/\n", encoding="utf-8")
    _git(root, "init", "-q")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "first price")
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    monkeypatch.delenv("OPERONX_RUNS_DIR", raising=False)
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def test_two_runs_show_the_code_that_changed_between_them(client, project):
    v1 = _git(project, "rev-parse", "HEAD")[:12]
    (project / "main.py").write_text("PRICE = 90\n", encoding="utf-8")
    _git(project, "commit", "-q", "-am", "cheaper")
    v2 = _git(project, "rev-parse", "HEAD")[:12]
    _run(project, "run-a", v1)
    _run(project, "run-b", v2, dirty=True)
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]

    got = client.get(f"/api/p/{pid}/compare/code", params={"a": "run-a", "b": "run-b"}).json()
    assert got["a"]["version"] == v1 and got["b"] == {"run": "run-b", "version": v2, "dirty": True}
    (f,) = got["files"]
    assert (f["path"], f["added"], f["removed"]) == ("main.py", 1, 1)
    assert "-PRICE = 120" in f["patch"] and "+PRICE = 90" in f["patch"]
    assert [c["subject"] for c in got["commits"]] == ["cheaper"]

    same = client.get(f"/api/p/{pid}/compare/code", params={"a": "run-a", "b": "run-a"}).json()
    assert same["same"] is True and same["files"] == []


def test_a_commit_the_checkout_lacks_is_said_not_failed(client, project):
    _run(project, "run-a", _git(project, "rev-parse", "HEAD")[:12])
    _run(project, "run-b", "0123456789ab")
    _run(project, "run-c", "--output=x")  # never reaches git as an option
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.get(f"/api/p/{pid}/compare/code", params={"a": "run-a", "b": "run-b"}).json()
    assert "not in this checkout" in got["why"]
    bad = client.get(f"/api/p/{pid}/compare/code", params={"a": "run-a", "b": "run-c"}).json()
    assert "not a commit" in bad["why"]
