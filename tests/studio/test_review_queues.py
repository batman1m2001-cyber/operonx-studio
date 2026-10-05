"""operonx review queues in the Review tab (PLATFORM_PAGES_PLAN S1): the
declared queues, an item waiting, a review saved as operonx scores — and
the item no longer waiting."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = '''
from operonx.core import END, START, graph, op


@op
def echo(text: str) -> dict:
    return {"out": text}


@graph
def flow(text):
    e = echo(text=text)
    START >> e >> END
'''


@pytest.fixture()
def project(tmp_path: Path):
    root = tmp_path / "rv"
    root.mkdir()
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(
        '[project]\nname = "rv"\n\n[[graph]]\nname = "flow"\nentry = "main:flow"\n\n'
        '[[queue]]\nname = "calls"\ndescription = "calls an online eval failed"\n'
        'rubric = { polite = "bool", topic = "categorical" }\nreviewers = 1\n',
        encoding="utf-8",
    )
    from operonx.app.evals.queues import enqueue

    enqueue(root / ".operonx" / "queues", "calls", trace_id="t-1", source="online", reason="relevance 0.2")
    enqueue(root / ".operonx" / "queues", "calls", trace_id="t-2", source="online")
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def test_a_queue_item_is_reviewed_into_scores(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]

    (q,) = client.get(f"/api/p/{pid}/review/queues").json()["queues"]
    assert q["name"] == "calls" and q["waiting"] == 2 and q["total"] == 2
    assert q["rubric"] == {"polite": "bool", "topic": "categorical"}

    got = client.get(f"/api/p/{pid}/review/queues/calls").json()
    first = next(i for i in got["items"] if i["trace_id"] == "t-1")
    assert first["reason"] == "relevance 0.2" and got["detail"] is None  # t-1 has no recorded run

    saved = client.post(
        f"/api/p/{pid}/review/queues/calls/review",
        json={"item_id": first["item_id"], "verdict": "bad", "labels": "rude, slow", "note": "n",
              "rubric": {"polite": "false", "topic": "billing", "unknown": "x"}},
    )
    assert saved.json() == {"saved": 3, "item_id": first["item_id"]}  # review + 2 rubric answers

    left = client.get(f"/api/p/{pid}/review/queues/calls").json()
    assert [i["trace_id"] for i in left["items"]] == ["t-2"] and left["waiting"] == 1
    every = client.get(f"/api/p/{pid}/review/queues/calls", params={"done": True}).json()
    assert {i["trace_id"]: i["reviewed_by"] for i in every["items"]}["t-1"]  # who reviewed it

    from operonx.telemetry.scores import ScoreFilter, project_score_store

    store = project_score_store(project).open()
    rows = {s.score_name: s for s in store.scores(ScoreFilter(trace_id="t-1"), limit=100)}
    assert rows["review"].label == "bad" and rows["review"].source == "human"
    assert rows["review"].metadata["labels"] == ["rude", "slow"] and rows["review"].queue == "calls"
    assert rows["polite"].passed is False and rows["topic"].label == "billing"


def test_an_unknown_queue_or_item_is_refused(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    assert client.get(f"/api/p/{pid}/review/queues/nope").status_code == 404
    bad = client.post(f"/api/p/{pid}/review/queues/calls/review", json={"item_id": "nope", "verdict": "good"})
    assert bad.status_code == 404
    wrong = client.get(f"/api/p/{pid}/review/queues/calls").json()["items"][0]["item_id"]
    refused = client.post(f"/api/p/{pid}/review/queues/calls/review", json={"item_id": wrong, "verdict": "meh"})
    assert refused.status_code == 400
