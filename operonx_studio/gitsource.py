"""A project that comes from a git remote (PROJECT_SOURCE_PLAN S2, S3).

``clone`` puts a repository under ``<state>/workspaces/`` and the studio
opens that folder like any other: a cloned project and an opened folder are
the same thing from then on. ``source`` says where a folder comes from, read
from its ``.git`` files, for the home page.

``pull`` and ``push`` are all the git the studio does (S3): bring the
folder up to date, and send what was edited in the studio to one branch,
``studio/<project>``, for the team to merge with its own tools. ``push``
never commits on the folder's branch and never touches the default one: the
edits stay in the folder as edits until they come back by a pull.

Access is one token per host, in ``<state>/secrets/git-tokens.env`` (0600),
a line ``host=token``, set by an admin in Settings (``set_token``). The token reaches git through ``GIT_ASKPASS`` and the
environment only: it is never in a command line, a URL or ``.git/config``.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse

from .registry import MANIFEST, state_dir

__all__ = ["CloneError", "GitRefused", "clone", "pull", "push", "set_token", "source", "status", "test_token", "tokens", "tracked_env_files", "workspaces"]

_ASKPASS = '#!/bin/sh\ncase "$1" in Username*) printf "%s\\n" "$OX_GIT_USER";; *) printf "%s\\n" "$OX_GIT_TOKEN";; esac\n'
_URL = re.compile(r"https://[A-Za-z0-9.-]+(:\d+)?/[A-Za-z0-9._~/-]+")
_BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,200}")


class CloneError(ValueError):
    """Why a repository was not added, in words for the person who asked."""


def workspaces() -> Path:
    return state_dir() / "workspaces"


def tokens() -> Dict[str, str]:
    """``host -> token`` from the tokens file; empty when there is none."""
    out: Dict[str, str] = {}
    try:
        text = (state_dir() / "secrets" / "git-tokens.env").read_text(encoding="utf-8")
    except OSError:
        return out
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            host, token = line.split("=", 1)
            if host.strip() and token.strip():
                out[host.strip().lower()] = token.strip()
    return out


_HOST = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?")


def set_token(host: str, token: str) -> None:
    """Write (or, with an empty *token*, remove) the token of *host*. The
    other hosts' lines are kept; the file is 0600 from its first byte."""
    host, token = host.strip().lower(), token.strip()
    if not _HOST.fullmatch(host):
        raise CloneError("a host name like github.com")
    if len(token) > 400 or re.search(r"\s", token):
        raise CloneError("a token is one word, without spaces")
    kept = tokens()
    kept.pop(host, None)
    if token:
        kept[host] = token
    path = state_dir() / "secrets" / "git-tokens.env"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("".join(f"{h}={t}\n" for h, t in sorted(kept.items())))
    os.replace(tmp, path)


def test_token(host: str, remote: str) -> Optional[str]:
    """Ask *host* for the branches of *remote* (``host/org/repo``) with the
    token it has: ``None`` when it answers, else why not, in words."""
    try:
        result = git(["ls-remote", "--heads", "--", f"https://{remote}.git"], host, timeout=30)
    except subprocess.TimeoutExpired:
        return f"{host} did not answer in 30 seconds"
    return None if result.returncode == 0 else _why(result, host)


def _askpass() -> Path:
    path = state_dir() / "secrets" / "git-askpass.sh"
    if not path.is_file() or path.read_text(encoding="utf-8") != _ASKPASS:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(_ASKPASS)
    return path


