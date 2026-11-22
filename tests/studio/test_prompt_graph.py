"""The Prompts page's graph (PROMPT_OBJECTS_PLAN O2): a prompt card says what
kind of object it is, its id, what it links (use / pick with its case / when)
and where each variable comes from; a composite is saved as its whole file and
only while it still loads."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")
P = pytest.importorskip("operonx.prompts")
if not hasattr(P, "CompositePrompt"):
    pytest.skip("composites are operonx >= 1.44", allow_module_level=True)
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

CHAT = """\
id: pr_0000c0de
kind: chat
system:
  - use: persona
  - pick: team
    cases:
      billing: billing/rules
    else: none
  - when: urgent
    use: urgent
user:
  - var: message
"""


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "pg"
    d = root / "prompts"
    (d / "billing").mkdir(parents=True)
    (root / "operonx.toml").write_text('[project]\nname = "pg-demo"\n', encoding="utf-8")
    (d / "persona.md").write_text("---\nid: pr_00000001\n---\nYou help {{customer}}.\n", encoding="utf-8")
    (d / "billing" / "rules.md").write_text("Refunds take 5 days.\n", encoding="utf-8")
    (d / "urgent.md").write_text("It is urgent.\n", encoding="utf-8")
    (d / "intake.yaml").write_text(CHAT, encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_RETENTION", "off")
    monkeypatch.delenv("OPERONX_PROMPT_LABEL", raising=False)
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def _cards(client, pid):
    return {p["name"]: p for p in client.get(f"/api/p/{pid}/prompts").json()["prompts"]}


def test_a_card_says_what_an_object_links_and_where_its_variables_come_from(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    cards = _cards(client, pid)
    c = cards["intake"]
    assert (c["kind"], c["id"], c["file"]) == ("chat", "pr_0000c0de", "prompts/intake.yaml")
    assert [(e["role"], e["how"], e["case"], e["name"]) for e in c["links"]] == [
        ("system", "use", None, "persona"),
        ("system", "pick", "billing", "billing/rules"),
        ("system", "pick", "else", None),
        ("system", "when", None, "urgent"),
    ]
    assert c["needs"] == {"customer": "persona", "team": "pick", "urgent": "when", "message": "data"}
    t = cards["persona"]
    assert (t["kind"], t["id"], t["links"], t["needs"]) == ("text", "pr_00000001", [], {"customer": "persona"})
    assert cards["billing/rules"]["file"] == "prompts/billing/rules.md"


def test_a_composite_is_saved_whole_and_only_while_it_still_loads(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    base = _cards(client, pid)["intake"]["base"]
    broken = CHAT.replace("use: urgent", "use: hurry")
    got = client.post(f"/api/p/{pid}/prompts/write", json={"name": "intake", "text": broken, "base": base})
    assert got.status_code == 400 and "hurry" in got.json()["error"]
    assert (project / "prompts" / "intake.yaml").read_text() == CHAT  # nothing written
    fixed = CHAT.replace("    else: none\n", "")
    got = client.post(f"/api/p/{pid}/prompts/write", json={"name": "intake", "text": fixed, "base": base})
    assert got.status_code == 200, got.text
    assert (project / "prompts" / "intake.yaml").read_text() == fixed
    assert [e["case"] for e in got.json()["prompt"]["links"] if e["how"] == "pick"] == ["billing"]
