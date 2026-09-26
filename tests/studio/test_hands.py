"""The assistant's hands — P5.

Gates: the studio tool server speaks MCP (initialize, tools/list,
tools/call, errors as answers, notifications unanswered); its tools read
the project through the studio's own API and put what they open on the
user's screen (/ui/actions); every turn is snapshotted, so the diff it
reports is only the agent's edits — never the user's own uncommitted work
— and Undo puts exactly those files back; the chat turn hands the agent
the tool server and reports a ``changes`` event before ``done``; and the
reach of the studio tools follows the chat mode.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx.core.workflow_trace import OpExecution, WorkflowTrace
from operonx.telemetry.runs.files import FilesRunStore

from operonx_studio import chat, mcp
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MANIFEST = '[project]\nname = "hands-demo"\n\n[[graph]]\nname = "flow"\nentry = "main:flow"\n'
MAIN = ("from operonx.core import graph, op, START, END\n\n@op\ndef a(x: int = 1):\n    return {'y': x}\n\n"
        "@graph\ndef flow():\n    s = a()\n    START >> s >> END\n")


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                          check=True, capture_output=True, text=True).stdout


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "notes.md").write_text("one\ntwo\n", encoding="utf-8")
    _git(root, "init", "-q")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "init")
    return root


def _trace(tid: str, ms: float = 10.0, error: bool = False, **meta: Any) -> WorkflowTrace:
    node = OpExecution(op_id=f"g.a#{tid}", op_name="a", op_full_name="g.a", ctx=("main",),
                       start_time=100.0, end_time=100.0 + ms / 1000, inputs={"x": 1}, outputs={"y": 1},
                       upstreams=[], status="error" if error else "ok", error="Boom" if error else None)
    return WorkflowTrace(trace_id=tid, workflow_name="flow", started_at=100.0, ended_at=100.0 + ms / 1000,
                         nodes=[node], metadata=meta, wall_started_at=time.time())


# ── the MCP protocol ──────────────────────────────────────────────────────


class FakeStudio(mcp.Studio):
    """Answers a few API paths from a dict and records what it was asked."""

    def __init__(self, answers: Dict[str, Any]):
        super().__init__("http://x", "p")
        self.answers, self.calls, self.shown = answers, [], []

    def call(self, path: str, body: Optional[Dict[str, Any]] = None, **params: Any) -> Any:
        self.calls.append((path, body, params))
        if path == "/ui/action":
            self.shown.append(body)
            return {"seq": len(self.shown)}
        if path not in self.answers:
            raise RuntimeError(f"unknown path {path}")
        return self.answers[path]


def _rpc(studio: mcp.Studio, method: str, params: Optional[Dict[str, Any]] = None, mid: Any = 1):
    return mcp.handle({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}, studio)


def test_initialize_and_list_tools():
    s = FakeStudio({})
    init = _rpc(s, "initialize")["result"]
    assert init["protocolVersion"] == mcp.PROTOCOL and "tools" in init["capabilities"]
    tools = {t["name"]: t for t in _rpc(s, "tools/list")["result"]["tools"]}
    assert set(tools) == {"list_runs", "open_run", "op_values", "monitor", "compare_runs",
                          "select_op", "run_job", "rerun_op", "play", "run_eval", "set_llm_price"}
    # tools that run the project's code are not read tools
    assert not {"mcp__studio__rerun_op", "mcp__studio__play", "mcp__studio__run_job"} & set(chat.STUDIO_READ_TOOLS)
    assert tools["open_run"]["inputSchema"]["required"] == ["run"]
    # every read tool the read-only chat mode allows is a real tool
    assert {n.split("__")[-1] for n in chat.STUDIO_READ_TOOLS} <= set(tools)


def test_notifications_get_no_answer_and_unknowns_are_errors():
    s = FakeStudio({})
    assert mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}, s) is None
    assert _rpc(s, "nope")["error"]["code"] == -32601
    assert _rpc(s, "tools/call", {"name": "ghost"})["error"]["code"] == -32602
    assert _rpc(s, "ping")["result"] == {}


def test_a_tool_failure_is_its_answer_not_a_crash():
    got = _rpc(FakeStudio({}), "tools/call", {"name": "list_runs", "arguments": {}})["result"]
    assert got["isError"] and "unknown path /runs" in got["content"][0]["text"]


def test_open_run_reads_the_summary_and_shows_it():
    s = FakeStudio({"/trace/r1/tree": {
        "summary": {"status": "error", "duration_ms": 1500, "executions": 3, "cost_usd": None,
                    "unpriced": 1, "llm_calls": 1, "first_error": "a: Boom"},
        "rollups": [{"op": "a", "count": 3, "total_ms": 12.0, "max_ms": 5.0, "errors": 1,
                     "cost_usd": None, "unpriced": 1}],
        "rows": [{"op": "a", "ctx": "main", "status": "error", "error": "Boom"}]}})
    text = _rpc(s, "tools/call", {"name": "open_run", "arguments": {"run": "r1", "lens": "errors"}})
    text = text["result"]["content"][0]["text"]
    assert "run r1: error in 1.50s" in text and "unpriced" in text and "$0" not in text
    assert "first error: a: Boom" in text and "failed a @ main: Boom" in text
    assert s.shown == [{"kind": "open_run", "args": {"run": "r1", "mode": "tree", "lens": "errors"}}]


def test_select_op_only_points():
    s = FakeStudio({})
    _rpc(s, "tools/call", {"name": "select_op", "arguments": {"op": "stt"}})
    assert s.shown == [{"kind": "select_op", "args": {"op": "stt"}}]
    assert [c[0] for c in s.calls] == ["/ui/action"]


# ── the tools against the real studio API ────────────────────────────────


class ClientStudio(mcp.Studio):
    """The tool server's HTTP calls, routed into a TestClient."""

    def __init__(self, client: TestClient, pid: str):
        super().__init__("http://testserver", pid)
        self.client = client

    def call(self, path: str, body: Optional[Dict[str, Any]] = None, **params: Any) -> Any:
        url = f"/api/p/{self.pid}{path}"
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        res = (self.client.post(url, json=body, params=clean) if body is not None
               else self.client.get(url, params=clean))
        if res.status_code >= 400:
            raise RuntimeError(res.json().get("error") or f"HTTP {res.status_code}")
        return res.json()


