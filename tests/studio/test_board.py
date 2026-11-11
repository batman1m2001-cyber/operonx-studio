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


def _git_out(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()


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
    assert (m["state"], m["mode"], m["cards"], m["done"]) == ("waiting_human", "w2", 2, 1)
    assert m["budget_usd"] and m["running_s"] >= 0

    ms = client.get(f"/api/p/{pid}/board/m1").json()
    cols = {c["key"]: c["cards"] for c in ms["columns"]}
    assert cols["done"] == ["C1"] and cols["in_progress"] == ["C2"]  # parked, its question above the board
    assert next(c for c in ms["columns"] if c["key"] == "in_progress")["limit"] == 1
    assert ms["cursor"] == ms["events"][-1]["seq"] > 0

    c2 = client.get(f"/api/p/{pid}/board/m1/card/C2").json()
    assert c2["card"]["asks"] and c2["events"]
    assert client.get(f"/api/p/{pid}/board/m1/card/C9").status_code == 404
    assert client.get(f"/api/p/{pid}/board/m9").status_code == 404


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


def _real_engine() -> str | None:
    explicit = os.environ.get("OPERONX_PROJECT_BIN")
    return explicit if explicit and Path(explicit).is_file() else shutil.which("operonx-project")


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
    assert got == {"available": True, "schema": 2, "milestones": [], "brd": True, "engine": False}
    ck = client.get(f"/api/p/{pid}/brd").json()
    assert ck["branch"] == "main" and ck["brd"] == "docs/brd"
    assert ck["counts"] == {"implemented_verified": 1, "needs_clarification": 1}
    assert [q["id"] for q in ck["questions"]] == ["Q-01"]
    # an engine-driven project has it too, beside its milestones
    pid = _open(client, make_project(tmp_path / "calc"))
    assert client.get(f"/api/p/{pid}/board").json()["brd"] is False  # its matrix is on the milestone's branch only
    assert client.get(f"/api/p/{pid}/brd").json()["rows"] == []


# ── the live line, the assistant's tools ─────────────────────────────────


def _bin(tmp_path: Path, text: str, name: str = "operonx-project") -> Path:
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


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
    assert "- m1 · calc" in text and "1/2 cards done" in text
    text = _tool(s, "board_status", milestone="m1")
    assert "C2 · " in text and "asks the owner" in text
    assert _tool(s, "board_card", milestone="m1", card="C2").startswith("C2 · ")
    assert [x["args"] for x in s.shown] == [{"view": "board"}, {"mid": "m1", "view": "board"},
                                            {"mid": "m1", "card": "C2"}]  # fmt: skip
    assert "no 'C9' here" in _tool(s, "board_card", milestone="m1", card="C9")
    assert "board_act" not in json.dumps(mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, s))


def test_what_waits_on_the_owner_across_every_board(client, tmp_path):
    root = make_project(tmp_path / "calc")
    _open(client, root)
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "operonx.toml").write_text('[project]\nname = "plain"\n', encoding="utf-8")
    _open(client, plain)  # not a board: not listed
    (root / "docs/brd/requirements").mkdir(parents=True)
    (root / "docs/brd/requirements/open_questions.md").write_text(QUESTIONS, encoding="utf-8")
    got = client.get("/api/boards/waiting").json()
    assert [b["name"] for b in got["boards"]] == ["calc"]
    board = got["boards"][0]
    assert got["count"] == len(board["waiting"]) == 1
    assert {"id", "qid", "milestone", "card", "problem"} <= set(board["waiting"][0])
    assert board["milestones"][0]["id"] == "m1"


