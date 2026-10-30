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
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from operonx_studio import mcp
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
    edited = client.post(f"/api/p/{pid}/board/m1/act", json={"op": "edit", "card": "C2", "paths": ["calc.py", "x.py"]})
    assert edited.status_code == 200 and "paths changed" in edited.json()["message"], edited.text


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


def test_a_brd_folder_alone_is_a_board_its_checklist_from_the_checkout(client, tmp_path):
    root = make_project(tmp_path / "plain", store=False)
    _git(root, "init", "-q", "-b", "main")
    req = root / "docs" / "brd" / "requirements"
    req.mkdir(parents=True)
    (req / "requirements_traceability.md").write_text(MATRIX, encoding="utf-8")
    (req / "open_questions.md").write_text(QUESTIONS, encoding="utf-8")
    pid = _open(client, root)
    got = client.get(f"/api/p/{pid}/board").json()
    assert isinstance(got.pop("installed"), bool)  # whether this machine has the engine: not the folder's business
    assert got == {"available": True, "schema": 2, "milestones": [], "brd": True, "engine": False,
                   "daemon": {"running": False}, "sandbox": True, "models": {"model": None, "models": {}},
                   "practices": None}
    ck = client.get(f"/api/p/{pid}/brd").json()
    assert ck["branch"] == "main" and ck["brd"] == "docs/brd"
    assert ck["counts"] == {"implemented_verified": 1, "needs_clarification": 1}
    assert [q["id"] for q in ck["questions"]] == ["Q-01"]
    # an engine-driven project has it too, beside its milestones
    pid = _open(client, make_project(tmp_path / "calc"))
    assert client.get(f"/api/p/{pid}/board").json()["brd"] is False  # its matrix is on the milestone's branch only
    assert client.get(f"/api/p/{pid}/brd").json()["rows"] == []


# ── B5: Run/Stop, a new milestone, the live line, the assistant's tools ─────
DAEMON = """#!{python}
# a stand-in daemon: holds the lease while it runs, lets it go on an interrupt
import os, signal, socket, sqlite3, sys, time
if sys.argv[1] != "daemon":
    sys.exit(2)
db = sqlite3.connect(os.path.join(sys.argv[3], ".operonx", "project", "project.db"))
owner = f"{{socket.gethostname()}}:{{os.getpid()}}:ab12"
db.execute("INSERT OR REPLACE INTO lease VALUES ('daemon', ?, ?)", (owner, time.time() + 60))
db.commit()
def bye(*_):
    db.execute("DELETE FROM lease WHERE name='daemon'")
    db.commit()
    sys.exit(0)
signal.signal(signal.SIGINT, bye)
while True:
    time.sleep(0.1)
"""


def _bin(tmp_path: Path, text: str, name: str = "operonx-project") -> Path:
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


def test_run_and_stop_start_and_stop_the_daemon(client, tmp_path, monkeypatch):
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(_bin(tmp_path, DAEMON.format(python=sys.executable))))
    assert client.get(f"/api/p/{pid}/board").json()["daemon"] == {"running": False}

    got = client.post(f"/api/p/{pid}/board/daemon", json={"action": "start"})
    assert got.status_code == 200 and got.json()["status"] == "started", got.text
    d = client.get(f"/api/p/{pid}/board").json()["daemon"]
    assert d["running"] and d["here"] and d["pid"]
    # a second Run is no second daemon
    assert client.post(f"/api/p/{pid}/board/daemon", json={"action": "start"}).json()["status"] == "running"

    got = client.post(f"/api/p/{pid}/board/daemon", json={"action": "stop"})
    assert got.status_code == 200 and got.json()["status"] == "stopped"
    assert client.get(f"/api/p/{pid}/board").json()["daemon"] == {"running": False}
    assert not Path(f"/proc/{d['pid']}").exists() or b"zombie" in Path(f"/proc/{d['pid']}/status").read_bytes().lower()
    assert client.post(f"/api/p/{pid}/board/daemon", json={"action": "go"}).status_code == 400


