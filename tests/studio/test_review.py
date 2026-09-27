"""The review queue — P9.

Gates: a run reads as a conversation — what the toy sent and every
recorded transcript are the user's, what the door sent (or, with no door,
an op's text answer) is the bot's, in time order, placeholders skipped;
reviews are appended with their user and the latest wins; the queue counts
and filters by verdict; a review saves; and a reviewed run becomes a
dataset case carrying its labels, verdict and note.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx.core.workflow_trace import OpExecution, WorkflowTrace
from operonx.telemetry.runs.files import FilesRunStore

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents
from operonx_studio.review import ReviewLog, conversation

pytestmark = pytest.mark.unit

NOW = time.time()


def test_a_run_reads_as_a_conversation():
    rows = [
        {"op_name": "stt", "wall_start": 10.0, "outputs": {"transcript": "I want to move my class"}},
        {"op_name": "classify", "wall_start": 10.5, "outputs": {"content": '{"intent": "reschedule"}'}},
        {"op_name": "out", "wall_start": 11.0, "inputs": {"item": "Sure — which day?"}},
        {"op_name": "stt", "wall_start": 12.0, "outputs": {"transcript": "<str transient>"}},  # not said
        {"op_name": "out", "wall_start": 13.0, "inputs": {"item": {"text": "Done, Friday it is."}}},
    ]
    turns = conversation(rows, {"playground_script": [{"kind": "text", "text": "hello", "at": 9.0}]}, egress={"out"})
    assert [(t["who"], t["text"], t["op"]) for t in turns] == [
        ("user", "hello", "playground"), ("user", "I want to move my class", "stt"),
        ("bot", "Sure — which day?", "out"), ("bot", "Done, Friday it is.", "out")]
    # a script with no times (recorded before they were kept) alternates with the replies
    old = conversation([{"op_name": "out", "wall_start": 5.0, "inputs": {"item": "a1"}},
                        {"op_name": "out", "wall_start": 7.0, "inputs": {"item": "a2"}}],
                       {"playground_script": [{"kind": "text", "text": "q1"}, {"kind": "text", "text": "q2"}]},
                       egress={"out"})
    assert [t["text"] for t in old] == ["q1", "a1", "q2", "a2"]
    # no door recorded anything: an op's text answer is the reply
    turns = conversation([{"op_name": "answer", "wall_start": 1.0, "outputs": {"reply": "42"}}], {})
    assert turns == [{"who": "bot", "text": "42", "op": "answer", "at": 1.0}]


def test_reviews_append_and_the_latest_wins(tmp_path):
    log = ReviewLog(tmp_path)
    log.put("r1", verdict="bad", labels=["slow", " slow", ""], note="late", user="ana")
    log.put("r1", verdict="good", labels=[], note="", user="ben")
    log.put("r2", verdict=None, labels=["x"], note="", user="ana")
    latest = log.latest()
    assert latest["r1"]["verdict"] == "good" and latest["r1"]["user"] == "ben"
    assert latest["r2"]["labels"] == ["x"]
    assert len(log.path.read_text().splitlines()) == 3  # history kept
    with pytest.raises(ValueError):
        log.put("r3", verdict="meh", labels=[], note="", user="ana")


def _run(tid, age, said, answer, status="ok"):
    t0 = 100.0
    nodes = [
        OpExecution(op_id=f"g.stt#{tid}", op_name="stt", op_full_name="g.stt", ctx=("main",), start_time=t0,
                    end_time=t0 + 0.05, inputs={}, outputs={"transcript": said}, upstreams=[]),
        OpExecution(op_id=f"g.reply#{tid}", op_name="reply", op_full_name="g.reply", ctx=("main",), start_time=t0 + 0.1,
                    end_time=t0 + 0.3, inputs={}, outputs={"reply": answer}, upstreams=[], status=status,
                    error="boom" if status == "error" else None),
    ]
    return WorkflowTrace(trace_id=tid, workflow_name="flow", started_at=t0, ended_at=t0 + 0.3, nodes=nodes,
                         metadata={"origin": "service", "service": "desk"}, wall_started_at=NOW - age)


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "rev"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "rev-demo"\n', encoding="utf-8")
    store = FilesRunStore(root=root / ".operonx" / "runs", refresh_every=0)
    store.consume(_run("c1", 30, "move my class to friday", "Done — Friday."))
    store.consume(_run("c2", 20, "cancel it", "Sorry, I can only move classes.", status="error"))
    store.consume(_run("c3", 10, "thanks", "You're welcome!"))
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def test_the_queue_reads_judges_and_files_a_case(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    q = client.get(f"/api/p/{pid}/review/queue").json()
    assert [r["run"] for r in q["runs"]] == ["c3", "c2", "c1"] and q["counts"] == {"unreviewed": 3, "good": 0, "bad": 0}

    assert q["detail"]["run"] == "c3"           # the queue carries the conversation it opens
    got = client.get(f"/api/p/{pid}/review/run/c2").json()
    opened = client.get(f"/api/p/{pid}/review/queue", params={"open": "c2"}).json()["detail"]
    assert {k: opened[k] for k in got} == got
    assert [(t["who"], t["text"]) for t in got["turns"]] == [
        ("user", "cancel it"), ("bot", "Sorry, I can only move classes.")]
    assert got["review"] is None

    saved = client.post(f"/api/p/{pid}/review/run/c2",
                        json={"verdict": "bad", "labels": "wrong-intent, cancel", "note": "should offer to cancel"}).json()
    assert saved["verdict"] == "bad" and saved["labels"] == ["cancel", "wrong-intent"] and saved["user"]
    client.post(f"/api/p/{pid}/review/run/c1", json={"verdict": "good"})
    q = client.get(f"/api/p/{pid}/review/queue").json()
    assert [r["run"] for r in q["runs"]] == ["c3"] and q["counts"] == {"unreviewed": 1, "good": 1, "bad": 1}
    assert [r["run"] for r in client.get(f"/api/p/{pid}/review/queue", params={"verdict": "bad"}).json()["runs"]] == ["c2"]
    assert client.get(f"/api/p/{pid}/review/queue", params={"verdict": "all", "label": "cancel"}).json()["runs"][0]["run"] == "c2"
    assert client.post(f"/api/p/{pid}/review/run/c3", json={"verdict": "meh"}).status_code == 400

    added = client.post(f"/api/p/{pid}/review/run/c2/dataset", json={"dataset": "reviewed"}).json()
    (case_id,) = added["added"]
    row = next(r for r in client.get(f"/api/p/{pid}/datasets/reviewed").json()["rows"] if r["id"] == case_id)
    assert row["input"] == "cancel it" and "expected" not in row
    assert row["tags"] == ["cancel", "review:bad", "wrong-intent"] and row["note"] == "should offer to cancel"
    assert row["from"] == {"run": "c2", "origin": "service", "name": "desk"}