def test_one_list_of_what_waits_the_engine_the_brd_and_the_assistant(client, tmp_path):
    """WORKSPACE_PLAN W1.5: the BRD's open questions and a turn that ended
    on a question, in the waiting list and on the card the turn named."""
    from operonx_studio.assistant import ChatStore

    root = make_project(tmp_path / "calc")
    req = root / "docs" / "brd" / "requirements"
    req.mkdir(parents=True)
    (req / "open_questions.md").write_text(QUESTIONS + "| Q-02 | scope | Is CSV export in v1? | open |\n"
                                           "| Q-03 | scope | Old one | answered |\n", encoding="utf-8")
    pid = _open(client, root)
    store = ChatStore(tmp_path / "assistant.sqlite")
    a = store.create_session(pid, owner="u")["id"]
    store.add_turn("t1", a, message="continue C1", kind="message", claude_before=None)
    store.update_turn("t1", card="m1/C1", state="done", ended=time.time())
    store.put_items(a, [{"seq": 1, "turn": "t1", "kind": "text", "text": "Done with C1.\n\n**Shall I start C2?**"}])
    b = store.create_session(pid, owner="u")["id"]
    store.add_turn("t2", b, message="ship it", kind="message", claude_before=None)
    store.update_turn("t2", state="done", ended=time.time())
    store.put_items(b, [
        {"seq": 1, "turn": "t2", "kind": "tool", "name": "mcp__studio__steps", "status": "ok",
         "plan": {"steps": [{"title": "Build", "state": "done"},
                            {"title": "Deploy", "state": "waiting", "detail": "Push to production?"}]}},
        {"seq": 2, "turn": "t2", "kind": "text", "text": "Built. Waiting on your go."}])
    got = client.get("/api/boards/waiting").json()
    waiting = got["boards"][0]["waiting"]
    assert [(w["source"], w["qid"] or w["problem"]) for w in waiting] == [
        ("brd", "Q-01"), ("brd", "Q-02"), ("assistant", "Shall I start C2?"), ("assistant", "Push to production?")]
    assert got["count"] == 4 and waiting[2]["card"] == "m1/C1" and waiting[2]["session"] == a
    c1 = next(c for c in client.get(f"/api/p/{pid}/board/m1").json()["cards"] if c["id"] == "C1")
    assert c1["asks"] is True and c1["question"].endswith("C2?")
    # the owner answered: a later turn in that session, and it waits no more
    store.add_turn("t3", a, message="yes", kind="message", claude_before=None)
    assert [w["id"] for w in client.get("/api/boards/waiting").json()["boards"][0]["waiting"]][2:] == ["turn:t2"]


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
    assert pb.act(root, {"op": "status"}, "studio")["status"] == "unavailable"
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


def test_project_mode_lists_the_assistants_questions_with_the_engines(client, tmp_path, monkeypatch):
    """WORKSPACE_PLAN W1.5: Project mode's needs-you list has a turn that ended waiting on the owner."""
    from operonx_studio.assistant import ChatStore

    root = make_project(tmp_path / "calc", store=False)
    pid = _open(client, root)
    eng = _bin(tmp_path, "#!/bin/sh\ncat > /dev/null\n"
               "echo '{\"ok\": true, \"status\": \"ok\", \"project\": {\"needs_you\": []}}'\n")
    monkeypatch.setenv("OPERONX_PROJECT_BIN", str(eng))
    store = ChatStore(tmp_path / "assistant.sqlite")
    a = store.create_session(pid, owner="u")["id"]
    store.add_turn("t1", a, message="continue C1", kind="message", claude_before=None)
    store.update_turn("t1", card="m1/C1", state="done", ended=time.time())
    store.put_items(a, [{"seq": 1, "turn": "t1", "kind": "text", "text": "Done with C1. Shall I start C2?"}])
    got = client.get(f"/api/p/{pid}/project/status")
    assert got.status_code == 200, got.text
    assert got.json()["project"]["needs_you"] == [
        {"source": "assistant", "id": "turn:t1", "kind": "assistant", "text": "Done with C1. Shall I start C2?",
         "card": "m1/C1", "session": a, "title": store.session(a)["title"]}]


def test_project_mode_has_its_pages_and_the_board_lives_inside_it(client, tmp_path):
    root = make_project(tmp_path / "calc", store=False)
    pid = _open(client, root)
    page = client.get(f"/p/{pid}/project/plans")
    assert page.status_code == 200
    html = page.text
    pages = [p for p in ("now", "plans", "checklist", "questions", "changes", "settings") if f'data-ppage="{p}"' in html]
    assert pages == ["now", "plans", "changes", "settings"]  # Checklist and Questions are sections of Now
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