def test_a_daemon_elsewhere_is_not_stopped_from_here(client, tmp_path):
    root = make_project(tmp_path / "calc")
    con = sqlite3.connect(root / ".operonx" / "project" / "project.db")
    con.execute("INSERT INTO lease VALUES ('daemon', 'other-host:4242:ff', ?)", (time.time() + 60,))
    con.commit()
    con.close()
    pid = _open(client, root)
    got = client.post(f"/api/p/{pid}/board/daemon", json={"action": "stop"})
    assert got.status_code == 409 and "other-host" in got.json()["message"]


def test_settings_say_when_the_coders_run_unsandboxed(client, tmp_path):
    root = make_project(tmp_path / "calc")
    (root / ".operonx" / "project" / "settings.toml").write_text("sandbox = false\n", encoding="utf-8")
    assert client.get(f"/api/p/{_open(client, root)}/board").json()["sandbox"] is False


def test_a_new_milestone_is_the_engines_start_and_says_who_asked(client, tmp_path, monkeypatch):
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)
    log = tmp_path / "engine"
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(_bin(tmp_path, FAKE.format(log=log))))
    got = client.post(f"/api/p/{pid}/board/new", json={"title": "double", "rows": ["CALC-REQ-MATH-02"], "op": "pause"})
    assert got.status_code == 200, got.text
    assert json.loads((tmp_path / "engine.stdin").read_text()) == {"title": "double", "rows": ["CALC-REQ-MATH-02"],
                                                                   "op": "start"}  # fmt: skip
    client.post(f"/api/p/{pid}/board/new", json={"title": "x", "goal": "y"}, headers={"x-operonx-via": "assistant"})
    assert (tmp_path / "engine.argv").read_text().split()[4] == "studio:local/assistant"


def test_a_running_card_shows_what_its_session_does_now(client, tmp_path):
    root = make_project(tmp_path / "calc")
    con = sqlite3.connect(root / ".operonx" / "project" / "project.db")
    con.execute("UPDATE cards SET state='running', stage='implement' WHERE milestone='m1' AND id='C2'")
    for at, text in ((1.0, "reads calc.py"), (2.0, "runs pytest tests/")):
        con.execute("INSERT INTO events (at, milestone, card, kind, actor, data) VALUES (?, 'm1', 'C2', 'activity', "
                    "'implementer', ?)", (at, json.dumps({"text": text})))  # fmt: skip
    con.commit()
    con.close()
    cards = {c["id"]: c for c in client.get(f"/api/p/{_open(client, root)}/board/m1").json()["cards"]}
    assert cards["C2"]["activity"] == {"text": "runs pytest tests/", "at": 2.0}
    assert "activity" not in cards["C1"]  # done: no live line


class BoardStudio(mcp.Studio):
    """The assistant's tool server, its HTTP calls routed into the TestClient."""

    def __init__(self, client: TestClient, pid: str):
        super().__init__("http://testserver", pid)
        self.client, self.shown = client, []

    def call(self, path: str, body=None, **params):
        if path == "/ui/action":
            self.shown.append(body)
            return {}
        url = f"/api/p/{self.pid}{path}"
        res = self.client.post(url, json=body, headers={"x-operonx-via": "assistant"}) if body is not None \
            else self.client.get(url, params=params)  # fmt: skip
        if res.status_code >= 400:
            got = res.json()
            raise RuntimeError(got.get("error") or got.get("message") or f"HTTP {res.status_code}")
        return res.json()


def _tool(s: mcp.Studio, name: str, **args):
    got = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}, s)
    return got["result"]["content"][0]["text"]


def test_the_assistant_reads_the_board_and_opens_it(client, tmp_path):
    root = make_project(tmp_path / "calc")
    s = BoardStudio(client, _open(client, root))
    text = _tool(s, "board_status")
    assert "Daemon: stopped" in text and "- m1 · calc" in text and "1/2 cards done" in text
    text = _tool(s, "board_status", milestone="m1")
    assert "C2 · " in text and "asks the owner" in text and "Open question Q-01" in text
    assert _tool(s, "board_card", milestone="m1", card="C2").startswith("C2 · ")
    assert [x["args"] for x in s.shown] == [{"view": "board"}, {"mid": "m1", "view": "board"},
                                            {"mid": "m1", "card": "C2"}]  # fmt: skip
    assert "no 'C9' here" in _tool(s, "board_card", milestone="m1", card="C9")
    assert _tool(s, "board_act", milestone="m1", op="take").startswith("no op 'take'")