@pytest.fixture()
def studio(tmp_path: Path, repo: Path):
    store = FilesRunStore(root=repo / ".operonx" / "runs", refresh_every=0)
    store.consume(_trace("fast", 10, origin="service", service="call"))
    store.consume(_trace("slow", 90, origin="service", service="call"))
    store.consume(_trace("bad", 20, error=True, origin="service", service="call"))
    client = TestClient(build_studio_app(Recents(state_file=tmp_path / "s.json")))
    pid = client.post("/api/open", json={"path": str(repo)}).json()["id"]
    return client, pid, ClientStudio(client, pid)


def _text(studio: mcp.Studio, name: str, **args: Any) -> str:
    got = _rpc(studio, "tools/call", {"name": name, "arguments": args})["result"]
    assert not got.get("isError"), got
    return got["content"][0]["text"]


def test_list_open_compare_through_the_api_and_the_screen_follows(studio):
    client, pid, s = studio
    listed = _text(s, "list_runs", order="duration_desc")
    assert listed.splitlines()[0].startswith("3 runs match") and listed.splitlines()[1].startswith("slow |")
    assert "bad | error" in _text(s, "list_runs", status="error")

    assert _text(s, "open_run", run="bad").startswith("run bad: error")
    assert "B - A total: +80.0 ms" in _text(s, "compare_runs", a="fast", b="slow")

    shown = client.get(f"/api/p/{pid}/ui/actions").json()["actions"]
    assert [(a["kind"], a["args"].get("run") or a["args"].get("b")) for a in shown] == \
        [("open_run", "bad"), ("compare", "slow")]


def test_price_tool_previews_unless_told_to_apply(studio, repo):
    _, _, s = studio
    (repo / "resources.yaml").write_text("llm:\n  inhouse:\n    api_type: openai\n", encoding="utf-8")
    preview = _text(s, "set_llm_price", resource="inhouse", input_per_1m=0, output_per_1m=0)
    assert preview.startswith("preview") and "+    cost_per_input_token: 0" in preview
    assert "cost_per" not in (repo / "resources.yaml").read_text()
    assert _text(s, "set_llm_price", resource="inhouse", input_per_1m=0, output_per_1m=0,
                 apply=True).startswith("applied")
    assert "cost_per_output_token: 0" in (repo / "resources.yaml").read_text()


