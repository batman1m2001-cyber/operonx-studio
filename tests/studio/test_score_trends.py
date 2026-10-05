"""Score trends on the Monitor (PLATFORM_PAGES_PLAN S2) and score alerts
that are judged at all."""

from __future__ import annotations

import json
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
from operonx.app.serve import ingress


@op
def keep(item: dict = None) -> dict:
    return {"kept": item}


@graph
def chat():
    src = ingress()
    k = keep(item=src["item"])
    START >> src >> k >> END
'''


@pytest.fixture()
def project(tmp_path: Path):
    root = tmp_path / "st"
    root.mkdir()
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(
        '[project]\nname = "st"\n\n[[serve]]\nname = "chat"\nkind = "http"\ngraph = "main:chat"\n'
        'path = "/chat"\nport = 8896\n',
        encoding="utf-8",
    )
    from operonx.telemetry.scores import Score, project_score_store

    store = project_score_store(root).open()
    now = time.time()
    rows = []
    for day, (value, passed) in enumerate([(0.9, True), (0.8, True), (0.3, False), (0.2, False)]):
        t = now - (3 - day) * 86400 - 60
        rows.append(Score(score_name="helpfulness", data_type="numeric", value=value, passed=passed,
                          source="judge", rule="help", target="trace", origin="service", name="chat",
                          trace_id=f"t{day}", created_at=t))
    rows.append(Score(score_name="review", data_type="categorical", label="bad", passed=False,
                      source="human", target="trace", origin="service", name="chat", trace_id="t3",
                      author="ann", created_at=now - 60))
    store.put_scores(rows)
    (root / ".operonx").mkdir(exist_ok=True)
    (root / ".operonx" / "alerts.json").write_text(json.dumps({"alerts": [
        {"name": "help drops", "origin": "service", "target": "chat", "metric": "score_mean:helpfulness",
         "threshold": 0.5, "window_min": 60 * 24 * 7, "min_runs": 1},
        {"name": "help fails", "origin": "service", "target": "chat", "metric": "score_fail_rate:helpfulness",
         "threshold": 0.25, "window_min": 60 * 24 * 7, "min_runs": 1},
    ]}))
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def test_a_score_trends_per_day_with_its_alert_thresholds(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    now = int(time.time())
    got = client.get(f"/api/p/{pid}/monitor/scores", params={
        "origin": "service", "name": "chat", "since": now - 4 * 86400, "until": now, "buckets": 4}).json()
    (sc,) = got["scores"]  # the human review is not a trend
    assert sc["score"] == "helpfulness" and sc["n"] == 4
    assert [b["mean"] for b in sc["series"]] == pytest.approx([0.9, 0.8, 0.3, 0.2])
    assert [b["fail_share"] for b in sc["series"]] == [0.0, 0.0, 1.0, 1.0]
    assert sc["mean_threshold"] == 0.5 and sc["fail_threshold"] == 0.25


def test_a_score_alert_is_judged_from_the_score_store(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    alerts = {a["name"]: a for a in client.get(f"/api/p/{pid}/alerts").json()["alerts"]}
    mean = alerts["help drops"]["now"]
    assert mean["value"] == pytest.approx(0.55) and mean["firing"] is False  # 0.55 is not under 0.5
    fails = alerts["help fails"]["now"]
    assert fails["value"] == pytest.approx(0.5) and fails["firing"] is True
