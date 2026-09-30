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

import base64
import json
import subprocess
import threading
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.assistant import ChatStore, Relay, split_message, title_from
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

FAKE = r'''#!/usr/bin/env python3
import json, os, sys, time, uuid, signal

argv = sys.argv[1:]
home = os.environ.get("CLAUDE_CONFIG_DIR")
creds = os.path.join(home, ".fake-credentials") if home else None
if argv[:1] == ["auth"]:
    log = os.environ.get("OX_FAKE_LOG")
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"auth": argv[1], "config_dir": home,
                                "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY"))}) + "\n")
if argv[:2] == ["auth", "status"]:
    # the machine's login is you@example.com; a config dir is signed in once
    # its login finished
    if home and not os.path.exists(creds):
        print(json.dumps({"loggedIn": False, "authMethod": "none", "configDirectory": home}))
        sys.exit(1)
    email = open(creds).read().strip() if home else "you@example.com"
    print(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                      "email": email, "orgName": "Your org", "orgId": "secret-org-id",
                      "subscriptionType": "max"}))
    sys.exit(0)
if argv[:2] == ["auth", "login"]:
    sys.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: "
                     "https://claude.com/cai/oauth/authorize?code=true&state=fake\nPaste code here if prompted > ")
    sys.stdout.flush()
    code = sys.stdin.readline().strip()
    if code == "good-code#fake":
        with open(creds, "w") as f:
            f.write("studio@example.com")
        print("Login successful.")
        sys.exit(0)
    print("Login failed: Request failed with status code 400")
    sys.exit(1)
if argv[:2] == ["auth", "logout"]:
    if creds and os.path.exists(creds):
        os.remove(creds)
    print("Successfully logged out from your Anthropic account.")
    sys.exit(0)
# a message turn arrives on stdin as one stream-json user message (images,
# then words); a /compact or a title call as the -p argument
images = []
if "--input-format" in argv and argv[argv.index("--input-format") + 1] == "stream-json":
    line = sys.stdin.readline()
    content = (json.loads(line) if line.strip() else {}).get("message", {}).get("content", [])
    msg = "".join(b.get("text", "") for b in content if b.get("type") == "text")
    images = [[b["source"]["media_type"], b["source"]["data"]] for b in content if b.get("type") == "image"]
else:
    msg = argv[argv.index("-p") + 1] if "-p" in argv else ""
log = os.environ.get("OX_FAKE_LOG")
# the MCP config is a file (it carries the turn's agent token): what it
# held, and who could read it, while the turn ran
mcp, mcp_mode = None, None
if "--mcp-config" in argv:
    cfg = argv[argv.index("--mcp-config") + 1]
    mcp_mode = oct(os.stat(cfg).st_mode & 0o777)
    mcp = json.load(open(cfg))
if log:
    with open(log, "a") as f:
        f.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "msg": msg, "images": images,
                            "config_dir": home, "mcp": mcp, "mcp_mode": mcp_mode,
                            "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY"))}) + "\n")

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

if "AUTHFAIL" in msg:
    emit({"type": "system", "subtype": "init", "session_id": sid, "model": model})
    emit({"type": "result", "subtype": "success", "session_id": sid, "is_error": True, "usage": {}, "num_turns": 0,
          "result": "Invalid API key · Please run /login"})
    sys.exit(1)

if "CRASH" in msg:
    sys.stderr.write("boom: the fake fell over\n")
    sys.exit(3)

emit({"type": "system", "subtype": "init", "session_id": sid, "model": model})

if "badmodel" in model:
    emit({"type": "result", "subtype": "success", "session_id": sid, "is_error": True, "usage": {}, "num_turns": 0,
          "result": f"There's an issue with the selected model ({model}). It may not exist or you may not have access to it."})
    sys.exit(1)

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
emit({"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed", "resetsAt": 1790552400, "rateLimitType": "five_hour", "isUsingOverage": False,
    "unifiedWindows": {"five_hour": {"utilization": 0.05, "resetsAt": 1790552400},
                       "seven_day": {"utilization": 0.52, "resetsAt": 1790791200}}}})
emit({"type": "result", "subtype": "success", "session_id": sid, "total_cost_usd": 0.0125, "duration_ms": 1234,
      "num_turns": 2, "is_error": "FAIL" in msg, "result": "the fake failed on purpose" if "FAIL" in msg else "Hello world",
      "usage": usage, "modelUsage": {model: {"contextWindow": 200000, "maxOutputTokens": 32000},
                                     "claude-helper-1": {"contextWindow": 111}}})
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
    # the studio's own sign-in lives here, never in the real ~/.operonx/claude
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_HOME", str(tmp_path / "claude-home"))
    from operonx_studio import chat as _chat_mod
    _chat_mod._homes.clear()
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
    # a reader that is behind rebuilds exactly the text: an item event is a
    # snapshot, its deltas add the rest (a live reference once doubled the
    # first delta: "HelHello")
    rebuilt = {}
    for e in events:
        if e["t"] == "item" and e["item"]["kind"] == "text":
            rebuilt[e["item"]["seq"]] = e["item"].get("text") or ""
        elif e["t"] == "delta" and e["seq"] in rebuilt:
            rebuilt[e["seq"]] += e["text"]
    assert list(rebuilt.values()) == ["Hello", " world"]
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
    assert _tool_label("ToolSearch", {"query": "select:mcp__studio__new_project"}) == "Loaded the studio's tools"
    assert "from operonx.core import op" in tool["output"] and tool["ms"] >= 0
    assert end["state"] == "done" and end["cost"] == 0.0125 and end["context"] == 1250

    s = got["session"]
    assert s["title"] == "Why is shout slow?" and s["claude_session"].startswith("new-")
    assert s["preview"] == "world"
    u = s["usage"]
    assert u["context_tokens"] == 1250 and u["context_window"] == 200000 and u["model"] == "claude-fake-1"
    assert u["cost_usd"] == 0.0125 and u["turns"] == 1 and u["output_tokens"] == 40 and u["rate"]["five_hour"]["used"] == 0.05

    call = fake()[0]
    assert call["cwd"] == str(project) and "--resume" not in call["argv"]
    prompt = call["argv"][call["argv"].index("--append-system-prompt") + 1]
    assert "Project briefing: chatty-demo" in prompt and "selected op: `shout`" in prompt
    mcp = call["mcp"]
    assert mcp["mcpServers"]["studio"]["env"]["OPERONX_STUDIO_PID"] == pid
    assert "--strict-mcp-config" in call["argv"]       # the studio's tools, not the host's connectors

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
    call3 = fake()[-1]
    argv3 = call3["argv"]
    assert call3["msg"] == "second" and argv3[argv3.index("--resume") + 1] == after1
    items = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    assert [i["text"] for i in items if i["kind"] == "user"] == ["first", "second"]
    assert {i["turn"] for i in items} == {t1, t3}                      # t2 is hidden, not shown twice

    # edit the FIRST message: a fresh conversation from there
    t4, _ = _say(client, sid, "first, reworded", edit_of=t1)
    call4 = fake()[-1]
    assert "--resume" not in call4["argv"] and call4["msg"] == "first, reworded"
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


def test_pasted_blocks_are_not_the_title():
    """The composer sends a paste as a fenced block ahead of the words
    (static/paste.js); the title comes from the words, or names the paste."""
    body = "\n".join(f'  "k{i}": {i},' for i in range(40))
    msg = "```json\n{\n" + body + "\n}\n```\n\nWhy is this payload rejected?"
    assert title_from(msg) == "Why is this payload rejected?"
    assert title_from("```json\n{\n" + body + "\n}\n```") == "Pasted JSON · 42 lines"
    assert title_from("```python main.py\nprint(1)\n```") == "main.py · 1 line"
    # a longer fence holds a shorter one inside
    words, blocks = split_message("````markdown\nsee:\n```js\nx()\n```\n````\n\nfix it")
    assert words == "fix it"
    assert blocks == [("markdown", "", "see:\n```js\nx()\n```")]


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
    sess = store.create_session("home", owner="u1")
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
    assert call["mcp"]["mcpServers"]["studio"]["env"]["OPERONX_STUDIO_PID"] == "home"


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


# ── A2: the message on stdin, and images with it ─────────────────────────

PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6300010000050001" "0d0a2db40000000049454e44ae426082")).decode()


def test_a_message_goes_in_on_stdin_whatever_its_size(client, project, fake):
    """As one argument a message past Linux's 128 KiB MAX_ARG_STRLEN could
    not start the CLI; on stdin a 200 KB paste goes through."""
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    big = "".join(f"Line {i:05d}: the quick brown fox jumps over the lazy dog.\n" for i in range(3600))
    assert len(big.encode()) > 200_000
    _, events = _say(client, sid, big + "How many lines?")
    assert events[-1]["state"] == "done"
    call = fake()[-1]
    assert call["msg"] == big + "How many lines?"
    assert "stream-json" in call["argv"] and big[:40] not in " ".join(call["argv"])


def test_images_ride_along_and_are_sent_again_on_retry(client, project, fake, tmp_path):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    up = client.post(f"/api/assistant/sessions/{sid}/attachments",
                     json={"name": "chart.png", "mime": "image/png", "data": PNG, "w": 1, "h": 1})
    assert up.status_code == 200, up.text
    ref = up.json()["attachment"]
    assert ref["mime"] == "image/png" and ref["name"] == "chart.png" and ref["size"] > 0 and len(ref["id"]) == 32
    # the same bytes twice are one file
    assert client.post(f"/api/assistant/sessions/{sid}/attachments",
                       json={"mime": "image/png", "data": PNG}).json()["attachment"]["id"] == ref["id"]
    got = client.get(f"/api/assistant/sessions/{sid}/attachments/{ref['id']}")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert base64.b64encode(got.content).decode() == PNG

    t1, events = _say(client, sid, "What is in this chart?", attachments=[ref["id"]])
    assert events[-1]["state"] == "done"
    call = fake()[-1]
    assert call["msg"] == "What is in this chart?" and call["images"] == [["image/png", PNG]]
    user = next(i for i in client.get(f"/api/assistant/sessions/{sid}").json()["items"] if i["kind"] == "user")
    assert user["attachments"] == [ref]                               # references, never bytes

    # regenerate: the same image again; edit: what the edit has now
    _say(client, sid, "", retry_of=t1)
    assert fake()[-1]["images"] == [["image/png", PNG]]
    items = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    t2 = next(i for i in items if i["kind"] == "user")["turn"]
    _say(client, sid, "Describe it in words instead", edit_of=t2, attachments=[])
    assert fake()[-1]["images"] == [] and fake()[-1]["msg"] == "Describe it in words instead"

    # images alone make a message, and name a new conversation
    sid2 = _session(client, pid)["id"]
    ref2 = client.post(f"/api/assistant/sessions/{sid2}/attachments",
                       json={"name": "screen.png", "mime": "image/png", "data": PNG}).json()["attachment"]
    _say(client, sid2, "", attachments=[ref2["id"]])
    assert client.get(f"/api/assistant/sessions/{sid2}").json()["session"]["title"] == "screen.png"

    # deleting the conversation deletes its files
    folder = next(f for f in (tmp_path / "state").rglob(ref2["id"] + ".png") if f.parent.name == sid2).parent
    res = client.delete(f"/api/assistant/sessions/{sid2}")
    assert res.status_code == 200, res.text
    assert not folder.exists(), list(folder.iterdir())


def test_attachments_are_checked(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    post = lambda body: client.post(f"/api/assistant/sessions/{sid}/attachments", json=body)
    assert post({"mime": "application/pdf", "data": PNG}).status_code == 400
    assert post({"mime": "image/png", "data": "not base64!"}).status_code == 400
    assert post({"mime": "image/png", "data": ""}).status_code == 400
    huge = base64.b64encode(b"\0" * (5 * 1024 * 1024 + 1)).decode()
    assert post({"mime": "image/png", "data": huge}).status_code == 413
    turn = lambda body: client.post(f"/api/assistant/sessions/{sid}/turns", json=body)
    assert turn({"message": "hi", "attachments": ["nope"]}).status_code == 400
    assert turn({"message": "hi", "attachments": "nope"}).status_code == 400
    ids = []
    for i in range(9):
        data = base64.b64encode(base64.b64decode(PNG) + bytes([i])).decode()
        ids.append(post({"mime": "image/png", "data": data}).json()["attachment"]["id"])
    assert turn({"message": "hi", "attachments": ids}).status_code == 400          # at most 8
    assert turn({"message": "", "attachments": []}).status_code == 400
    assert client.get(f"/api/assistant/sessions/{sid}/attachments/nope").status_code == 404


def test_a_store_from_before_attachments_gains_the_column(tmp_path):
    import sqlite3
    path = tmp_path / "old.sqlite"
    db = sqlite3.connect(str(path))
    db.executescript("""CREATE TABLE turns (id TEXT PRIMARY KEY, session TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
        message TEXT NOT NULL, claude_before TEXT, claude_after TEXT, state TEXT NOT NULL, started REAL NOT NULL,
        ended REAL, usage TEXT NOT NULL DEFAULT '{}', cost REAL, hidden INTEGER NOT NULL DEFAULT 0);
        INSERT INTO turns (id, session, message, state, started) VALUES ('t1', 's1', 'hi', 'done', 1);""")
    db.commit()
    db.close()
    store = ChatStore(path)
    assert store.turn("t1")["attachments"] == []



# ── A3: model and effort; B3: a project's own tool servers ────────────────

def test_effort_and_model_reach_the_cli_and_the_answer(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    assert client.patch(f"/api/assistant/sessions/{sid}", json={"effort": "extreme"}).status_code == 400
    assert client.patch(f"/api/assistant/sessions/{sid}", json={"model": "claude-sonnet-5"}).status_code == 200
    got = client.patch(f"/api/assistant/sessions/{sid}", json={"model": "fable", "effort": "high"}).json()["session"]
    assert got["model"] == "fable" and got["effort"] == "high"
    _, events = _say(client, sid, "hello")
    argv = fake()[-1]["argv"]
    assert argv[argv.index("--model") + 1] == "fable" and argv[argv.index("--effort") + 1] == "high"
    end = next(e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "turn_end")
    assert end["model"] == "fable" and end["effort"] == "high"
    # the window is the turn's own model's, not the helper listed after it
    assert client.get(f"/api/assistant/sessions/{sid}").json()["session"]["usage"]["context_window"] == 200000
    # effort back to the CLI's default: no flag
    client.patch(f"/api/assistant/sessions/{sid}", json={"effort": None})
    _say(client, sid, "again")
    assert "--effort" not in fake()[-1]["argv"]


def test_the_menu_learns_what_the_cli_resolved(client, project, fake):
    got = client.get("/api/assistant/models").json()
    assert [m["id"] for m in got["models"]] == ["fable", "opus", "sonnet", "haiku"]
    assert got["efforts"] == ["low", "medium", "high", "xhigh", "max"] and got["default"]["full"] is None
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _say(client, sid, "hello")                       # no model: the CLI's default (the fake's claude-fake-1)
    got = client.get("/api/assistant/models").json()
    assert got["default"] == {"full": "claude-fake-1", "window": 200000}


def test_defaults_for_new_conversations(client, project, fake):
    pid = _pid(client, project)
    assert client.put("/api/assistant/defaults", json={"model": "gpt"}).status_code == 400
    assert client.put("/api/assistant/defaults", json={"model": "sonnet", "effort": "high"}).json() == \
        {"studio_defaults": {"model": "sonnet", "effort": "high"}}
    s = _session(client, pid)
    assert (s["model"], s["effort"]) == ("sonnet", "high")
    assert _session(client, "home")["model"] == "sonnet"
    # an explicit choice wins; so does the project's [studio.assistant]
    assert _session(client, pid, model=None)["model"] is None
    (project / "operonx.toml").write_text(MANIFEST + '\n[studio.assistant]\nmodel = "haiku"\n', encoding="utf-8")
    s = _session(client, pid)
    assert (s["model"], s["effort"]) == ("haiku", "high")
    assert client.get("/api/assistant/models", params={"scope": pid}).json()["new"] == {"model": "haiku", "effort": "high"}


def test_a_model_the_account_cannot_use_says_so(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid, model="claude-badmodel-9")["id"]
    _, events = _say(client, sid, "hello")
    err = next(e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "error")
    assert err["model_error"] == "claude-badmodel-9" and "can't use the model" in err["text"] and err["retry"]


def test_a_projects_own_tool_servers_join_the_studios(client, project, fake):
    (project / ".mcp.json").write_text(json.dumps({"mcpServers": {
        "notes": {"type": "stdio", "command": "notes-server", "args": ["--quiet"]},
        "studio": {"command": "impostor"},            # the studio's own name is the studio's
        "bad name!": {"command": "x"}}}), encoding="utf-8")
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _say(client, sid, "hello")
    argv = fake()[-1]["argv"]
    servers = fake()[-1]["mcp"]["mcpServers"]
    assert set(servers) == {"notes", "studio"} and servers["notes"]["command"] == "notes-server"
    assert servers["studio"]["args"] == ["-m", "operonx_studio.mcp"]
    assert "--strict-mcp-config" in argv                   # the host's personal connectors stay out
    assert "mcp__notes" in argv[argv.index("--allowedTools"):]



# ── A4: usage ─────────────────────────────────────────────────────────────

def test_plan_limits_are_kept_with_their_reset_times(client, project, fake):
    assert client.get("/api/assistant/usage").json()["rate"] is None      # nothing heard yet
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _, events = _say(client, sid, "hello")
    rate = client.get(f"/api/assistant/sessions/{sid}").json()["session"]["usage"]["rate"]
    assert rate["five_hour"] == {"used": 0.05, "resets": 1790552400}
    assert rate["seven_day"] == {"used": 0.52, "resets": 1790791200}
    assert rate["status"] == "allowed" and rate["limited_by"] == "five_hour" and rate["overage"] is False
    # the account's limits, studio-wide, with when they were heard
    got = client.get("/api/assistant/usage").json()
    assert got["rate"]["seven_day"]["used"] == 0.52 and got["as_of"] and got["as_of"] <= time.time()
    assert client.get(f"/api/p/{pid}/pulse", params={"hold": 0}).json()["assistant_rate"]["five_hour"]["used"] == 0.05
    # each answer carries its tokens: all input (cached included), output, cached
    end = next(e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "turn_end")
    assert end["tokens"] == {"in": 1210, "out": 40, "cached": 1000}


def test_the_account_line_never_carries_an_id(client, project, fake):
    acc = client.get("/api/assistant/account").json()["account"]
    assert {k: acc[k] for k in ("logged_in", "method", "email", "org", "plan", "provider", "source")} == \
        {"logged_in": True, "method": "claude.ai", "email": "you@example.com", "org": "Your org",
         "plan": "max", "provider": "firstParty", "source": "machine"}
    assert "secret" not in json.dumps(client.get("/api/assistant/usage").json())



# ── A5: the assistant's own sign-in ───────────────────────────────────────

def _calls(fake):
    return [c for c in fake() if "argv" in c]


def test_signing_in_the_studio_and_out_again(client, project, fake, tmp_path):
    home = tmp_path / "claude-home"
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _say(client, sid, "hello")                                         # under this machine's login
    assert _calls(fake)[-1]["config_dir"] is None
    assert client.get("/api/assistant/account").json()["account"]["source"] == "machine"

    # a wrong code: the CLI's own words come back, and the sign-in is over
    got = client.post("/api/assistant/login", json={"method": "claudeai"}).json()
    assert got["url"] == "https://claude.com/cai/oauth/authorize?code=true&state=fake"
    bad = client.post(f"/api/assistant/login/{got['login_id']}/code", json={"code": "nope"})
    assert bad.status_code == 400 and bad.json()["error"] == "Login failed: Request failed with status code 400"
    assert client.post(f"/api/assistant/login/{got['login_id']}/code", json={"code": "x"}).status_code == 404

    # the right code: signed in, in the studio's own config dir
    got = client.post("/api/assistant/login", json={"method": "claudeai"}).json()
    res = client.post(f"/api/assistant/login/{got['login_id']}/code", json={"code": "good-code#fake"}).json()
    assert res["ok"] and res["account"]["source"] == "studio" and res["account"]["email"] == "studio@example.com"
    assert (home / ".fake-credentials").is_file()

    # the conversation's Claude session is the machine's: a fresh one, seeded
    # with a summary; the transcript stays whole
    _say(client, sid, "and now?")
    call = _calls(fake)[-1]
    assert call["config_dir"] == str(home) and "--resume" not in call["argv"]
    prompt = call["argv"][call["argv"].index("--append-system-prompt") + 1]
    assert "This conversation so far" in prompt and "Fake title here" in prompt       # the fake's summary
    items = client.get(f"/api/assistant/sessions/{sid}").json()["items"]
    assert [i["text"] for i in items if i["kind"] == "user"] == ["hello", "and now?"]
    _say(client, sid, "and then?")                                     # now it resumes, under the studio's
    assert "--resume" in _calls(fake)[-1]["argv"]

    # signing out: the studio's own, never the machine's; back to the machine's login
    out = client.post("/api/assistant/logout").json()["account"]
    assert out["source"] == "machine" and not (home / ".fake-credentials").exists()
    logouts = [c for c in fake() if c.get("auth") == "logout"]
    assert logouts and all(c["config_dir"] == str(home) for c in logouts)
    _say(client, sid, "back?")
    assert _calls(fake)[-1]["config_dir"] is None


def test_a_sign_in_can_be_cancelled(client, project, fake):
    got = client.post("/api/assistant/login", json={"method": "console"}).json()
    assert client.get("/api/assistant/account").json()["account"]["login"]["id"] == got["login_id"]
    assert client.delete(f"/api/assistant/login/{got['login_id']}").status_code == 200
    assert client.post(f"/api/assistant/login/{got['login_id']}/code", json={"code": "good-code#fake"}).status_code == 404
    assert client.post("/api/assistant/login", json={"method": "carrier-pigeon"}).status_code == 400


def test_a_turn_that_is_not_signed_in_asks_for_it(client, project, fake):
    pid = _pid(client, project)
    sid = _session(client, pid)["id"]
    _, events = _say(client, sid, "AUTHFAIL please")
    err = next(e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "error")
    assert err["auth"] is True and "Please run /login" in err["text"]


# ── P3: a conversation belongs to the person who started it ──────────────
# (docs/TEAM_PLAN.md §2.3). A and B share one client and switch cookies: a
# turn is a task on that client's loop.

def _two(team, project):
    """A (the admin, root) with a conversation, a finished turn and an image
    in the project; B an editor. Returns the ids B must not reach."""
    c = team.client
    b = team.person("bee", "editor")
    team.use(team.admin_token)
    pid = _pid(c, project)
    sid = _session(c, pid)["id"]
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()
    aid = c.post(f"/api/assistant/sessions/{sid}/attachments",
                 json={"mime": "image/png", "data": png, "name": "a.png"}).json()["attachment"]["id"]
    tid, _ = _say(c, sid, "hello from A")
    return {"b": b, "pid": pid, "sid": sid, "aid": aid, "tid": tid}


def test_someone_elses_conversation_is_not_there(team, project, fake):
    from operonx_studio.access import ACCESS

    c = team.client
    a = _two(team, project)
    # every self route that names a conversation, a turn, an image or an item
    routes = [(m, p) for (m, p), level in ACCESS.items() if level == "self"
              and any(k in p for k in ("{sid}", "{tid}", "{aid}", "{seq}"))]
    assert len(routes) == 11
    team.use(a["b"]["token"])
    assert [s["id"] for s in c.get("/api/assistant/sessions").json()["sessions"]] == []
    assert [s["id"] for s in c.get("/api/assistant/sessions", params={"scope": a["pid"]}).json()["sessions"]] == []
    for method, path in routes:
        url = (path.replace("{sid}", a["sid"]).replace("{tid}", a["tid"]).replace("{aid}", a["aid"])
               .replace("{seq}", "1"))
        body = {"message": "mine now", "state": "kept", "title": "stolen", "mime": "image/png",
                "data": base64.b64encode(b"x").decode()} if method in ("POST", "PATCH", "PUT") else None
        res = c.request(method, url, json=body)
        assert res.status_code == 404, (method, path, res.status_code, res.text[:200])
    # nothing of A's changed
    team.use(team.admin_token)
    got = c.get(f"/api/assistant/sessions/{a['sid']}").json()
    assert got["session"]["title"] != "stolen" and [i["text"] for i in got["items"] if i["kind"] == "user"] == ["hello from A"]
    assert all(i.get("state") != "kept" for i in got["items"])
    # B's own conversations work as ever, and A does not see them either
    team.use(a["b"]["token"])
    mine = _session(c, a["pid"])["id"]
    _say(c, mine, "hello from B")
    assert [s["id"] for s in c.get("/api/assistant/sessions").json()["sessions"]] == [mine]
    team.use(team.admin_token)
    assert mine not in [s["id"] for s in c.get("/api/assistant/sessions").json()["sessions"]]
    assert c.get(f"/api/assistant/sessions/{mine}").status_code == 404      # admins don't read them either


def test_the_home_page_and_the_pulse_show_only_your_own(team, project, fake):
    import json as _json

    c = team.client
    a = _two(team, project)
    boot = lambda html: _json.loads(html.split('<script id="home-boot" type="application/json">')[1].split("</script>")[0])
    assert [s["id"] for s in boot(c.get("/").text)["sessions"]] == [a["sid"]]
    ended = c.get(f"/api/p/{a['pid']}/pulse", params={"chat": 0, "hold": 0}).json()["chat_ended"]
    assert [e["session"] for e in ended] == [a["sid"]]
    assert ended[0]["owner"] == c.get("/api/me").json()["user"]["id"]
    team.use(a["b"]["token"])
    assert boot(c.get("/").text)["sessions"] == []
    assert c.get(f"/api/p/{a['pid']}/pulse", params={"chat": 0, "hold": 0}).json()["chat_ended"] == []


def test_screen_actions_reach_only_their_owners_screen(team, project, fake):
    c = team.client
    a = _two(team, project)
    root_id = c.get("/api/me").json()["user"]["id"]
    agent = c.app.state.agents.issue(root_id, 60)          # what A's turn's tools sign in with
    team.use(agent)
    assert c.post(f"/api/p/{a['pid']}/ui/action", json={"kind": "open_run", "args": {"run": "r1"}}).status_code == 200
    team.use(team.admin_token)
    mine = c.get(f"/api/p/{a['pid']}/pulse", params={"ui": 0, "hold": 0}).json()
    assert [x["args"]["run"] for x in mine["actions"]] == ["r1"]
    assert [x["args"]["run"] for x in c.get(f"/api/p/{a['pid']}/ui/actions").json()["actions"]] == ["r1"]
    team.use(a["b"]["token"])
    theirs = c.get(f"/api/p/{a['pid']}/pulse", params={"ui": 0, "hold": 0}).json()
    assert theirs["actions"] == [] and theirs["ui_last"] == 0
    assert c.get(f"/api/p/{a['pid']}/ui/actions").json()["actions"] == []


def test_defaults_are_per_person_and_the_admin_keeps_the_studios(team, project, fake):
    c = team.client
    c.app.state.chat_store.set_meta("defaults", {"model": "sonnet"})     # what the single-login studio had
    b = team.person("bee", "editor")
    team.use(team.admin_token)
    assert c.get("/api/assistant/models").json()["studio_defaults"] == {"model": "sonnet"}
    assert c.put("/api/assistant/defaults", json={"model": "opus", "effort": "high"}).status_code == 200
    team.use(b["token"])
    got = c.get("/api/assistant/models").json()
    assert got["studio_defaults"] == {} and got["new"] == {}
    c.put("/api/assistant/defaults", json={"model": "haiku"})
    assert _session(c, "home")["model"] == "haiku"
    team.use(team.admin_token)
    assert c.get("/api/assistant/models").json()["studio_defaults"] == {"model": "opus", "effort": "high"}
    assert _session(c, "home")["model"] == "opus"


def test_an_old_store_is_adopted_by_the_first_admin(tmp_path, auth_on, fake):
    import sqlite3

    state = tmp_path / "old"
    state.mkdir()
    db = sqlite3.connect(state / "assistant.sqlite")             # a store made before owners
    db.executescript("CREATE TABLE sessions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',"
                     " title_source TEXT NOT NULL DEFAULT '', created REAL NOT NULL, updated REAL NOT NULL,"
                     " archived INTEGER NOT NULL DEFAULT 0, model TEXT, claude_session TEXT,"
                     " usage TEXT NOT NULL DEFAULT '{}', running_turn TEXT, preview TEXT NOT NULL DEFAULT '');"
                     "INSERT INTO sessions (id, scope, title, created, updated) VALUES ('old1', 'home', 'Before', 1, 1);")
    db.commit()
    db.close()
    with TestClient(build_studio_app(Recents(state_file=state / "studio.json"))) as c:
        c.post("/api/login", json={"username": "root", "password": "admin-pass-1"})
        assert [s["id"] for s in c.get("/api/assistant/sessions").json()["sessions"]] == ["old1"]
    # an auth-off studio's conversations ("local") go to the admin too, once there is one
    store = ChatStore(state / "assistant.sqlite")
    store.create_session("home", owner="local", title="From auth off")
    with TestClient(build_studio_app(Recents(state_file=state / "studio.json"))) as c:
        c.post("/api/login", json={"username": "root", "password": "admin-pass-1"})
        assert {s["title"] for s in c.get("/api/assistant/sessions").json()["sessions"]} == {"Before", "From auth off"}


def test_the_studio_runs_at_most_so_many_turns_at_once(team, project, fake, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_MAX_TURNS", "1")
    c = team.client
    b = team.person("bee", "editor")
    team.use(team.admin_token)
    slow = _session(c, "home")["id"]
    running = c.post(f"/api/assistant/sessions/{slow}/turns", json={"message": "SLOW"}).json()["turn"]
    team.use(b["token"])
    sid = _session(c, "home")["id"]
    busy = c.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "hi"})
    assert busy.status_code == 429 and "busy" in busy.json()["error"]
    team.use(team.admin_token)
    c.post(f"/api/assistant/turns/{running}/stop")
    _drain(c, running)
    team.use(b["token"])
    assert c.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "hi"}).status_code == 200


def test_two_assistants_in_one_project_flag_their_changes(team, project, fake):
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], cwd=project, check=True)
    c = team.client
    b = team.person("bee", "editor")
    team.use(team.admin_token)
    pid = _pid(c, project)
    team.use(b["token"])
    _sign_in(c)                                                     # B runs under B's own sign-in (P4)
    theirs = _session(c, pid)["id"]
    slow = c.post(f"/api/assistant/sessions/{theirs}/turns", json={"message": "SLOW"}).json()["turn"]
    team.use(team.admin_token)
    sid = _session(c, pid)["id"]
    _, events = _say(c, sid, "EDIT please")
    card = next(e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "changes")
    assert card["overlap"] == ["Bee"]                               # whose turn ran beside it
    team.use(b["token"])
    c.post(f"/api/assistant/turns/{slow}/stop")
    _drain(c, slow)
    # alone, no note
    team.use(team.admin_token)
    (project / "added.py").unlink()
    _, events = _say(c, sid, "EDIT again")
    card = next(e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "changes")
    assert "overlap" not in card


def test_deleting_someone_deletes_their_conversations(team, project, fake):
    c = team.client
    b = team.person("bee", "editor")
    team.use(b["token"])
    sid = _session(c, "home")["id"]
    _say(c, sid, "hello")
    folder = c.app.state.chat_store.files_dir(sid)
    team.use(team.admin_token)
    assert c.delete(f"/api/admin/users/{b['id']}").status_code == 200
    assert c.app.state.chat_store.session(sid) is None and not folder.exists()


# ── P4: each person's own Claude sign-in (docs/TEAM_PLAN.md §2.4) ─────────

def _home_of(team, uid):
    return team.state / "users" / uid / "claude"


def _sign_in(c, email_check=True):
    """The whole sign-in, through the studio, with the fake's good code."""
    got = c.post("/api/assistant/login", json={"method": "claudeai"}).json()
    res = c.post(f"/api/assistant/login/{got['login_id']}/code", json={"code": "good-code#fake"}).json()
    assert res["ok"], res
    return res["account"]


def test_someone_not_signed_in_is_asked_to_and_no_claude_starts(team, project, fake, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-host-key")
    c = team.client
    b = team.person("bee", "editor")
    team.use(b["token"])
    acc = c.get("/api/assistant/account").json()["account"]
    assert acc["logged_in"] is False and acc["source"] == "none"          # never the machine's login
    sid = _session(c, "home")["id"]
    _, events = _say(c, sid, "hello")
    err = next(e["item"] for e in events if e["t"] == "item" and e["item"]["kind"] == "error")
    assert err["auth"] is True and "your own Claude account" in err["text"]
    assert _calls(fake) == []                                               # no process started


def test_each_person_runs_in_their_own_directory(team, project, fake, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-host-key")
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_TITLES", "on")
    c = team.client
    b = team.person("bee", "editor")
    team.use(b["token"])
    acc = _sign_in(c)
    home = _home_of(team, b["id"])
    assert acc["source"] == "studio" and acc["email"] == "studio@example.com"
    assert (home / ".fake-credentials").is_file() and oct(home.stat().st_mode & 0o777) == "0o700"
    sid = _session(c, "home")["id"]
    _say(c, sid, "hello from B")
    turn = _calls(fake)[-1]
    assert turn["config_dir"] == str(home) and turn["anthropic"] is False   # the host's key never leaks in
    for _ in range(100):                                                   # the title, in the background
        titles = [x for x in _calls(fake) if "--output-format" in x["argv"] and "json" in x["argv"]]
        if titles:
            break
        time.sleep(0.05)
    assert titles and titles[-1]["config_dir"] == str(home) and titles[-1]["anthropic"] is False
    # a conversation carried over from elsewhere is re-seeded with a summary: under B's sign-in too
    got = c.post("/api/assistant/import", json={"scope": "home", "session": "old-claude-9",
                                                "log": [{"w": "me", "text": "earlier"}, {"w": "bot", "text": "yes"}]})
    _say(c, got.json()["session"]["id"], "and now?")
    summary = [x for x in _calls(fake) if "<conversation>" in " ".join(x["argv"]) and "Summary:" in " ".join(x["argv"])]
    assert summary and all(x["config_dir"] == str(home) for x in summary)
    # the Team page knows which Claude account they use, never a token
    team.use(team.admin_token)
    row = next(u for u in c.get("/api/admin/users").json()["users"] if u["username"] == "bee")
    assert row["claude_email"] == "studio@example.com"


def test_only_the_owner_of_the_machine_login_falls_back_to_it(team, project, fake, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-host-key")
    c = team.client
    team.use(team.admin_token)                                              # root: machine_login (D8)
    acc = c.get("/api/assistant/account").json()["account"]
    assert acc["source"] == "machine" and acc["email"] == "you@example.com"
    sid = _session(c, "home")["id"]
    _say(c, sid, "hello from root")
    assert _calls(fake)[-1]["config_dir"] is None and _calls(fake)[-1]["anthropic"] is True
    # once root signs in to their own directory, that wins
    acc = _sign_in(c)
    assert acc["source"] == "studio"
    _say(c, sid, "again")
    root_home = _calls(fake)[-1]["config_dir"]
    assert root_home and _calls(fake)[-1]["anthropic"] is False


def test_one_sign_in_per_person_and_no_one_else_can_finish_or_cancel_it(team, project, fake):
    c = team.client
    b = team.person("bee", "editor")
    team.use(team.admin_token)
    la = c.post("/api/assistant/login", json={"method": "claudeai"}).json()["login_id"]
    team.use(b["token"])
    lb = c.post("/api/assistant/login", json={"method": "claudeai"}).json()["login_id"]
    assert c.post(f"/api/assistant/login/{la}/code", json={"code": "good-code#fake"}).status_code == 404
    assert c.delete(f"/api/assistant/login/{la}").status_code == 404
    assert c.get("/api/assistant/account").json()["account"]["login"]["id"] == lb
    team.use(team.admin_token)
    assert c.get("/api/assistant/account").json()["account"]["login"]["id"] == la   # B's did not cancel A's
    res = c.post(f"/api/assistant/login/{la}/code", json={"code": "good-code#fake"}).json()
    assert res["ok"]
    team.use(b["token"])
    assert c.delete(f"/api/assistant/login/{lb}").status_code == 200
    assert c.get("/api/assistant/account", params={"fresh": 1}).json()["account"]["logged_in"] is False


def test_account_and_usage_are_each_persons(team, project, fake):
    c = team.client
    b = team.person("bee", "editor")
    team.use(team.admin_token)
    sid = _session(c, "home")["id"]
    _say(c, sid, "hello")                                                   # a rate reading, under the machine login
    assert c.get("/api/assistant/usage").json()["rate"]["five_hour"]["used"] == 0.05
    team.use(b["token"])
    got = c.get("/api/assistant/usage").json()
    assert got["rate"] is None and got["account"]["source"] == "none"       # not the machine's limits
    _sign_in(c)
    assert c.get("/api/assistant/usage").json()["account"]["email"] == "studio@example.com"
    team.use(team.admin_token)
    assert c.get("/api/assistant/usage").json()["account"]["email"] == "you@example.com"


def test_signing_out_signs_out_only_your_own(team, project, fake):
    c = team.client
    b = team.person("bee", "editor")
    team.use(b["token"])
    _sign_in(c)
    team.use(team.admin_token)
    _sign_in(c)
    out = c.post("/api/assistant/logout").json()["account"]
    assert out["source"] == "machine"                                       # root falls back to the machine
    team.use(b["token"])
    assert c.get("/api/assistant/account", params={"fresh": 1}).json()["account"]["source"] == "studio"
    assert (_home_of(team, b["id"]) / ".fake-credentials").is_file()


# ── P5: a viewer's assistant reads, and only what is theirs to read ───────

def test_a_viewers_turn_reads_with_deny_rules_and_no_project_servers(team, project, fake, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_MODE", "full")               # the studio's reach: viewers still read
    (project / ".mcp.json").write_text(json.dumps({"mcpServers": {"notes": {"command": "notes-server"}}}),
                                       encoding="utf-8")
    c = team.client
    v = team.person("vee", "viewer")
    team.use(team.admin_token)
    pid = _pid(c, project)
    team.use(v["token"])
    _sign_in(c)
    sid = _session(c, pid)["id"]
    _say(c, sid, "what is here?")
    argv = _calls(fake)[-1]["argv"]
    allowed = argv[argv.index("--allowedTools") + 1:]
    assert "Bash" not in argv and "Edit" not in allowed and "mcp__studio" not in allowed
    assert "Read" in allowed and "mcp__studio__open_run" in allowed and "--permission-mode" not in argv
    denied = argv[argv.index("--disallowedTools") + 1: argv.index("--allowedTools")]
    state = str(team.state)
    for tool in ("Read", "Grep", "Glob"):
        assert f"{tool}(/{state}/**)" in denied and f"{tool}(~/.claude/**)" in denied and f"{tool}(**/.env*)" in denied
    assert set(_calls(fake)[-1]["mcp"]["mcpServers"]) == {"studio"}       # no project servers
    assert c.get(f"/api/assistant/sessions/{sid}").json()["agent"]["reach"] == "read"
    # home-scope turns run in the viewer's own empty directory, not the server's home
    home_sid = _session(c, "home")["id"]
    _say(c, home_sid, "hello")
    cwd = Path(_calls(fake)[-1]["cwd"])
    assert cwd == team.state / "users" / v["id"] / "home" and list(cwd.iterdir()) == []
    # an editor keeps the studio's reach and the project's servers
    team.use(team.admin_token)
    sid2 = _session(c, pid)["id"]
    _say(c, sid2, "and you?")
    argv = _calls(fake)[-1]["argv"]
    assert "--disallowedTools" not in argv and "Bash" in argv and "notes" in _calls(fake)[-1]["mcp"]["mcpServers"]


def test_a_viewer_is_never_offered_a_starter_it_cannot_act_on(team, tmp_path, fake):
    """A viewer's assistant only reads (TEAM_PLAN D10), so "Try … and
    report" and "Set up …" starters would only lead to a refusal."""
    from test_app import JOBS_MAIN, JOBS_MANIFEST

    project = tmp_path / "served"
    project.mkdir()
    (project / "main.py").write_text(JOBS_MAIN, encoding="utf-8")
    (project / "operonx.toml").write_text(JOBS_MANIFEST, encoding="utf-8")
    team.use(team.admin_token)
    pid = team.client.post("/api/open", json={"path": str(project)}).json()["id"]
    viewer = team.person("vi", "viewer")
    editor = team.person("ed", "editor")

    def kinds(token):
        team.use(token)
        return {s["kind"] for s in team.client.get(f"/api/p/{pid}/assistant/suggest").json()["suggestions"]}

    deadline = time.time() + 60                                  # the first ask starts the scan
    while "try" not in kinds(editor["token"]) and time.time() < deadline:
        time.sleep(0.5)
    assert "try" in kinds(editor["token"])                      # the project serves `shout`
    offered = kinds(viewer["token"])
    assert offered and not offered & {"setup", "try"}
