"""`[serve.variants]`: one door, one drawn graph per variant.

The manifest synthesises a GraphSpec per variant, named `<graph>[<variant>]`
and binding the graph's build-time parameters; the extractor builds each
one with the bound values static and the rest wired to PARENT.
"""

from __future__ import annotations

import textwrap
import uuid

import pytest

from operonx_project.extract import extract_project
from operonx_project.manifest import Manifest, ManifestError

FLOW = '''
from operonx.core import END, PARENT, START, graph
from operonx.core.ops import op


@op(bound="sync")
def shout(item: str = "", style=None, suffix: str = "") -> dict:
    return {"reply": style(item) + suffix}


@graph
def door(item, style, suffix):
    """`style` and `suffix` are bound per variant; `item` is the run's input."""
    loud = shout(item=item, style=style, suffix=suffix)
    loud["reply"] >> PARENT["reply"]
    START >> loud >> END
'''

STYLES = "LOUD = str.upper\nQUIET = str.lower\n"


@pytest.fixture(scope="module")
def project(tmp_path_factory):
    """One project for the module: the loader refuses a module name already
    imported from another project in the same process, so the files get a
    unique name and every test here shares them."""
    tmp_path = tmp_path_factory.mktemp("doors")
    tag = uuid.uuid4().hex[:6]
    (tmp_path / f"flow_{tag}.py").write_text(textwrap.dedent(FLOW), encoding="utf-8")
    (tmp_path / f"styles_{tag}.py").write_text(STYLES, encoding="utf-8")
    (tmp_path / "operonx.toml").write_text(
        textwrap.dedent(f'''
        [project]
        name = "doors"

        [[serve]]
        name  = "greet"
        kind  = "http"
        path  = "/greet"
        graph = "flow_{tag}:door"
        [serve.variants]
        loud  = {{ style = "styles_{tag}:LOUD",  suffix = "!" }}
        quiet = {{ style = "styles_{tag}:QUIET", suffix = "." }}
        '''),
        encoding="utf-8",
    )
    return tmp_path


def test_manifest_lists_one_graph_per_variant(project):
    m = Manifest.load(project)
    assert [g.name for g in m.graphs] == ["door[loud]", "door[quiet]"]
    assert m.graphs[0].entry.endswith(":door")
    assert m.graphs[0].bind["suffix"] == "!" and m.graphs[0].bind["style"].endswith(":LOUD")
    assert m.serves[0].variants == ("loud", "quiet")
    assert m.serves[0].as_dict()["variants"] == ["loud", "quiet"]


def test_a_variant_binds_module_refs_and_passes_literals(project):
    m = Manifest.load(project)
    bound = m.graphs[1].resolve_bind(project)
    assert bound["style"]("Hi") == "hi" and bound["suffix"] == "."


def test_extract_builds_every_variant(project):
    ir = extract_project(Manifest.load(project))
    names = [g["name"] for g in ir["graphs"]]
    assert names == ["door[loud]", "door[quiet]"]
    for g in ir["graphs"]:
        assert g["entry"].endswith(":door")
        assert [n["name"] for n in g["nodes"] if n["name"] == "loud"] == ["loud"]
    assert ir["serves"][0]["variants"] == ["loud", "quiet"]


def test_variants_must_be_a_table_of_tables(project, tmp_path):
    entry = next(p.stem for p in project.glob("flow_*.py"))
    (tmp_path / "operonx.toml").write_text(
        textwrap.dedent(f'''
        [project]
        name = "doors"
        [[serve]]
        kind  = "http"
        path  = "/greet"
        graph = "{entry}:door"
        variants = {{ loud = 1 }}
        '''),
        encoding="utf-8",
    )
    with pytest.raises(ManifestError, match="table of tables"):
        Manifest.load(tmp_path)


# -- the application declared in Python -----------------------------------

APP_MODULE = '''
from operonx.app import Application, Service, http
from operonx.app.serve import egress, ingress
from operonx.core import END, START, graph, op


@op(bound="sync")
def shout(item: str = "", style=None) -> dict:
    return {"reply": style(item)}


@graph
def door(style):
    src = ingress()
    loud = shout(item=src["item"], style=style)
    out = egress(item=loud["reply"])
    START >> src >> loud >> out >> END


APP = Application(
    "declared",
    services=[Service("greet", http("POST", "/greet"), graph=door,
                      variants={"loud": dict(style=str.upper), "quiet": dict(style=str.lower)},
                      ingress=["src"], egress=["out"])],
)
'''


@pytest.fixture(scope="module")
def declared(tmp_path_factory):
    root = tmp_path_factory.mktemp("declared")
    tag = uuid.uuid4().hex[:6]
    (root / f"appmod_{tag}.py").write_text(textwrap.dedent(APP_MODULE), encoding="utf-8")
    (root / "operonx.toml").write_text(
        f"[project]\nname = \"declared\"\napp = \"appmod_{tag}:APP\"\n", encoding="utf-8"
    )
    return root


def test_a_manifest_that_points_at_an_app_loads_with_no_graphs_of_its_own(declared):
    m = Manifest.load(declared)
    assert m.app.endswith(":APP") and m.graphs == ()


def test_the_graphs_and_doors_come_from_the_application(declared):
    ir = extract_project(Manifest.load(declared))
    assert [g["name"] for g in ir["graphs"]] == ["door[loud]", "door[quiet]"]
    greet = ir["services"][0]
    assert greet["variants"] == ["loud", "quiet"]
    assert greet["ingress"] == ["src"] and greet["egress"] == ["out"]
