"""failing_on_base (docs/TURN_HONESTY_PLAN.md S2) and on_base (docs/WORKSPACE_PLAN.md T3).

Gates: on a real repo whose branch broke one test, added a failing one and kept one that already failed, each id
gets its own answer — fails on base too, passes on base (new), not on base (new) — and the repo's worktree list
is left as it was; a command (a check that is not a test) runs here and on base, each with its exit status
and output, the project's .venv/bin first on PATH.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from operonx_studio import basecheck

pytestmark = pytest.mark.unit


def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True,
                   capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(basecheck, "ROOT", tmp_path / "checks")
    r = tmp_path / "repo"
    (r / "tests").mkdir(parents=True)
    (r / "tests" / "test_a.py").write_text("def test_ok():\n    assert True\n\ndef test_old():\n    assert False\n")
    _git(r, "init", "-q", "-b", "main")
    _git(r, "add", ".")
    _git(r, "commit", "-qm", "base")
    _git(r, "checkout", "-qb", "work")
    (r / "tests" / "test_a.py").write_text("def test_ok():\n    assert False\n\ndef test_old():\n    assert False\n")
    (r / "tests" / "test_b.py").write_text("def test_added():\n    assert False\n")
    _git(r, "add", ".")
    _git(r, "commit", "-qm", "work")
    return r


def test_each_failure_is_told_apart(repo):
    ids = ["tests/test_a.py::test_ok", "tests/test_a.py::test_old", "tests/test_b.py::test_added"]
    r = basecheck.check(str(repo), ids, base="main", python=sys.executable)
    assert r["results"] == {
        "tests/test_a.py::test_ok": "passes on base: NEW failure",
        "tests/test_a.py::test_old": "fails on base too",
        "tests/test_b.py::test_added": "not on base (a new test)",
    }
    text = basecheck.report(r)
    assert text.startswith("on main (merge-base ") and "2 of 3 fail only on this branch" in text
    trees = subprocess.run(["git", "-C", str(repo), "worktree", "list"], capture_output=True, text=True).stdout
    assert len(trees.strip().splitlines()) == 1


def test_a_file_id_covers_its_tests(repo):
    r = basecheck.check(str(repo), ["tests/test_a.py"], base="main", python=sys.executable)
    assert r["results"] == {"tests/test_a.py": "fails on base too"}


def test_the_base_copy_is_made_once(repo):
    basecheck.check(str(repo), ["tests/test_a.py::test_old"], base="main", python=sys.executable)
    (copy,) = list(basecheck.ROOT.iterdir())
    (copy / "marker").write_text("x")
    basecheck.check(str(repo), ["tests/test_a.py::test_old"], base="main", python=sys.executable)
    assert (copy / "marker").exists()


def test_no_ids_is_refused(repo):
    with pytest.raises(ValueError, match="failing test ids"):
        basecheck.check(str(repo), [" "], base="main")


def test_a_command_runs_here_and_on_base(repo):
    cmd = "ls tests; test ! -e tests/test_b.py"
    r = basecheck.on_base(str(repo), cmd, base="main", python=sys.executable)
    assert r["here"] == {"rc": 1, "output": "test_a.py\ntest_b.py\n"}
    assert r["on_base"] == {"rc": 0, "output": "test_a.py\n"}
    text = basecheck.on_base_report(r)
    assert text.startswith(f"`{cmd}` here: exit 1 · on main (merge-base ") and text.endswith("test_a.py")
    py_dir = basecheck._env(repo, sys.executable)["PATH"].split(":")[0]
    assert py_dir == str(Path(sys.executable).parent)
    with pytest.raises(ValueError, match="command"):
        basecheck.on_base(str(repo), "  ", base="main")



def test_a_project_in_a_subfolder_runs_there_on_base(tmp_path, monkeypatch):
    """A repo holding several projects: the ids and the command are the project's, not the repo top's."""
    monkeypatch.setattr(basecheck, "ROOT", tmp_path / "checks")
    r = tmp_path / "mono"
    (r / "proj" / "tests").mkdir(parents=True)
    (r / "proj" / "tests" / "test_a.py").write_text("def test_old():\n    assert False\n")
    _git(r, "init", "-q", "-b", "main")
    _git(r, "add", ".")
    _git(r, "commit", "-qm", "base")
    _git(r, "checkout", "-qb", "work")
    proj = str(r / "proj")
    got = basecheck.check(proj, ["tests/test_a.py::test_old"], base="main", python=sys.executable)
    assert got["results"] == {"tests/test_a.py::test_old": "fails on base too"}
    assert basecheck.on_base(proj, "ls tests/test_a.py", base="main")["on_base"] == {"rc": 0, "output": "tests/test_a.py\n"}
