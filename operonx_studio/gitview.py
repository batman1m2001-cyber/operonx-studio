"""Project mode › Git: the repo as the owner works it (docs/WORKSPACE_PLAN.md W2).

Read: what changed and is not committed (staged and not, with line diffs), the branches with how far each is
ahead or behind its upstream, the remotes, the worktrees, the history as a graph, the pull requests (``gh``).
Act: stage, unstage, discard, commit, fetch, pull, push, switch, branch, merge, rebase, abort, continue, stash,
open a pull request. Every act runs in the checkout or one of its worktrees, as the person who asked:

    commit       as the project's identity (gitpolicy: Settings › Git), so the owner's commits and the
                 assistant's are made as the same person
    push         to a protected branch (gitpolicy) only when the request says ``confirm``
    discard      only with ``confirm``; what is dropped is saved first as a patch (tracked) or a copy
                 (untracked) under ``<state>/git-backups/<pid>/<when>/``, and the answer says where
    switch       git's own refusal stands: a switch that would overwrite uncommitted work fails, it is not forced

A commit the assistant made in a turn that named a card carries the card (:meth:`ChatStore.card_turns`).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

from . import gitpolicy
from .terminals import worktrees

__all__ = ["act", "diff", "log", "prs", "register", "status"]

_prs: Dict[str, Any] = {}  # root → (when, the list)


class GitError(Exception):
    """A git command failed: its own words."""


def _run(cwd: Path, *args: str, timeout: float = 30, env: Optional[Dict[str, str]] = None,
         check: bool = True) -> str:  # fmt: skip
    try:
        out = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=timeout,
                             env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})})  # fmt: skip
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0]}: no answer in {int(timeout)}s") from exc
    if check and out.returncode != 0:
        raise GitError((out.stderr or out.stdout).strip() or f"git {args[0]} failed")
    return out.stdout


def _state(cwd: Path) -> str:
    """What the repo is in the middle of: merging, rebasing, cherry-picking, reverting, or ``""``."""
    gd = Path(_run(cwd, "rev-parse", "--absolute-git-dir").strip())
    if (gd / "rebase-merge").exists() or (gd / "rebase-apply").exists():
        return "rebasing"
    for name, word in (("MERGE_HEAD", "merging"), ("CHERRY_PICK_HEAD", "cherry-picking"), ("REVERT_HEAD", "reverting")):
        if (gd / name).exists():
            return word
    return ""


def status(cwd: Path) -> Dict[str, Any]:
    """The working tree (porcelain v2), the branches, the remotes, the stash."""
    out = _run(cwd, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")
    head: Dict[str, Any] = {"branch": "", "upstream": "", "ahead": 0, "behind": 0, "sha": ""}
    files: List[Dict[str, Any]] = []
    parts = out.split("\0")
    i = 0
    while i < len(parts):
        line = parts[i]
        i += 1
        if not line:
            continue
        if line.startswith("# "):
            k, _, val = line[2:].partition(" ")
            if k == "branch.head":
                head["branch"] = "" if val == "(detached)" else val
            elif k == "branch.oid":
                head["sha"] = "" if val == "(initial)" else val[:9]
            elif k == "branch.upstream":
                head["upstream"] = val
            elif k == "branch.ab":
                a, b = val.split()
                head["ahead"], head["behind"] = int(a), -int(b)
            continue
        kind = line[0]
        if kind == "?":
            files.append({"path": line[2:], "x": "?", "y": "?", "staged": False, "unstaged": True, "untracked": True})
        elif kind == "1":
            f = line.split(" ", 8)
            files.append({"path": f[8], "x": f[1][0], "y": f[1][1], "staged": f[1][0] != ".",
                          "unstaged": f[1][1] != "."})
        elif kind == "2":
            f = line.split(" ", 9)
            files.append({"path": f[9], "orig": parts[i], "x": f[1][0], "y": f[1][1], "staged": f[1][0] != ".",
                          "unstaged": f[1][1] != "."})
            i += 1
        elif kind == "u":
            f = line.split(" ", 10)
            files.append({"path": f[10], "x": f[1][0], "y": f[1][1], "conflict": True, "staged": False,
                          "unstaged": True})
    fmt = "%(refname)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(subject)%00" \
          "%(committerdate:unix)%00%(HEAD)"
    branches, remote = [], []
    for line in _run(cwd, "for-each-ref", f"--format={fmt}", "refs/heads", "refs/remotes").splitlines():
        ref, sha, up, track, subject, at, cur = (line.split("\0") + [""] * 7)[:7]
        if ref.endswith("/HEAD"):
            continue
        ahead = behind = 0
        for bit in track.split(","):
            bit = bit.strip()
            if bit.startswith("ahead "):
                ahead = int(bit[6:])
            elif bit.startswith("behind "):
                behind = int(bit[7:])
        row = {"sha": sha, "subject": subject[:120], "at": int(at or 0)}
        if ref.startswith("refs/heads/"):
            branches.append({**row, "name": ref[11:], "upstream": up, "ahead": ahead, "behind": behind,
                             "gone": track == "gone", "current": cur == "*"})
        else:
            remote.append({**row, "name": ref[13:]})
    branches.sort(key=lambda b: (not b["current"], -b["at"]))
    remote.sort(key=lambda b: -b["at"])
    remotes = []
    for line in _run(cwd, "remote", "-v").splitlines():
        name, url, *rest = line.split()
        if rest and rest[0] == "(fetch)":
            remotes.append({"name": name, "url": re.sub(r"//[^/@]*@", "//", url)})
    stash = len([s for s in _run(cwd, "stash", "list").splitlines() if s])
    return {**head, "state": _state(cwd), "files": files, "branches": branches, "remote_branches": remote[:60],
            "remotes": remotes, "stash": stash}


def log(cwd: Path, n: int = 120, all_refs: bool = True, cards: Optional[Dict[str, Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """The history, newest first in topological order, each commit with its parents (the page lays out the
    graph) and its refs; a commit made in a turn that named a card carries it."""
    args = ["log", f"-n{max(1, min(int(n), 1000))}", "--topo-order", "--format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s"]
    if all_refs:
        args.append("--all")
    try:
        out = _run(cwd, *args)
    except GitError:
        return []  # no commit yet
    rows = []
    for line in out.splitlines():
        sha, parents, author, at, refs, subject = (line.split("\0") + [""] * 6)[:6]
        row = {"sha": sha[:9], "parents": [p[:9] for p in parents.split()], "author": author, "at": int(at or 0),
               "refs": [r.strip() for r in refs.split(",") if r.strip()], "subject": subject}
        for k, v in (cards or {}).items():
            if sha.startswith(k):
                row["card"], row["session"] = v["card"], v["session"]
                break
        rows.append(row)
    return rows


def diff(cwd: Path, path: str = "", staged: bool = False, commit: str = "", limit: int = 400_000) -> Dict[str, Any]:
    """One file's change, staged or not; or one commit's; an untracked file reads as all added."""
    if commit:
        if not all(c in "0123456789abcdefABCDEF" for c in commit):
            raise GitError("a commit is its sha")
        text = _run(cwd, "show", "--format=%H%n%an <%ae>%n%ci%n%n%B", "--stat", "--patch", "--find-renames",
                    commit)  # fmt: skip
    elif staged:
        text = _run(cwd, "diff", "--cached", "--find-renames", "--", path)
    else:
        text = _run(cwd, "diff", "--find-renames", "--", path)
        if not text and path and (cwd / path).is_file():
            tracked = _run(cwd, "ls-files", "--error-unmatch", "--", path, check=False)
            if not tracked:
                text = _run(cwd, "diff", "--no-index", "--", "/dev/null", path, check=False)
    return {"diff": text[:limit], "cut": len(text) > limit}


def prs(root: Path, fresh: bool = False) -> Dict[str, Any]:
    """The repo's open pull requests (``gh``), kept a minute."""
    when, got = _prs.get(str(root), (0.0, None))
    if got is not None and not fresh and time.time() - when < 60:
        return got
    try:
        out = subprocess.run(["gh", "pr", "list", "--state", "open", "--limit", "50", "--json",
                              "number,title,headRefName,baseRefName,url,author,isDraft,updatedAt"],
                             cwd=root, capture_output=True, text=True, timeout=20)  # fmt: skip
        got = {"prs": json.loads(out.stdout), "error": ""} if out.returncode == 0 else \
            {"prs": [], "error": (out.stderr.strip().splitlines() or ["gh failed"])[-1]}
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        got = {"prs": [], "error": f"gh: {exc}"}
    _prs[str(root)] = (time.time(), got)
    return got