TAKER = """#!{python}
# a stand-in engine for take/submit: C2 parks for its taker, then passes on a submit
import json, pathlib, sys
state = pathlib.Path({state!r})
req = json.loads(sys.stdin.read())
seen = json.loads(state.read_text()) if state.exists() else []
seen.append([sys.argv[5], req])
state.write_text(json.dumps(seen))
ops = [r["op"] for _, r in seen]
if req["op"] in ("take", "submit"):
    print(json.dumps({{"ok": True, "status": "queued", "message": req["op"] + " queued", "seq": len(seen)}}))
elif req["op"] == "card":
    done = "submit" in ops
    print(json.dumps({{"ok": True, "status": "done", "card": "C2", "title": "double", "state": "done" if done
                      else "waiting_human", "stage": None, "taken": {{"actor": sys.argv[5]}}, "waiting_for_submit":
                      not done, "worktree": "/w/C2", "branch": "milestone/m1/C2", "intent": "double a number",
                      "rows": ["CALC-REQ-MATH-02"], "criteria": ["double(2) == 4"], "paths": ["calc.py"],
                      "acceptance_tests": "tests/acceptance/C2", "round": 1, "feedback": "", "reason": ""}}))
"""


def test_the_assistant_takes_a_card_and_submits_it(client, tmp_path, monkeypatch):
    root = make_project(tmp_path / "calc")
    state = tmp_path / "seen.json"
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(_bin(tmp_path, TAKER.format(python=sys.executable, state=str(state)))))
    s = BoardStudio(client, _open(client, root))
    text = _tool(s, "board_take", milestone="m1", card="C2")
    assert "Work in /w/C2 (branch milestone/m1/C2)" in text and "double(2) == 4" in text and "board_submit" in text
    assert _tool(s, "board_submit", milestone="m1", card="C2", summary="added double", wait=5) == "C2: done"
    seen = json.loads(state.read_text())
    assert [r["op"] for _, r in seen if r["op"] != "card"] == ["take", "submit"]
    assert {actor for actor, _ in seen} == {"studio:local/assistant"}
    assert next(r for _, r in seen if r["op"] == "submit")["summary"] == "added double"


REQUESTER = """#!/bin/sh
# a stand-in engine for request: records its stdin, answers with the new milestone
cat > "{log}.stdin"
echo '{{"ok": true, "status": "queued", "milestone": "m2", "seq": 3, "source": "sources/owner_requests/x.md", "message": "m2 created from the request"}}'
"""


def test_the_owners_words_go_to_the_engine_as_a_request(client, tmp_path, monkeypatch):
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)
    log = tmp_path / "engine"
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(_bin(tmp_path, REQUESTER.format(log=log))))
    got = client.post(f"/api/p/{pid}/board/request", json={"text": "remember the last tip", "op": "cancel"})
    assert got.status_code == 200 and got.json()["milestone"] == "m2", got.text
    assert json.loads((tmp_path / "engine.stdin").read_text()) == {"text": "remember the last tip", "op": "request"}
    s = BoardStudio(client, pid)
    text = _tool(s, "board_request", text="halve a number, too")
    assert text.startswith("m2 created from the request") and "sources/owner_requests/x.md" in text
    assert json.loads((tmp_path / "engine.stdin").read_text())["text"] == "halve a number, too"
    assert s.shown[-1]["args"] == {"mid": "m2", "view": "board"}


