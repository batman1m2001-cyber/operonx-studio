"""Project mode › Git (WORKSPACE_PLAN W2): the repo read and worked from the studio, as the project's identity."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from operonx_studio.app import Recents, build_studio_app


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True,
                          env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}).stdout  # fmt: skip


@pytest.fixture()
def client(tmp_path: Path):
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(remote))
    root = tmp_path / "calc"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "calc"\n', encoding="utf-8")
    (root / "a.py").write_text("x = 1\n", encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "init")
    _git(root, "remote", "add", "origin", str(remote))
    _git(root, "push", "-q", "-u", "origin", "main")
    return root


def test_the_working_tree_is_read_staged_and_committed_as_the_project(client, project, tmp_path):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    (project / "a.py").write_text("x = 2\n", encoding="utf-8")
    (project / "new.py").write_text("y = 1\n", encoding="utf-8")
    url = f"/api/p/{pid}/repo"
    st = client.get(url).json()
    assert (st["branch"], st["upstream"], st["ahead"], st["state"]) == ("main", "origin/main", 0, "")
    files = {f["path"]: f for f in st["files"]}
    assert files["a.py"]["unstaged"] and not files["a.py"]["staged"] and files["new.py"].get("untracked")
    assert [b["name"] for b in st["branches"]] == ["main"] and st["remotes"][0]["name"] == "origin"
    # the line diff of each, an untracked file all added
    assert "+x = 2" in client.get(f"{url}/diff", params={"path": "a.py"}).json()["diff"]
    assert "+y = 1" in client.get(f"{url}/diff", params={"path": "new.py"}).json()["diff"]
    got = client.post(url, json={"op": "stage", "paths": ["a.py"]}).json()
    assert {f["path"]: f["staged"] for f in got["status"]["files"]}["a.py"]
    assert "+x = 2" in client.get(f"{url}/diff", params={"path": "a.py", "staged": True}).json()["diff"]
    # no identity yet (Settings › Git): refused, not committed as whoever the machine is
    _git(project, "config", "--unset", "user.name") if _git_has(project, "user.name") else None
    r = client.post(url, json={"op": "commit", "message": "two"})
    assert r.status_code == 400 and "Commit as" in r.json()["error"]
    client.post(f"/api/p/{pid}/git", json={"identity": {"name": "Owner", "email": "o@x.io"}})
    assert client.post(url, json={"op": "commit", "message": "two"}).json()["ok"]
    assert _git(project, "log", "-1", "--format=%an <%ae>|%s").strip() == "Owner <o@x.io>|two"
    st = client.get(url).json()
    assert st["ahead"] == 1 and [f["path"] for f in st["files"]] == ["new.py"]
    # the history as a graph: parents, refs
    commits = client.get(f"{url}/log").json()["commits"]
    assert [c["subject"] for c in commits] == ["two", "init"] and commits[0]["parents"] == [commits[1]["sha"]]
    assert any("origin/main" in r for r in commits[1]["refs"])
    assert "+x = 2" in client.get(f"{url}/diff", params={"commit": commits[0]["sha"]}).json()["diff"]


def _git_has(root: Path, key: str) -> bool:
    return subprocess.run(["git", "config", key], cwd=root, capture_output=True).returncode == 0


def test_nothing_uncommitted_is_dropped_without_confirm_and_a_copy_is_kept(client, project, tmp_path):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    url = f"/api/p/{pid}/repo"
    (project / "a.py").write_text("x = 3\n", encoding="utf-8")
    (project / "scratch.txt").write_text("notes\n", encoding="utf-8")
    asked = client.post(url, json={"op": "discard", "paths": ["a.py", "scratch.txt"]}).json()
    assert "needs_confirm" in asked and (project / "a.py").read_text() == "x = 3\n"
    got = client.post(url, json={"op": "discard", "paths": ["a.py", "scratch.txt"], "confirm": True}).json()
    assert (project / "a.py").read_text() == "x = 1\n" and not (project / "scratch.txt").exists()
    kept = Path(got["said"].removeprefix("kept a copy in "))
    assert "+x = 3" in (kept / "changes.patch").read_text() and (kept / "untracked/scratch.txt").read_text() == "notes\n"
    # a switch that would overwrite uncommitted work is git's refusal, not a forced checkout
    _git(project, "switch", "-q", "-c", "other")
    (project / "a.py").write_text("x = 9\n", encoding="utf-8")
    _git(project, "commit", "-qam", "nine")
    _git(project, "switch", "-q", "main")
    (project / "a.py").write_text("x = 4\n", encoding="utf-8")
    r = client.post(url, json={"op": "switch", "branch": "other"})
    assert r.status_code == 400 and (project / "a.py").read_text() == "x = 4\n"


def test_a_conflict_is_shown_and_aborted_and_a_protected_push_asks(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    url = f"/api/p/{pid}/repo"
    client.post(f"/api/p/{pid}/git", json={"identity": {"name": "Owner", "email": "o@x.io"}})
    assert client.post(url, json={"op": "branch", "name": "feat"}).json()["status"]["branch"] == "feat"
    (project / "a.py").write_text("x = 5\n", encoding="utf-8")
    client.post(url, json={"op": "commit", "message": "five", "all": True})
    client.post(url, json={"op": "switch", "branch": "main"})
    (project / "a.py").write_text("x = 6\n", encoding="utf-8")
    client.post(url, json={"op": "commit", "message": "six", "all": True})
    got = client.post(url, json={"op": "merge", "branch": "feat"}).json()
    assert got["status"]["state"] == "merging" and "conflicts" in got["said"]
    assert [f["path"] for f in got["status"]["files"] if f.get("conflict")] == ["a.py"]
    assert client.post(url, json={"op": "abort"}).json()["status"]["state"] == ""
    # main is protected (the remote's default branch): a push asks first
    asked = client.post(url, json={"op": "push"}).json()
    assert "protected" in asked["needs_confirm"]
    assert client.post(url, json={"op": "push", "confirm": True}).json()["status"]["ahead"] == 0
    # a branch with no upstream is pushed and tracked
    client.post(url, json={"op": "switch", "branch": "feat"})
    assert client.post(url, json={"op": "push"}).json()["status"]["upstream"] == "origin/feat"
    # outside the checkout and its worktrees: refused
    assert client.get(url, params={"cwd": "/tmp"}).status_code == 400
