"""Starter templates — P9.

Gates, for every template: the project it writes loads as an application
(its service, its job, its eval), its eval passes out of the box, its job
runs clean, and its service answers the example the studio offers — each
in its own process, the way a newcomer's first minutes would run them.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from operonx_project.templates import TEMPLATES, TemplateError, create, describe

pytestmark = pytest.mark.unit


def _py(root: Path, code: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True, timeout=120)


@pytest.mark.parametrize("template", list(TEMPLATES))
def test_a_template_runs_green_out_of_the_box(tmp_path, template):
    root = tmp_path / f"my_{template.replace('-', '_')}"
    create(root, template)
    t = TEMPLATES[template]

    got = _py(root, "import json; from operonx.app import Application; "
                    "print(json.dumps(Application.find('.').describe()))")
    assert got.returncode == 0, got.stderr
    d = json.loads(got.stdout.strip().splitlines()[-1])
    kinds = {j["name"]: j["kind"] for j in d["jobs"]}
    assert "eval" in kinds.values() and "job" in kinds.values() and d["services"]

    for name in t["first_runs"] + [n for n, k in kinds.items() if k == "job" and n not in t["first_runs"]]:
        run = subprocess.run([sys.executable, "-m", "operonx.cli.run", name], cwd=root,
                             capture_output=True, text=True, timeout=180)
        assert run.returncode == 0, f"{name}: {run.stdout}\n{run.stderr}"

    if t["try"]:
        code = f"""
import asyncio, json
from operonx.app import Application
from operonx.app.play import Bridge
app = Application.find('.'); app.bootstrap()
events = []
b = Bridge(app, events.append)
async def go():
    await b.handle({{"op": "open", "sid": "t", "service": {t['try']['service']!r}, "end": True,
                     "send": [{json.dumps(t['try']['message'])}]}})
    for _ in range(300):
        if any(e["t"] == "ended" for e in events): break
        await asyncio.sleep(0.02)
asyncio.run(go())
print(json.dumps(events))
"""
        got = _py(root, code)
        assert got.returncode == 0, got.stderr
        events = json.loads(got.stdout.strip().splitlines()[-1])
        ended = next(e for e in events if e["t"] == "ended")
        assert ended["status"] == "ok" and any(e["t"] == "out" for e in events), events


def test_the_catalogue_and_its_refusals(tmp_path):
    assert {t["id"] for t in describe()} == set(TEMPLATES)
    with pytest.raises(TemplateError, match="no template"):
        create(tmp_path / "x", "blockchain")
    (tmp_path / "full").mkdir()
    (tmp_path / "full" / "keep.txt").write_text("mine")
    with pytest.raises(TemplateError, match="not empty"):
        create(tmp_path / "full", "http-api")


def test_the_studio_creates_from_a_template_and_starts_its_first_runs(tmp_path, monkeypatch):
    import time

    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from operonx_studio.app import build_studio_app
    from operonx_studio.registry import Recents

    monkeypatch.setenv("OPERONX_STUDIO_ALERTS", "off")
    client = TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))
    ids = [t["id"] for t in client.get("/api/templates").json()["templates"]]
    assert ids[0] == "blank" and set(ids[1:]) == set(TEMPLATES)
    got = client.post("/api/new", json={"path": str(tmp_path), "name": "scores", "template": "batch-scorer"}).json()
    assert got["first_runs"] == ["score_reviews", "labels"] and (tmp_path / "scores" / "main.py").is_file()
    log = tmp_path / "scores" / ".operonx" / "first-runs.log"
    end = time.monotonic() + 120
    while time.monotonic() < end and "passed=" not in (log.read_text() if log.is_file() else ""):
        time.sleep(0.5)
    assert "passed=5/5" in log.read_text()  # the eval ran green in the background
    assert client.post("/api/new", json={"path": str(tmp_path), "name": "x", "template": "nope"}).status_code == 400
