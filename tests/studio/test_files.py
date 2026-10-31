"""Project mode › Files: what git tracks, read-only; the lately changed files marked."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from operonx_studio.app import Recents, build_studio_app


def _git(root: Path, *args: str, **env: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t", **env})  # fmt: skip


def _open(client, root: Path) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


@pytest.fixture()
def client(tmp_path: Path):
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


def _project(root: Path) -> Path:
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "calc"\n', encoding="utf-8")
    (root / ".gitignore").write_text(".env\n", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "calc.py").write_text("def double(x):\n    return 2 * x\n", encoding="utf-8")
    (root / "logo.bin").write_bytes(b"\x89PNG\0\0\0")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "init", GIT_AUTHOR_DATE="2020-01-01T00:00:00",
         GIT_COMMITTER_DATE="2020-01-01T00:00:00")
    return root


def test_the_tree_is_what_git_sees_and_marks_what_changed(client, tmp_path):
    root = _project(tmp_path / "p")
    (root / ".env").write_text("SECRET=1\n", encoding="utf-8")
    (root / "src" / "calc.py").write_text("def double(x):\n    return x + x\n", encoding="utf-8")
    (root / "notes.md").write_text("new\n", encoding="utf-8")
    pid = _open(client, root)
    got = client.get(f"/api/p/{pid}/project/files").json()
    assert got["ok"] and ".env" not in got["files"]
    assert {"src/calc.py", "notes.md", "logo.bin", ".gitignore", "operonx.toml"} <= set(got["files"])
    assert got["changed"] == {"src/calc.py": "uncommitted", "notes.md": "uncommitted"}


def test_a_commit_just_made_is_marked_recent(client, tmp_path):
    root = _project(tmp_path / "p")
    (root / "src" / "calc.py").write_text("def double(x):\n    return x + x\n", encoding="utf-8")
    _git(root, "commit", "-qam", "now")
    pid = _open(client, root)
    assert client.get(f"/api/p/{pid}/project/files").json()["changed"].get("src/calc.py") == "recent"


def test_a_project_in_a_subfolder_of_its_repo_is_marked_too(client, tmp_path):
    repo = _project(tmp_path / "repo")
    root = repo / "app"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "app"\n', encoding="utf-8")
    (root / "main.py").write_text("print(1)\n", encoding="utf-8")
    (root / "done.py").write_text("x = 1\n", encoding="utf-8")
    _git(repo, "add", "app/done.py")
    _git(repo, "commit", "-qm", "now")
    pid = _open(client, root)
    got = client.get(f"/api/p/{pid}/project/files").json()
    assert set(got["files"]) == {"operonx.toml", "main.py", "done.py"}
    assert got["changed"] == {"operonx.toml": "uncommitted", "main.py": "uncommitted", "done.py": "recent"}


def test_a_file_reads_and_nothing_outside_the_tree_does(client, tmp_path):
    root = _project(tmp_path / "p")
    (root / ".env").write_text("SECRET=1\n", encoding="utf-8")
    (tmp_path / "outside.txt").write_text("no\n", encoding="utf-8")
    pid = _open(client, root)
    got = client.get(f"/api/p/{pid}/project/file", params={"path": "src/calc.py"}).json()
    assert got["text"].startswith("def double") and not got["truncated"]
    assert client.get(f"/api/p/{pid}/project/file", params={"path": "logo.bin"}).json()["binary"] is True
    for bad in (".env", "../outside.txt", "/etc/passwd", "src/../.env"):
        assert client.get(f"/api/p/{pid}/project/file", params={"path": bad}).status_code == 404, bad


def test_a_folder_without_git_says_so(client, tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "calc"\n', encoding="utf-8")
    pid = _open(client, root)
    got = client.get(f"/api/p/{pid}/project/files")
    assert got.status_code == 409 and "git" in got.json()["message"]