@pytest.mark.skipif(_real_engine() is None, reason="operonx-project is not installed here")
def test_the_assistant_sets_every_session_to_sonnet(client, tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_PROJECT_BIN", _real_engine())
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)
    s = BoardStudio(client, pid)
    assert "- fable: " in _tool(s, "board_models")  # the engine's defaults
    text = _tool(s, "board_models", model="sonnet")
    assert text.startswith("Changed.") and "- sonnet: " in text and "fable" not in text and "opus" not in text
    assert client.get(f"/api/p/{pid}/board").json()["models"] == {"model": "sonnet", "models": {}}
    assert "refused: not a model: gpt-5" in _tool(s, "board_models", model="gpt-5")
    got = client.post(f"/api/p/{pid}/board/settings", json={"models": {"implementer": "opus"}}).json()
    assert got["effective"]["implementer"] == "opus" and got["effective"]["reviewer"] == "sonnet"


def test_an_adopted_baseline_shows_the_checkouts_checklist(client, tmp_path):
    root = make_project(tmp_path / "calc")
    req = root / "docs" / "brd" / "requirements"
    req.mkdir(parents=True)
    (req / "requirements_traceability.md").write_text(MATRIX, encoding="utf-8")
    con = sqlite3.connect(root / ".operonx" / "project" / "project.db")
    con.execute("UPDATE milestones SET id='m0' WHERE id='m1'")
    con.execute("UPDATE cards SET milestone='m0'")
    con.commit()
    con.close()
    got = client.get(f"/api/p/{_open(client, root)}/board/m0/checklist").json()
    assert got["branch"] == "main" and got["counts"] == {"implemented_verified": 1, "needs_clarification": 1}, got
    assert "m0 has no branch" in got["note"]
    # done, but no branch of its own: nothing to ship, so the Board offers no Ship (tipcalc B8 screenshots)
    con = sqlite3.connect(root / ".operonx" / "project" / "project.db")
    con.execute("UPDATE milestones SET state='done'")
    con.commit()
    con.close()
    pid = _open(client, root)
    assert client.get(f"/api/p/{pid}/board/m0").json()["shippable"] is False
    subprocess.run(["git", "branch", "milestone/m0/main"], cwd=root, check=True, capture_output=True)
    assert client.get(f"/api/p/{pid}/board/m0").json()["shippable"] is True


def test_a_shipped_milestone_shows_its_pr_and_whether_merge_is_granted(client, tmp_path):
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)
    assert client.get(f"/api/p/{pid}/board/m1").json()["shipped"] is None
    shipped = {"branch": "milestone/m1/main", "base": "main", "remote": "github", "pr": "https://github.com/o/r/pull/7"}
    con = sqlite3.connect(root / ".operonx" / "project" / "project.db")
    con.execute("INSERT INTO steps VALUES ('ms:m1:shipped', 0, ?)", (json.dumps(shipped),))
    con.commit()
    con.close()
    (root / ".operonx" / "project" / "settings.toml").write_text("merge = true\n", encoding="utf-8")
    got = client.get(f"/api/p/{pid}/board/m1").json()
    assert got["shipped"] == shipped and got["merge_granted"] is True


def test_what_waits_on_the_owner_across_every_board(client, tmp_path):
    root = make_project(tmp_path / "calc")
    _open(client, root)
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "operonx.toml").write_text('[project]\nname = "plain"\n', encoding="utf-8")
    _open(client, plain)  # not a board: not listed
    got = client.get("/api/boards/waiting").json()
    assert [b["name"] for b in got["boards"]] == ["calc"]
    board = got["boards"][0]
    assert got["count"] == len(board["waiting"]) >= 1
    assert {"id", "qid", "milestone", "card", "problem"} <= set(board["waiting"][0])
    assert board["milestones"][0]["id"] == "m1"


def test_linked_milestones_show_on_both_boards(client, tmp_path, monkeypatch):
    calc, other = make_project(tmp_path / "calc"), make_project(tmp_path / "other")
    index = tmp_path / "projects.json"
    index.write_text(json.dumps({"calc": str(calc / ".operonx" / "project"),
                                 "other": str(other / ".operonx" / "project")}), encoding="utf-8")  # fmt: skip
    monkeypatch.setenv("OPERONX_PROJECTS_INDEX", str(index))
    con = sqlite3.connect(other / ".operonx" / "project" / "project.db")
    con.execute("INSERT INTO steps VALUES ('ms:m1:needs', 0, ?)", (json.dumps({"needs": ["calc#m1", "gone#m4"]}),))
    con.commit()
    con.close()
    mine = client.get(f"/api/p/{_open(client, other)}/board/m1").json()
    state = client.get(f"/api/p/{_open(client, calc)}/board/m1").json()
    assert mine["needs"] == [{"ref": "calc#m1", "state": state["milestone"]["state"]}, {"ref": "gone#m4", "state": None}]
    assert state["needed_by"] == [{"ref": "other#m1"}] and mine["needed_by"] == []


