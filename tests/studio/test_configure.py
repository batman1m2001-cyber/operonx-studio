"""An op's configuration, edited as what it is (docs/STUDIO_EXPERIENCE_PLAN.md §4).

The source edits (an @op keyword, a keyword the call does not write yet, a
dict literal), the types the extractor gives each input, the YAML file
edited value by value, and the endpoints that put them through safewrite.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
import yaml

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_project import pyedit
from operonx_project.extract import _type_info
from operonx_studio import yamldoc
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

MAIN = textwrap.dedent('''\
    from typing import Literal

    from operonx.core import graph, op, START, END


    @op(show_keys=["out"])
    def repeat(text: str = "hi", times: int = 1, loud: bool = False,
               style: Literal["plain", "fancy"] = "plain", parts: dict = None):
        return {"out": text * times, "style": style}


    @graph
    def flow():
        a = repeat(text="hello", times=2, parts={"system": "You are {name}."})  # the greeting
        START >> a >> END
''')

PROMPTS = textwrap.dedent('''\
    # the agent's words
    intents:
      ask_price:
        description: Hỏi giá   # short
        examples:
        - bao nhiêu tiền
      bye:
        description: 'Chào tạm biệt'
        examples: [tạm biệt]
''')


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    root.mkdir()
    (root / "main.py").write_text(MAIN)
    (root / "prompts.yaml").write_text(PROMPTS)
    (root / "operonx.toml").write_text('[project]\nname = "cfg"\n\n[[graph]]\nname = "flow"\nentry = "main:flow"\n')
    return root


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


# -- the source edits ---------------------------------------------------------------


def test_a_decorator_keyword_is_read_set_and_added_and_a_computed_one_refused():
    src = MAIN.replace('@op(show_keys=["out"])', '@op(show_keys=["out"], timeout=Timeout(run=2))')
    kw = pyedit.decorator_kwargs(src, "repeat")
    assert kw["show_keys"] == {"literal": True, "value": ["out"], "source": '["out"]'}
    assert kw["timeout"]["literal"] is False and kw["timeout"]["source"] == "Timeout(run=2)"
    out = pyedit.set_decorator_kwarg(src, "repeat", "show_keys", ["out", "style"])
    out = pyedit.set_decorator_kwarg(out, "repeat", "bound", "io")
    assert '@op(show_keys=["out", "style"], timeout=Timeout(run=2), bound="io")' in out
    with pytest.raises(pyedit.PyEditError, match="computed"):
        pyedit.set_decorator_kwarg(src, "repeat", "timeout", 3)
    assert pyedit.function_at(src, 6) == "repeat"


def test_a_keyword_left_at_its_default_is_added_and_a_dict_rendered():
    out = pyedit.set_op_param(MAIN, "flow", "a", "loud", True, add=True)
    assert 'parts={"system": "You are {name}."}, loud=True)  # the greeting' in out
    out = pyedit.set_op_param(out, "flow", "a", "parts", {"system": "Hi", "user": "Say {text}"})
    assert 'parts={"system": "Hi", "user": "Say {text}"}' in out


@pytest.mark.parametrize("annotation, expected", [
    ("int", {"type": "int", "optional": False}),
    ("Optional[str]", {"type": "str", "optional": True}),
    ('Literal["a", "b"]', {"type": "choice", "choices": ["a", "b"], "optional": False}),
    (bool, {"type": "bool"}),
    ("dict[str, str]", {"type": "dict", "optional": False}),
])
def test_an_annotation_names_the_field(annotation, expected):
    assert _type_info(annotation) == expected


# -- YAML, value by value ----------------------------------------------------------------


def _changed(before: str, after: str) -> list:
    import difflib

    return [ln for ln in difflib.unified_diff(before.splitlines(), after.splitlines(), n=0)
            if ln[:1] in "+-" and not ln.startswith(("+++", "---"))]


def test_each_yaml_edit_touches_only_its_lines_and_keeps_comments_and_quotes():
    out, _ = yamldoc.edit(PROMPTS, "set", ["intents", "ask_price", "description"], "Hỏi học phí")
    assert "description: Hỏi học phí   # short" in out and len(_changed(PROMPTS, out)) == 2
    out, _ = yamldoc.edit(PROMPTS, "set", ["intents", "bye", "description"], "Tạm biệt 'nhé'")
    assert "description: 'Tạm biệt ''nhé'''" in out
    out, _ = yamldoc.edit(PROMPTS, "append", ["intents", "ask_price", "examples"], "học phí")
    assert _changed(PROMPTS, out) == ["+    - học phí"]
    out, _ = yamldoc.edit(PROMPTS, "append", ["intents", "bye", "examples"], "hẹn gặp lại")
    assert "examples: [tạm biệt, hẹn gặp lại]" in out
    out, _ = yamldoc.edit(PROMPTS, "remove", ["intents", "ask_price", "examples", 0])
    assert yaml.safe_load(out)["intents"]["ask_price"]["examples"] is None
    out, paths = yamldoc.edit(PROMPTS, "add", ["intents"], {"description": "Hỏi lịch", "examples": ["mấy giờ"]}, key="ask_time")
    assert yaml.safe_load(out)["intents"]["ask_time"] == {"description": "Hỏi lịch", "examples": ["mấy giờ"]}
    assert paths == [("intents", "ask_time")] and out.startswith("# the agent's words")
    out, _ = yamldoc.edit(PROMPTS, "delete", ["intents", "bye"])
    assert "bye" not in yaml.safe_load(out)["intents"] and "# short" in out


def test_text_with_line_breaks_becomes_a_block_unless_a_comment_would_be_swallowed():
    out, _ = yamldoc.edit(PROMPTS, "set", ["intents", "bye", "description"], "Chào\nHẹn gặp lại")
    assert yaml.safe_load(out)["intents"]["bye"]["description"] == "Chào\nHẹn gặp lại"
    with pytest.raises(yamldoc.YamlDocError, match="comment"):
        yamldoc.edit(PROMPTS, "set", ["intents", "ask_price", "description"], "a\nb")


# -- the endpoints -------------------------------------------------------------------


def test_op_config_reads_the_decorator_and_op_decorator_writes_it(client, project):
    pid = _open(client, project)
    cfg = client.get(f"/api/p/{pid}/op-config", params={"graph": "flow", "op": "a"}).json()
    d = cfg["decorator"]
    assert d["file"] == "main.py" and d["func"] == "repeat" and d["kwargs"]["show_keys"]["editable"]
    body = {"file": "main.py", "func": "repeat", "key": "transient", "value": True}
    preview = client.post(f"/api/p/{pid}/op-decorator", json=body).json()
    assert "transient=True" in preview["diff"] and not preview["applied"]
    done = client.post(f"/api/p/{pid}/op-decorator", json={**body, "apply": True, "base": preview["base"]}).json()
    assert done["applied"] and "@op(show_keys=[\"out\"], transient=True)" in (project / "main.py").read_text()
    refused = client.post(f"/api/p/{pid}/op-decorator", json={**body, "key": "door", "value": "egress"})
    assert refused.status_code == 400


def test_a_yaml_file_is_read_and_edited_through_safewrite(client, project):
    pid = _open(client, project)
    got = client.get(f"/api/p/{pid}/yaml", params={"file": "prompts.yaml"}).json()
    assert got["tree"]["kind"] == "map" and got["tree"]["items"][0][0] == "intents"
    edit = {"file": "prompts.yaml", "op": "append", "path": ["intents", "ask_price", "examples"], "value": "giá"}
    preview = client.post(f"/api/p/{pid}/yaml", json=edit).json()
    done = client.post(f"/api/p/{pid}/yaml", json={**edit, "apply": True, "base": preview["base"]}).json()
    assert done["applied"] and "- giá" in (project / "prompts.yaml").read_text()
    outside = client.get(f"/api/p/{pid}/yaml", params={"file": "../../etc/passwd.yaml"})
    assert outside.status_code == 400