def _paths(body: Dict[str, Any]) -> List[str]:
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
        raise GitError("paths: the files, a list")
    return paths


def act(cwd: Path, body: Dict[str, Any], *, policy: Dict[str, Any], backups: Path) -> Dict[str, Any]:
    """Do one thing to the repo (see the module's docstring); returns what git said, or raises
    :class:`GitError` with its words. ``{"needs_confirm": why}`` when the request must say ``confirm``."""
    op = str(body.get("op") or "")
    confirm = bool(body.get("confirm"))
    said = ""
    if op == "stage":
        _run(cwd, "add", "--", *_paths(body))
    elif op == "unstage":
        _run(cwd, "restore", "--staged", "--", *_paths(body))
    elif op == "discard":
        paths = _paths(body)
        if not confirm:
            return {"needs_confirm": f"Throw away the changes to {len(paths)} file(s)? A copy is kept."}
        to = backups / time.strftime("%Y%m%d-%H%M%S")
        to.mkdir(parents=True, exist_ok=True)
        untracked = set(_run(cwd, "ls-files", "--others", "--exclude-standard", "-z", "--", *paths).split("\0")) - {""}
        tracked = [p for p in paths if p not in untracked]
        if tracked:
            patch = _run(cwd, "diff", "HEAD", "--binary", "--", *tracked, check=False)
            (to / "changes.patch").write_text(patch, encoding="utf-8")
            _run(cwd, "restore", "--staged", "--worktree", "--source=HEAD", "--", *tracked)
        for p in sorted(untracked):
            src = cwd / p
            dst = to / "untracked" / p
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), dst)
        said = f"kept a copy in {to}"
    elif op == "commit":
        msg = str(body.get("message") or "").strip()
        if not msg:
            raise GitError("a commit needs a message")
        ident = policy.get("identity")
        if not ident:
            raise GitError("no identity: set Commit as in Settings › Git")
        args = ["-c", f"user.name={ident['name']}", "-c", f"user.email={ident['email']}", "commit", "-m", msg]
        if body.get("all"):
            args.insert(-2, "--all")
        said = _run(cwd, *args, timeout=120)
    elif op == "fetch":
        said = _run(cwd, "fetch", "--all", "--prune", timeout=120)
    elif op == "pull":
        said = _run(cwd, "pull", "--rebase" if body.get("rebase") else "--ff-only", timeout=120)
    elif op == "push":
        branch = _run(cwd, "branch", "--show-current").strip()
        if not branch:
            raise GitError("not on a branch")
        if branch in policy.get("protected", []) and not confirm:
            return {"needs_confirm": f"{branch} is protected (Settings › Git). Push to it anyway?"}
        up = _run(cwd, "rev-parse", "--abbrev-ref", "@{upstream}", check=False).strip()
        args = ["push"] if up else ["push", "--set-upstream", "origin", branch]
        if body.get("force"):
            if not confirm:
                return {"needs_confirm": f"Force-push {branch}? Commits on the remote that are not here are lost."}
            args.insert(1, "--force-with-lease")
        said = _run(cwd, *args, timeout=120)
    elif op == "switch":
        said = _run(cwd, "switch", str(body.get("branch") or ""))
    elif op == "branch":
        name = str(body.get("name") or "").strip()
        _run(cwd, "check-ref-format", "--branch", name)
        args = ["switch", "-c", name] + ([str(body["from"])] if body.get("from") else [])
        said = _run(cwd, *args)
    elif op == "delete_branch":
        said = _run(cwd, "branch", "-d", str(body.get("branch") or ""))  # -d: an unmerged branch is refused
    elif op in ("merge", "rebase"):
        target = str(body.get("branch") or body.get("onto") or "")
        args = ["merge", "--no-edit", target] if op == "merge" else ["rebase", target]
        ident = policy.get("identity")
        env = {"GIT_COMMITTER_NAME": ident["name"], "GIT_COMMITTER_EMAIL": ident["email"],
               "GIT_AUTHOR_NAME": ident["name"], "GIT_AUTHOR_EMAIL": ident["email"]} if ident and op == "merge" else {}
        try:
            said = _run(cwd, *args, env=env, timeout=120)
        except GitError as exc:
            if not _state(cwd):
                raise
            said = f"{exc}\nconflicts: resolve them, stage the files, then Continue (or Abort)"
    elif op in ("abort", "continue"):
        state = _state(cwd)
        verb = {"rebasing": "rebase", "merging": "merge", "cherry-picking": "cherry-pick", "reverting": "revert"}.get(state)
        if not verb:
            raise GitError("nothing to " + op)
        env = {"GIT_EDITOR": "true"}
        ident = policy.get("identity")
        if ident:
            env |= {"GIT_COMMITTER_NAME": ident["name"], "GIT_COMMITTER_EMAIL": ident["email"]}
        said = _run(cwd, verb, f"--{op}", env=env, timeout=120)
    elif op == "stash":
        said = _run(cwd, "stash", "push", "--include-untracked", "-m", str(body.get("message") or "from the studio"))
    elif op == "stash_pop":
        said = _run(cwd, "stash", "pop")
    elif op == "pr":
        title = str(body.get("title") or "").strip()
        if not title:
            raise GitError("a pull request needs a title")
        args = ["gh", "pr", "create", "--title", title, "--body", str(body.get("body") or "")]
        if body.get("base"):
            args += ["--base", str(body["base"])]
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise GitError(out.stderr.strip() or "gh pr create failed")
        _prs.clear()
        said = out.stdout.strip()
    else:
        raise GitError(f"unknown op {op!r}")
    return {"ok": True, "said": said.strip()[-4000:], "status": status(cwd)}