def _engine_knows(op: str) -> bool:
    """The installed engine answers *op* (an older one says it does not know it)."""
    eng = _real_engine()
    if eng is None:
        return False
    got = subprocess.run([*eng.split(), "api", "--repo", ".", "-"], input=json.dumps({"op": op}),
                         capture_output=True, text=True, cwd=Path(__file__).parent)  # fmt: skip
    return f"unknown op {op!r}" not in got.stdout


def test_the_board_shows_the_practices_the_architecture_and_the_retrospective(client, tmp_path):
    root = make_project(tmp_path / "calc")
    (root / "docs" / "brd").mkdir(parents=True)
    (root / "docs/brd/practices.toml").write_text('[tdd]\nmode = "strict"\n\n[architecture]\nstyle = "clean"\n'
                                                  'private = "forbid"\nlayers = [{ name = "a", paths = ["a/**"] }, '
                                                  '{ name = "b", paths = ["b/**"] }]\n')  # fmt: skip
    db = sqlite3.connect(root / ".operonx/project/project.db")
    retro = {"report": {"cost_usd": 1.5, "rounds": 3, "by_stage": {"plan": 0.4},
                        "cards": [{"id": "C1", "title": "add", "state": "done", "rounds": 3, "cost_usd": 1.1,
                                   "failed_checks": ["acceptance"], "rewritten": [], "vacuous": 0, "reopens": 0,
                                   "questions": [{"question": "does add accept strings?", "choice": "a",
                                                  "answer": "numbers only"}]}]},
             "lessons": [{"rule": "add() takes numbers only", "evidence": "C1, Q-01"}], "file": "docs/brd/LESSONS.md"}
    base = {"results": [{"name": "architecture", "ok": False, "failures": ["arch:private:x.py->y._z"]}]}
    end = {"results": [{"name": "architecture", "ok": True, "failures": []}], "fixed": ["architecture"]}
    for key, data in (("retro", retro), ("baseline", base), ("final_checks", end)):
        db.execute("INSERT OR REPLACE INTO steps (key, data) VALUES (?, ?)", (f"ms:m1:{key}", json.dumps(data)))
    detail = json.loads(db.execute("SELECT detail FROM cards WHERE id='C1'").fetchone()[0])
    detail["red"] = {"red": True, "rewritten": True, "passed": 0, "failed": ["t"]}
    db.execute("UPDATE cards SET detail=? WHERE id='C1'", (json.dumps(detail),))
    db.commit()
    db.close()
    pid = _open(client, root)
    assert client.get(f"/api/p/{pid}/board").json()["practices"] == {
        "tdd": "strict", "style": "clean", "layers": 2, "contexts": 0, "private": "forbid", "forbid": 0,
        "command": False, "done": 0, "lessons": ""}
    ms = client.get(f"/api/p/{pid}/board/m1").json()
    assert ms["architecture"] == {"ok": False, "violations": 1, "after": {"ok": True, "violations": 0}}
    assert ms["retro"]["lessons"][0]["rule"] == "add() takes numbers only"
    c1 = next(c for c in ms["cards"] if c["id"] == "C1")
    assert c1["red"] == {"red": True, "rewritten": True, "passed": 0}
    text = _tool(BoardStudio(client, pid), "board_status", milestone="m1")
    assert "red before the code (written again: the first set passed already)" in text
    assert "1 violation(s) already on the milestone's base" in text and "  At final verification: clean" in text
    assert "Retrospective: $1.50 over 1 card(s), 3 round(s); stages plan $0.40" in text
    assert "the owner decided: does add accept strings? → a numbers only" in text
    assert "Lesson (docs/brd/LESSONS.md): add() takes numbers only — C1, Q-01" in text
    (root / "docs/brd/practices.toml").write_text("[tdd\n")
    assert client.get(f"/api/p/{pid}/board").json()["practices"] == {"error": "docs/brd/practices.toml does not parse"}


