"""The Board's routes (projectboard.py): the project's ``docs/brd/board.md``, read and moved through
``operonx_project.board``, and Project mode's status document from the engine, in-process."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from operonx_project import board as B
from operonx_studio import mcp
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

MATRIX = """# Requirements traceability matrix

| ID | Source § | Requirement (short) | Features | Screens | Code / API | Tests | Status | Evidence, gaps |
|---|---|---|---|---|---|---|---|---|
| CALC-REQ-MATH-01 | §1 | The calculator must add two numbers. | | | calc.add | tests/test_calc.py::test_adds | implemented_verified | ok |
| CALC-REQ-MATH-02 | §2 | The calculator must double a number. | | | | | planned | waits on Q-01 |
"""
QUESTIONS = """# Open questions

| ID | Type | Topic | State |
|---|---|---|---|
| Q-01 | ambiguity | Should double() accept strings? | open |
"""
TESTS = "def test_adds():\n    assert 1 + 1 == 2\n\n\ndef test_doubles():\n    assert 2 * 2 == {}\n"


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t"})  # fmt: skip


def make_project(root: Path, brd: bool = True, cards: bool = True) -> Path:
    """calc: a git repo, its BRD, and three cards — C1 done, C2 doing after C1, C3 needs you (a new file name)."""
    root.mkdir(parents=True)
    (root / "operonx.toml").write_text('[project]\nname = "calc"\n', encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    if brd:
        req = root / "docs" / "brd" / "requirements"
        req.mkdir(parents=True)
        (req / "requirements_traceability.md").write_text(MATRIX, encoding="utf-8")
        (req / "open_questions.md").write_text(QUESTIONS, encoding="utf-8")
    (root / "tests").mkdir()
    (root / "tests" / "test_calc.py").write_text(TESTS.format(5), encoding="utf-8")  # test_doubles is red
    if cards:
        B.put(root, title="add", req=["CALC-REQ-MATH-01"], files=["src/calc/ops.py"],
              done=["tests/test_calc.py::test_adds"])  # fmt: skip
        B.put(root, title="double", req=["CALC-REQ-MATH-02"], after=["C1"], files=["src/calc/ops.py"],
              done=["tests/test_calc.py::test_doubles"])  # fmt: skip
        B.put(root, title="the screen", files=["web/calc.js", "src/calc/widgets.py"])
        B.move(root, "C1", "doing")
        B.move(root, "C1", "done")
        B.move(root, "C2", "doing")
        B.move(root, "C3", "doing")  # a new file name: it needs the owner
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "init")
    return root


@pytest.fixture()
def client(tmp_path: Path):
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _open(client, root: Path) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def _store(tmp_path: Path):
    from operonx_studio.assistant import ChatStore

    return ChatStore(tmp_path / "assistant.sqlite")


def test_the_board_reads_board_md(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "calc"))
    got = client.get(f"/api/p/{pid}/board").json()
    assert got["available"] and got["file"] == "docs/brd/board.md"
    assert got["columns"] == {"todo": [], "doing": ["C2"], "needs you": ["C3"], "done": ["C1"]}
    cards = {c["id"]: c for c in got["cards"]}
    assert [(cards[i]["lane"], cards[i]["kind"]) for i in ("C1", "C3")] == [("core", "build"), ("UI", "fix")]
    assert "widgets.py" in cards["C3"]["note"] and cards["C2"]["waits"] == []
    c2 = client.get(f"/api/p/{pid}/board/card/C2").json()
    assert c2["card"]["after"] == ["C1"] and c2["turns"] == []
    assert client.get(f"/api/p/{pid}/board/card/C9").status_code == 404
    assert client.get("/api/p/nope/board").status_code == 404


def test_a_project_with_neither_board_nor_brd_has_no_board(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "plain", brd=False, cards=False))
    assert client.get(f"/api/p/{pid}/board").json() == {"available": False}


def test_a_brd_folder_alone_is_a_board_its_checklist_from_the_checkout(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "calc", cards=False))
    got = client.get(f"/api/p/{pid}/board").json()
    assert got["available"] and got["file"] == "" and got["cards"] == []
    ck = client.get(f"/api/p/{pid}/brd").json()
    assert (ck["branch"], ck["brd"]) == ("main", "docs/brd")
    assert ck["counts"] == {"implemented_verified": 1, "planned": 1}
    assert [q["id"] for q in ck["questions"]] == ["Q-01"]


def test_cards_are_added_and_moved_and_done_means_their_tests_pass(client, tmp_path):
    root = make_project(tmp_path / "calc")
    pid = _open(client, root)

    def post(**body):
        return client.post(f"/api/p/{pid}/board/card", json=body)

    assert post(title="halve", after=["C2"], files=["src/calc/ops.py"]).json() == {
        "ok": True, "card": "C4", "state": "todo", "note": ""}
    refused = post(card="C4", to="doing")
    assert refused.status_code == 409 and "C2" in refused.json()["message"]  # its after card is not done
    red = post(card="C2", to="done")
    assert red.status_code == 409 and red.json()["red"] == ["tests/test_calc.py::test_doubles"]
    (root / "tests" / "test_calc.py").write_text(TESTS.format(4), encoding="utf-8")
    assert post(card="C2", to="done").json()["state"] == "done"
    assert post(card="C4", to="doing").json()["state"] == "doing"
    assert post(card="C3", to="doing", note="").json() == {"ok": True, "card": "C3", "state": "doing", "note": ""}
    assert post(card="C4", title="halve it").json()["card"] == "C4"
    text = (root / "docs" / "brd" / "board.md").read_text(encoding="utf-8")
    assert "### C2 · double · done" in text and "### C4 · halve it · doing" in text


def test_a_running_turn_on_a_card_shows_its_step(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "calc"))
    store = _store(tmp_path)
    a = store.create_session(pid, owner="u")["id"]
    store.add_turn("t1", a, message="do C2", kind="message", claude_before=None)
    store.update_turn("t1", card="C2")
    store.put_items(a, [{"seq": 1, "turn": "t1", "kind": "tool", "name": "mcp__studio__steps", "status": "ok",
                         "plan": {"card": "C2", "steps": [{"title": "Read ops.py", "state": "done"},
                                                          {"title": "Write double()", "state": "active"}]}}])
    cards = {c["id"]: c for c in client.get(f"/api/p/{pid}/board").json()["cards"]}
    assert (cards["C2"]["working"], cards["C2"]["now"], cards["C2"]["turns"]) == (True, "Write double()", 1)
    assert "working" not in cards["C1"]
    got = client.get(f"/api/p/{pid}/board/card/C2").json()
    assert [(t["id"], t["now"]) for t in got["turns"]] == [("t1", "Write double()")]
    # a turn that shows no steps: its last tool is the line
    store.add_turn("t2", a, message="do C1", kind="message", claude_before=None)
    store.update_turn("t2", card="C1")
    store.put_items(a, [{"seq": 2, "turn": "t2", "kind": "tool", "name": "Bash", "status": "running",
                         "label": "Ran uv run pytest tests/test_calc.py"}])
    cards = {c["id"]: c for c in client.get(f"/api/p/{pid}/board").json()["cards"]}
    assert (cards["C1"]["working"], cards["C1"]["now"]) == (True, "Ran uv run pytest tests/test_calc.py")
    # the store keeps a tool's input as JSON text: a commit is still read as evidence
    store.put_items(a, [{"seq": 3, "turn": "t2", "kind": "tool", "name": "Bash", "status": "ok",
                         "input": '{"command": "git commit -m longest"}', "output": "[main 1a2b3c4] longest\n"}])
    got = client.get(f"/api/p/{pid}/board/card/C1").json()
    assert got["turns"][0]["evidence"] == [{"kind": "commit", "branch": "main", "sha": "1a2b3c4", "subject": "longest"}]


def test_one_list_of_what_waits_the_board_the_brd_and_the_assistant(client, tmp_path):
    """WORKSPACE_PLAN W1.5: the cards that need the owner, the BRD's open questions and a turn that ended on a
    question, in one waiting list; the turn's question on the card it named."""
    pid = _open(client, make_project(tmp_path / "calc"))
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "operonx.toml").write_text('[project]\nname = "plain"\n', encoding="utf-8")
    _open(client, plain)  # no board: not listed
    store = _store(tmp_path)
    a = store.create_session(pid, owner="u")["id"]
    store.add_turn("t1", a, message="continue C1", kind="message", claude_before=None)
    store.update_turn("t1", card="C1", state="done", ended=time.time())
    store.put_items(a, [{"seq": 1, "turn": "t1", "kind": "text", "text": "Done with C1.\n\n**Shall I start C2?**"}])
    got = client.get("/api/boards/waiting").json()
    assert [b["name"] for b in got["boards"]] == ["calc"]
    board = got["boards"][0]
    assert board["counts"] == {"todo": 0, "doing": 1, "needs you": 1, "done": 1}
    assert [(w["source"], w["card"] or w["qid"]) for w in board["waiting"]] == [
        ("board", "C3"), ("brd", "Q-01"), ("assistant", "C1")]
    assert got["count"] == 3 and board["waiting"][2]["session"] == a
    c1 = next(c for c in client.get(f"/api/p/{pid}/board").json()["cards"] if c["id"] == "C1")
    assert c1["asks"] is True and c1["question"].endswith("C2?")
    store.add_turn("t2", a, message="yes", kind="message", claude_before=None)  # the owner answered
    assert client.get("/api/boards/waiting").json()["count"] == 2


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