PLAN_DOC = ("---\ntitle: CSV export\nstatus: in_progress\nphases:\n  - {id: E1, title: Rows, status: done}\n"
            "  - {id: E2, title: Header, status: in_progress}\n  - {id: E3, title: Docs, status: open}\n---\n")  # fmt: skip


def _engine_plans() -> bool:
    eng = _engine_here()
    if eng is None:
        return False
    got = subprocess.run([eng, "api", "--repo", ".", "-"], input='{"op": "plan"}', capture_output=True, text=True,
                         cwd=Path(__file__).parent)  # fmt: skip
    return "unknown op 'plan'" not in got.stdout


@pytest.mark.skipif(not _engine_plans(), reason="the installed engine has no plan op")
def test_a_plan_doc_is_put_on_the_board_from_the_checkout_or_its_worktree(client, tmp_path, monkeypatch):
    """mr-finance FEATURE_FLOWS_PLAN was worked in chat and never showed on the Board: a plan is its milestone."""
    from operonx_studio import projectboard as pb

    monkeypatch.setenv("OPERONX_PROJECT_BIN", _engine_here())
    root = make_project(tmp_path / "calc")
    (root / "docs").mkdir(exist_ok=True)
    (root / "docs" / "EXPORT_PLAN.md").write_text(PLAN_DOC, encoding="utf-8")
    _git(root, "add", "docs/EXPORT_PLAN.md")
    _git(root, "commit", "-q", "-m", "plan")
    pid = _open(client, root)
    got = client.post(f"/api/p/{pid}/board/plan", json={"path": "docs/EXPORT_PLAN.md"})
    assert got.status_code == 200, got.text
    mid = got.json()["milestone"]
    cards = {c["title"]: c["state"] for c in client.get(f"/api/p/{pid}/board/{mid}").json()["cards"]}
    assert cards == {"E1 Rows": "done", "E2 Header": "running", "E3 Docs": "ready"}, cards

    # the plan moves on in a worktree, its doc not on main yet: the board follows the worktree's copy
    wt = tmp_path / "wt"
    _git(root, "worktree", "add", "-q", "-b", "feat", str(wt))
    head = _git_out(root, "rev-parse", "HEAD")
    (wt / "docs" / "EXPORT_PLAN.md").write_text(PLAN_DOC.replace("in_progress}", "done}"), encoding="utf-8")
    assert pb.plan_request(root, str(wt / "docs" / "EXPORT_PLAN.md"))["path"] == "docs/EXPORT_PLAN.md"
    got = client.post(f"/api/p/{pid}/board/plan", json={"path": str(wt / "docs" / "EXPORT_PLAN.md")})
    assert got.status_code == 200 and got.json()["milestone"] == mid, got.text
    states = [c["state"] for c in client.get(f"/api/p/{pid}/board/{mid}").json()["cards"]]
    assert sorted(states) == ["done", "done", "ready"], states
    # WORKSPACE_PLAN W1.2: a branch's plan moves the store alone, the main checkout gets no commit
    assert _git_out(root, "rev-parse", "HEAD") == head
    assert pb.plan_request(root, str(root / "docs" / "EXPORT_PLAN.md")) == {"op": "plan", "path": "docs/EXPORT_PLAN.md"}

    # W1.1: the doc changed from the shell (no Edit, no board_plan) is found stale, the worktree's copy
    assert pb.stale_plans(root) == []
    doc = wt / "docs" / "EXPORT_PLAN.md"
    doc.write_text(PLAN_DOC.replace("open}", "done}").replace("in_progress}", "done}"), encoding="utf-8")
    later = time.time() + 30
    os.utime(doc, (later, later))
    assert pb.stale_plans(root) == [str(doc)]
    got = client.post(f"/api/p/{pid}/board/plan", json={"path": str(doc)})
    assert got.status_code == 200 and _git_out(root, "rev-parse", "HEAD") == head, got.text
    assert pb.stale_plans(root) == []  # the text the board read, whatever the file's time says

    # W1.3–W1.4: a turn names its card (a steps call's card); the card lists it, lit while it runs, with its
    # evidence: a green test run, base checks, commits. A done phase with nothing run reads "no evidence".
    from operonx_studio.assistant import ChatStore, evidence

    store = ChatStore(tmp_path / "assistant.sqlite")
    sid = store.create_session(pid, owner="u")["id"]
    store.add_turn("t1", sid, message="continue E2", kind="message", claude_before=None)
    store.update_turn("t1", card=f"{wt}/docs/EXPORT_PLAN.md#E2", state="done")
    store.put_items(sid, [
        {"seq": 1, "turn": "t1", "kind": "tool", "name": "Bash", "status": "ok", "input": {"command": "pytest -q"},
         "tests": {"passed": 3, "failed": 1, "skipped": 0, "errors": 0}},
        {"seq": 2, "turn": "t1", "kind": "tool", "name": "Bash", "status": "ok", "input": {"command": "pytest -q"},
         "tests": {"passed": 4, "failed": 0, "skipped": 1, "errors": 0}},
        {"seq": 3, "turn": "t1", "kind": "tool", "name": "mcp__studio__on_base", "status": "ok",
         "output": "`brd check` here: exit 1 · on base (merge-base 1a2b3c4d5e6f): exit 1\n…"},
        {"seq": 4, "turn": "t1", "kind": "tool", "name": "Bash", "status": "ok",
         "input": {"command": "git commit -m 'E2 header'"}, "output": "[feat 9f8e7d6] E2 header\n 1 file changed"}])
    store.add_turn("t2", sid, message="E3 now", kind="message", claude_before=None)
    store.update_turn("t2", card=f"{mid}/C3")
    store.add_turn("t3", sid, message="other plan", kind="message", claude_before=None)
    store.update_turn("t3", card="docs/OTHER_PLAN.md#E2")
    ms = client.get(f"/api/p/{pid}/board/{mid}").json()
    cards = {c["id"]: c for c in ms["cards"]}
    assert ms["doc"] == "docs/EXPORT_PLAN.md" and ms["turns_key"]
    assert cards["C2"]["turns"] == 1 and cards["C2"]["evidence"] == "tests" and not cards["C2"].get("working")
    assert cards["C3"]["turns"] == 1 and cards["C3"].get("working")  # t2 still running
    assert cards["C1"]["turns"] == 0 and cards["C1"]["evidence"] == "none"  # done in the doc, nothing run
    got = client.get(f"/api/p/{pid}/board/{mid}/card/C2").json()
    assert [t["id"] for t in got["turns"]] == ["t1"]
    assert [e["kind"] for e in got["turns"][0]["evidence"]] == ["tests", "tests", "base", "commit"]
    assert got["turns"][0]["evidence"][3] == {"kind": "commit", "branch": "feat", "sha": "9f8e7d6", "subject": "E2 header"}
    assert evidence([{"name": "Bash", "status": "running", "tests": {"passed": 1}}]) == []  # a guess so far
    # W2: a terminal opened for the card is listed on it; one for another card is not
    mine = client.post(f"/api/p/{pid}/terminals", json={"card": f"{mid}/C2", "title": "dev"}).json()
    other_t = client.post(f"/api/p/{pid}/terminals", json={"card": f"{mid}/C3"}).json()
    got = client.get(f"/api/p/{pid}/board/{mid}/card/C2").json()
    assert [(t["id"], t["title"]) for t in got["terminals"]] == [(mine["id"], "dev")]
    for t in (mine, other_t):
        client.request("DELETE", f"/api/p/{pid}/terminals/{t['id']}")
    # W4: and a deploy made for it
    for i, c in enumerate(("C2", "C3")):
        client.app.state.deploys.put(pid, {"id": f"d-{i}", "env": "staging", "card": f"{mid}/{c}", "state": "ok", "created": i})
    assert [r["id"] for r in client.get(f"/api/p/{pid}/board/{mid}/card/C2").json()["deploys"]] == ["d-0"]

    # a path in another repository is not this project's plan
    other = make_project(tmp_path / "other", store=False)
    (other / "X_PLAN.md").write_text(PLAN_DOC, encoding="utf-8")
    got = client.post(f"/api/p/{pid}/board/plan", json={"path": str(other / "X_PLAN.md")})
    assert got.status_code >= 400 and got.status_code != 500, got.text