def test_ui_action_queue(studio):
    client, pid, _ = studio
    assert client.post(f"/api/p/{pid}/ui/action", json={"kind": "rm -rf"}).status_code == 400
    for i in range(55):
        client.post(f"/api/p/{pid}/ui/action", json={"kind": "open_tab", "args": {"tab": f"t{i}"}})
    got = client.get(f"/api/p/{pid}/ui/actions").json()
    assert got["last"] == 55 and len(got["actions"]) == 50  # the queue keeps the latest 50
    assert [a["seq"] for a in client.get(f"/api/p/{pid}/ui/actions?after=53").json()["actions"]] == [54, 55]


# ── snapshots, changes and undo ───────────────────────────────────────────


def test_changes_are_only_the_agents_and_undo_puts_them_back(repo):
    # the user's own uncommitted work, before the turn — never the agent's
    (repo / "notes.md").write_text("one\ntwo\nmine\n", encoding="utf-8")
    (repo / "scratch.txt").write_text("user's untracked file\n", encoding="utf-8")
    snap = chat.snapshot(repo)
    assert snap and "scratch.txt" in snap["untracked"]

    # the turn: edits a tracked file, adds a file, writes runs (ignored)
    (repo / "main.py").write_text(MAIN.replace("x: int = 1", "x: int = 2"), encoding="utf-8")
    (repo / "new_op.py").write_text("a = 1\nb = 2\n", encoding="utf-8")
    (repo / ".operonx" / "runs").mkdir(parents=True)
    (repo / ".operonx" / "runs" / "r.json").write_text("{}", encoding="utf-8")

    got = chat.changes_since(repo, snap)
    files = {f["path"]: f for f in got["files"]}
    assert set(files) == {"main.py", "new_op.py"}  # not notes.md, scratch.txt or .operonx
    assert (files["main.py"]["added"], files["main.py"]["removed"], files["main.py"]["new"]) == (1, 1, False)
    assert (files["new_op.py"]["added"], files["new_op.py"]["new"]) == (2, True)
    assert "+def a(x: int = 2):" in got["diff"] and "+++ b/new_op.py" in got["diff"]

    done = chat.undo(repo, got["sha"], ["main.py"], ["new_op.py"])
    assert sorted(done) == ["main.py", "new_op.py"]
    assert (repo / "main.py").read_text() == MAIN and not (repo / "new_op.py").exists()
    # the user's work survived the undo
    assert (repo / "notes.md").read_text() == "one\ntwo\nmine\n" and (repo / "scratch.txt").exists()


def test_undo_restores_the_snapshot_version_not_head(repo):
    """The user had uncommitted edits to the very file the agent then
    changed: undo returns the user's version, not the last commit."""
    (repo / "notes.md").write_text("one\ntwo\nmine\n", encoding="utf-8")
    snap = chat.snapshot(repo)
    (repo / "notes.md").write_text("one\ntwo\nmine\nagent\n", encoding="utf-8")
    got = chat.changes_since(repo, snap)
    assert [(f["path"], f["added"], f["removed"]) for f in got["files"]] == [("notes.md", 1, 0)]
    chat.undo(repo, got["sha"], ["notes.md"], [])
    assert (repo / "notes.md").read_text() == "one\ntwo\nmine\n"


