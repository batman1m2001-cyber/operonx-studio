"""PROJECT_SOURCE_PLAN S2: a project added from a git remote."""

import subprocess

import pytest

from operonx_studio import gitsource

URL = "https://example.test/org/demo"


def _repo(path, manifest=True):
    """A bare repository holding one commit, standing in for the remote."""
    work = path.parent / (path.name + "-work")
    work.mkdir(parents=True)
    run = lambda *a: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=work, check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    if manifest:
        (work / "operonx.toml").write_text("[project]\nname = 'demo'\n")
    (work / ".env_prod").write_text("A=1\n")
    (work / ".env.example").write_text("A=\n")
    run("add", "-A")
    run("commit", "-q", "-m", "one")
    subprocess.run(["git", "clone", "-q", "--bare", str(work), str(path)], check=True, capture_output=True)
    return path


@pytest.fixture
def remote(tmp_path, monkeypatch):
    """`https://example.test/org/demo.git` answers from a local repository."""
    monkeypatch.setenv("OPERONX_STUDIO_STATE_DIR", str(tmp_path / "state"))

    def point(url, bare):
        monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
        monkeypatch.setenv("GIT_CONFIG_KEY_0", f"url.file://{bare}.insteadOf")
        monkeypatch.setenv("GIT_CONFIG_VALUE_0", url + ".git")
    return tmp_path, point


def test_a_clone_lands_in_the_workspaces_and_says_where_it_came_from(remote):
    tmp, point = remote
    point(URL, _repo(tmp / "bare.git"))
    root = gitsource.clone(URL + ".git/")
    assert root.parent == tmp / "state" / "workspaces" and (root / "operonx.toml").is_file()
    assert gitsource.tracked_env_files(root) == [".env_prod"]            # .env.example is fine
    assert gitsource.clone(URL) == root                                   # already there: the same folder
    # where it came from is read from the folder's own git files
    subprocess.run(["git", "remote", "set-url", "origin", "https://user:tok@example.test/org/demo.git"], cwd=root, check=True)
    assert gitsource.source(root) == {"remote": "example.test/org/demo", "branch": "main"}
    assert gitsource.source(tmp) is None


def test_a_repository_that_is_not_a_project_is_refused_and_leaves_nothing(remote):
    tmp, point = remote
    point(URL, _repo(tmp / "bare.git", manifest=False))
    with pytest.raises(gitsource.CloneError, match="operonx.toml"):
        gitsource.clone(URL)
    assert not any((tmp / "state" / "workspaces").iterdir())


@pytest.mark.parametrize("url", ["", "git@example.test:org/demo", "file:///etc", "http://example.test/org/demo",
                                 "https://example.test/org/demo --upload-pack=x", "--upload-pack=x", "https://u:p@example.test/o/r"])
def test_only_a_plain_https_address_is_cloned(remote, url):
    with pytest.raises(gitsource.CloneError):
        gitsource.clone(url)
    with pytest.raises(gitsource.CloneError):
        gitsource.clone(URL, "--upload-pack=x")


def test_the_token_reaches_git_by_the_environment_only(remote, monkeypatch):
    tmp, _ = remote
    (tmp / "state" / "secrets").mkdir(parents=True)
    (tmp / "state" / "secrets" / "git-tokens.env").write_text("# hosts\nexample.test=tok-123\n")
    seen = {}

    def fake(args, **kw):
        seen.update(args=args, env=kw["env"])
        return subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr(gitsource.subprocess, "run", fake)
    gitsource.git(["ls-remote", URL], "Example.Test")
    assert "tok-123" not in " ".join(seen["args"])
    assert seen["env"]["OX_GIT_TOKEN"] == "tok-123" and seen["env"]["OX_GIT_USER"] == "oauth2"
    assert seen["env"]["GIT_TERMINAL_PROMPT"] == "0"
    gitsource.git(["ls-remote", URL], "github.com")                       # no token for this host: no askpass
    assert "OX_GIT_TOKEN" not in seen["env"]


def test_a_refused_sign_in_says_where_the_token_goes(remote):
    tmp, _ = remote
    failed = subprocess.CompletedProcess([], 128, "", "fatal: could not read Username for 'https://example.test': terminal prompts disabled")
    assert "example.test=<token>" in gitsource._why(failed, "example.test")
