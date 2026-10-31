"""What the assistant may do with git, per project, enforced in git (docs/PROJECT_STANDARD_PLAN.md D6).

Every case runs the real git through the guard the assistant's PATH starts with, against a real repo and a bare
remote; ``gh`` is a fake that records what reached it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from operonx_studio import gitpolicy
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

OWNER = {"name": "Owner", "email": "owner@example.com"}
CLEAN = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "OPERONX_STUDIO_GIT"))}


def _plain(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), "-c", "user.name=o", "-c", "user.email=o@o", *args],
                          check=True, capture_output=True, text=True, env=CLEAN).stdout  # fmt: skip


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    root = tmp_path / "proj"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "proj"\n', encoding="utf-8")
    _plain(root, "init", "-q", "-b", "main")
    _plain(root, "remote", "add", "origin", str(remote))
    _plain(root, "add", ".")
    _plain(root, "commit", "-qm", "first")
    _plain(root, "push", "-q", "origin", "main")
    _plain(root, "remote", "set-head", "origin", "main")
    return root


def _env(tmp_path: Path, root: Path, **policy) -> dict:
    state = tmp_path / "state"
    if policy:
        gitpolicy.save(state, "p1", root, policy)
    env = gitpolicy.assistant_env(state, "p1", root, {**CLEAN, "PATH": f"{tmp_path / 'fakebin'}{os.pathsep}{CLEAN['PATH']}"})
    return env


def _run(env: dict, root: Path, *cmd: str) -> subprocess.CompletedProcess:
    return subprocess.run(list(cmd), cwd=root, env=env, capture_output=True, text=True)


def _change(root: Path, name: str = "operonx.toml") -> None:
    p = root / name
    p.write_text(p.read_text() + "#\n", encoding="utf-8")


def test_the_defaults_protect_the_default_branch_and_commit_needs_an_identity(tmp_path, repo):
    policy = gitpolicy.load(tmp_path / "state", "p1", repo)
    assert policy["level"] == "commit" and policy["protected"] == ["main", "production"]
    assert policy["identity"] is None or policy["identity"]["email"]  # whatever git would use, if anything
    env = _env(tmp_path, repo)
    env["HOME"] = str(tmp_path)  # no global identity
    json.dump({**json.loads(Path(env["OPERONX_STUDIO_GIT_POLICY"]).read_text()), "identity": None},
              open(env["OPERONX_STUDIO_GIT_POLICY"], "w"))  # fmt: skip
    _change(repo)
    got = _run(env, repo, "git", "commit", "-qam", "x")
    assert got.returncode != 0 and "no Commit as for this project" in got.stderr  # never a borrowed name


def test_a_default_branch_with_a_slash_is_protected_whole(tmp_path, repo):
    _plain(repo, "push", "-q", "origin", "HEAD:refs/heads/refactor/work")
    _plain(repo, "remote", "set-head", "origin", "refactor/work")
    assert gitpolicy.load(tmp_path / "state", "p1", repo)["protected"] == ["refactor/work", "production"]


def test_commits_are_made_as_the_project_identity_and_no_one_else(tmp_path, repo):
    env = _env(tmp_path, repo, identity=OWNER)
    assert _plain(repo, "config", "--local", "user.email").strip() == OWNER["email"]  # the owner's commits too
    _change(repo)
    _run(env, repo, "git", "add", ".")
    assert _run(env, repo, "git", "commit", "-qm", "ok").returncode == 0
    assert _plain(repo, "log", "-1", "--format=%an <%ae>").strip() == "Owner <owner@example.com>"
    _change(repo)
    spoof = _run(env, repo, "git", "-c", "user.email=me@x", "commit", "-qam", "spoof")
    assert spoof.returncode != 0 and "sets its own identity" in spoof.stderr
    by_env = _run({**env, "GIT_AUTHOR_EMAIL": "me@x"}, repo, "git", "commit", "-qam", "env")
    assert by_env.returncode != 0 and "this project commits as Owner <owner@example.com>" in by_env.stderr
    author = _run(env, repo, "git", "commit", "-qam", "author", "--author", "Me <me@x>")
    assert author.returncode != 0
    for skip in (["commit", "-n", "-qam", "x"], ["commit", "--no-verify", "-qam", "x"], ["push", "--no-verify"]):
        got = _run(env, repo, "git", *skip)
        assert got.returncode != 0 and "--no-verify skips" in got.stderr
    hooks = _run(env, repo, "git", "-c", "core.hooksPath=/dev/null", "commit", "-qam", "x")
    assert hooks.returncode != 0 and "core.hooksPath" in hooks.stderr


def test_each_level_allows_what_it_names(tmp_path, repo):
    env = _env(tmp_path, repo, identity=OWNER, level="off")
    _change(repo)
    off = _run(env, repo, "git", "commit", "-qam", "x")
    assert off.returncode != 0 and "may not commit" in off.stderr

    env = _env(tmp_path, repo, level="commit")
    assert _run(env, repo, "git", "commit", "-qam", "x").returncode == 0
    no_push = _run(env, repo, "git", "push", "-q", "origin", "HEAD:refs/heads/work")
    assert no_push.returncode != 0 and "may not push" in no_push.stderr

    env = _env(tmp_path, repo, level="push")
    assert _run(env, repo, "git", "push", "-q", "origin", "HEAD:refs/heads/work").returncode == 0
    to_main = _run(env, repo, "git", "push", "-q", "origin", "HEAD:main")
    assert to_main.returncode != 0 and "main is protected in this project" in to_main.stderr
    gone = _run(env, repo, "git", "push", "-q", "origin", ":main")
    assert gone.returncode != 0 and "does not delete it" in gone.stderr
    env = _env(tmp_path, repo, protected="production")
    assert _run(env, repo, "git", "push", "-q", "origin", "HEAD:main").returncode == 0  # the owner unprotected it


def test_the_repos_own_hooks_still_run(tmp_path, repo):
    hook = repo / ".git" / "hooks" / "pre-push"
    hook.write_text("#!/bin/sh\ncat > \"$(git rev-parse --git-dir)/pushed\"\necho own-hook-ran >&2\nexit 0\n")
    hook.chmod(0o755)
    env = _env(tmp_path, repo, identity=OWNER, level="push")
    got = _run(env, repo, "git", "push", "-q", "origin", "HEAD:refs/heads/work")
    assert got.returncode == 0 and "own-hook-ran" in got.stderr
    assert "refs/heads/work" in (repo / ".git" / "pushed").read_text()  # with the refs on its stdin


def test_gh_follows_the_level(tmp_path, repo):
    fake = tmp_path / "fakebin"
    fake.mkdir()
    (fake / "gh").write_text(f"#!/bin/sh\necho \"$@\" >> {tmp_path / 'gh.log'}\n")
    (fake / "gh").chmod(0o755)

    def gh(level: str, *args: str) -> subprocess.CompletedProcess:
        return _run(_env(tmp_path, repo, identity=OWNER, level=level), repo, "gh", *args)

    assert "may not open pull requests" in gh("push", "pr", "create", "--fill").stderr
    assert gh("pr", "pr", "create", "--fill").returncode == 0
    assert "may not merge" in gh("pr", "pr", "merge", "3").stderr
    assert gh("merge", "pr", "merge", "3").returncode == 0
    assert "a write through gh api" in gh("pr", "api", "-X", "PUT", "repos/o/r/pulls/3/merge").stderr
    assert "a write through gh api" in gh("pr", "api", "repos/o/r/issues", "-f", "title=x").stderr
    assert gh("pr", "api", "repos/o/r/pulls").returncode == 0
    assert "never the assistant's" in gh("merge", "repo", "delete", "o/r", "--yes").stderr
    assert (tmp_path / "gh.log").read_text().splitlines() == ["pr create --fill", "pr merge 3", "api repos/o/r/pulls"]


def test_the_guard_comes_first_on_the_assistants_path_only(tmp_path, repo):
    env = _env(tmp_path, repo)
    first = env["PATH"].split(os.pathsep)[0]
    assert Path(first) == gitpolicy.GUARD / "bin" and env["OPERONX_STUDIO_PY"] == sys.executable
    assert "OPERONX_STUDIO_GIT_POLICY" not in os.environ  # the studio's own git is untouched


def test_another_copy_of_the_guard_on_the_path_is_not_the_real_git(tmp_path, repo):
    # a studio started inside an assistant turn, or a studio checkout whose tests import the installed copy: two
    # guards' bin/ on one PATH; the guard used to take the other's shim for git and exec it forever
    import shutil
    from operonx_studio.gitguard import HERE
    other = tmp_path / "other-studio" / "gitguard" / "bin"
    shutil.copytree(HERE / "bin", other)
    env = _env(tmp_path, repo, identity=OWNER)
    first, rest = env["PATH"].split(os.pathsep, 1)
    for path in (os.pathsep.join([first, str(other), rest]), os.pathsep.join([str(other), first, rest])):
        _change(repo)
        got = subprocess.run(["git", "commit", "-qam", "nested"], cwd=repo, env={**env, "PATH": path},
                             capture_output=True, text=True, timeout=20)
        assert got.returncode == 0, got.stderr


def test_the_routes_read_and_change_the_policy(tmp_path, repo):
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as client:
        pid = client.post("/api/open", json={"path": str(repo)}).json()["id"]
        got = client.get(f"/api/p/{pid}/git").json()
        assert got["level"] == "commit" and got["protected"] == ["main", "production"] and got["host"] == ""
        assert got["levels"] == ["off", "commit", "push", "pr", "merge"] and got["line"].startswith("Git: ")
        bad = client.post(f"/api/p/{pid}/git", json={"level": "everything"})
        assert bad.status_code == 400
        assert client.post(f"/api/p/{pid}/git", json={"identity": {"name": "X", "email": "nope"}}).status_code == 400
        ok = client.post(f"/api/p/{pid}/git", json={"identity": OWNER, "level": "pr", "protected": "main, release"})
        assert ok.status_code == 200
        body = ok.json()
        assert body["identity"] == OWNER and body["level"] == "pr" and body["protected"] == ["main", "release"]
        assert "commits as Owner <owner@example.com>" in body["line"] and "open pull requests" in body["line"]
