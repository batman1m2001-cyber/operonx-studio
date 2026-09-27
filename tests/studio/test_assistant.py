"""The assistant's sessions and turns (operonx_studio.assistant) — R2.

A fake ``claude`` binary replays stream-json shaped like Claude Code
2.1.283's real output (captured 2026-09-27: init, thinking and text
deltas, a Read tool call and its result, per-message usage, a result
with modelUsage; ``/compact`` as status → compact_boundary). Its reply
depends on the message, so one binary covers every path. It records
each invocation, so the tests see the flags each turn ran with.

Gates: conversations persist and restore with every item; each turn
forks from the one before, and regenerate / edit fork from before the
turn they replace; the stream and the poll deliver the same events and
resume by cursor; stop keeps what was written; failures and crashes say
so and offer a retry; compaction is an item and resets the context
meter; search, archive, rename and delete; titles from the first
message, then from the model; old browser transcripts import; a studio
restart marks the turns it killed; the pulse hears a turn end.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.assistant import ChatStore, Relay, title_from
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

FAKE = r'''#!/usr/bin/env python3
import json, os, sys, time, uuid, signal

argv = sys.argv[1:]
log = os.environ.get("OX_FAKE_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps({"argv": argv, "cwd": os.getcwd()}) + "\n")
msg = argv[argv.index("-p") + 1] if "-p" in argv else ""

if "--output-format" in argv and argv[argv.index("--output-format") + 1] == "json":
    print(json.dumps({"type": "result", "result": "Fake title here"}))
    sys.exit(0)

def emit(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()

sid = ("fork-" if "--fork-session" in argv else "new-") + uuid.uuid4().hex[:8]
model = argv[argv.index("--model") + 1] if "--model" in argv else "claude-fake-1"
usage = {"input_tokens": 10, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200, "output_tokens": 40}

if msg == "/compact":
    emit({"type": "system", "subtype": "status", "status": "compacting", "session_id": sid})
    emit({"type": "system", "subtype": "init", "session_id": sid, "model": model})
    emit({"type": "system", "subtype": "compact_boundary", "session_id": sid,
          "compact_metadata": {"trigger": "manual", "pre_tokens": 22505, "post_tokens": 2077, "duration_ms": 1500}})
    emit({"type": "result", "subtype": "success", "session_id": sid, "total_cost_usd": 0.03, "is_error": False,
          "usage": {}, "num_turns": 0})
    sys.exit(0)

if "CRASH" in msg:
    sys.stderr.write("boom: the fake fell over\n")
    sys.exit(3)

emit({"type": "system", "subtype": "init", "session_id": sid, "model": model})

if "SLOW" in msg:
    signal.signal(signal.SIGINT, lambda *a: sys.exit(130))
    emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}})
    emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Working on it"}}})
    time.sleep(30)
    sys.exit(0)

emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Let me look."}}})
emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Hel"}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "lo"}}})
emit({"type": "assistant", "message": {"model": model, "content": [
    {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": os.path.join(os.getcwd(), "main.py")}}],
    "usage": usage}, "session_id": sid})
if "EDIT" in msg:
    with open("added.py", "w") as f:
        f.write("X = 1\n")
emit({"type": "user", "message": {"role": "user", "content": [
    {"tool_use_id": "toolu_1", "type": "tool_result", "content": "1\tfrom operonx.core import op\n",
     **({"is_error": True} if "TOOLFAIL" in msg else {})}]}, "session_id": sid})
emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " world"}}})
emit({"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {"five_hour": {"utilization": 0.05}}}})
emit({"type": "result", "subtype": "success", "session_id": sid, "total_cost_usd": 0.0125, "duration_ms": 1234,
      "num_turns": 2, "is_error": "FAIL" in msg, "result": "the fake failed on purpose" if "FAIL" in msg else "Hello world",
      "usage": usage, "modelUsage": {model: {"contextWindow": 200000, "maxOutputTokens": 32000}}})
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

MANIFEST = '[project]\nname = "chatty-demo"\n\n[[graph]]\nname  = "flow"\nentry = "main:flow"\n'


@pytest.fixture()
def fake(tmp_path: Path, monkeypatch):
    binary = tmp_path / "fake-claude"
    binary.write_text(FAKE, encoding="utf-8")
    binary.chmod(0o755)
    log = tmp_path / "invocations.jsonl"
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("OX_FAKE_LOG", str(log))
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    # the model-made title runs after a turn, in the background: on only
    # where a test waits for it, so no test ends with one in flight
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_TITLES", "off")

    def calls():
        if not log.is_file():
            return []
        return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    return calls


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "main.py").write_text(PROJECT_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path):
    app = build_studio_app(Recents(state_file=tmp_path / "state" / "studio.json"))
    with TestClient(app) as c:
        yield c


def _pid(client, root: Path) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def _session(client, scope: str, **kw) -> dict:
    res = client.post("/api/assistant/sessions", json={"scope": scope, **kw})
    assert res.status_code == 200, res.text
    return res.json()["session"]


def _drain(client, turn: str, cursor: int = 0) -> list:
    events = []
    for _ in range(100):
        got = client.get(f"/api/assistant/turns/{turn}", params={"cursor": cursor}).json()
        events += got["events"]
        cursor = got["cursor"]
        if not got["alive"]:
            return events
    raise AssertionError(f"turn never ended: {events[-3:]}")


def _say(client, sid: str, message: str, **kw) -> tuple:
    res = client.post(f"/api/assistant/sessions/{sid}/turns", json={"message": message, **kw})
    assert res.status_code == 200, res.text
    turn = res.json()["turn"]
    return turn, _drain(client, turn)


def _kinds(items: list) -> list:
    return [i["kind"] for i in items]


def test_a_turn_becomes_items_that_persist_and_restore(client, project, fake):
    pid = _pid(client, project)
    sess = _session(client, pid)
    assert sess["title"] == "" and sess["scope_name"] == "chatty-demo" and not sess["running"]
    turn, events = _say(client, sess["id"], "Why is shout slow?", view={"node": "shout", "tab": "flow"})
    assert [e["i"] for e in events] == list(range(len(events)))       # the cursor is the index
    assert events[-1]["t"] == "done" and events[-1]["state"] == "done"
    states = [e["state"] for e in events if e["t"] == "state"]
    assert states[:2] == ["starting", "thinking"] and "writing" in states and "tool" in states

    got = client.get(f"/api/assistant/sessions/{sess['id']}").json()
    assert got["running"] is None
    items = got["items"]
    assert _kinds(items) == ["user", "thinking", "text", "tool", "text", "turn_end"]
    user, thinking, hello, tool, world, end = items
    assert user["text"] == "Why is shout slow?" and user["view"] == {"node": "shout", "tab": "flow"}
    assert thinking["text"] == "Let me look." and thinking["ms"] >= 0
    assert hello["text"] == "Hello" and world["text"] == " world"
    assert tool["name"] == "Read" and tool["status"] == "ok" and tool["label"] == "Read main.py"
    from operonx_studio.assistant import _tool_label
    deep = "/very/long/" + "x" * 90 + "/proj"
    assert _tool_label("Read", {"file_path": deep + "/app/main.py"}, deep) == "Read app/main.py"
    assert "from operonx.core import op" in tool["output"] and tool["ms"] >= 0
    assert end["state"] == "done" and end["cost"] == 0.0125 and end["context"] == 1250

    s = got["session"]
    assert s["title"] == "Why is shout slow?" and s["claude_session"].startswith("new-")
    assert s["preview"] == "world"
    u = s["usage"]
    assert u["context_tokens"] == 1250 and u["context_window"] == 200000 and u["model"] == "claude-fake-1"
    assert u["cost_usd"] == 0.0125 and u["turns"] == 1 and u["output_tokens"] == 40 and u["rate"]["five_hour"] == 0.05

    call = fake()[0]
    assert call["cwd"] == str(project) and "--resume" not in call["argv"]
    prompt = call["argv"][call["argv"].index("--append-system-prompt") + 1]
    assert "Project briefing: chatty-demo" in prompt and "selected op: `shout`" in prompt
    mcp = json.loads(call["argv"][call["argv"].index("--mcp-config") + 1])
    assert mcp["mcpServers"]["studio"]["env"]["OPERONX_STUDIO_PID"] == pid

    # a new studio process, the same store: the conversation is all there
    app2 = build_studio_app(Recents(state_file=project.parent / "state" / "studio.json"))
    with TestClient(app2) as c2:
        again = c2.get(f"/api/assistant/sessions/{sess['id']}").json()
    assert again["items"] == items


def test_every_turn_forks_and_redo_forks_from_before(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    t1, _ = _say(client, sid, "first")
    after1 = client.get(f"/api/assistant/sessions/{sid}").json()["session"]["claude_session"]
    t2, _ = _say(client, sid, "second")
    calls = fake()
    argv2 = calls[-1]["argv"]
    assert argv2[argv2.index("--resume") + 1] == after1 and "--fork-session" in argv2
    after2 = client.get(f"/api/assistant/sessions/{sid}").json()["session"]["claude_session"]
    assert after2.startswith("fork-") and after2 != after1

    # regenerate the second answer: fork from after the FIRST turn
    t3, _ = _say(client, sid, "", retry_of=t2)
    argv3 = fake()[-1]["argv"]
    assert argv3[argv3.index("-p") + 1] == "second" and argv3[argv3.index("--resume") + 1] == after1
    items = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    assert [i["text"] for i in items if i["kind"] == "user"] == ["first", "second"]
    assert {i["turn"] for i in items} == {t1, t3}                      # t2 is hidden, not shown twice

    # edit the FIRST message: a fresh conversation from there
    t4, _ = _say(client, sid, "first, reworded", edit_of=t1)
    argv4 = fake()[-1]["argv"]
    assert "--resume" not in argv4 and argv4[argv4.index("-p") + 1] == "first, reworded"
    items = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    assert [i["text"] for i in items if i["kind"] == "user"] == ["first, reworded"]
    assert client.post(f"/api/assistant/sessions/{sid}/turns", json={"retry_of": "nope"}).status_code == 404


def test_the_stream_and_the_poll_agree_and_resume_by_cursor(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    turn = client.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "hi"}).json()["turn"]
    streamed = []
    for _ in range(20):                                  # windows until the turn is done
        with client.stream("GET", f"/api/assistant/turns/{turn}/stream",
                           params={"cursor": len(streamed), "window": 2}) as res:
            assert res.headers["content-type"].startswith("application/x-ndjson")
            for line in res.iter_lines():
                ev = json.loads(line)
                if ev["t"] != "hb":
                    streamed.append(ev)
        if streamed and streamed[-1]["t"] == "done":
            break
    polled = _drain(client, turn)
    assert streamed == polled
    # from the middle: exactly the rest
    mid = len(polled) // 2
    with client.stream("GET", f"/api/assistant/turns/{turn}/stream", params={"cursor": mid}) as res:
        rest = [json.loads(line) for line in res.iter_lines()]
    assert rest == polled[mid:]
    assert client.get("/api/assistant/turns/nope/stream").status_code == 404


def test_stop_keeps_what_was_written(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    turn = client.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "SLOW please"}).json()["turn"]
    for _ in range(50):
        got = client.get(f"/api/assistant/sessions/{sid}").json()
        if any(i["kind"] == "text" for i in got["items"]):
            break
        time.sleep(0.1)
    assert got["running"]["id"] == turn and got["session"]["running"]
    # one conversation, one turn at a time
    busy = client.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "again"})
    assert busy.status_code == 409
    t0 = time.monotonic()
    assert client.post(f"/api/assistant/turns/{turn}/stop").json()["ok"]
    events = _drain(client, turn)
    assert time.monotonic() - t0 < 5 and events[-1]["state"] == "stopped"
    items = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    assert [i["text"] for i in items if i["kind"] == "text"] == ["Working on it"]
    assert items[-1]["kind"] == "turn_end" and items[-1]["state"] == "stopped"
    sess = client.get(f"/api/assistant/sessions/{sid}").json()["session"]
    assert not sess["running"] and sess["claude_session"]          # the next turn continues from it


def test_failures_say_so_and_offer_a_retry(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _, events = _say(client, sid, "FAIL now")
    assert events[-1]["state"] == "failed"
    err = next(i for i in client.get(f"/api/assistant/sessions/{sid}").json()["items"] if i["kind"] == "error")
    assert err["text"] == "the fake failed on purpose" and err["retry"]
    sid2 = _session(client, pid)["id"]
    _, events = _say(client, sid2, "CRASH now")
    items = client.get(f"/api/assistant/sessions/{sid2}").json()["items"]
    assert events[-1]["state"] == "failed" and "the fake fell over" in items[-2]["text"]
    sid3 = _session(client, pid)["id"]
    _say(client, sid3, "TOOLFAIL now")
    tool = next(i for i in client.get(f"/api/assistant/sessions/{sid3}").json()["items"] if i["kind"] == "tool")
    assert tool["status"] == "error"


def test_compact_is_an_item_and_resets_the_meter(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    assert client.post(f"/api/assistant/sessions/{sid}/compact").status_code == 400   # nothing yet
    _say(client, sid, "hello")
    before = client.get(f"/api/assistant/sessions/{sid}").json()["session"]["claude_session"]
    turn = client.post(f"/api/assistant/sessions/{sid}/compact").json()["turn"]
    events = _drain(client, turn)
    assert "compacting" in [e["state"] for e in events if e["t"] == "state"]
    argv = fake()[-1]["argv"]
    assert argv[argv.index("-p") + 1] == "/compact" and argv[argv.index("--resume") + 1] == before
    got = client.get(f"/api/assistant/sessions/{sid}").json()
    compact = next(i for i in got["items"] if i["kind"] == "compact")
    assert (compact["pre"], compact["post"]) == (22505, 2077)
    assert got["session"]["usage"]["context_tokens"] == 2077 and got["session"]["claude_session"] != before
    assert [i["text"] for i in got["items"] if i["kind"] == "user"] == ["hello"]   # no "/compact" bubble


def test_find_archive_rename_delete(client, project, fake):
    pid = _pid(client, project)
    a = _session(client, pid)["id"]
    b = _session(client, "home")["id"]
    _say(client, a, "Tune the refund prompt")
    _say(client, b, "Make me a new project")
    listed = client.get("/api/assistant/sessions").json()["sessions"]
    assert [s["id"] for s in listed] == [b, a] and listed[0]["scope_name"] == "Home"
    assert [s["id"] for s in client.get("/api/assistant/sessions", params={"scope": pid}).json()["sessions"]] == [a]
    assert [s["id"] for s in client.get("/api/assistant/sessions", params={"q": "refund"}).json()["sessions"]] == [a]
    # search reaches what was said, not only titles
    assert [s["id"] for s in client.get("/api/assistant/sessions", params={"q": "world"}).json()["sessions"]] == [b, a]
    assert client.get("/api/assistant/sessions", params={"q": "100%_x"}).json()["sessions"] == []

    client.patch(f"/api/assistant/sessions/{a}", json={"title": "  Refund   prompt "})
    client.patch(f"/api/assistant/sessions/{a}", json={"archived": True})
    assert [s["id"] for s in client.get("/api/assistant/sessions").json()["sessions"]] == [b]
    arch = client.get("/api/assistant/sessions", params={"archived": "1"}).json()["sessions"]
    assert [(s["id"], s["title"], s["title_source"]) for s in arch] == [(a, "Refund prompt", "user")]
    assert client.patch(f"/api/assistant/sessions/{a}", json={"title": " "}).status_code == 400
    assert client.patch(f"/api/assistant/sessions/{a}", json={"model": "gpt"}).status_code == 400
    client.patch(f"/api/assistant/sessions/{b}", json={"model": "haiku"})
    _say(client, b, "and another")
    argv = fake()[-1]["argv"]
    assert argv[argv.index("--model") + 1] == "haiku"

    assert client.delete(f"/api/assistant/sessions/{a}").json()["deleted"] == a
    assert client.get(f"/api/assistant/sessions/{a}").status_code == 404
    assert client.post("/api/assistant/sessions", json={"scope": "nope"}).status_code == 404


def test_titles_come_from_the_first_message_then_the_model(client, project, fake, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_TITLES", "on")
    assert title_from("  fix the\nrest") == "fix the"
    long = "Please look into why the refund classifier keeps sending cancellations to the wrong queue today"
    assert title_from(long).endswith("…") and len(title_from(long)) <= 61
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _say(client, sid, "Why is shout slow?")
    for _ in range(50):
        s = client.get(f"/api/assistant/sessions/{sid}").json()["session"]
        if s["title_source"] == "ai":
            break
        time.sleep(0.1)
    assert (s["title"], s["title_source"]) == ("Fake title here", "ai")
    title_calls = [c for c in fake() if "json" in c["argv"]]
    argv = title_calls[0]["argv"]
    assert argv[argv.index("--model") + 1] == "haiku" and argv[argv.index("--tools") + 1] == ""
    assert "--strict-mcp-config" in argv and "Never answer" in argv[argv.index("--system-prompt") + 1]
    assert "<user>Why is shout slow?</user>" in argv[argv.index("-p") + 1]
    # what the model says is kept only if it reads as a title
    from operonx_studio.assistant import _looks_like_title
    assert _looks_like_title("Refund classifier routing bug")
    assert not _looks_like_title("I can't find operonx.toml in /root/.operonx. Could you provide the file")
    assert not _looks_like_title("What does this project do?") and not _looks_like_title("")


def test_old_browser_transcripts_import(client, project, fake):
    pid = _pid(client, project)
    log = [{"w": "me", "text": "What does shout do?"}, {"w": "bot", "text": "It upper-cases."},
           {"w": "tool", "name": "Read", "hint": "main.py"},
           {"w": "changes", "sha": "abc1234", "files": [{"path": "main.py", "added": 1, "removed": 0}],
            "diff": "+x", "state": "kept"},
           {"w": "meta", "text": "$0.01"}]
    got = client.post("/api/assistant/import", json={"scope": pid, "log": log, "session": "old-claude-1"}).json()
    sess = got["session"]
    assert got["items"] == 5 and sess["title"] == "What does shout do?" and sess["claude_session"] == "old-claude-1"
    items = client.get(f"/api/assistant/sessions/{sess['id']}").json()["items"]
    assert _kinds(items) == ["user", "text", "tool", "changes", "note"] and items[3]["state"] == "kept"
    _say(client, sess["id"], "and now?")           # it carries on the same Claude conversation
    argv = fake()[-1]["argv"]
    assert argv[argv.index("--resume") + 1] == "old-claude-1"
    assert client.post("/api/assistant/import", json={"scope": pid, "log": []}).status_code == 400


def test_a_restart_marks_the_turns_it_killed(tmp_path):
    store = ChatStore(tmp_path / "a.sqlite")
    sess = store.create_session("home")
    store.add_turn("t1", sess["id"], message="long job", kind="message", claude_before=None)
    store.update_session(sess["id"], running_turn="t1")
    Relay(store)                                   # what a new studio process does on start
    after = store.session(sess["id"])
    assert not after["running"] and store.turn("t1")["state"] == "interrupted"
    (err,) = store.items(sess["id"])
    assert err["kind"] == "error" and "restarted" in err["text"] and err["retry"]


def test_changes_are_a_card_with_keep_and_undo_state(client, project, fake):
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], cwd=project,
                   check=True)
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _say(client, sid, "EDIT something")
    items = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    card = next(i for i in items if i["kind"] == "changes")
    assert [f["path"] for f in card["files"]] == ["added.py"] and card["files"][0]["new"]
    done = client.post(f"/api/p/{pid}/chat/undo", json={"sha": card["sha"], "files": [], "new_files": ["added.py"]})
    assert done.json()["restored"] == ["added.py"] and not (project / "added.py").exists()
    marked = client.post(f"/api/assistant/sessions/{sid}/items/{card['seq']}", json={"state": "undone", "restored": 1})
    assert marked.json()["item"]["state"] == "undone"
    again = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    assert next(i for i in again if i["kind"] == "changes")["state"] == "undone"
    assert client.post(f"/api/assistant/sessions/{sid}/items/999", json={"state": "kept"}).status_code == 404


def test_home_turns_brief_the_roster_and_carry_home_tools(client, project, fake):
    _pid(client, project)
    sid = _session(client, "home")["id"]
    _say(client, sid, "what do I have?")
    call = fake()[0]
    prompt = call["argv"][call["argv"].index("--append-system-prompt") + 1]
    assert "No project is open" in prompt and "chatty-demo" in prompt and "rag-qa" in prompt
    mcp = json.loads(call["argv"][call["argv"].index("--mcp-config") + 1])
    assert mcp["mcpServers"]["studio"]["env"]["OPERONX_STUDIO_PID"] == "home"


def test_the_pulse_hears_a_turn_end(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    first = client.get(f"/api/p/{pid}/pulse", params={"ui": -1, "chat": -1}).json()
    seen = first["chat_last"]
    holder = {}

    def wait():
        holder["got"] = client.get(f"/api/p/{pid}/pulse", params={"stamp": first["stamp"], "ui": first["ui_last"],
                                                                    "chat": seen, "hold": 8}).json()

    th = threading.Thread(target=wait)
    th.start()
    time.sleep(0.3)
    t0 = time.monotonic()
    _say(client, sid, "hi")
    th.join(10)
    assert time.monotonic() - t0 < 6
    (ended,) = holder["got"]["chat_ended"]
    assert ended["session"] == sid and ended["state"] == "done" and ended["title"] == "hi"


def test_starters_come_from_the_projects_state(client, project, fake):
    from operonx.core.workflow_trace import OpExecution, WorkflowTrace
    from operonx.telemetry.runs.files import FilesRunStore

    store = FilesRunStore(root=project / ".operonx" / "runs", refresh_every=0)
    for i, bad in enumerate([True, True, False]):
        node = OpExecution(op_id=f"g.a#{i}", op_name="a", op_full_name="g.a", ctx=("main",), start_time=1.0,
                           end_time=1.2, inputs={}, outputs={}, upstreams=[],
                           status="error" if bad else "ok", error="boom" if bad else None)
        store.consume(WorkflowTrace(trace_id=f"r{i}", workflow_name="flow", started_at=1.0, ended_at=1.2,
                                    nodes=[node], metadata={"origin": "service", "service": "desk"},
                                    wall_started_at=time.time() - 60))
    pid = _pid(client, project)
    got = client.get(f"/api/p/{pid}/assistant/suggest").json()["suggestions"]
    assert got[0]["kind"] == "failure" and got[0]["label"] == "Why did 2 runs of desk fail today?"
    assert "2 of today's 3 service runs" in got[0]["prompt"]
    assert any(s["kind"] == "learn" for s in got) and len(got) <= 6
    pointed = client.get(f"/api/p/{pid}/assistant/suggest", params={"node": "shout"}).json()["suggestions"]
    assert [s["label"] for s in pointed[:2]] == ["Explain shout", "Why is shout slow?"]
    assert client.get("/api/p/nope/assistant/suggest").status_code == 404
