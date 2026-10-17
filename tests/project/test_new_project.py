"""A new project is core's `operonx init` project, from the studio too.

The studio's "New project" and its old `operonx-new` / `operonx-lint` names
are core's commands: a project born in the studio and one born on the
command line are byte-for-byte the same, and the studio opens it.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from operonx.cli.init import TEMPLATES as PROJECTS
from operonx.cli.init import init_project

pytestmark = pytest.mark.unit


def _tree(root: Path) -> dict:
    return {
        p.relative_to(root).as_posix(): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


@pytest.fixture
def client(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from operonx_studio.app import build_studio_app
    from operonx_studio.registry import Recents

    monkeypatch.setenv("OPERONX_STUDIO_ALERTS", "off")
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


@pytest.mark.parametrize("template", list(PROJECTS))
def test_new_project_writes_exactly_what_operonx_init_writes(tmp_path, client, template):
    studio, cli = tmp_path / "studio", tmp_path / "cli"
    studio.mkdir()
    got = client.post("/api/new", json={"path": str(studio), "name": "myapp", "template": template})
    assert got.status_code == 200, got.text
    assert got.json()["first_runs"] == []
    init_project(cli / "myapp", template=template, name="myapp")
    made, expected = _tree(studio / "myapp"), _tree(cli / "myapp")
    assert sorted(made) == sorted(expected)
    assert made == expected
    assert "AGENTS.md" in made and ".operonx/guide/README.md" in made


def test_the_old_blank_id_is_the_smallest_project(tmp_path, client):
    got = client.post("/api/new", json={"path": str(tmp_path), "name": "b", "template": "blank"}).json()
    assert got["template"] == "hello" and (tmp_path / "b" / "app" / "main.py").is_file()


def test_refusals(tmp_path, client):
    assert client.post("/api/new", json={"path": str(tmp_path), "name": "", "template": "hello"}).status_code == 400
    (tmp_path / "taken").mkdir()
    assert client.post("/api/new", json={"path": str(tmp_path), "name": "taken"}).status_code == 400
    bad = client.post("/api/new", json={"path": str(tmp_path), "name": "x", "template": "nope"})
    assert bad.status_code == 400 and "hello" in bad.json()["error"]


def test_the_studio_extracts_a_fresh_operonx_init_project(tmp_path):
    from operonx_studio_toolkit.extract import extract_project
    from operonx_studio_toolkit.manifest import Manifest

    root = tmp_path / "greeter"
    init_project(root, template="http", name="greeter")
    import sys

    sys.path.insert(0, str(root / "src"))
    try:
        ir = extract_project(Manifest.load(root))
    finally:
        sys.path.remove(str(root / "src"))
    (graph,) = ir["graphs"]
    assert graph["name"] == "stats_flow"
    assert [n["name"] for n in graph["nodes"]] == ["c", "m"]


def test_the_old_command_names_are_core_commands(tmp_path, capsys):
    from operonx_studio_toolkit.cli import main as operonx_lint
    from operonx_studio_toolkit.cli import new_main as operonx_new

    assert operonx_new([str(tmp_path / "p"), "--template", "hello"]) == 0
    assert (tmp_path / "p" / "AGENTS.md").is_file()
    capsys.readouterr()
    assert operonx_lint([str(tmp_path / "p")]) == 0
    assert "clean" in capsys.readouterr().out
    assert operonx_lint(["--rules"]) == 0 and "C12" in capsys.readouterr().out
