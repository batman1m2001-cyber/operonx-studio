"""The playground, through the studio — P6.

A real bridge process (``python -m operonx.app.play``) under the project's
interpreter, driven through the studio's routes. Gates: the doors and
their toys are listed; a form request runs to its reply; a chat session
is opened, fed and ended while the page polls; a recorded playground run
replays to the same replies; the re-run plan says where an op's graph
lives and which recorded inputs were never kept; a re-run returns the
op's result, and after the code changes the bridge restarts and the
re-run runs the new code; and a project whose operonx has no playground
is told so, not shown a traceback.
"""

from __future__ import annotations

import json
import textwrap
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = '''
from operonx.core import END, START, graph, op
from operonx.app.serve import egress, ingress


@op(bound="sync")
def score(call: dict = None) -> dict:
    if not call.get("text"):
        raise ValueError("empty text")
    return {"result": {"id": call["id"], "words": len(call["text"].split())}}


@graph
def score_flow():
    src = ingress()
    scored = score(call=src["item"])
    out = egress(item=scored["result"])
    START >> src >> scored >> out >> END


@op(bound="sync")
def shout(text: str = "", prefix: str = ">") -> dict:
    return {"reply": f"{prefix} {str(text).upper()}"}


@graph
def chat_flow(prefix: str = ">"):
    src = ingress()
    said = shout(text=src["item"], prefix=prefix)
    out = egress(item=said["reply"])
    START >> src >> said >> out >> END
'''