@pytest.mark.skipif(not _engine_knows("practices"), reason="the installed operonx-project has no practices op")
def test_the_assistant_reads_and_sets_the_practices_through_the_engine(client, tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_PROJECT_BIN", _real_engine())
    root = make_project(tmp_path / "calc")
    (root / "src/calc").mkdir(parents=True)
    (root / "src/calc/ops.py").write_text("import json\n\nD = json._default_decoder\n")
    pid = _open(client, root)
    s = BoardStudio(client, pid)
    text = _tool(s, "board_practices")
    assert "no architecture rules" in text and "Presets: operonx, clean." in text
    text = _tool(s, "board_practices", preview="operonx")
    assert "The operonx preset would flag 1 on the checkout today" in text and "json._default_decoder" in text
    assert not (root / "docs/brd/practices.toml").exists()
    text = _tool(s, "board_practices", preset="operonx")
    assert text.startswith("Changed: wrote docs/brd/practices.toml (commit ")
    assert "src/calc/ops.py:3 src/calc/ops.py touches json._default_decoder" in text
    assert 'mode = "acceptance"' in text  # the file, to edit from
    log = subprocess.run(["git", "log", "-1", "--name-only", "--format=%s"], cwd=root, capture_output=True,
                         text=True).stdout.split()  # fmt: skip
    assert log == ["practices:", "operonx", "(studio:local/assistant)", "docs/brd/practices.toml"]
    edited = text.split("The file (docs/brd/practices.toml):\n", 1)[1].replace('mode = "acceptance"', 'mode = "off"')
    assert "TDD off" not in text and "No acceptance tests are written" in _tool(s, "board_practices", toml=edited)
    assert _tool(s, "board_practices", toml='[tdd]\nmode = "red"\n').startswith("refused: docs/brd/practices.toml "
                                                                              "would not be valid")
    assert client.get(f"/api/p/{pid}/board").json()["practices"]["tdd"] == "off"


def test_the_assistant_reads_the_plan_it_asks_the_owner_to_approve(client, tmp_path):
    """A W1 plan's cards are on no board until it is approved: the approval question carries them."""
    root = make_project(tmp_path / "calc")
    db = sqlite3.connect(root / ".operonx/project/project.db")
    db.row_factory = sqlite3.Row
    row = dict(db.execute("SELECT * FROM interactions WHERE qid='Q-01'").fetchone())
    plan = {"cards": [{"id": "C5", "title": "Remove the hack", "risk": "high", "deps": ["C2"], "paths": ["ops.py"],
                       "intent": "Test first, then delete the class.",
                       "criteria": [{"row": "R1", "text": "WHEN ops.py is read THE SYSTEM SHALL hold no hack"}]}]}
    row.update(id=row["id"] + "-plan", qid="Q-02", short="Q-02", kind="approval", card=None,
               payload=json.dumps({"problem": "Approve m1's plan?", "plan": plan,
                                   "options": [{"key": "approve", "label": "Approve"}]}))  # fmt: skip
    db.execute(f"INSERT INTO interactions ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", list(row.values()))
    db.commit()
    db.close()
    s = BoardStudio(client, _open(client, root))
    text = _tool(s, "board_status", milestone="m1")
    assert "  Plan C5 [risky] · Remove the hack — needs C2 — paths ops.py" in text
    assert "    Test first, then delete the class." in text and "    - WHEN ops.py is read" in text
    # board_card reads a proposed card in full: it is not on the board until the plan is approved
    text = _tool(s, "board_card", milestone="m1", card="C5")
    assert text.startswith("C5 · Remove the hack [proposed, waits for approval, risky] — Test first")
    assert "deps C2; files ops.py" in text and "  - WHEN ops.py is read THE SYSTEM SHALL hold no hack" in text


def test_the_assistant_reads_what_the_engine_saw_when_it_asked(client, tmp_path):
    """tipcalc m3/C5: the question named a rewrite of the held-out tests; without the failing names the
    assistant guessed it was about the acceptance tests."""
    root = make_project(tmp_path / "calc")
    db = sqlite3.connect(root / ".operonx/project/project.db")
    db.row_factory = sqlite3.Row
    row = dict(db.execute("SELECT * FROM interactions WHERE qid='Q-01'").fetchone())
    payload = {**json.loads(row["payload"]), "evidence": "The held-out tests failing:\n- test_direct: {} != errors"}
    db.execute("UPDATE interactions SET payload=? WHERE qid='Q-01'", (json.dumps(payload),))
    db.commit()
    db.close()
    text = _tool(BoardStudio(client, _open(client, root)), "board_status", milestone="m1")
    assert "    The held-out tests failing:\n    - test_direct: {} != errors" in text


def test_a_matrix_of_several_tables_reads_each_row_by_its_own_columns(tmp_path):
    """OneWealth's matrix has six tables with different columns: read with the first table's header, every row
    after it took its status from the Features or Notes cell, and the Board showed ~70 nonsense counts. A
    route with an escaped pipe shifted its row's cells."""
    from operonx_studio.projectboard import project_checklist

    brd = tmp_path / "docs/brd/requirements"
    brd.mkdir(parents=True)
    (brd / "requirements_traceability.md").write_text(
        "| ID | BRD § | Requirement (short) | Features | Code / API | Tests | Status | Evidence |\n"
        "|---|---|---|---|---|---|---|---|\n"
        "| BR-01 | §1 | Three news sources | FEAT-01 | `POST /api/p[/a\\|/b]` | — | implemented_verified | x |\n\n"
        "| ID | Features | Status | Notes |\n|---|---|---|---|\n"
        "| RULE-WF-02 | FEAT-04, 05 | planned | the RM sees it first |\n", encoding="utf-8")
    ck = project_checklist(tmp_path)
    assert ck["counts"] == {"implemented_verified": 1, "planned": 1}
    assert [r["text"] for r in ck["rows"]] == ["Three news sources", "the RM sees it first"]
    assert ck["rows"][0]["cells"][4] == "`POST /api/p[/a|/b]`"


def test_the_engine_is_found_beside_the_studios_python_or_said_missing(tmp_path, monkeypatch):
    """The live studio ran as .venv/bin/python with its venv off PATH: no Board action could reach the engine."""
    from operonx_studio import projectboard as pb

    root = make_project(tmp_path / "calc")
    monkeypatch.delenv("OPERONX_PROJECT_BIN", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path / "nowhere"))
    (tmp_path / "venv/bin").mkdir(parents=True)
    monkeypatch.setattr(pb.sys, "executable", str(tmp_path / "venv/bin/python"))
    assert pb._engine() is None and pb.milestones(root)["installed"] is False
    assert pb.act(root, {"op": "settings"}, "studio")["status"] == "unavailable"
    (tmp_path / "venv/bin/operonx-project").write_text("#!/bin/sh\n")
    assert pb._engine() == [str(tmp_path / "venv/bin/operonx-project")] and pb.milestones(root)["installed"] is True


