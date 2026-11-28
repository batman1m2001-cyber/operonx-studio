"""A project that comes from a git remote (PROJECT_SOURCE_PLAN S2).

``clone`` puts a repository under ``<state>/workspaces/`` and the studio
opens that folder like any other: a cloned project and an opened folder are
the same thing from then on. ``source`` says where a folder comes from, read
from its ``.git`` files, for the home page.

Access is one token per host, in ``<state>/secrets/git-tokens.env`` (0600),
a line ``host=token``. The token reaches git through ``GIT_ASKPASS`` and the
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

__all__ = ["CloneError", "clone", "source", "tokens", "tracked_env_files", "workspaces"]

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
            return f"{host} refused the token in git-tokens.env"
        return f"{host} asks for a sign-in: add a line {host}=<token> to {state_dir() / 'secrets' / 'git-tokens.env'}"
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