def register(app: Any, *, watcher_of: Callable[[str], Any], state_dir: Callable[[], Path],
             turns_of: Callable[[str], List[Dict[str, Any]]]) -> None:
    """``/api/p/{pid}/repo``: read with GET (status, log, diff, prs), act with POST."""

    def where(pid: str, cwd: str) -> Any:
        w = watcher_of(pid)
        if w is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        root = Path(w.root).resolve()
        places = [str(root)] + [p for p in worktrees(root) if p != str(root)]
        at = str(Path(cwd).resolve()) if cwd else str(root)
        if at not in places:
            return JSONResponse({"error": "not the checkout or one of its worktrees"}, status_code=400)
        return root, Path(at), places

    def cards(pid: str) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for t in turns_of(pid):
            for e in t.get("evidence") or []:
                if e.get("kind") == "commit" and e.get("sha"):
                    out.setdefault(str(e["sha"]), {"card": t["card"], "session": t["session"]})
        return out

    async def guarded(fn: Callable[[], Any]) -> JSONResponse:
        try:
            return JSONResponse(await asyncio.to_thread(fn))
        except GitError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    @app.get("/api/p/{pid}/repo")
    async def repo_status(pid: str, cwd: str = "") -> JSONResponse:
        got = where(pid, cwd)
        if isinstance(got, JSONResponse):
            return got
        root, at, places = got

        def read() -> Dict[str, Any]:
            policy = gitpolicy.load(state_dir(), pid, root)
            return {**status(at), "cwd": str(at), "places": places, "identity": policy["identity"],
                    "protected": policy["protected"]}

        return await guarded(read)

    @app.get("/api/p/{pid}/repo/log")
    async def repo_log(pid: str, cwd: str = "", n: int = 120, all: bool = True) -> JSONResponse:  # noqa: A002
        got = where(pid, cwd)
        if isinstance(got, JSONResponse):
            return got
        linked = await asyncio.to_thread(cards, pid)
        return await guarded(lambda: {"commits": log(got[1], n, all, linked)})

    @app.get("/api/p/{pid}/repo/diff")
    async def repo_diff(pid: str, cwd: str = "", path: str = "", staged: bool = False, commit: str = "") -> JSONResponse:
        got = where(pid, cwd)
        if isinstance(got, JSONResponse):
            return got
        return await guarded(lambda: diff(got[1], path, staged, commit))

    @app.get("/api/p/{pid}/repo/prs")
    async def repo_prs(pid: str, fresh: bool = False) -> JSONResponse:
        got = where(pid, "")
        if isinstance(got, JSONResponse):
            return got
        return await guarded(lambda: prs(got[0], fresh))

    @app.post("/api/p/{pid}/repo")
    async def repo_act(pid: str, request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return JSONResponse({"error": "a JSON object"}, status_code=400)
        got = where(pid, str(body.get("cwd") or ""))
        if isinstance(got, JSONResponse):
            return got
        root, at, _ = got
        policy = gitpolicy.load(state_dir(), pid, root)
        return await guarded(lambda: act(at, body, policy=policy, backups=state_dir() / "git-backups" / pid))
