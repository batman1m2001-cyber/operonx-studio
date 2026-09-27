"""The agent behind the assistant: how it is briefed, how far it may
reach, and the gate in front of it.

A fake ``claude`` binary stands in for the real CLI — it records how it
was invoked (argv + cwd) and plays back a scripted stream-json turn —
so these tests check what every turn is started with: the project's
briefing and the knowledge doc, the permission flags per
OPERONX_STUDIO_CHAT_MODE, what happens without a binary, and the login
wall. The conversation itself (items, forks, streams, sessions) is
tests/studio/test_assistant.py's.
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


FAKE_CLAUDE = '''#!/usr/bin/env python3
import json, os, sys

out = os.environ.get("OX_FAKE_OUT")
if out:
    with open(out, "w") as f:
        json.dump({"argv": sys.argv[1:], "cwd": os.getcwd()}, f)

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")

emit({"type": "system", "subtype": "init", "session_id": "fake-1"})
emit({"type": "stream_event",
      "event": {"delta": {"type": "text_delta", "text": "Hel"}}})
emit({"type": "stream_event",
      "event": {"delta": {"type": "text_delta", "text": "lo"}}})
emit({"type": "assistant", "message": {"content": [
    {"type": "tool_use", "name": "Edit", "input": {"file_path": "main.py"}}]}})
emit({"type": "result", "session_id": "fake-1",
      "total_cost_usd": 0.01, "is_error": False})
'''

PROJECT_MAIN = '''
from operonx.core import graph, op, START, END

@op
def shout(text: str = "hi"):
    return {"loud": text.upper()}

@graph
def flow():
    a = shout(text="hello")
    START >> a >> END
'''

MANIFEST = '''
[project]
name = "chatty-demo"

[[graph]]
name  = "flow"
entry = "main:flow"
'''


@pytest.fixture()
def fake_claude(tmp_path: Path, monkeypatch):
    """Install the scripted binary and a place for it to report to."""
    binary = tmp_path / "fake-claude"
    binary.write_text(FAKE_CLAUDE, encoding="utf-8")
    binary.chmod(0o755)
    report = tmp_path / "invocation.json"
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("OX_FAKE_OUT", str(report))
    return report


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "main.py").write_text(PROJECT_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path):
    # Context-manager mode keeps one event loop alive across requests —
    # a turn is a background task that must outlive the POST that
    # started it, exactly as in production.
    app = build_studio_app(Recents(state_file=tmp_path / "studio.json"))
    with TestClient(app) as c:
        yield c


def _open(client: TestClient, root: Path) -> str:
    res = client.post("/api/open", json={"path": str(root)})
    assert res.status_code == 200, res.text
    return res.json()["id"]


def _turn(client: TestClient, scope: str, message: str = "hi", **extra) -> list:
    """Start a turn in a new session and drain its events by poll."""
    sid = client.post("/api/assistant/sessions", json={"scope": scope}).json()["session"]["id"]
    res = client.post(f"/api/assistant/sessions/{sid}/turns", json={"message": message, **extra})
    assert res.status_code == 200, res.text
    turn, events, cursor = res.json()["turn"], [], 0
    for _ in range(50):
        got = client.get(f"/api/assistant/turns/{turn}", params={"cursor": cursor}).json()
        events += got["events"]
        cursor = got["cursor"]
        if not got["alive"]:
            break
    return events


def _invocation(report: Path) -> dict:
    return json.loads(report.read_text(encoding="utf-8"))


def test_the_agent_runs_in_the_project_with_its_briefing(client, project, fake_claude):
    pid = _open(client, project)
    events = _turn(client, pid)
    assert events[-1]["t"] == "done" and events[-1]["state"] == "done"
    invocation = _invocation(fake_claude)
    assert invocation["cwd"] == str(project.resolve())
    argv = invocation["argv"]
    prompt = argv[argv.index("--append-system-prompt") + 1]
    # the packaged knowledge doc, then the live briefing
    assert "operonx studio assistant" in prompt
    assert "chatty-demo" in prompt and str(project.resolve()) in prompt
    # graphs summarised as node(kind) — node names match what traces record
    assert "Graph `flow`: a(FuncOp)" in prompt


def test_mode_read_denies_everything_but_looking(client, project, fake_claude, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_MODE", "read")
    pid = _open(client, project)
    _turn(client, pid)
    argv = _invocation(fake_claude)["argv"]
    assert "Read" in argv and "Bash" not in argv and "Edit" not in argv
    assert "--permission-mode" not in argv


def test_mode_full_is_the_default_and_grants_bash(client, project, fake_claude):
    pid = _open(client, project)
    _turn(client, pid)
    argv = _invocation(fake_claude)["argv"]
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    assert "Bash" in argv


def test_home_turns_know_the_roster(client, project, fake_claude):
    _open(client, project)
    _turn(client, "home", "what's here?")
    argv = _invocation(fake_claude)["argv"]
    prompt = argv[argv.index("--append-system-prompt") + 1]
    assert "chatty-demo" in prompt and str(project.resolve()) in prompt


def test_a_missing_binary_is_an_error_item_not_a_crash(client, project, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", "/nowhere/claude")
    pid = _open(client, project)
    events = _turn(client, pid)
    errors = [e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "error"]
    assert errors and "claude" in errors[0]["text"].lower() and events[-1]["state"] == "failed"


def test_unknown_turns_and_sessions_are_404(client):
    assert client.get("/api/assistant/turns/nope").status_code == 404
    assert client.post("/api/assistant/turns/nope/stop").status_code == 404
    assert client.get("/api/assistant/sessions/nope").status_code == 404
    assert client.post("/api/assistant/sessions/nope/turns", json={"message": "hi"}).status_code == 404


def test_empty_messages_and_unknown_projects_are_rejected(client, project, fake_claude):
    pid = _open(client, project)
    sid = client.post("/api/assistant/sessions", json={"scope": pid}).json()["session"]["id"]
    assert client.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "  "}).status_code == 400
    assert client.post("/api/assistant/sessions", json={"scope": "nope"}).status_code == 404


def test_the_assistant_sits_behind_the_login_wall(tmp_path, project, fake_claude, monkeypatch):
    monkeypatch.delenv("OPERONX_STUDIO_AUTH", raising=False)
    signed_out = TestClient(build_studio_app(Recents(state_file=tmp_path / "auth" / "auth.json")))
    assert signed_out.get("/api/assistant/sessions").status_code == 401
    assert signed_out.post("/api/assistant/sessions", json={"scope": "home"}).status_code == 401
    assert signed_out.get("/api/assistant/turns/any/stream").status_code == 401
    assert signed_out.post("/api/assistant/import", json={"log": []}).status_code == 401


def test_the_view_rides_along_with_the_message(client, project, fake_claude):
    """'why is this slow?' must not need the op name typed — what the
    user is looking at goes into the system prompt."""
    pid = _open(client, project)
    _turn(client, pid, "why is this slow?",
          view={"node": "shout", "kind": "FuncOp", "run": "call-42", "tab": "flow"})
    argv = _invocation(fake_claude)["argv"]
    prompt = argv[argv.index("--append-system-prompt") + 1]
    assert "looking at right now" in prompt
    assert "`shout` (FuncOp)" in prompt and "`call-42`" in prompt
