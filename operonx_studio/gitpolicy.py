"""What the assistant may do with git, per project (docs/PROJECT_STANDARD_PLAN.md D6).

The studio's rule for its own assistant, so it lives in the studio's state (``<state>/git/<pid>.json``), not in
the project:

    identity    who commits: a name and an email, also written to the repo's own git config
    level       off · commit · push (branches) · pr (open pull requests) · merge (merge them)
    protected   branches the assistant never pushes to (default: the remote's default branch, production)

It is enforced in git, for the assistant's processes only: :func:`assistant_env` puts the guard
(:mod:`operonx_studio.gitguard`) first on the assistant's PATH, as ``git`` and ``gh``. The guard adds the
studio's hooks to every git command (``core.hooksPath``), which check the level, the author and the refs pushed,
then run the repo's own hooks; it refuses ``--no-verify`` and another ``core.hooksPath``. A process that calls
git by its absolute path is not guarded: the guard is the assistant's PATH, not the machine's.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict

__all__ = ["LEVELS", "assistant_env", "describe", "load", "routes", "save", "summary"]

LEVELS = ("off", "commit", "push", "pr", "merge")
WORDS = {"off": "nothing with git", "commit": "commit", "push": "commit and push branches",
         "pr": "commit, push branches, open pull requests", "merge": "commit, push branches, open and merge pull requests"}
GUARD = Path(__file__).resolve().parent / "gitguard"
_EMAIL = re.compile(r"^[^@\s<>]+@[^@\s<>]+$")
_who: Dict[str, Any] = {}  # host → (when, the account gh pushes as)


def _git(root: Path, *args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def _file(state: Path, pid: str) -> Path:
    return Path(state) / "git" / f"{pid}.json"


def _default_branch(root: Path) -> str:
    head = _git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    if head:
        return head.removeprefix("refs/remotes/origin/")   # a branch may have slashes: refactor/x
    for name in ("main", "master"):
        if _git(root, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{name}") or \
                _git(root, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}"):
            return name
    return "main"


def load(state: Path, pid: str, root: Path) -> Dict[str, Any]:
    """The project's policy: what was saved, else the defaults (commit; the default branch and production
    protected; the identity git would use, if it has one)."""
    try:
        saved = json.loads(_file(state, pid).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    name, email = _git(root, "config", "user.name"), _git(root, "config", "user.email")
    ident = saved.get("identity") or ({"name": name, "email": email} if name and email else None)
    level = saved.get("level") if saved.get("level") in LEVELS else "commit"
    protected = saved.get("protected")
    if not isinstance(protected, list):
        protected = [_default_branch(root), "production"]
    return {"identity": ident, "level": level, "protected": [str(b) for b in protected if str(b).strip()],
            "saved": bool(saved)}


def save(state: Path, pid: str, root: Path, body: Dict[str, Any]) -> Dict[str, Any]:
    """Change the policy; an identity is also written to the repo's own git config, so the owner's commits
    and the assistant's are made as the same person. Raises ``ValueError`` with what is wrong."""
    cur = load(state, pid, root)
    if "level" in body:
        if body["level"] not in LEVELS:
            raise ValueError(f"level is one of {', '.join(LEVELS)}")
        cur["level"] = body["level"]
    if "protected" in body:
        raw = body["protected"]
        items = raw.split(",") if isinstance(raw, str) else raw if isinstance(raw, list) else None
        if items is None:
            raise ValueError("protected is a list of branch names")
        cur["protected"] = [b.strip() for b in map(str, items) if b.strip()]
    if "identity" in body:
        ident = body["identity"] or {}
        name, email = str(ident.get("name") or "").strip(), str(ident.get("email") or "").strip()
        if not name or not _EMAIL.match(email):
            raise ValueError("commit as: a name and an email")
        for key, value in (("user.name", name), ("user.email", email)):
            out = subprocess.run(["git", "-C", str(root), "config", "--local", key, value], capture_output=True,
                                 text=True, timeout=10)  # fmt: skip
            if out.returncode != 0:
                raise ValueError(f"git config {key}: {out.stderr.strip() or 'failed'}")
        cur["identity"] = {"name": name, "email": email}
    f = _file(state, pid)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({k: cur[k] for k in ("identity", "level", "protected")}, indent=1), encoding="utf-8")
    return load(state, pid, root)


def _account(host: str) -> str:
    """Who the machine pushes as on *host*: gh's login for github.com, else the machine's git credentials."""
    if host != "github.com":
        return "the machine's git credentials"
    when, who = _who.get(host, (0.0, ""))
    if time.time() - when > 600:
        try:
            out = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True, timeout=15)
            who = out.stdout.strip() if out.returncode == 0 else ""
        except (OSError, subprocess.TimeoutExpired):
            who = ""
        _who[host] = (time.time(), who)
    return who or "no gh login on this machine"


def describe(root: Path) -> Dict[str, Any]:
    """The repo's remote as the owner reads it: its address (no credentials), its host, who pushes."""
    url = _git(root, "remote", "get-url", "origin")
    if not url:
        return {"remote": "", "host": "", "push_as": "", "branch": _git(root, "branch", "--show-current")}
    url = re.sub(r"//[^/@]*@", "//", url)
    m = re.match(r"^(?:\w+://)?(?:[^@/]+@)?([^/:]+)[:/]", url)
    host = m.group(1) if m else ""
    return {"remote": url, "host": host, "push_as": _account(host), "branch": _git(root, "branch", "--show-current")}


def summary(policy: Dict[str, Any]) -> str:
    """One line for the assistant: what it may do and as whom."""
    ident = policy.get("identity")
    who = f"commits as {ident['name']} <{ident['email']}>" if ident else "no identity: commits are refused until " \
        "the owner sets Commit as (Settings › Git)"
    prot = ", ".join(policy["protected"]) or "none"
    return f"Git: the assistant may {WORDS[policy['level']]}; protected (never pushed to): {prot}; {who}"


def assistant_env(state: Path, pid: str, root: Path, env: Dict[str, str]) -> Dict[str, str]:
    """*env* with the guard in front: the policy written where the guard reads it, ``git`` and ``gh`` on the
    PATH first."""
    policy = load(state, pid, root)
    f = _file(state, pid).with_suffix(".effective.json")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({**policy, "root": str(root)}), encoding="utf-8")
    out = dict(env)
    out["OPERONX_STUDIO_GIT_POLICY"] = str(f)
    out["OPERONX_STUDIO_PY"] = sys.executable
    out["PATH"] = os.pathsep.join([str(GUARD / "bin"), *[p for p in env.get("PATH", "").split(os.pathsep)
                                                            if p and Path(p).resolve() != (GUARD / "bin")]])
    return out


def routes(policy: Dict[str, Any], root: Path) -> Dict[str, Any]:
    """What the Settings page reads: the policy, the remote, the levels."""
    return {**policy, **describe(root), "levels": list(LEVELS), "words": WORDS, "line": summary(policy)}
