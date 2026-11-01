"""failing_on_base (docs/TURN_HONESTY_PLAN.md S2).

Gates: on a real repo whose branch broke one test, added a failing one and kept one that already failed, each id
gets its own answer — fails on base too, passes on base (new), not on base (new) — and the repo's worktree list
is left as it was.
"""

from __future__ import annotations

import subprocess
import sys

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
