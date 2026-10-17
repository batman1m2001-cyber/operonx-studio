"""The Board tab's routes (projectboard.py): a project driven by operonx-project.

The store is a real one: ``fixtures/project_board.sql`` is the engine's own
``project.db`` (a W2 milestone, C1 done, C2 asking the owner Q-01), dumped
as text. Actions run ``operonx-project api``: a fake binary here checks what
the studio sends and how it answers; the real engine, when it is installed,
checks that a second answer is refused.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import stat
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

FIXTURE = Path(__file__).parent / "fixtures" / "project_board.sql"

MATRIX = """# Requirements traceability matrix

| ID | Source § | Requirement (short) | Features | Screens | Code / API | Tests | Status | Evidence, gaps |
|---|---|---|---|---|---|---|---|---|
| CALC-REQ-MATH-01 | §1 | The calculator must add two numbers. | | | calc.add | tests/acceptance/C1/test_c1_add.py::test_adds | implemented_verified | ok |
| CALC-REQ-MATH-02 | §2 | The calculator must double a number. | | | | | needs_clarification | waits on Q-01 |
"""
QUESTIONS = """# Open questions

| ID | Type | Topic | State |
|---|---|---|---|
| Q-01 | ambiguity | C2: Should double() accept strings? | open |
"""


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t"})  # fmt: skip


def make_project(root: Path, store: bool = True) -> Path:
    root.mkdir(parents=True)
    (root / "operonx.toml").write_text('[project]\nname = "calc"\n', encoding="utf-8")
    if store:
        db = root / ".operonx" / "project" / "project.db"
        db.parent.mkdir(parents=True)
        con = sqlite3.connect(db)
        con.executescript(FIXTURE.read_text(encoding="utf-8"))
        con.close()
        _git(root, "init", "-q", "-b", "main")
        _git(root, "commit", "-q", "--allow-empty", "-m", "init")
        _git(root, "checkout", "-q", "-b", "milestone/m1/main")
        req = root / "docs" / "brd" / "requirements"
        req.mkdir(parents=True)
        (req / "requirements_traceability.md").write_text(MATRIX, encoding="utf-8")
        (req / "open_questions.md").write_text(QUESTIONS, encoding="utf-8")
        _git(root, "add", "docs")
        _git(root, "commit", "-q", "-m", "brd")
        _git(root, "checkout", "-q", "main")
    return root


@pytest.fixture()
def client(tmp_path: Path):
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _open(client, root: Path) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def test_the_board_reads_the_engines_store(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "calc"))
    got = client.get(f"/api/p/{pid}/board").json()
    assert got["available"] and [m["id"] for m in got["milestones"]] == ["m1"]
    m = got["milestones"][0]
    assert (m["state"], m["mode"], m["cards"], m["done"], m["open_questions"]) == ("waiting_human", "w2", 2, 1, 1)
    assert m["budget_usd"] and m["running_s"] >= 0

    ms = client.get(f"/api/p/{pid}/board/m1").json()
    cols = {c["key"]: c["cards"] for c in ms["columns"]}
    assert cols["done"] == ["C1"] and cols["in_progress"] == ["C2"]  # parked, its question above the board
    assert next(c for c in ms["columns"] if c["key"] == "in_progress")["limit"] == 1
    (q,) = ms["questions"]
    assert (q["qid"], q["kind"], q["card"]) == ("Q-01", "card", "C2")
    assert [o["label"] for o in q["options"]] == ["Numbers only", "Accept numeric strings"]
    assert q["recommended"] is None  # only the triage recommends; this question came from the implementer
    assert ms["graph"] == {"waves": [["C1"], ["C2"]], "edges": [["C1", "C2"]]}
    assert ms["cursor"] == ms["events"][-1]["seq"] > 0

    c2 = client.get(f"/api/p/{pid}/board/m1/card/C2").json()
    assert c2["card"]["asks"] and c2["card"]["heldout"] >= 1 and c2["events"]
    assert "test_" not in json.dumps(c2["card"].get("heldout"))  # a count, never the held-out tests
    assert client.get(f"/api/p/{pid}/board/m1/card/C9").status_code == 404
    assert client.get(f"/api/p/{pid}/board/m9").status_code == 404


def test_the_checklist_is_the_milestones_matrix(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "calc"))
    ck = client.get(f"/api/p/{pid}/board/m1/checklist").json()
    assert ck["branch"] == "milestone/m1/main"
    rows = {r["id"]: r for r in ck["rows"]}
    assert rows["CALC-REQ-MATH-01"]["status"] == "implemented_verified"
    assert rows["CALC-REQ-MATH-01"]["tests"] == ["tests/acceptance/C1/test_c1_add.py::test_adds"]
    assert rows["CALC-REQ-MATH-02"]["questions"] == ["Q-01"]
    assert ck["counts"] == {"implemented_verified": 1, "needs_clarification": 1}
    assert ck["questions"] == [{"id": "Q-01", "type": "ambiguity", "topic": "C2: Should double() accept strings?",
                                "state": "open", "asked": "open"}]  # fmt: skip


def test_a_project_without_the_engine_has_no_board(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "plain", store=False))
    assert client.get(f"/api/p/{pid}/board").json() == {"available": False}
    assert client.get("/api/p/nope/board").status_code == 404


def test_a_newer_store_is_refused_not_misread(client, tmp_path):
    root = make_project(tmp_path / "calc")
    con = sqlite3.connect(root / ".operonx" / "project" / "project.db")
    con.execute("UPDATE meta SET value='99' WHERE key='schema_version'")
    con.commit()
    con.close()
    got = client.get(f"/api/p/{_open(client, root)}/board")
    assert got.status_code == 409 and "update it" in got.json()["error"]


FAKE = """#!/bin/sh
# a stand-in for operonx-project: records its argv and stdin, answers like the engine
printf '%s\\n' "$@" > "{log}.argv"
cat > "{log}.stdin"
if grep -q '"Q-01"' "{log}.stdin"; then
  echo '{{"ok": false, "status": "already", "message": "already answered (a, 06:25)"}}'