def test_undo_never_leaves_the_repo(repo, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("keep me", encoding="utf-8")
    snap = chat.snapshot(repo)
    assert chat.undo(repo, snap["sha"], ["../outside.txt"], ["../outside.txt"]) == []
    assert outside.read_text() == "keep me"


def test_a_clean_tree_snapshots_as_head_and_no_git_is_none(repo, tmp_path):
    assert chat.snapshot(repo)["sha"] == _git(repo, "rev-parse", "HEAD").strip()
    plain = tmp_path / "plain"
    plain.mkdir()
    assert chat.snapshot(plain) is None and chat.snapshot(None) is None


def test_undo_endpoint(studio, repo):
    client, pid, _ = studio
    snap = chat.snapshot(repo)
    (repo / "main.py").write_text("broken\n", encoding="utf-8")
    (repo / "extra.py").write_text("x\n", encoding="utf-8")
    assert client.post(f"/api/p/{pid}/chat/undo", json={"sha": "HEAD; rm", "files": []}).status_code == 400
    got = client.post(f"/api/p/{pid}/chat/undo",
                      json={"sha": snap["sha"], "files": ["main.py"], "new_files": ["extra.py"]}).json()
    assert sorted(got["restored"]) == ["extra.py", "main.py"]
    assert (repo / "main.py").read_text() == MAIN and not (repo / "extra.py").exists()


# ── the turn: tools handed over, changes reported ─────────────────────────

EDITING_CLAUDE = '''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["OX_FAKE_OUT"], "w") as f:
    json.dump({"argv": sys.argv[1:]}, f)
if not os.environ.get("OX_FAKE_READONLY"):
    with open("main.py", "a") as f:
        f.write("# tuned\\n")
def emit(o):
    sys.stdout.write(json.dumps(o) + "\\n")
emit({"type": "system", "subtype": "init", "session_id": "s1"})
emit({"type": "stream_event", "event": {"delta": {"type": "text_delta", "text": "done"}}})
emit({"type": "result", "session_id": "s1", "total_cost_usd": 0.02, "is_error": False})
'''


def test_a_turn_gets_the_studio_tools_and_reports_its_changes(tmp_path, repo, monkeypatch):
    binary = tmp_path / "claude"
    binary.write_text(EDITING_CLAUDE, encoding="utf-8")
    binary.chmod(0o755)
    report = tmp_path / "argv.json"
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("OX_FAKE_OUT", str(report))
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "s.json"))) as client:
        pid = client.post("/api/open", json={"path": str(repo)}).json()["id"]
        turn = client.post(f"/api/p/{pid}/chat", json={"message": "tune it"}).json()["turn"]
        events, cursor = [], 0
        for _ in range(50):
            batch = client.get(f"/api/chat/turn/{turn}?cursor={cursor}").json()
            events += batch["events"]
            cursor = batch["cursor"]
            if not batch["alive"]:
                break
    kinds = [e["t"] for e in events]
    assert kinds.index("changes") == kinds.index("done") - 1
    change = events[kinds.index("changes")]
    assert [(f["path"], f["added"]) for f in change["files"]] == [("main.py", 1)]
    assert "+# tuned" in change["diff"]

    argv = json.loads(report.read_text())["argv"]
    server = json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]["studio"]
    assert server["args"] == ["-m", "operonx_studio.mcp"] and server["env"]["OPERONX_STUDIO_PID"] == pid
    prompt = argv[argv.index("--append-system-prompt") + 1]
    assert "mcp__studio__" in prompt and "studio:run/" in prompt


def test_a_turn_that_changes_nothing_reports_no_changes(tmp_path, repo, monkeypatch):
    binary = tmp_path / "claude"
    binary.write_text(EDITING_CLAUDE, encoding="utf-8")
    binary.chmod(0o755)
    monkeypatch.setenv("OX_FAKE_READONLY", "1")
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("OX_FAKE_OUT", str(tmp_path / "argv.json"))
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "s.json"))) as client:
        pid = client.post("/api/open", json={"path": str(repo)}).json()["id"]
        turn = client.post(f"/api/p/{pid}/chat", json={"message": "look"}).json()["turn"]
        events, cursor = [], 0
        for _ in range(50):
            batch = client.get(f"/api/chat/turn/{turn}?cursor={cursor}").json()
            events += batch["events"]
            cursor = batch["cursor"]
            if not batch["alive"]:
                break
    assert "changes" not in [e["t"] for e in events] and events[-1]["t"] == "done"


@pytest.mark.parametrize("mode, allowed, denied", [
    ("read", ["mcp__studio__open_run", "mcp__studio__monitor"], ["mcp__studio", "mcp__studio__run_job", "Bash"]),
    ("edit", ["mcp__studio", "Edit"], ["Bash"]),
    ("full", ["mcp__studio", "Bash"], []),
])
def test_the_studio_tools_follow_the_chat_mode(monkeypatch, mode, allowed, denied):
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_MODE", mode)
    args = chat._mode_args()
    for tool in allowed:
        assert tool in args
    for tool in denied:
        assert tool not in args
