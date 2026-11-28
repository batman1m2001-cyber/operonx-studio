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
    assert "Git access" in gitsource._why(failed, "example.test")
    gitsource.set_token("example.test", "old")
    assert "refused its token" in gitsource._why(failed, "example.test")


def test_a_token_is_set_replaced_and_removed_in_a_private_file(remote):
    tmp, _ = remote
    gitsource.set_token("GitHub.com", "t-one")
    gitsource.set_token("gitlab.example.test:8443", "t-two")
    gitsource.set_token("github.com", "t-three")                 # replaced, the other host kept
    assert gitsource.tokens() == {"github.com": "t-three", "gitlab.example.test:8443": "t-two"}
    path = tmp / "state" / "secrets" / "git-tokens.env"
    assert path.stat().st_mode & 0o777 == 0o600
    gitsource.set_token("github.com", "")                        # removed
    assert gitsource.tokens() == {"gitlab.example.test:8443": "t-two"}
    for host, token in (("not a host", "t"), ("", "t"), ("github.com", "two words"), ("github.com", "a\nb=c")):
        with pytest.raises(gitsource.CloneError):
            gitsource.set_token(host, token)
    assert gitsource.tokens() == {"gitlab.example.test:8443": "t-two"}


def test_a_token_is_tested_against_a_repository_of_its_host(remote):
    tmp, point = remote
    point(URL, _repo(tmp / "remote.git"))
    assert gitsource.test_token("example.test", "example.test/org/demo") is None
    assert gitsource.test_token("example.test", "example.test/org/missing")       # says why, in words


# ── S3: pull and push ─────────────────────────────────────────────────

def _git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


@pytest.fixture
def cloned(remote):
    tmp, point = remote
    bare = _repo(tmp / "bare.git")
    point(URL, bare)
    return gitsource.clone(URL), bare, tmp


def _upstream(tmp, bare, name, text):
    """Someone else commits to the remote's main."""
    other = tmp / "other"
    if not other.exists():
        subprocess.run(["git", "clone", "-q", str(bare), str(other)], check=True, capture_output=True)
    _git(other, "pull", "-q")
    (other / name).write_text(text)
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", f"upstream {name}")
    _git(other, "push", "-q")


def test_push_sends_the_edits_to_the_studio_branch_and_leaves_the_folder_alone(cloned):
    root, bare, _ = cloned
    assert gitsource.status(root, "demo") == {"remote": "example.test/org/demo", "branch": "main", "edits": 0,
                                               "files": [], "pushed": False, "push_branch": "studio/demo", "link": None}
    with pytest.raises(gitsource.GitRefused, match="nothing was edited"):
        gitsource.push(root, "demo", "ann")
    (root / "prompts").mkdir()
    (root / "prompts" / "a.md").write_text("hello\n")
    (root / "operonx.toml").write_text("[project]\nname = 'demo'\n# edited\n")
    (root / ".env").write_text("SECRET=1\n")                               # never sent
    (root / ".operonx" / "runs").mkdir(parents=True)
    (root / ".operonx" / "runs" / ".index.sqlite").write_text("runs")      # the studio's own files: never sent
    head = _git(root, "rev-parse", "HEAD")
    done = gitsource.push(root, "demo", "ann")
    assert done == {"branch": "studio/demo", "files": 2, "link": None}     # example.test: no known merge page
    assert _git(bare, "show", "--name-only", "--format=%an|%s", "studio/demo").splitlines() == [
        "ann|studio: edits to operonx.toml, prompts/a.md", "", "operonx.toml", "prompts/a.md"]
    assert _git(bare, "rev-parse", "studio/demo~1") == head                # one commit on top of the folder's
    assert _git(bare, "rev-parse", "main") == head                         # the default branch is not touched
    assert _git(root, "rev-parse", "HEAD") == head and _git(root, "status", "--porcelain") != ""   # still edits here
    st = gitsource.status(root, "demo")
    assert st["edits"] == 2 and st["pushed"] is True
    (root / "prompts" / "a.md").write_text("hello again\n")
    assert gitsource.status(root, "demo")["pushed"] is False               # a new edit is not the pushed one


def test_pull_keeps_edits_drops_the_ones_the_remote_now_holds_and_refuses_a_clash(cloned):
    root, bare, tmp = cloned
    (root / "notes.md").write_text("mine\n")                               # an edit the remote never touches
    _upstream(tmp, bare, "src.py", "x = 1\n")
    assert gitsource.pull(root) == {"updated": True, "commits": 1}
    assert (root / "src.py").read_text() == "x = 1\n" and (root / "notes.md").read_text() == "mine\n"
    assert gitsource.pull(root) == {"updated": False, "commits": 0}
    # the pushed edit was merged upstream as it is: after the pull it is no longer an edit
    _upstream(tmp, bare, "notes.md", "mine\n")
    gitsource.pull(root)
    assert gitsource.status(root, "demo")["edits"] == 0
    # the remote and the folder changed the same file differently: nothing is pulled, nothing is lost
    (root / "src.py").write_text("x = 2  # here\n")
    _upstream(tmp, bare, "src.py", "x = 3  # there\n")
    with pytest.raises(gitsource.GitRefused, match="src.py"):
        gitsource.pull(root)
    assert (root / "src.py").read_text() == "x = 2  # here\n"


def test_the_merge_page_is_known_for_github_and_gitlab():
    assert gitsource._merge_link("github.com/o/r", "main", "studio/r") == "https://github.com/o/r/compare/main...studio/r?expand=1"
    assert "gitlab.tguru.vn/g/r/-/merge_requests/new?" in gitsource._merge_link("gitlab.tguru.vn/g/r", "main", "studio/r")
    assert gitsource._merge_link("example.test/o/r", "main", "studio/r") is None
    assert gitsource.push_branch("Mr Finance!") == "studio/Mr-Finance"


def test_a_plain_folder_has_no_git(tmp_path):
    assert gitsource.status(tmp_path, "x") == {"remote": None}
    with pytest.raises(gitsource.GitRefused):
        gitsource.pull(tmp_path)