def git(args: List[str], host: str, cwd: Optional[Path] = None, timeout: int = 300) -> subprocess.CompletedProcess:
    """Run git against *host*, never asking a person for anything."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    token = tokens().get(host.lower())
    if token:
        env.update(GIT_ASKPASS=str(_askpass()), OX_GIT_TOKEN=token,
                   OX_GIT_USER="x-access-token" if host.lower() == "github.com" else "oauth2")
    return subprocess.run(["git", "-c", "credential.helper=", *args], cwd=cwd, env=env, timeout=timeout,
                          capture_output=True, text=True, stdin=subprocess.DEVNULL)


def _why(result: subprocess.CompletedProcess, host: str) -> str:
    err = (result.stderr or "").strip()
    low = err.lower()
    if "could not read username" in low or "authentication failed" in low or "terminal prompts disabled" in low:
        if host.lower() in tokens():
            return f"{host} refused its token (wrong or expired): an admin sets a new one in Settings › Project › Git access"
        return f"{host} asks for a sign-in: an admin sets its token in Settings › Project › Git access"
    if "not found" in low:
        return "the repository or branch was not found (a private one also answers this without a token)"
    return " ".join(err.split())[:300] if err else "git failed"


def clone(url: str, branch: str = "") -> Path:
    """Clone *url* into the workspaces and return the project's folder. A
    repository already cloned is returned as it is."""
    url = url.strip().rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    if not _URL.fullmatch(url):
        raise CloneError("an https address like https://github.com/org/repo")
    if branch and not _BRANCH.fullmatch(branch):
        raise CloneError("a branch name like main")
    parsed = urlparse(url)
    host = parsed.hostname or ""
    name = re.sub(r"[^A-Za-z0-9_-]", "-", parsed.path.rsplit("/", 1)[-1]) or "project"
    dest = workspaces() / f"{name}-{hashlib.sha1(url.lower().encode()).hexdigest()[:8]}"
    if (dest / MANIFEST).is_file():
        return dest
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = ["clone", "--quiet"] + (["--branch", branch] if branch else []) + ["--", url + ".git", str(dest)]
    try:
        result = git(args, host)
    except subprocess.TimeoutExpired:
        shutil.rmtree(dest, ignore_errors=True)
        raise CloneError("the clone took more than five minutes and was stopped") from None
    if result.returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        raise CloneError(_why(result, host))
    if not (dest / MANIFEST).is_file():
        shutil.rmtree(dest, ignore_errors=True)
        raise CloneError(f"no {MANIFEST} at the top of that repository: it is not an operonx project")
    return dest


def source(root: Path) -> Optional[Dict[str, str]]:
    """``{"remote": "host/org/repo", "branch": "main"}`` for a folder with a
    git remote, read from its files; ``None`` for a plain folder."""
    gitdir = Path(root) / ".git"
    try:
        config = (gitdir / "config").read_text(encoding="utf-8", errors="replace")
        head = (gitdir / "HEAD").read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    found = re.search(r'\[remote "origin"\][^\[]*?^\s*url\s*=\s*(\S+)', config, re.S | re.M)
    if not found:
        return None
    remote = re.sub(r"^[a-z+]+://([^@/]*@)?", "", found.group(1))   # no scheme, no credentials
    remote = re.sub(r"^[^@/]+@([^:]+):", r"\1/", remote)             # git@host:org/repo
    remote = re.sub(r"\.git$", "", remote)
    branch = head[len("ref: refs/heads/"):] if head.startswith("ref: refs/heads/") else head[:7]
    return {"remote": remote, "branch": branch}


def tracked_env_files(root: Path) -> List[str]:
    """``.env*`` files the repository tracks, other than ``.env.example``:
    secrets that were committed."""
    try:
        out = subprocess.run(["git", "ls-files", "--", ".env*"], cwd=root, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return sorted(n for n in out.stdout.split("\n") if n and n not in (".env.example", ".env.sample", ".env.template"))


# ── S3: pull and push ─────────────────────────────────────────────────

class GitRefused(ValueError):
    """Why a pull or a push did not happen, in words for the person who asked."""


def _host(root: Path) -> str:
    src = source(root)
    return src["remote"].split("/", 1)[0] if src else ""


def _local(root: Path, *args: str, env: Optional[Dict[str, str]] = None) -> str:
    """A git command that talks to no remote; its output, or GitRefused."""
    out = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=60,
                         env={**os.environ, **(env or {})}, stdin=subprocess.DEVNULL)
    if out.returncode != 0:
        raise GitRefused(" ".join((out.stderr or out.stdout).split())[:300] or "git failed")
    return out.stdout.rstrip()   # not the front: a status line starts with a space


def _edited(root: Path) -> List[str]:
    """Files that differ from the last commit, new ones included. Never
    ``.env`` (secrets) nor ``.operonx/`` (runs and caches the studio and
    operonx write there), whatever the project's ``.gitignore`` says."""
    lines = _local(root, "status", "--porcelain", "--untracked-files=all").splitlines()
    names = [line[3:].split(" -> ")[-1].strip('"') for line in lines if len(line) > 3]
    return sorted(n for n in names if n != ".env" and not n.startswith(".operonx/"))


def _tree(root: Path) -> str:
    """The tree of the folder as it is now, written through a scratch index:
    the real index and the branch are left alone."""
    index = Path(_local(root, "rev-parse", "--absolute-git-dir")) / "ox-index"
    env = {"GIT_INDEX_FILE": str(index)}
    try:
        _local(root, "read-tree", "HEAD", env=env)
        _local(root, "add", "-A", "--", ".", ":(exclude).env", ":(exclude).operonx", env=env)
        return _local(root, "write-tree", env=env)
    finally:
        index.unlink(missing_ok=True)


