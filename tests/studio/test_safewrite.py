"""Every write the studio makes to a project file (operonx_studio/safewrite.py).

The gates of docs/STUDIO_EXPERIENCE_PLAN.md §5: a write names the file it was
previewed against and is refused if it moved; it changes only what it was
for; it is atomic; a project that built before still builds after, or the
file goes back; and it can be undone.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pytest

from operonx_studio import safewrite as sw
from operonx_studio.safewrite import WriteRefused

pytestmark = pytest.mark.unit

YAML = """\
# the models
llm:
  inhouse:
    model: a   # cheap
    base_url: http://x
  other:
    model: b
"""


@dataclass
class Got:
    ok: bool
    error: Optional[str] = None


class FakeWatcher:
    """A project that builds unless the file says BROKEN."""

    def __init__(self, path: Path):
        self.path = path
        self.last = Got(True)
        self.extractions = 0

    def extract(self) -> Got:
        self.extractions += 1
        self.last = Got("BROKEN" not in self.path.read_text(), "NameError: BROKEN")
        return self.last


def _file(tmp_path, text=YAML, name="resources.yaml"):
    p = tmp_path / name
    p.write_text(text)
    return p


def test_a_write_lands_and_is_journalled(tmp_path):
    p = _file(tmp_path)
    after = YAML.replace("model: a", "model: c")
    w = sw.commit(tmp_path, p, after, sw.sha(YAML), scope=sw.yaml_scope([("llm", "inhouse", "model")]), what="model")
    assert p.read_text() == after
    assert [x.id for x in sw.journal(tmp_path)][-1] == w.id and w.file == "resources.yaml"


def test_a_file_that_moved_since_the_preview_is_refused_with_the_new_diff(tmp_path):
    p = _file(tmp_path)
    base = sw.sha(YAML)
    p.write_text(YAML.replace("model: b", "model: z"))  # someone else's edit
    with pytest.raises(WriteRefused) as e:
        sw.commit(tmp_path, p, YAML.replace("model: a", "model: c"), base)
    assert e.value.code == "stale" and "model: z" in e.value.diff and e.value.base == sw.sha(p.read_text())
    assert "model: z" in p.read_text()  # untouched


def test_yaml_outside_the_named_paths_is_refused(tmp_path):
    p = _file(tmp_path)
    after = YAML.replace("model: a", "model: c").replace("model: b", "model: d")
    with pytest.raises(WriteRefused) as e:
        sw.commit(tmp_path, p, after, sw.sha(YAML), scope=sw.yaml_scope([("llm", "inhouse", "model")]))
    assert e.value.code == "scope" and "llm.other.model" in str(e.value)
    assert p.read_text() == YAML


def test_python_outside_the_statement_is_refused_and_must_parse(tmp_path):
    src = "a = 1\nb = 2\nc = 3\n"
    p = _file(tmp_path, src, "m.py")
    import ast

    with pytest.raises(WriteRefused, match="line 3"):
        sw.commit(tmp_path, p, "a = 1\nb = 5\nc = 4\n", sw.sha(src), scope=sw.lines_scope(2, 2, parse=ast.parse))
    with pytest.raises(WriteRefused, match="does not parse"):
        sw.commit(tmp_path, p, "a = 1\nb = (\nc = 3\n", sw.sha(src), scope=sw.lines_scope(2, 2, parse=ast.parse))
    sw.commit(tmp_path, p, "a = 1\nb = 5\nc = 3\n", sw.sha(src), scope=sw.lines_scope(2, 2, parse=ast.parse))
    assert p.read_text() == "a = 1\nb = 5\nc = 3\n"


def test_env_and_span_scopes(tmp_path):
    assert sw.env_scope(["A"])("A=1\nB=2\n", "A=3\nB=2\n") is None
    assert "B" in sw.env_scope(["A"])("A=1\nB=2\n", "A=3\nB=4\n")
    text = "x = '''hello there'''\n"
    at = text.find("hello there")
    ok = text[:at] + "bye" + text[at + len("hello there"):]
    assert sw.span_scope(at, at + len("hello there"))(text, ok) is None
    assert sw.span_scope(at, at + len("hello there"))(text, ok.replace("x =", "y =")) is not None


def test_a_project_that_stops_building_gets_its_file_back(tmp_path):
    src = "ok = 1\n"
    p = _file(tmp_path, src, "m.py")
    watcher = FakeWatcher(p)
    with pytest.raises(WriteRefused) as e:
        sw.commit(tmp_path, p, "ok = BROKEN\n", sw.sha(src), watcher=watcher)
    assert e.value.code == "build" and "NameError" in str(e.value)
    assert p.read_text() == src and watcher.last.ok


def test_the_write_is_atomic_and_keeps_the_files_mode(tmp_path):
    p = _file(tmp_path)
    os.chmod(p, 0o640)
    sw.commit(tmp_path, p, YAML + "# more\n", sw.sha(YAML))
    assert oct(p.stat().st_mode & 0o777) == "0o640"
    assert not [x for x in tmp_path.iterdir() if x.name.endswith(".studio")]  # no temp file left


def test_undo_puts_it_back_only_if_nothing_changed_since(tmp_path):
    p = _file(tmp_path)
    w = sw.commit(tmp_path, p, YAML.replace("model: a", "model: c"), sw.sha(YAML))
    sw.undo(tmp_path, w.id)
    assert p.read_text() == YAML
    w2 = sw.commit(tmp_path, p, YAML.replace("model: a", "model: e"), sw.sha(YAML))
    p.write_text(p.read_text() + "# an editor\n")
    with pytest.raises(WriteRefused) as e:
        sw.undo(tmp_path, w2.id)
    assert e.value.code == "stale"