def test_the_assistant_reads_adds_and_moves_cards_and_opens_them(client, tmp_path):
    s = BoardStudio(client, _open(client, make_project(tmp_path / "calc")))
    text = _tool(s, "board_status")
    assert text.startswith("Board (docs/brd/board.md): 1 doing, 1 needs you, 1 done")
    assert "C3 · the screen [UI, fix] — " in text and text.endswith("done: C1")
    assert _tool(s, "board_card", card="C2").startswith("C2 · double [doing] core, build\nreq: CALC-REQ-MATH-02")
    assert _tool(s, "board_card", title="halve", after=["C2"], files=["src/calc/ops.py"]).startswith("C4 · halve [todo]")
    assert _tool(s, "board_move", card="C4", to="doing").startswith("refused: ")
    assert _tool(s, "board_move", card="C2", to="needs you", note="Strings too?") == "C2 is needs you — Strings too?"
    assert [x["args"] for x in s.shown] == [{}, {"card": "C2"}, {"card": "C4"}, {"card": "C2"}]
    names = json.dumps(mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, s))
    assert "board_move" in names and "board_plan" not in names


def test_project_mode_reads_the_engines_status_and_writes_nothing(client, tmp_path):
    root = make_project(tmp_path / "calc")
    (root / "docs" / "EXPORT_PLAN.md").write_text(
        "---\ntitle: CSV export\nstatus: in_progress\nphases:\n  - {id: E1, title: Rows, status: in_progress}\n---\n",
        encoding="utf-8")  # fmt: skip
    (root / "docs" / "OLD_PLAN.md").write_text("# no block\n", encoding="utf-8")
    pid = _open(client, root)
    got = client.get(f"/api/p/{pid}/project/status")
    assert got.status_code == 200, got.text
    doc = got.json()["project"]
    assert doc["checklist"]["total"] == 2 and doc["board"]["columns"]["doing"] == ["C2"]
    assert [w["title"] for w in doc["working_on"]] == ["C2 · double", "CSV export"]
    assert [(n["source"], n["id"]) for n in doc["needs_you"]] == [("brd", "Q-01"), ("board", "C3")]
    assert doc["unmarked"] == ["docs/OLD_PLAN.md"] and got.json()["text"].startswith("Checklist: 1 of 2 verified")
    assert subprocess.run(["git", "status", "--porcelain", "docs/brd"], cwd=root, capture_output=True,
                          text=True).stdout == ""  # fmt: skip