else
  echo '{{"ok": true, "status": "queued", "message": "pause queued for m1", "seq": 7}}'
fi
"""


def test_actions_go_through_the_engine(client, tmp_path, monkeypatch):
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)
    log = tmp_path / "engine"
    fake = tmp_path / "operonx-project"
    fake.write_text(FAKE.format(log=log), encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(fake))

    got = client.post(f"/api/p/{pid}/board/m1/act", json={"op": "pause", "milestone": "m2"})
    assert got.status_code == 200 and got.json()["seq"] == 7
    argv = (tmp_path / "engine.argv").read_text().split()
    assert argv == ["api", "--repo", str(root), "--actor", "studio:local", "-"]
    # the milestone is the route's, whatever the body says
    assert json.loads((tmp_path / "engine.stdin").read_text()) == {"op": "pause", "milestone": "m1"}

    got = client.post(f"/api/p/{pid}/board/m1/act", json={"op": "answer", "ref": "Q-01", "answer": "b"})
    assert got.status_code == 409 and got.json()["status"] == "already"
    assert client.post(f"/api/p/{pid}/board/m1/act", json=["pause"]).status_code == 400

    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(tmp_path / "missing"))
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    got = client.post(f"/api/p/{pid}/board/m1/act", json={"op": "pause"})
    assert got.status_code == 503 and got.json()["status"] == "unavailable"


def _real_engine() -> str | None:
    explicit = os.environ.get("OPERONX_PROJECT_BIN")
    return explicit if explicit and Path(explicit).is_file() else shutil.which("operonx-project")


@pytest.mark.skipif(_real_engine() is None, reason="operonx-project is not installed here")
def test_the_real_engine_takes_one_answer_and_refuses_the_next(client, tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_PROJECT_BIN", _real_engine())
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)
    first = client.post(f"/api/p/{pid}/board/m1/act", json={"op": "answer", "ref": "Q-01",
                                                            "answer": {"choice": "a", "text": ""}})  # fmt: skip
    assert first.status_code == 200, first.text
    assert client.get(f"/api/p/{pid}/board/m1").json()["questions"] == []
    again = client.post(f"/api/p/{pid}/board/m1/act", json={"op": "answer", "ref": "Q-01", "answer": "b"})
    assert again.status_code == 409 and again.json()["status"] == "already"
    started = client.post(f"/api/p/{pid}/board/m1/act", json={"op": "prioritize", "card": "C1", "priority": -5})
    assert started.status_code == 409 and "only a card not started" in started.json()["message"]


@pytest.mark.skipif(_real_engine() is None, reason="operonx-project is not installed here")
def test_a_stale_answer_from_the_studio_is_refused_and_says_what_is_current(client, tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_PROJECT_BIN", _real_engine())
    root = make_project(tmp_path / "calc")
    con = sqlite3.connect(root / ".operonx" / "project" / "project.db")
    con.execute("UPDATE cards SET state='cancelled' WHERE milestone='m1' AND id='C2'")  # a replan dropped it
    con.commit()
    con.close()
    got = client.post(f"/api/p/{_open(client, root)}/board/m1/act", json={"op": "answer", "ref": "Q-01", "answer": "a"})
    assert got.status_code == 409 and got.json()["status"] == "stale", got.text
