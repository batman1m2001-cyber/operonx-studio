"""A prompt created on the page, and an inline prompt made a named one.

``promptadopt`` is two pure steps (the template as a prompt file's text, the
source asking for it by name); the endpoints put them through safewrite, so a
project that would not build with the change is left as it was.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from operonx import prompts as P

from operonx_studio import promptadopt
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = textwrap.dedent('''\
    from operonx.core import graph, op, START, END


    @op
    def ask(prompt=None, name: str = ""):
        return {"out": str(prompt)}


    @op
    def chat(prompt=None, q: str = ""):
        return {"out": str(prompt)}


    @graph
    def flow():
        a = ask(prompt="Hello {name}. Reply as {{\\"ok\\": true}}.", name="An")
        b = chat(
            prompt={"system": "Be kind.", "user": "{q}"},
            q="hi",
        )
        START >> a >> b >> END
''')


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text(MAIN)
    (root / "operonx.toml").write_text('[project]\nname = "adopt"\n\n[[graph]]\nname = "flow"\nentry = "src.main:flow"\n')
    return root


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def test_the_template_comes_back_the_same_from_the_file():
    template = 'Hello {name}. Reply as {{"ok": true}}.'
    text = promptadopt.to_named(template)
    assert text == 'Hello {{name}}. Reply as {"ok": true}.\n'
    assert P._as_template(text.rstrip("\n")) == template
    for bad in ("{x!r}", "{0} first", "{a.b}", "{n:>4}", "literally {{{{name}}}}"):
        with pytest.raises(promptadopt.Refused):
            promptadopt.to_named(bad)


def test_the_call_asks_by_name_and_the_import_is_added():
    out = promptadopt.rewrite_call(MAIN, 16, "greet")
    assert 'a = ask(prompt=prompt("greet"), name="An")' in out
    assert out.count("from operonx.prompts import prompt\n") == 1
    again = promptadopt.rewrite_call(out, 19, "chat.user", "user")   # the import is there now (one line lower)
    assert 'prompt={"system": "Be kind.", "user": prompt("chat.user")},' in again
    assert again.count("from operonx.prompts import prompt\n") == 1
    with pytest.raises(promptadopt.Refused):
        promptadopt.rewrite_call(MAIN, 18, "x", "nope")
    with pytest.raises(promptadopt.Refused):
        promptadopt.rewrite_call(MAIN, 2, "x")
    taken = "prompt = 1\n" + MAIN                                    # the name is somebody else's here
    assert "import prompt as named_prompt" in promptadopt.rewrite_call(taken, 17, "greet")


def test_a_new_prompt_is_a_file(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.post(f"/api/p/{pid}/prompts/new", json={"name": "intake/greeting", "text": "Greet {{who}}."})
    assert got.status_code == 200 and got.json()["prompt"]["name"] == "intake/greeting"
    assert (project / "prompts" / "intake" / "greeting.md").read_text() == "Greet {{who}}.\n"
    assert [p["name"] for p in client.get(f"/api/p/{pid}/prompts").json()["prompts"]] == ["intake/greeting"]
    assert client.post(f"/api/p/{pid}/prompts/new", json={"name": "intake/greeting", "text": "x"}).status_code == 409
    assert client.post(f"/api/p/{pid}/prompts/new", json={"name": "../up", "text": "x"}).status_code == 400
    assert client.post(f"/api/p/{pid}/prompts/new", json={"name": "blank", "text": "  "}).status_code == 400
    assert not (project / "prompts" / "blank.md").exists()


def test_an_inline_prompt_becomes_a_named_one(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    dry = client.post(f"/api/p/{pid}/prompts/adopt", json={"op": "a", "name": "greet"}).json()
    assert dry["file"] == "prompts/greet.md" and dry["code"] == "src/main.py" and not dry["applied"]
    assert '+    a = ask(prompt=prompt("greet"), name="An")' in dry["diff"]
    assert not (project / "prompts").exists() and (project / "src" / "main.py").read_text() == MAIN

    done = client.post(f"/api/p/{pid}/prompts/adopt", json={"op": "a", "name": "greet", "apply": True, "base": dry["base"]})
    assert done.status_code == 200, done.text
    assert (project / "prompts" / "greet.md").read_text() == 'Hello {{name}}. Reply as {"ok": true}.\n'
    assert 'prompt=prompt("greet")' in (project / "src" / "main.py").read_text()
    assert done.json()["prompt"]["name"] == "greet"

    # one part of a prompt={...}
    part = client.post(f"/api/p/{pid}/prompts/adopt", json={"op": "b", "name": "chat.user", "part": "user", "apply": True})
    assert part.status_code == 200, part.text
    assert (project / "prompts" / "chat.user.md").read_text() == "{{q}}\n"
    assert '"user": prompt("chat.user")' in (project / "src" / "main.py").read_text()

    # asked for by name already, a name that is taken, an op that is not there, parts with none named
    for body, code in (({"op": "a", "name": "again"}, 409), ({"op": "b", "name": "greet", "part": "system"}, 409),
                       ({"op": "nope", "name": "n"}, 404), ({"op": "b", "name": "whole"}, 409)):
        assert client.post(f"/api/p/{pid}/prompts/adopt", json=body).status_code == code, body
    assert not (project / "prompts" / "again.md").exists()


# ── the prompt store (Settings → Prompts) ────────────────────────────────


def test_the_toml_names_the_store_and_nothing_else_moves():
    from operonx_studio.app import _with_prompt_store

    added = _with_prompt_store('[project]\nname = "x"\n', "${PROMPT_STORE_DSN}")
    assert added.startswith('[project]\nname = "x"\n\n') and added.endswith('[prompts]\nstore = "${PROMPT_STORE_DSN}"\n')
    assert _with_prompt_store(added, "${PROMPT_STORE_DSN}") == added
    assert _with_prompt_store('[prompts]\nstore = "old"\n\n[lint]\na = 1\n', "${V}") == '[prompts]\nstore = "${V}"\n\n[lint]\na = 1\n'
    assert _with_prompt_store('[prompts]\n\n[lint]\na = 1\n', "${V}") == '[prompts]\nstore = "${V}"\n\n[lint]\na = 1\n'


def test_settings_say_no_store_and_refuse_an_address_that_cannot_be_reached(client, project, monkeypatch):
    monkeypatch.delenv("OPERONX_PROMPT_STORE", raising=False)
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    got = client.get(f"/api/p/{pid}/settings").json()["prompt_store"]
    assert got["configured"] is False and got["project"] == "adopt"
    assert client.get(f"/api/p/{pid}/prompts").json()["store"] is False
    assert client.post(f"/api/p/{pid}/settings/prompt-store", json={"dsn": "mysql://x"}).status_code == 400
    bad = client.post(f"/api/p/{pid}/settings/prompt-store", json={"dsn": "postgresql://nobody@127.0.0.1:9/none"})
    assert bad.status_code == 400 and "could not be reached" in bad.json()["error"]
    assert not (project / ".env").exists() and "[prompts]" not in (project / "operonx.toml").read_text()
    assert client.post(f"/api/p/{pid}/settings/prompt-store/push").status_code == 409


@pytest.mark.skipif(not __import__("os").environ.get("OPERONX_TEST_PG_DSN"), reason="OPERONX_TEST_PG_DSN is not set")
def test_a_publish_reaches_the_store(client, project, monkeypatch):
    import os
    import uuid

    from operonx import prompt_store

    monkeypatch.delenv("OPERONX_PROMPT_STORE", raising=False)
    monkeypatch.setenv("OPERONX_PROMPT_PROJECT", f"t-{uuid.uuid4().hex[:10]}")
    monkeypatch.setattr(prompt_store, "_SERVED", {})
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    client.post(f"/api/p/{pid}/prompts/new", json={"name": "greet", "text": "Hello {{who}}."})
    dsn = os.environ["OPERONX_TEST_PG_DSN"]
    saved = client.post(f"/api/p/{pid}/settings/prompt-store", json={"dsn": dsn})
    assert saved.status_code == 200, saved.text
    assert dsn not in saved.text and saved.json()["prompt_store"]["configured"]
    assert 'store = "${PROMPT_STORE_DSN}"' in (project / "operonx.toml").read_text()
    assert f"PROMPT_STORE_DSN={dsn}" in (project / ".env").read_text()

    done = client.post(f"/api/p/{pid}/prompts/publish", json={"name": "greet", "label": "production"}).json()
    assert done["store"]["versions"] == [["greet", 1]] and done["store"]["labels"] == [["greet", "production", 1, None]]
    view = client.get(f"/api/p/{pid}/settings").json()["prompt_store"]
    assert view["serving"] == 1 and view["differs"] == [] and view["error"] is None and "127.0.0.1" in view["where"]
    assert client.post(f"/api/p/{pid}/settings/prompt-store/push").json()["store"]["versions"] == []