def _engine_here() -> str | None:
    """The engine as the studio finds it: explicit, on PATH, or beside this Python."""
    beside = Path(sys.executable).parent / "operonx-project"
    return _real_engine() or (str(beside) if beside.is_file() else None)


@pytest.mark.skipif(_engine_here() is None, reason="operonx-project is not installed here")
def test_project_mode_reads_the_engines_status_and_makes_no_store(client, tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_PROJECT_BIN", _engine_here())
    root = make_project(tmp_path / "calc", store=False)
    req = root / "docs" / "brd" / "requirements"
    req.mkdir(parents=True)
    (req / "requirements_traceability.md").write_text(MATRIX, encoding="utf-8")
    (req / "open_questions.md").write_text(QUESTIONS, encoding="utf-8")
    (root / "docs" / "EXPORT_PLAN.md").write_text(
        "---\ntitle: CSV export\nstatus: in_progress\nphases:\n  - {id: E1, title: Rows, status: in_progress}\n---\n",
        encoding="utf-8")  # fmt: skip
    (root / "docs" / "OLD_PLAN.md").write_text("# no block\n", encoding="utf-8")
    pid = _open(client, root)
    got = client.get(f"/api/p/{pid}/project/status")
    assert got.status_code == 200, got.text
    doc = got.json()["project"]
    assert doc["checklist"]["total"] > 0 and [w["sentence"] for w in doc["working_on"]] == ["E1, phase 1 of 1: Rows"]
    assert doc["unmarked"] == ["docs/OLD_PLAN.md"]
    assert not (root / ".operonx" / "project").exists()  # Project mode only reads


def test_project_mode_says_plainly_when_the_engine_is_missing_or_too_old(client, tmp_path, monkeypatch):
    root = make_project(tmp_path / "calc", store=False)
    pid = _open(client, root)
    old = _bin(tmp_path, "#!/bin/sh\ncat > /dev/null\n"
               "echo '{\"ok\": false, \"status\": \"invalid\", \"message\": \"unknown op \\x27status\\x27; one of answer\"}'\n")
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(old))
    got = client.get(f"/api/p/{pid}/project/status")
    assert got.status_code == 503 and "too old for Project mode" in got.json()["message"]
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(tmp_path / "missing"))
    got = client.get(f"/api/p/{pid}/project/status")
    assert got.status_code == 503 and got.json()["status"] == "unavailable"


