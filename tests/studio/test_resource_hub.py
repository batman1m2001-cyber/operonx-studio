"""The Resource Hub (docs/STUDIO_EXPERIENCE_PLAN.md §6): browse, add, edit and
delete a project's resources in its own file, a secret's value in .env only."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest
import yaml

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = textwrap.dedent('''\
    from operonx.core import graph, op, START, END


    @op
    def hello(name: str = "x"):
        return {"out": name}


    @graph
    def flow():
        a = hello(name="hi")
        START >> a >> END
''')

RESOURCES = textwrap.dedent('''\
    # what the project reaches out to
    llm:
      small:
        api_type: openai
        api_key: ${SMALL_KEY}
        model: tiny   # cheap
    trace_local:
      mine:
        root: runs
''')


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "main.py").write_text(MAIN)
    (root / "resources.yaml").write_text(RESOURCES)
    (root / ".env").write_text("SMALL_KEY=sk-old\n")
    (root / "operonx.toml").write_text(textwrap.dedent('''\
        [project]
        name = "hub"

        [[graph]]
        name = "flow"
        entry = "main:flow"

        [resources]
        overlay = "resources.yaml"

        [tracing]
        sinks = ["trace_local:mine"]
    '''))
    return root


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


def _cat(hub, name):
    return next(c for c in hub["categories"] if c["name"] == name)


def test_the_hub_lists_resources_with_their_use_and_env_and_no_secret_value(client, project):
    pid = _open(client, project)
    hub = client.get(f"/api/p/{pid}/resources/hub").json()
    assert hub["file"] == "resources.yaml"
    llm = _cat(hub, "llm")
    (small,) = llm["resources"]
    assert small["fields"]["api_key"] == "${SMALL_KEY}" and small["env"] == {"SMALL_KEY": "set"}
    assert small["editable"] and small["line"] == 3
    assert llm["fields"]["api_key"]["secret"] and not llm["fields"]["model"]["secret"]
    assert "sk-old" not in json.dumps(hub)
    (mine,) = _cat(hub, "trace_local")["resources"]
    assert mine["used_by"] == [{"config": "operonx.toml", "as": "trace_local:mine"}]


def test_a_resource_is_added_with_its_secret_in_env_only(client, project):
    pid = _open(client, project)
    body = {"category": "llm", "name": "big", "fields": {"api_type": "openai", "model": "huge"},
            "secrets": {"api_key": {"var": "BIG_KEY", "value": "sk-new-123"}}}
    plan = client.post(f"/api/p/{pid}/resources/add", json=body).json()
    assert "sk-new-123" not in json.dumps(plan) and plan["env_changes"] == ["BIG_KEY=••••"]
    done = client.post(f"/api/p/{pid}/resources/add", json={**body, "apply": True, "base": plan["base"],
                                                            "env_base": plan["env_base"]}).json()
    assert done["applied"] and "sk-new-123" not in json.dumps(done)
    data = yaml.safe_load((project / "resources.yaml").read_text())
    assert data["llm"]["big"] == {"api_type": "openai", "model": "huge", "api_key": "${BIG_KEY}"}
    assert (project / "resources.yaml").read_text().startswith("# what the project reaches out to")
    assert "BIG_KEY=sk-new-123" in (project / ".env").read_text()
    assert "sk-new-123" not in (project / "resources.yaml").read_text()


def test_a_field_is_edited_in_place_and_a_secret_set_in_env(client, project):
    pid = _open(client, project)
    edit = {"file": "resources.yaml", "op": "set", "path": ["llm", "small", "model"], "value": "tiny-2"}
    plan = client.post(f"/api/p/{pid}/yaml", json=edit).json()
    client.post(f"/api/p/{pid}/yaml", json={**edit, "apply": True, "base": plan["base"]})
    assert "model: tiny-2   # cheap" in (project / "resources.yaml").read_text()
    got = client.post(f"/api/p/{pid}/env", json={"var": "SMALL_KEY", "value": "sk-rotated"}).json()
    assert got["applied"] and "sk-rotated" not in json.dumps(got)
    assert (project / ".env").read_text() == "SMALL_KEY=sk-rotated\n"


def test_delete_is_refused_while_used_and_removes_only_its_block(client, project):
    pid = _open(client, project)
    used = client.post(f"/api/p/{pid}/resources/delete", json={"category": "trace_local", "name": "mine"})
    assert used.status_code == 409 and "operonx.toml" in used.json()["error"]
    plan = client.post(f"/api/p/{pid}/resources/delete", json={"category": "llm", "name": "small"}).json()
    done = client.post(f"/api/p/{pid}/resources/delete", json={"category": "llm", "name": "small",
                                                               "apply": True, "base": plan["base"]})
    assert done.status_code == 200
    data = yaml.safe_load((project / "resources.yaml").read_text())
    assert data["llm"] is None and data["trace_local"] == {"mine": {"root": "runs"}}


def test_a_new_secret_never_overwrites_a_variable_already_set(client, project):
    pid = _open(client, project)
    body = {"category": "llm", "name": "big", "fields": {"api_type": "openai"},
            "secrets": {"api_key": {"var": "SMALL_KEY", "value": "sk-other"}}}
    got = client.post(f"/api/p/{pid}/resources/add", json=body)
    assert got.status_code == 409 and "already set" in got.json()["error"]
    assert (project / ".env").read_text() == "SMALL_KEY=sk-old\n"