def _pushed_file(root: Path) -> Path:
    return Path(_local(root, "rev-parse", "--absolute-git-dir")) / "ox-pushed"


def _merge_link(remote: str, base: str, branch: str) -> Optional[str]:
    host = remote.split("/", 1)[0]
    if host == "github.com":
        return f"https://{remote}/compare/{base}...{branch}?expand=1"
    if "gitlab" in host:
        return (f"https://{remote}/-/merge_requests/new?merge_request%5Bsource_branch%5D={branch}"
                f"&merge_request%5Btarget_branch%5D={base}")
    return None


def push_branch(name: str) -> str:
    return "studio/" + (re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.") or "project")


def status(root: Path, name: str) -> Dict:
    """What the two buttons show: the remote and branch, how many files the
    studio's edits touch, and whether exactly those edits were pushed."""
    src = source(root)
    if src is None:
        return {"remote": None}
    try:
        files = _edited(root)
        pushed = bool(files) and _pushed_file(root).is_file() and _pushed_file(root).read_text().strip() == _tree(root)
    except (GitRefused, OSError, subprocess.TimeoutExpired) as exc:
        return {**src, "error": str(exc), "edits": 0, "files": [], "pushed": False}
    branch = push_branch(name)
    return {**src, "edits": len(files), "files": files[:20], "pushed": pushed, "push_branch": branch,
            "link": _merge_link(src["remote"], src["branch"], branch) if pushed else None}


def pull(root: Path) -> Dict:
    """Bring the folder's branch up to date. Edits to files the remote did
    not change stay; an edit the remote now holds as it is (it was pushed
    and merged) is no longer an edit; any other clash refuses the pull."""
    src = source(root)
    if src is None:
        raise GitRefused("this project has no git remote")
    host, branch = _host(root), src["branch"]
    got = git(["fetch", "--quiet", "origin", branch], host, cwd=root)
    if got.returncode != 0:
        raise GitRefused(_why(got, host))
    before = _local(root, "rev-parse", "HEAD")
    theirs = _local(root, "rev-parse", "FETCH_HEAD")
    changed = set(_local(root, "diff", "--name-only", "HEAD", theirs).splitlines())
    clash, same = [], []
    for name in _edited(root):
        if name not in changed:
            continue
        path = Path(root) / name
        mine = _local(root, "hash-object", "--", name) if path.is_file() else ""
        try:
            upstream = _local(root, "rev-parse", f"{theirs}:{name}")
        except GitRefused:
            upstream = ""
        (same if mine == upstream else clash).append(name)
    if clash:
        raise GitRefused("the remote changed files that also have edits here: " + ", ".join(clash[:8])
                         + ". Push the edits and merge them first.")
    for name in same:      # the remote holds this edit already: let the pull write the file
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", "--", name], cwd=root, capture_output=True).returncode == 0
        if tracked:
            _local(root, "checkout", "HEAD", "--", name)
        else:
            (Path(root) / name).unlink(missing_ok=True)
    _local(root, "merge", "--ff-only", "--quiet", theirs)
    return {"updated": before != theirs, "commits": int(_local(root, "rev-list", "--count", f"{before}..{theirs}") or 0)}


def push(root: Path, name: str, who: str) -> Dict:
    """Send the folder's edits, as one commit on top of the folder's commit,
    to ``studio/<project>`` on the remote. That branch is the studio's: each
    push replaces it with the edits as they are now."""
    src = source(root)
    if src is None:
        raise GitRefused("this project has no git remote")
    files = _edited(root)
    if not files:
        raise GitRefused("nothing was edited")
    host, branch = _host(root), push_branch(name)
    tree = _tree(root)
    person = re.sub(r"[^\w .@-]", "", who or "") or "studio"
    ident = {"GIT_AUTHOR_NAME": person, "GIT_AUTHOR_EMAIL": f"{person.replace(' ', '.')}@studio.invalid",
             "GIT_COMMITTER_NAME": "operonx studio", "GIT_COMMITTER_EMAIL": "studio@studio.invalid"}
    shown = ", ".join(files[:5]) + (f" and {len(files) - 5} more" if len(files) > 5 else "")
    commit = _local(root, "commit-tree", tree, "-p", "HEAD", "-m", f"studio: edits to {shown}", env=ident)
    sent = git(["push", "--quiet", "--force", "origin", f"{commit}:refs/heads/{branch}"], host, cwd=root)
    if sent.returncode != 0:
        raise GitRefused(_why(sent, host))
    _pushed_file(root).write_text(tree + "\n")
    return {"branch": branch, "files": len(files), "link": _merge_link(src["remote"], src["branch"], branch)}
