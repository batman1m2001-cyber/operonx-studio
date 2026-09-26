"""A door op says what it is: `@op(door="ingress")` / `@op(door="egress")`.

A project's own door — one that reads or writes the session over
`current_session()` — draws as a door without any list naming it, and
keeps its code in the inspector; an ordinary op is not a door.
"""

from __future__ import annotations

import textwrap
import uuid

import pytest

operonx_ops = pytest.importorskip("operonx.core.ops")
if "door" not in operonx_ops.op.__code__.co_varnames:  # operonx < 1.8
    pytest.skip("this operonx has no @op(door=)", allow_module_level=True)

from operonx_project.extract import extract_project  # noqa: E402
from operonx_project.manifest import Manifest  # noqa: E402

FLOW = '''
from operonx.core import END, START, graph
from operonx.core.ops import op


@op(door="ingress")
def heard(item=None):
    """The caller's item, read off the session."""
    return {"text": item}


@op
def shout(text: str = "") -> dict:
    return {"reply": text.upper()}


@op(door="egress")
def said(reply: str = ""):
    """Hands the reply back to the caller."""
    return {"sent": True}


@graph
def echo(item):
    a = heard(item=item)
    b = shout(text=a["text"])
    c = said(reply=b["reply"])
    START >> a >> b >> c >> END
'''


@pytest.fixture(scope="module")
def graph(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("door_ops")
    tag = uuid.uuid4().hex[:6]
    (tmp_path / f"flow_{tag}.py").write_text(textwrap.dedent(FLOW), encoding="utf-8")
    (tmp_path / "operonx.toml").write_text(
        textwrap.dedent(f'''
        [project]
        name = "door_ops"

        [[serve]]
        name  = "echo"
        kind  = "http"
        path  = "/echo"
        graph = "flow_{tag}:echo"
        '''),
        encoding="utf-8",
    )
    return extract_project(Manifest.load(tmp_path))["graphs"][0]


def test_a_declared_door_draws_as_one(graph):
    roles = {n["name"]: n.get("serve_role") for n in graph["nodes"]}
    assert roles == {"a": "ingress", "b": None, "c": "egress"}


def test_a_projects_own_door_keeps_its_code(graph):
    said = next(n for n in graph["nodes"] if n["name"] == "c")
    assert "def said" in said["code"]