def test_project_mode_lists_the_assistants_questions_with_the_engines(client, tmp_path):
    """WORKSPACE_PLAN W1.5: Project mode's needs-you list has a turn that ended waiting on the owner."""
    pid = _open(client, make_project(tmp_path / "calc", brd=False, cards=False))
    store = _store(tmp_path)
    a = store.create_session(pid, owner="u")["id"]
    store.add_turn("t1", a, message="continue C1", kind="message", claude_before=None)
    store.update_turn("t1", card="C1", state="done", ended=time.time())
    store.put_items(a, [{"seq": 1, "turn": "t1", "kind": "text", "text": "Done with C1. Shall I start C2?"}])
    got = client.get(f"/api/p/{pid}/project/status")
    assert got.status_code == 200, got.text
    assert got.json()["project"]["needs_you"] == [
        {"source": "assistant", "id": "turn:t1", "kind": "assistant", "text": "Done with C1. Shall I start C2?",
         "card": "C1", "session": a, "title": store.session(a)["title"]}]


def test_the_assistant_reads_where_the_project_stands_from_the_engine(client, tmp_path):
    from operonx_studio.chat import STUDIO_READ_TOOLS

    text = _tool(BoardStudio(client, _open(client, make_project(tmp_path / "calc"))), "project_status")
    assert text.startswith("Checklist: ") and "Board: 1 doing, 1 needs you, 1 done" in text
    assert "  C2 · double — doing · core · 1 of 3 cards done" in text  # the screen's words
    assert "mcp__studio__project_status" in STUDIO_READ_TOOLS  # a viewer's assistant may read it too
    assert "mcp__studio__board_move" not in STUDIO_READ_TOOLS  # moving a card writes


def test_project_mode_has_its_pages_and_the_board_lives_inside_it(client, tmp_path):
    pid = _open(client, make_project(tmp_path / "calc", cards=False))
    page = client.get(f"/p/{pid}/project/board")
    assert page.status_code == 200
    html = page.text
    pages = [p for p in ("now", "board", "plans", "checklist", "changes", "settings") if f'data-ppage="{p}"' in html]
    assert pages == ["now", "board", "changes", "settings"]  # Checklist and Questions are sections of Now
    assert 'data-tab="project"' in html and 'data-tab="board"' not in html  # the rail's Board became Project
    shell = (Path(__file__).resolve().parents[2] / "operonx_studio" / "static" / "shell.js").read_text(encoding="utf-8")
    assert 'if (name === "board") { switchTab("project", {page: "board"}); return; }' in shell


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


def test_the_assistants_bash_finds_the_studios_own_commands():
    from operonx_studio.chat import base_env

    assert str(Path(sys.executable).parent) in base_env()["PATH"].split(os.pathsep)


def test_the_assistant_never_inherits_the_studios_virtualenv(monkeypatch):
    from operonx_studio.chat import base_env

    monkeypatch.setenv("VIRTUAL_ENV", "/elsewhere/.venv")  # the shell that started the studio
    assert "VIRTUAL_ENV" not in base_env()