def test_project_mode_has_its_pages_and_the_board_lives_inside_it(client, tmp_path):
    root = make_project(tmp_path / "calc", store=False)
    pid = _open(client, root)
    page = client.get(f"/p/{pid}/project/plans")
    assert page.status_code == 200
    html = page.text
    pages = [p for p in ("now", "plans", "checklist", "questions", "changes", "settings") if f'data-ppage="{p}"' in html]
    assert pages == ["now", "plans", "checklist", "questions", "changes", "settings"]
    assert 'data-tab="project"' in html and 'data-tab="board"' not in html  # the rail's Board became Project
    static = Path(__file__).resolve().parents[2] / "operonx_studio" / "static"
    shell = (static / "shell.js").read_text(encoding="utf-8")
    assert 'if (name === "board") { switchTab("project", {page: "plans"' in shell  # /board and open_board land there


@pytest.mark.skipif(_engine_here() is None, reason="operonx-project is not installed here")
def test_the_assistant_reads_where_the_project_stands_from_the_engine(client, tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_PROJECT_BIN", _engine_here())
    root = make_project(tmp_path / "calc", store=False)
    req = root / "docs" / "brd" / "requirements"
    req.mkdir(parents=True)
    (req / "requirements_traceability.md").write_text(MATRIX, encoding="utf-8")
    (req / "open_questions.md").write_text(QUESTIONS, encoding="utf-8")
    (root / "docs" / "EXPORT_PLAN.md").write_text(
        "---\ntitle: CSV export\nstatus: in_progress\nphases:\n  - {id: E1, title: Rows, status: in_progress}\n---\n",
        encoding="utf-8")  # fmt: skip
    from operonx_studio.chat import STUDIO_READ_TOOLS

    text = _tool(BoardStudio(client, _open(client, root)), "project_status")
    assert text.startswith("Checklist: ") and "  CSV export — E1, phase 1 of 1: Rows" in text  # the screen's words
    assert "mcp__studio__project_status" in STUDIO_READ_TOOLS  # a viewer's assistant may read it too


def test_the_assistants_bash_finds_the_studios_own_commands():
    from operonx_studio.chat import base_env

    assert str(Path(sys.executable).parent) in base_env()["PATH"].split(os.pathsep)


def test_the_assistant_never_inherits_the_studios_virtualenv(monkeypatch):
    from operonx_studio.chat import base_env

    monkeypatch.setenv("VIRTUAL_ENV", "/elsewhere/.venv")  # the shell that started the studio
    assert "VIRTUAL_ENV" not in base_env()