MANIFEST = '''
[project]
name = "play-demo"
trace = ["trace_local:default"]

[resources]
overlay = "resources.yaml"

[[serve]]
name  = "score"
kind  = "http"
path  = "/score"
port  = 8931
graph = "main:score_flow"

[[serve]]
name  = "chat"
kind  = "websocket"
path  = "/chat"
port  = 8931
max_inflight = 8
graph = "main:chat_flow"
'''


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(MANIFEST, encoding="utf-8")
    (root / "resources.yaml").write_text("trace_local:\n  default: {}\n", encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    monkeypatch.delenv("OPERONX_RUNS_DIR", raising=False)
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def _drain(client, pid, cursor, until, timeout=30.0):
    events, end = [], time.monotonic() + timeout
    while time.monotonic() < end:
        got = client.get(f"/api/p/{pid}/play/events", params={"cursor": cursor}).json()
        cursor = got["cursor"]
        events += got["events"]
        if any(until(e) for e in got["events"]):
            return events, cursor
    raise AssertionError(f"timed out: {events}")


def test_doors_and_a_form_request(client, project):
    pid = _open(client, project)
    doors = {d["service"]: d for d in client.get(f"/api/p/{pid}/play/doors").json()["doors"]}
    assert doors["score"]["toys"] == ["form"] and doors["chat"]["toys"] == ["chat", "form"]
    assert doors["chat"]["inputs"] == ["prefix"]

    got = client.post(f"/api/p/{pid}/play/open", json={
        "service": "score", "toy": "form", "wait": True, "end": True,
        "send": [{"kind": "json", "value": {"id": "a", "text": "one two"}}]}).json()
    kinds = [e["t"] for e in got["events"]]
    # the run's ops stream as they finish (a canvas follows them), before the end
    assert [k for k in kinds if k != "ops"] == ["opened", "out", "ended"]
    assert "ops" in kinds and kinds.index("ops") < kinds.index("ended")
    (out,) = [e for e in got["events"] if e["t"] == "out"]
    assert out["msg"]["value"] == {"id": "a", "words": 2}
    trace_id = got["events"][-1]["trace_id"]

    # the files store rescans at most every 2 s (the doors call above
    # already listed it once)
    import time as _time
    for _ in range(40):
        runs = client.get(f"/api/p/{pid}/runs", params={"origin": "playground"}).json()["runs"]
        if runs:
            break
        _time.sleep(0.1)
    assert [r["trace_id"] for r in runs] == [trace_id] and runs[0]["name"] == "score"

    # the screen opens in one round trip: the doors carry the event cursor
    # and the recent sessions of the asked service (or the first drivable one)
    again = client.get(f"/api/p/{pid}/play/doors", params={"service": "score"}).json()
    assert again["recent"]["service"] == "score" and again["recent"]["runs"][0]["run"] == trace_id
    assert again["cursor"] == client.get(f"/api/p/{pid}/play/events").json()["cursor"]
    assert client.get(f"/api/p/{pid}/play/doors").json()["recent"]["service"] in ("score", "chat")


def test_a_chat_session_polled_like_the_page(client, project):
    pid = _open(client, project)
    cursor = client.get(f"/api/p/{pid}/play/events").json()["cursor"]
    sid = client.post(f"/api/p/{pid}/play/open",
                      json={"service": "chat", "toy": "chat", "query": {"prefix": "bot:"}}).json()["sid"]
    _, cursor = _drain(client, pid, cursor, lambda e: e["t"] == "opened" and e["sid"] == sid)
    for text in ("hi", "again"):
        assert client.post(f"/api/p/{pid}/play/send",
                           json={"sid": sid, "msg": {"kind": "text", "text": text}}).json()["ok"]
    outs, cursor = _drain(client, pid, cursor, lambda e: e["t"] == "out" and "AGAIN" in e["msg"]["text"])
    assert [e["msg"]["text"] for e in outs if e["t"] == "out"] == ["bot: HI", "bot: AGAIN"]
    client.post(f"/api/p/{pid}/play/end", json={"sid": sid})
    ended, _ = _drain(client, pid, cursor, lambda e: e["t"] == "ended")
    run = next(e for e in ended if e["t"] == "ended")["trace_id"]

    # the recorded session replays: same query, same messages, same replies
    again = client.post(f"/api/p/{pid}/play/open", json={"replay_of": run, "wait": True}).json()
    assert [e["msg"]["text"] for e in again["events"] if e["t"] == "out"] == ["bot: HI", "bot: AGAIN"]
    replayed = client.get(f"/api/p/{pid}/trace/{again['events'][-1]['trace_id']}/tree").json()["summary"]
    assert replayed["metadata"]["replay_of"] == run

    # a message to a session that has ended, and a bad message, are refused
    assert client.post(f"/api/p/{pid}/play/send",
                       json={"sid": sid, "msg": {"kind": "text", "text": "x"}}).status_code == 404
    assert client.post(f"/api/p/{pid}/play/open", json={"replay_of": "nope"}).status_code == 404


def test_rerun_plan_and_rerun_after_a_code_change(client, project):
    pid = _open(client, project)
    got = client.post(f"/api/p/{pid}/play/open", json={
        "service": "score", "wait": True, "end": True,
        "send": [{"kind": "json", "value": {"id": "b", "text": ""}}]}).json()
    run = got["events"][-1]["trace_id"]
    assert got["events"][-1]["status"] == "error"

    plan = client.get(f"/api/p/{pid}/play/rerun-plan", params={"run": run, "op": "scored"}).json()
    assert plan["target"] == {"service": "score", "variant": None}
    (ex,) = plan["executions"]
    assert ex["status"] == "error" and ex["missing"] == ["call"]  # fed by the door's transient stream

    inputs = {"call": {"id": "b", "text": ""}}
    bad = client.post(f"/api/p/{pid}/play/rerun",
                      json={"run": run, "op": "scored", "inputs": inputs, "wait": True}).json()
    assert bad["status"] == "error" and bad["error"] == "scored: ValueError: empty text"

    # the fix lands; the next re-run runs it (the bridge restarts on its own)
    main = project / "main.py"
    main.write_text(main.read_text().replace('raise ValueError("empty text")',
                                             'return {"result": {"id": call["id"], "words": 0}}'))
    fixed = client.post(f"/api/p/{pid}/play/rerun",
                        json={"run": run, "op": "scored", "inputs": inputs, "wait": True}).json()
    assert fixed["status"] == "ok" and fixed["outputs"] == {"result": {"id": "b", "words": 0}}
    rerun = client.get(f"/api/p/{pid}/trace/{fixed['trace_id']}/tree").json()["summary"]
    assert rerun["metadata"]["rerun_of"] == run and rerun["origin"] == "playground"

    # without wait, the result arrives as an event carrying the request id
    cursor = client.get(f"/api/p/{pid}/play/events").json()["cursor"]
    rid = client.post(f"/api/p/{pid}/play/rerun", json={"run": run, "op": "scored", "inputs": inputs}).json()["rid"]
    events, _ = _drain(client, pid, cursor, lambda e: e.get("id") == rid)
    assert next(e for e in events if e.get("id") == rid)["status"] == "ok"

    assert client.post(f"/api/p/{pid}/play/rerun", json={"op": "scored"}).status_code == 400


def test_a_project_without_the_playground_is_told_why(client, project):
    venv = project / ".venv" / "bin"
    venv.mkdir(parents=True)
    fake = venv / "python"
    fake.write_text("#!/bin/sh\necho \"ModuleNotFoundError: No module named 'operonx.app.play'\" >&2\nexit 1\n")
    fake.chmod(0o755)
    pid = _open(client, project)
    res = client.get(f"/api/p/{pid}/play/doors")
    assert res.status_code == 503 and "needs operonx ≥ 1.9" in res.json()["error"]


class _ClientStudio:
    """The tool server's HTTP calls, routed into the TestClient."""

    def __init__(self, client, pid):
        from operonx_studio import mcp

        self._mcp, self.client, self.pid = mcp, client, pid

    def studio(self):
        outer = self

        class S(self._mcp.Studio):
            def call(self, path, body=None, **params):
                url = f"/api/p/{outer.pid}{path}"
                clean = {k: v for k, v in params.items() if v not in (None, "")}
                res = (outer.client.post(url, json=body, params=clean) if body is not None
                       else outer.client.get(url, params=clean))
                if res.status_code >= 400:
                    raise RuntimeError(res.json().get("error") or f"HTTP {res.status_code}")
                return res.json()

            def show(self, kind, **args):
                pass

        return S("http://testserver", outer.pid)


def _tool(studio, name, **args):
    from operonx_studio import mcp

    got = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": name, "arguments": args}}, studio)["result"]
    return got["content"][0]["text"], bool(got.get("isError"))


def test_the_assistant_plays_and_reruns_through_its_tools(client, project):
    pid = _open(client, project)
    studio = _ClientStudio(client, pid).studio()

    text, bad = _tool(studio, "play", service="chat", messages=["hello", "bye"], query={"prefix": "bot:"})
    assert not bad and text.splitlines()[0].startswith("session ok")
    assert "  ← bot: HELLO" in text and "  ← bot: BYE" in text

    text, bad = _tool(studio, "play", service="score", toy="form",
                      messages=[{"id": "q", "text": ""}])
    assert text.startswith("session error") and "empty text" in text
    run = text.split("run ")[1].split()[0]

    # the recorded input was never kept (a transient stream): the tool says so
    text, _ = _tool(studio, "rerun_op", run=run, op="scored")
    assert "missing call" in text and "inputs" in text
    text, _ = _tool(studio, "rerun_op", run=run, op="scored", inputs={"call": {"id": "q", "text": "a b c"}})
    assert text.startswith(f"re-ran scored of {run} in the current code: then error") and "now ok" in text
    assert '"words": 3' in text


# ── voice, conditions, the simulated user — P8 ───────────────────────────

VOICE_MAIN = '''
from operonx.core import END, START, graph, op
from operonx.app.play import PcmCodec
from operonx.app.serve import egress, ingress


@op(bound="sync")
def echo(item=None) -> dict:
    return {"frame": item}


@graph
def voice_flow():
    src = ingress()
    e = echo(item=src["item"])
    out = egress(item=e["frame"])
    START >> src >> e >> out >> END


VOICE = PcmCodec(rate=8000, frame_ms=40)
'''


@pytest.fixture()
def voice_project(tmp_path: Path) -> Path:
    root = tmp_path / "voice"
    root.mkdir()
    (root / "main.py").write_text(VOICE_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(textwrap.dedent('''
        [project]
        name = "voice-demo"

        [[serve]]
        name  = "voice"
        kind  = "websocket"
        path  = "/voice"
        port  = 8933
        max_inflight = 64
        graph = "main:voice_flow"
        playground = "main:VOICE"
    '''), encoding="utf-8")
    return root


def _pcm(n, value=500):
    import base64
    import struct

    return base64.b64encode(struct.pack(f"<{n}h", *([value] * n))).decode()


def test_audio_goes_through_the_studio_and_conditions_ride_along(client, voice_project):
    pid = _open(client, voice_project)
    (door,) = client.get(f"/api/p/{pid}/play/doors").json()["doors"]
    assert door["toys"] == ["voice"] and door["audio"] == {"rate": 8000, "encoding": "pcm16", "frame_ms": 40}
    assert door["remote_trace"] == []

    got = client.post(f"/api/p/{pid}/play/open", json={
        "service": "voice", "toy": "voice", "wait": True, "end": True,
        "send": [{"kind": "audio", "b64": _pcm(640), "rate": 8000}]}).json()
    outs = [e["msg"] for e in got["events"] if e["t"] == "out"]
    assert [o["kind"] for o in outs] == ["audio", "audio"]  # 80 ms in, two 40 ms frames back

    # a live session takes audio through /send too
    cursor = client.get(f"/api/p/{pid}/play/events").json()["cursor"]
    sid = client.post(f"/api/p/{pid}/play/open", json={"service": "voice", "toy": "voice"}).json()["sid"]
    _drain(client, pid, cursor, lambda e: e["t"] == "opened" and e["sid"] == sid)
    assert client.post(f"/api/p/{pid}/play/send",
                       json={"sid": sid, "msg": {"kind": "audio", "b64": _pcm(320), "rate": 8000}}).json()["ok"]
    client.post(f"/api/p/{pid}/play/end", json={"sid": sid})
    _drain(client, pid, cursor, lambda e: e["t"] == "ended" and e["sid"] == sid)

    lost = client.post(f"/api/p/{pid}/play/open", json={
        "service": "voice", "wait": True, "end": True, "conditions": {"drop": 1.0},
        "send": [{"kind": "audio", "b64": _pcm(640), "rate": 8000}]}).json()
    ended = lost["events"][-1]
    assert ended["t"] == "ended" and ended["dropped"] == 2 and not [e for e in lost["events"] if e["t"] == "out"]


def test_simulated_users_are_checked_and_refused_where_they_cannot_talk(client, voice_project):
    pid = _open(client, voice_project)
    assert client.post(f"/api/p/{pid}/play/simulate", json={"service": "voice", "llm": "llm:x"}).status_code == 400
    cursor = client.get(f"/api/p/{pid}/play/events").json()["cursor"]
    got = client.post(f"/api/p/{pid}/play/simulate", json={
        "service": "voice", "persona": "someone", "llm": "llm:x", "count": 2}).json()
    assert len(got["sids"]) == 2
    events, _ = _drain(client, pid, cursor, lambda e: e["t"] == "refused" and e["sid"] == got["sids"][1])
    refused = [e for e in events if e["t"] == "refused"]
    assert {e["sid"] for e in refused} == set(got["sids"])
    assert refused[0]["reason"] == "a simulated user speaks text, and this door takes voice"
