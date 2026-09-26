"""The prompt workbench — P9.

Gates: an LLM op's recorded executions are its samples (newest first,
only runs of a declared service or job — something a re-run can target);
inputs equal in every sample are the prompt, the rest the cases' data,
and a recorded placeholder is never taken for a prompt; an edited prompt
is written back only where its text is verbatim in exactly one file, the
diff shown before anything is written.
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

pytestmark = pytest.mark.unit

SYSTEM = "You are the Edupia help desk.\nBe kind and precise."


def _run(tid, age, question, answer, *, origin="service", service="helpdesk"):
    node = OpExecution(op_id=f"g.ask#{tid}", op_name="ask", op_full_name="g.ask", ctx=("main",), start_time=1.0,
                       end_time=1.4, inputs={"prompt": {"system": "{system_prompt}", "user": "{question}"},
                                             "system_prompt": SYSTEM, "question": question, "stream": "<gen transient>"},
                       outputs={"content": answer, "usage": {"prompt_tokens": 30, "completion_tokens": 8},
                                "cost_usd": 0.0001}, upstreams=[], op_type="llm")
    md = {"origin": origin}
    if service:
        md["service"] = service
    return WorkflowTrace(trace_id=tid, workflow_name="flow", started_at=1.0, ended_at=1.4, nodes=[node],
                         metadata=md, wall_started_at=time.time() - age)


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "pw"
    (root / "prompts").mkdir(parents=True)
    (root / "operonx.toml").write_text('[project]\nname = "pw-demo"\n', encoding="utf-8")
    (root / "prompts" / "helpdesk.txt").write_text(SYSTEM + "\n", encoding="utf-8")
    (root / "main.py").write_text('SYSTEM = open("prompts/helpdesk.txt").read()\n', encoding="utf-8")
    store = FilesRunStore(root=root / ".operonx" / "runs", refresh_every=0)
    store.consume(_run("q1", 30, "When is my class?", "Tomorrow at 7pm."))
    store.consume(_run("q2", 20, "Can I move it?", "Yes — which day suits you?"))
    store.consume(_run("q3", 10, "Who is my teacher?", "Ms. Linh."))
    store.consume(_run("adhoc", 5, "x", "y", origin="adhoc", service=None))  # nothing to re-run it in
    tried = _run("tried", 2, "When is my class?", "short", origin="playground")
    tried.metadata["toy"] = "rerun"  # a workbench try: never a sample of real inputs
    store.consume(tried)
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def test_samples_split_the_prompt_from_the_data(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.get(f"/api/p/{pid}/prompts/ask/samples").json()
    assert [s["run"] for s in got["samples"]] == ["q3", "q2", "q1"]  # newest first, the adhoc run left out
    assert got["constant"] == {"prompt": {"system": "{system_prompt}", "user": "{question}"}, "system_prompt": SYSTEM}
    assert got["varying"] == ["question", "stream"]  # the placeholder is never the prompt
    s = got["samples"][0]
    assert s["content"] == "Ms. Linh." and s["cost_usd"] == 0.0001 and s["usage"]["completion_tokens"] == 8
    assert client.get(f"/api/p/{pid}/prompts/nope/samples").json()["samples"] == []


def test_saving_writes_the_text_where_it_lives(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    updated = SYSTEM + "\nAnswer in one short sentence."
    dry = client.post(f"/api/p/{pid}/prompts/save", json={"original": SYSTEM, "updated": updated}).json()
    assert dry["file"] == "prompts/helpdesk.txt" and not dry["applied"]
    assert "+Answer in one short sentence." in dry["diff"]
    assert (project / "prompts" / "helpdesk.txt").read_text() == SYSTEM + "\n"
    done = client.post(f"/api/p/{pid}/prompts/save", json={"original": SYSTEM, "updated": updated, "apply": True}).json()
    assert done["applied"] and (project / "prompts" / "helpdesk.txt").read_text() == updated + "\n"

    # not there verbatim, or in two places: say so, write nothing
    miss = client.post(f"/api/p/{pid}/prompts/save", json={"original": "never written anywhere", "updated": "x"})
    assert miss.status_code == 409 and miss.json()["found"] == []
    (project / "prompts" / "copy.txt").write_text(updated, encoding="utf-8")
    twice = client.post(f"/api/p/{pid}/prompts/save", json={"original": updated, "updated": "z"})
    assert twice.status_code == 409 and sorted(twice.json()["found"]) == ["prompts/copy.txt", "prompts/helpdesk.txt"]
    assert client.post(f"/api/p/{pid}/prompts/save", json={"original": "short", "updated": "short"}).status_code == 400
