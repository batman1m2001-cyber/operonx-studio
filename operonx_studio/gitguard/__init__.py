"""The assistant's git and gh (docs/PROJECT_STANDARD_PLAN.md D6; the policy: :mod:`operonx_studio.gitpolicy`).

``bin/git`` and ``bin/gh`` come first on the assistant's PATH and run this module:

- ``git``: refuses ``--no-verify`` and a ``core.hooksPath`` or identity of the command's own, then runs the real
  git with the studio's hooks (``hooks/``) and the policy's identity added to its config;
- the hooks: ``pre-commit`` checks the level and the author, ``pre-push`` the level and the branches pushed to;
  every hook then runs the repo's own hook of the same name, with the same input;
- ``gh``: ``pr create`` needs the level ``pr``, ``pr merge`` and a write through ``gh api`` need ``merge``;
  deleting, archiving or renaming the repo is never the assistant's.

A refusal is one line on stderr starting ``refused by the studio:``, with what would allow it, and exit 1.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

HERE = Path(__file__).resolve().parent
LEVELS = ("off", "commit", "push", "pr", "merge")
ZERO = "0" * 40
_GLOBAL_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
                      "--config-env"}  # fmt: skip
_VERIFYING = {"commit", "push", "merge", "rebase", "cherry-pick", "am", "revert", "pull"}


def _policy() -> Optional[Dict]:
    f = os.environ.get("OPERONX_STUDIO_GIT_POLICY")
    if not f:
        return None
    try:
        return json.loads(Path(f).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"level": "off", "protected": [], "identity": None, "broken": f}


def _refuse(why: str, allow: str = "") -> int:
    sys.stderr.write(f"refused by the studio: {why}" + (f" ({allow})" if allow else "") + "\n")
    return 1


def _at_least(policy: Dict, level: str) -> bool:
    have = policy.get("level") if policy.get("level") in LEVELS else "off"
    return LEVELS.index(have) >= LEVELS.index(level)


def _real(name: str) -> Optional[str]:
    mine = (HERE / "bin").resolve()
    path = os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep) if p and Path(p).resolve() != mine)
    return shutil.which(name, path=path)


def _setting(where: str) -> str:
    return f"the owner can change it in Project mode › Settings › Git{': ' + where if where else ''}"


# ── git ─────────────────────────────────────────────────────────────────


def _subcommand(args: List[str]) -> tuple:
    """(the subcommand, its index, the -c settings the command gives itself)"""
    i, configs = 0, []
    while i < len(args):
        a = args[i]
        if a in _GLOBAL_WITH_VALUE:
            if a == "-c" and i + 1 < len(args):
                configs.append(args[i + 1])
            i += 2
            continue
        if a.startswith("-"):
            if a.startswith("--config-env="):
                configs.append(a.split("=", 1)[1])
            i += 1
            continue
        return a, i, configs
    return "", len(args), configs


def git(args: List[str]) -> int:
    real = _real("git")
    if real is None:
        return _refuse("no git on this machine")
    policy = _policy()
    if policy is None:
        os.execv(real, [real, *args])
    sub, at, configs = _subcommand(args)
    for c in configs:
        key = c.split("=", 1)[0].lower()
        if key == "core.hookspath":
            return _refuse("this command sets its own core.hooksPath", "the studio's hooks run the repo's own")
        if key in ("user.name", "user.email") and sub == "commit":
            return _refuse("this command sets its own identity",
                           "commits are made as the project's Commit as; " + _setting("Commit as"))
    if sub == "commit" and not policy.get("identity"):
        return _refuse("no Commit as for this project, so no commit (the assistant never borrows someone's name)",
                       _setting("Commit as"))
    rest = args[at + 1:]
    if sub in _VERIFYING and ("--no-verify" in rest or (sub == "commit" and "-n" in rest)):
        return _refuse(f"git {sub} --no-verify skips the checks the studio keeps", "run it without")
    env = dict(os.environ)
    extra = [("core.hooksPath", str(HERE / "hooks")), ("user.useConfigOnly", "true")]
    ident = policy.get("identity")
    if ident:
        extra += [("user.name", ident["name"]), ("user.email", ident["email"])]
    n = int(env.get("GIT_CONFIG_COUNT") or 0)
    for k, v in extra:
        env[f"GIT_CONFIG_KEY_{n}"], env[f"GIT_CONFIG_VALUE_{n}"] = k, v
        n += 1
    env["GIT_CONFIG_COUNT"] = str(n)
    os.execve(real, [real, *args], env)
    return 0  # pragma: no cover — execve does not return


# ── the hooks ───────────────────────────────────────────────────────────


def _own_hooks() -> Optional[Path]:
    """The repo's own hooks: its core.hooksPath from its files (never the studio's, which comes from the
    environment), else <git dir>/hooks."""
    real = _real("git") or "git"
    for scope in ("--local", "--global", "--system"):
        out = subprocess.run([real, "config", scope, "--get", "core.hooksPath"], capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            p = Path(os.path.expanduser(out.stdout.strip()))
            if not p.is_absolute():
                top = subprocess.run([real, "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout
                p = Path(top.strip()) / p
            return p
    common = subprocess.run([real, "rev-parse", "--git-common-dir"], capture_output=True, text=True).stdout.strip()
    return Path(common).resolve() / "hooks" if common else None


def _ident() -> str:
    real = _real("git") or "git"
    return subprocess.run([real, "var", "GIT_AUTHOR_IDENT"], capture_output=True, text=True).stdout.strip()


def hook(name: str, args: List[str]) -> int:
    data = sys.stdin.buffer.read() if name in ("pre-push", "pre-receive", "post-rewrite", "reference-transaction") \
        else b""
    policy = _policy() or {"level": "merge", "protected": [], "identity": None}
    if name == "pre-commit":
        if not _at_least(policy, "commit"):
            return _refuse("this project's assistant may not commit", _setting("The assistant may"))
        ident = policy.get("identity")
        if not ident:
            return _refuse("no Commit as for this project, so no commit (the assistant never borrows someone's "
                           "name)", _setting("Commit as"))
        want = f"{ident['name']} <{ident['email']}>"
        got = _ident()
        if not got.startswith(want):
            return _refuse(f"the author is {got.rsplit(' ', 2)[0]}, this project commits as {want}",
                           _setting("Commit as"))
    if name == "pre-push":
        if not _at_least(policy, "push"):
            return _refuse("this project's assistant may not push", _setting("The assistant may"))
        protected = set(policy.get("protected") or [])
        for line in data.decode("utf-8", "replace").splitlines():
            parts = line.split()
            if len(parts) != 4:
                continue
            branch = parts[2].removeprefix("refs/heads/")
            if branch in protected:
                verb = "delete" if parts[1] == ZERO else "push to"
                return _refuse(f"{branch} is protected in this project: the assistant does not {verb} it",
                               "push a branch and open a pull request; " + _setting("Protected branches"))
    own = _own_hooks()
    script = own / name if own else None
    if script and script.is_file() and os.access(script, os.X_OK) and script.resolve().parent != (HERE / "hooks"):
        return subprocess.run([str(script), *args], input=data).returncode
    return 0


# ── gh ──────────────────────────────────────────────────────────────────


def gh(args: List[str]) -> int:
    real = _real("gh")
    if real is None:
        return _refuse("no gh on this machine")
    policy = _policy()
    if policy is not None:
        words = [a for a in args if not a.startswith("-")]
        head = words[:2]
        if head == ["pr", "create"] and not _at_least(policy, "pr"):
            return _refuse("this project's assistant may not open pull requests", _setting("The assistant may"))
        if head == ["pr", "merge"] and not _at_least(policy, "merge"):
            return _refuse("this project's assistant may not merge pull requests", _setting("The assistant may"))
        if head[:1] == ["repo"] and len(head) > 1 and head[1] in ("delete", "archive", "rename", "edit"):
            return _refuse(f"gh repo {head[1]} is never the assistant's", "the owner does it")
        if head[:1] == ["api"]:
            method = next((args[i + 1] for i, a in enumerate(args[:-1]) if a in ("-X", "--method")), None)
            writes = (method or "").upper() not in ("", "GET") or \
                (method is None and any(a in ("-f", "-F", "--field", "--raw-field", "--input") for a in args))
            if writes and not _at_least(policy, "merge"):
                return _refuse("a write through gh api", "only at the level merge; " + _setting("The assistant may"))
    os.execv(real, [real, *args])
    return 0  # pragma: no cover


def main(argv: List[str]) -> int:
    if not argv:
        return _refuse("usage: python -m operonx_studio.gitguard git|gh|hook <name> …")
    if argv[0] == "git":
        return git(argv[1:])
    if argv[0] == "gh":
        return gh(argv[1:])
    if argv[0] == "hook" and len(argv) > 1:
        return hook(argv[1], argv[2:])
    return _refuse(f"unknown: {argv[0]}")
