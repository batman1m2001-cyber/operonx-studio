"""The wired assistant: spawn, relay, brief, gate.

A fake ``claude`` binary stands in for the real CLI — it records how it
was invoked (argv + cwd) and plays back a scripted stream-json
conversation, so these tests exercise the whole relay without an API
call: flag mapping, SSE translation, the project briefing, and the
login wall in front of it all.
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
def client(tmp_path: Path) -> TestClient:
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def _open(client: TestClient, root: Path) -> str:
    res = client.post("/api/open", json={"path": str(root)})
    assert res.status_code == 200, res.text
    return res.json()["id"]


def _events(response) -> list:
    assert response.status_code == 200, response.text
    return [json.loads(line[6:])
            for line in response.text.split("\n\n")
            if line.startswith("data: ")]


def _invocation(report: Path) -> dict:
    return json.loads(report.read_text(encoding="utf-8"))


def test_chat_streams_deltas_tools_and_done(client, project, fake_claude):
    pid = _open(client, project)
    events = _events(client.post(f"/api/p/{pid}/chat", json={"message": "hi"}))
    kinds = [e["t"] for e in events]
    assert kinds == ["start", "delta", "delta", "tool", "done"]
    assert events[0]["session"] == "fake-1"
    assert "".join(e["text"] for e in events if e["t"] == "delta") == "Hello"
    assert events[3] == {"t": "tool", "name": "Edit", "hint": "main.py"}
    assert events[-1]["session"] == "fake-1" and "error" not in events[-1]


def test_agent_runs_in_the_project_with_its_briefing(client, project, fake_claude):
    pid = _open(client, project)
    client.post(f"/api/p/{pid}/chat", json={"message": "hi"})
    invocation = _invocation(fake_claude)
    assert invocation["cwd"] == str(project.resolve())
    argv = invocation["argv"]
    prompt = argv[argv.index("--append-system-prompt") + 1]
    # the packaged knowledge doc, then the live briefing
    assert "operonx studio assistant" in prompt
    assert "chatty-demo" in prompt and str(project.resolve()) in prompt
    # graphs summarised as node(kind) — node names match what traces record
    assert "Graph `flow`: a(FuncOp)" in prompt


def test_resume_carries_the_session_id(client, project, fake_claude):
    pid = _open(client, project)
    client.post(f"/api/p/{pid}/chat",
                json={"message": "again", "session": "prev-42"})
    argv = _invocation(fake_claude)["argv"]
    assert argv[argv.index("--resume") + 1] == "prev-42"


def test_mode_read_denies_everything_but_looking(client, project, fake_claude,
                                                 monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_MODE", "read")
    pid = _open(client, project)
    client.post(f"/api/p/{pid}/chat", json={"message": "hi"})
    argv = _invocation(fake_claude)["argv"]
    assert "Read" in argv and "Bash" not in argv and "Edit" not in argv
    assert "--permission-mode" not in argv


def test_mode_full_is_the_default_and_grants_bash(client, project, fake_claude):
    pid = _open(client, project)
    client.post(f"/api/p/{pid}/chat", json={"message": "hi"})
    argv = _invocation(fake_claude)["argv"]
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    assert "Bash" in argv


def test_home_chat_knows_the_roster(client, project, fake_claude):
    _open(client, project)
    events = _events(client.post("/api/chat", json={"message": "what's here?"}))
    assert [e["t"] for e in events][0] == "start"
    prompt_argv = _invocation(fake_claude)["argv"]
    prompt = prompt_argv[prompt_argv.index("--append-system-prompt") + 1]
    assert "chatty-demo" in prompt and str(project.resolve()) in prompt


def test_missing_binary_is_an_error_event_not_a_crash(client, project,
                                                      monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", "/nowhere/claude")
    pid = _open(client, project)
    events = _events(client.post(f"/api/p/{pid}/chat", json={"message": "hi"}))
    assert events[0]["t"] == "error" and "claude" in events[0]["text"].lower()


def test_empty_message_and_unknown_project_are_rejected(client, project,
                                                        fake_claude):
    pid = _open(client, project)
    assert client.post(f"/api/p/{pid}/chat",
                       json={"message": "  "}).status_code == 400
    assert client.post("/api/p/nope/chat",
                       json={"message": "hi"}).status_code == 404


def test_chat_sits_behind_the_login_wall(tmp_path, project, fake_claude,
                                         monkeypatch):
    monkeypatch.delenv("OPERONX_STUDIO_AUTH", raising=False)
    signed_out = TestClient(
        build_studio_app(Recents(state_file=tmp_path / "auth.json")))
    assert signed_out.post("/api/p/any/chat",
                           json={"message": "hi"}).status_code == 401
    assert signed_out.post("/api/chat",
                           json={"message": "hi"}).status_code == 401
