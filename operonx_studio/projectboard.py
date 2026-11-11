"""The Board tab: an operonx-project milestone, read from the project's own store.

A project driven by operonx-project keeps its state in
``<project>/.operonx/project/project.db`` (outside git). The studio reads
it **read-only** (a ``mode=ro`` SQLite connection) and knows only its
documented, versioned schema (``meta.schema_version``, at most
:data:`SCHEMA`): the tables ``milestones``, ``cards``, ``events``,
``interactions`` and the ``steps`` records ``ms:<milestone>:<key>``. A
requirement's status is read from the BRD on the milestone's branch
(``milestone/<id>/main``) with ``git show``, so the studio needs no
worktree.

A project with a BRD folder (``docs/brd/``, made by ``operonx init``) has a
board before its first milestone: :func:`project_checklist` reads the
matrix from the checkout, the project's status as committed work states it.

The studio never changes that store: its one write, a plan doc mirrored
onto the board, goes through the engine's ``operonx-project api``
(:func:`act`).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# at module level: the routes' annotations are strings (__future__), which
# FastAPI resolves here — a Request imported inside register() is a query field
from fastapi import Request
from fastapi.responses import JSONResponse

__all__ = ["SCHEMA", "BoardError", "act", "available", "brd_questions", "card", "milestone", "milestones",
           "overview", "plan_request", "project_checklist", "stale_plans"]

#: The newest store layout this reader knows.
SCHEMA = 2
STATE_DIR = Path(".operonx") / "project"
BRD_DIR = "docs/brd"
MATRIX = "requirements/requirements_traceability.md"
QUESTIONS = "requirements/open_questions.md"
#: Board columns, left to right (the engine's ``board.COLUMNS``).
COLUMNS = [("backlog", "Backlog"), ("ready", "Ready"), ("in_progress", "In progress"), ("review", "Review"),
           ("qa", "QA"), ("done", "Done"), ("blocked", "Stopped")]  # fmt: skip
_WORKING = {"discovering", "requirements", "planning", "running", "verifying"}
_STAGE_COLUMN = {"review": "review", "qa": "qa"}


class BoardError(RuntimeError):
    """The store is missing, newer than this studio, or unreadable."""


def _db(root: Path) -> Path:
    return Path(root) / STATE_DIR / "project.db"


def _has_store(root: Path) -> bool:
    return _db(root).is_file()


def _has_brd(root: Path) -> bool:
    return (Path(root) / BRD_DIR / MATRIX).is_file()


def available(root: Path) -> bool:
    """A board: the engine's store, or a BRD folder (a project before its first milestone)."""
    return _has_store(root) or _has_brd(root)


def _connect(root: Path) -> sqlite3.Connection:
    path = _db(root)
    if not path.is_file():
        raise BoardError("this project is not driven by operonx-project (no .operonx/project/project.db)")
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    version = int(row[0]) if row else 1
    if version > SCHEMA:
        db.close()
        raise BoardError(f"the project's store is version {version}; this studio reads up to {SCHEMA}: update it")
    return db


def _json(text: Optional[str], default: Any) -> Any:
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default


def _record(db: sqlite3.Connection, mid: str, key: str) -> Dict[str, Any]:
    row = db.execute("SELECT data FROM steps WHERE key=?", (f"ms:{mid}:{key}",)).fetchone()
    return _json(row[0], {}) if row else {}


def _running_s(db: sqlite3.Connection, mid: str) -> float:
    """Seconds spent in a working stage (the engine's ``Store.running_seconds``)."""
    total, since = 0.0, None
    for at, data in db.execute("SELECT at, data FROM events WHERE milestone=? AND kind='milestone.state' "
                               "ORDER BY seq", (mid,)):  # fmt: skip
        to = _json(data, {}).get("to")
        if to in _WORKING and since is None:
            since = at
        elif to not in _WORKING and since is not None:
            total, since = total + (at - since), None
    return total + (time.time() - since if since is not None else 0.0)


def _column(c: Dict[str, Any]) -> str:
    s = c["state"]
    if s == "pending":
        return "backlog"
    if s == "ready":
        return "ready"
    if s == "running":
        return _STAGE_COLUMN.get(c.get("stage") or "", "in_progress")
    if s == "verified":
        return "qa"
    if s == "waiting_human":
        return "in_progress"  # parked, with its question in "Waiting on you"
    if s == "done":
        return "done"
    return "blocked"


def _card(row: sqlite3.Row) -> Dict[str, Any]:
    detail = _json(row["detail"], {})
    q = detail.get("question") or {}
    runs = detail.get("runs")
    return {
        "id": row["id"], "title": row["title"], "intent": row["intent"], "state": row["state"],
        "stage": row["stage"], "kind": row["kind"], "risk": row["risk"], "priority": row["priority"],
        "epic": row["epic"], "rows": _json(row["rows"], []), "deps": _json(row["deps"], []),
        "paths": _json(row["paths"], []), "criteria": _json(row["criteria"], []), "reason": row["reason"] or "",
        "reopens": row["reopens"], "run_id": row["run_id"], "cost_usd": round(row["cost_usd"] or 0.0, 4),
        "round": q.get("round") or (runs if isinstance(runs, int) else None),
        "asks": bool(q) and row["state"] == "waiting_human",
        "acceptance": sorted((detail.get("acceptance") or {}).get("files") or {}),
        "checks": [{"name": r.get("name"), "ok": r.get("ok")} for r in detail.get("baseline") or []
                   if isinstance(r, dict)],
        "updated": row["updated"],
    }  # fmt: skip


def _ms(db: sqlite3.Connection, row: sqlite3.Row) -> Dict[str, Any]:
    policy = _json(row["policy"], {})
    budget = policy.get("budget") or {}
    counts = dict(db.execute("SELECT state, COUNT(*) FROM cards WHERE milestone=? GROUP BY state", (row["id"],))
                  .fetchall())  # fmt: skip
    return {
        "id": row["id"], "title": row["title"], "goal": row["goal"], "state": row["state"],
        "reason": row["reason"] or "", "mode": "w1" if policy.get("horizon") == "all" else "w2",
        "cost_usd": round(row["cost_usd"] or 0.0, 4), "budget_usd": budget.get("max_usd"),
        "running_s": round(_running_s(db, row["id"]), 1), "max_hours": budget.get("max_hours"),
        "replans": row["replans"], "resume_at": row["resume_at"],
        "max_parallel": policy.get("max_parallel"), "wip": policy.get("wip") or {},
        "cards": sum(counts.values()), "done": counts.get("done", 0),
        "updated": row["updated"],
    }  # fmt: skip


def milestones(root: Path) -> Dict[str, Any]:
    base = {"schema": SCHEMA, "brd": _has_brd(root), "installed": _engine() is not None}
    if not _has_store(root):
        return {**base, "milestones": [], "engine": False}
    db = _connect(root)
    try:
        rows = db.execute("SELECT * FROM milestones ORDER BY created").fetchall()
        return {**base, "milestones": [_ms(db, r) for r in rows], "engine": True}
    finally:
        db.close()


def overview(root: Path) -> Dict[str, Any]:
    """One project's board at a glance, for the studio's home and the title count
    (plan D18): its milestones, and the BRD's open questions (``source: brd``, WORKSPACE_PLAN W1.5)."""
    ms: List[Dict[str, Any]] = []
    if _has_store(root):
        db = _connect(root)
        try:
            ms = [{k: m[k] for k in ("id", "title", "state", "done", "cards")}
                  for m in (_ms(db, r) for r in db.execute("SELECT * FROM milestones ORDER BY created"))]  # fmt: skip
        finally:
            db.close()
    return {"milestones": ms, "waiting": brd_questions(root)}


def brd_questions(root: Path) -> List[Dict[str, Any]]:
    """The BRD's open questions (``requirements/open_questions.md``, state ``open``) in the checkout."""
    qfile = Path(root) / BRD_DIR / QUESTIONS
    if not qfile.is_file():
        return []
    return [{"id": f"brd:{q['id']}", "qid": q["id"], "milestone": "", "kind": q["type"] or "question", "card": "",
             "problem": q["topic"][:300], "created": "", "source": "brd"}
            for q in _parse("", qfile.read_text(encoding="utf-8"), {})["questions"]
            if q["state"].strip().lower() == "open"]  # fmt: skip


def milestone(root: Path, mid: str, events: int = 40) -> Dict[str, Any]:
    db = _connect(root)
    try:
        row = db.execute("SELECT * FROM milestones WHERE id=?", (mid,)).fetchone()
        if row is None:
            raise KeyError(mid)
        cards = [_card(r) for r in db.execute("SELECT * FROM cards WHERE milestone=? ORDER BY priority, created, id",
                                              (mid,))]  # fmt: skip
        cols = [{"key": k, "title": t, "cards": [c["id"] for c in cards if _column(c) == k]} for k, t in COLUMNS]
        ms = _ms(db, row)
        limits = {"in_progress": ms["max_parallel"], **{k: v for k, v in ms["wip"].items()}}
        for col in cols:
            col["limit"] = limits.get(col["key"])
        # the live line: what each running card's session does now (the engine's throttled activity events)
        live = {r["card"]: {"text": _json(r["data"], {}).get("text", ""), "at": r["at"]} for r in db.execute(
            "SELECT card, data, at FROM events WHERE seq IN (SELECT MAX(seq) FROM events WHERE milestone=? "
            "AND kind='activity' GROUP BY card)", (mid,))}  # fmt: skip
        for c in cards:
            if c["state"] == "running" and c["id"] in live:
                c["activity"] = live[c["id"]]
        plan = _record(db, mid, "plan")
        evs = [{"seq": r["seq"], "at": r["at"], "kind": r["kind"], "card": r["card"], "actor": r["actor"],
                "data": _json(r["data"], {})}
               for r in db.execute("SELECT * FROM events WHERE milestone=? ORDER BY seq DESC LIMIT ?", (mid, events))]
        return {
            "milestone": ms, "cards": cards, "columns": cols,
            "events": evs[::-1], "cursor": evs[0]["seq"] if evs else 0, "doc": plan.get("path") or "",
        }  # fmt: skip
    finally:
        db.close()


def card(root: Path, mid: str, cid: str, events: int = 60) -> Dict[str, Any]:
    db = _connect(root)
    try:
        row = db.execute("SELECT * FROM cards WHERE milestone=? AND id=?", (mid, cid)).fetchone()
        if row is None:
            raise KeyError(cid)
        evs = [{"seq": r["seq"], "at": r["at"], "kind": r["kind"], "actor": r["actor"], "data": _json(r["data"], {})}
               for r in db.execute("SELECT * FROM events WHERE milestone=? AND card=? ORDER BY seq DESC LIMIT ?",
                                   (mid, cid, events))]  # fmt: skip
        return {"card": _card(row), "events": evs[::-1]}
    finally:
        db.close()


# ── the checklist: the requirements matrix in the checkout ─────────────────
_ROW = re.compile(r"^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\|")
_TEST = re.compile(r"tests/(?:[\w.-]+/)*test_\w+\.py::test_\w+")


def _cells(line: str) -> List[str]:
    """A table row's cells; an escaped ``\\|`` inside a cell (a route like ``/api/policy[/verify\\|/status]``) is text."""
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def project_checklist(root: Path) -> Dict[str, Any]:
    """The project's matrix and questions as the checkout has them (its current branch)."""
    root = Path(root)
    got = subprocess.run(["git", "symbolic-ref", "--short", "-q", "HEAD"], cwd=root, capture_output=True, text=True,
                         timeout=20)  # fmt: skip
    branch = got.stdout.strip() if got.returncode == 0 else ""
    brd = root / BRD_DIR
    if not (brd / MATRIX).is_file():
        return {"branch": branch, "brd": BRD_DIR, "rows": [], "header": [], "counts": {},
                "note": "no docs/brd/ here: `operonx-project brd init` makes one"}  # fmt: skip
    qfile = brd / QUESTIONS
    qtext = qfile.read_text(encoding="utf-8") if qfile.is_file() else ""
    return {"branch": branch, "brd": BRD_DIR, **_parse((brd / MATRIX).read_text(encoding="utf-8"), qtext, {})}


def _parse(text: str, qtext: str, asks: Dict[str, str]) -> Dict[str, Any]:
    header: List[str] = []  # the first table's, for the API's callers
    here: List[str] = []  # the table this row is in: a matrix may hold several, each with its own columns
    rows: List[Dict[str, Any]] = []
    for line in text.splitlines():
        if line.startswith("|") and re.search(r"\|\s*ID\s*\|", line, re.I):
            here = _cells(line)
            header = header or here
            continue
        if _ROW.match(line):
            cells = _cells(line)
            named = {h.lower(): cells[i] for i, h in enumerate(here) if i < len(cells)}
            status = named.get("status") or (cells[1] if len(cells) > 1 else "")
            text_col = next((h for pre in ("requirement", "metric", "notes") for h in named if h.startswith(pre)), None)
            rows.append({"id": cells[0], "status": status, "cells": cells, "tests": _TEST.findall(line),
                         "text": named.get(text_col, "") if text_col else "",
                         "questions": re.findall(r"Q-\d{2,3}", line)})  # fmt: skip
    questions = []
    for line in qtext.splitlines():
        m = re.match(r"^\|\s*(Q-\d{2,3})\s*\|", line)
        if m:
            cells = _cells(line)
            questions.append({"id": cells[0], "type": cells[1] if len(cells) > 1 else "",
                              "topic": cells[2] if len(cells) > 2 else "", "state": cells[3] if len(cells) > 3 else "",
                              "asked": asks.get(cells[0])})  # fmt: skip
    counts: Dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"header": header, "rows": rows, "counts": counts, "questions": questions}


# ── actions: the engine's own door ──────────────────────────────────────────
def _engine() -> Optional[List[str]]:
    """How to run ``operonx-project``: ``OPERONX_PROJECT_BIN``, on PATH, or beside the studio's own Python (a
    studio started as ``.venv/bin/python -m operonx_studio.cli`` has its venv's scripts off PATH)."""
    explicit = os.environ.get("OPERONX_PROJECT_BIN")
    if explicit:
        return explicit.split()
    found = shutil.which("operonx-project")
    if found:
        return [found]
    beside = Path(sys.executable).parent / "operonx-project"
    return [str(beside)] if beside.is_file() else None


def _worktrees(root: Path) -> List[Path]:
    got = subprocess.run(["git", "-C", str(root), "worktree", "list", "--porcelain"], capture_output=True, text=True)
    return [Path(line[9:]) for line in got.stdout.splitlines() if line.startswith("worktree ")] or [Path(root)]


def stale_plans(root: Path) -> List[str]:
    """The plans the board mirrors whose newest copy (the checkout's, or a worktree's) is not the text the board
    last read, however it was changed — Edit, ``sed``, a merge (WORKSPACE_PLAN W1.1: mr-finance m33 stayed a day
    behind its doc, which the assistant only ever changed from the shell). Each as :func:`plan_request` takes it:
    relative in the checkout, absolute in another worktree. A mirror from before the engine kept the doc's sha is
    compared by time instead."""
    try:
        db = _connect(root)
    except BoardError:
        return []
    try:
        mirrored = [(key.split(":")[1], _json(data, {})) for key, data in
                    db.execute("SELECT key, data FROM steps WHERE key LIKE 'ms:%:plan'")]  # fmt: skip
        updated = {r[0]: r[1] or 0.0 for r in db.execute("SELECT id, updated FROM milestones")}
    finally:
        db.close()
    trees, out = _worktrees(root), []
    for mid, step in mirrored:
        rel = step.get("path")
        if not rel or mid not in updated:
            continue
        copies = [(f.stat().st_mtime, tree) for tree in trees if (f := tree / rel).is_file()]
        if not copies:
            continue
        at, tree = max(copies)
        if step.get("sha"):
            stale = hashlib.sha256((tree / rel).read_bytes()).hexdigest() != step["sha"]
        else:
            stale = at > updated[mid] + 1
        if stale:
            out.append(rel if tree.resolve() == Path(root).resolve() else str(tree / rel))
    return out


def _of(ref: str, mid: str, doc: str, cards: List[Dict[str, Any]]) -> Optional[str]:
    """The card of this milestone a turn's ``card`` names: ``m3/C2``, or ``docs/X_PLAN.md#W1`` (the doc's path as
    the turn saw it — relative, or absolute in any checkout) when the milestone mirrors that doc."""
    ref = ref.strip()
    if "#" in ref:
        path, phase = ref.rsplit("#", 1)
        path = path.removeprefix("./")
        if not doc or not (path == doc or path.endswith("/" + doc)):
            return None
        return next((c["id"] for c in cards if c["title"].split(" ", 1)[0] == phase or c["id"] == phase), None)
    m, _, cid = ref.partition("/")
    return cid if m == mid and any(c["id"] == cid for c in cards) else None


def link_turns(data: Dict[str, Any], turns: List[Dict[str, Any]], mid: str) -> Dict[str, Any]:
    """WORKSPACE_PLAN W1.3–W1.4 on a milestone's read: each card gets the turns that worked it (newest first),
    ``working`` while one runs, ``asks`` and ``question`` when the newest ended on a question to the owner, and
    ``evidence``: ``tests`` when one of them ran tests green after its last red,
    else ``none`` for a card that reads done with turns or a plan behind it and nothing run."""
    by: Dict[str, List[Dict[str, Any]]] = {}
    for t in turns:
        cid = _of(str(t.get("card") or ""), mid, data.get("doc") or "", data["cards"])
        if cid:
            by.setdefault(cid, []).append(t)
    for c in data["cards"]:
        mine = by.get(c["id"], [])
        c["turns"] = len(mine)
        if any(t["state"] == "running" for t in mine):
            c["working"] = True
        if mine and mine[0].get("asks"):  # its newest turn ended on a question to the owner (W1.5)
            c["asks"], c["question"] = True, mine[0]["asks"]
        runs = [e for t in reversed(mine) for e in t.get("evidence") or [] if e["kind"] == "tests"]
        if runs:
            c["evidence"] = "tests" if not runs[-1]["failed"] else "red"
        elif c["state"] == "done" and (mine or data.get("doc")):
            c["evidence"] = "none"
    data["turns_key"] = ",".join(f"{t['id']}:{t['state']}:{len(t.get('evidence') or [])}" for t in turns)
    return data


def plan_request(root: Path, path: str) -> Dict[str, Any]:
    """The engine's ``plan`` for a plan doc: ``docs/X_PLAN.md`` in the checkout, or the doc's path in a worktree
    of the same repo (a branch's), whose text is sent, since the checkout has not got it yet."""
    p = Path(path)
    if not p.is_absolute():
        return {"op": "plan", "path": path}

    def git(where: Path, *args: str) -> str:
        got = subprocess.run(["git", "-C", str(where), "rev-parse", *args], capture_output=True, text=True)
        return got.stdout.strip() if got.returncode == 0 else ""

    top = git(p.parent, "--show-toplevel")
    same = top and Path(git(p.parent, "--path-format=absolute", "--git-common-dir")).resolve() == Path(
        git(root, "--path-format=absolute", "--git-common-dir")).resolve()  # fmt: skip
    if not same or not p.is_file():
        raise BoardError(f"{path} is not a file in a checkout of this project")
    if Path(top).resolve() == Path(root).resolve():  # the checkout's own doc: the engine reads it and commits it
        return {"op": "plan", "path": p.resolve().relative_to(Path(top).resolve()).as_posix()}
    return {"op": "plan", "path": p.resolve().relative_to(Path(top).resolve()).as_posix(),
            "text": p.read_text(encoding="utf-8")}  # fmt: skip


def act(root: Path, request: Dict[str, Any], actor: str) -> Dict[str, Any]:
    """Run one action through ``operonx-project api``; its JSON answer, or why there is none."""
    argv = _engine()
    wait = 60
    if argv is None:
        return {"ok": False, "status": "unavailable",
                "message": "operonx-project is not installed where the studio runs (or set OPERONX_PROJECT_BIN)"}
    try:
        got = subprocess.run([*argv, "api", "--repo", str(root), "--actor", actor, "-"], input=json.dumps(request),
                             capture_output=True, text=True, timeout=wait, cwd=root)  # fmt: skip
    except OSError as exc:  # OPERONX_PROJECT_BIN names nothing runnable
        return {"ok": False, "status": "unavailable", "message": f"cannot run {argv[0]}: {exc.strerror}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "status": "error", "message": f"operonx-project did not answer within {wait} s"}
    try:
        out = json.loads(got.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"ok": False, "status": "error", "message": (got.stderr or got.stdout or "no answer")[-600:]}
    return out if isinstance(out, dict) else {"ok": False, "status": "error", "message": "not an object"}


# ── the routes ──────────────────────────────────────────────────────────────
def _actor(request: Any) -> str:
    """Who acts: ``studio:<user>``, and ``/assistant`` when the studio's assistant did it."""
    who = getattr(request.state, "user", None) or {}
    via = "/assistant" if request.headers.get("x-operonx-via") == "assistant" else ""
    return f"studio:{who.get('username') or 'local'}{via}"


def register(app: Any, *, watcher_of: Any, turns_of: Any = None, asks_of: Any = None, terminals_of: Any = None,
             deploys_of: Any = None) -> None:
    """The Board routes. ``watcher_of(pid)`` is the project's watcher (its root); ``turns_of(pid)`` the project's
    turns that named a card (the assistant's store), newest first; ``asks_of(pid)`` its turns that ended on a
    question to the owner."""

    def _root(pid: str):
        watcher = watcher_of(pid)
        if watcher is None:
            return None, JSONResponse({"error": "unknown project"}, status_code=404)
        return Path(watcher.root), None

    def _read(pid: str, fn, *args):
        root, bad = _root(pid)
        if bad is not None:
            return bad
        if not available(root):
            return JSONResponse({"available": False})
        try:
            return JSONResponse({"available": True, **fn(root, *args)})
        except KeyError as exc:
            return JSONResponse({"error": f"no {exc.args[0]!r} here"}, status_code=404)
        except (BoardError, sqlite3.Error) as exc:
            return JSONResponse({"available": True, "error": str(exc)}, status_code=409)

    @app.get("/api/p/{pid}/board")
    def board_milestones(pid: str) -> JSONResponse:
        """The project's milestones, when operonx-project drives it (``available``)."""
        return _read(pid, milestones)

    @app.get("/api/p/{pid}/brd")
    def board_project(pid: str) -> JSONResponse:
        """The project's checklist from its checkout's ``docs/brd`` (no milestone needed)."""
        return _read(pid, project_checklist)

    @app.get("/api/p/{pid}/project/status")
    async def project_status(pid: str, changes: int = 15) -> JSONResponse:
        """Where the project stands (the engine's ``status`` op, PROJECT_MODE_PLAN D2): the checklist, the
        plans and milestones, what needs the owner, what is in progress, the last commits, the setup. The
        engine only reads for it; a project it never ran keeps no store because of it."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        out = await asyncio.to_thread(act, root, {"op": "status", "changes": max(1, min(changes, 100))}, "studio")
        if not out.get("ok") and "unknown op" in str(out.get("message")):
            out = {**out, "status": "unavailable", "message": "the installed operonx-project is too old for Project "
                   "mode: install the one beside this studio (install.sh)"}  # fmt: skip
        if out.get("ok") and asks_of is not None and isinstance(out.get("project"), dict):
            # what the assistant asked the owner and was not answered, beside the engine's and the BRD's (W1.5)
            out["project"]["needs_you"] = list(out["project"].get("needs_you") or []) + [
                {"source": "assistant", "id": w["id"], "kind": "assistant", "text": w["problem"], "card": w["card"],
                 "session": w["session"], "title": w["title"]} for w in asks_of(pid)]  # fmt: skip
        return JSONResponse(out, status_code=200 if out.get("ok") else 503 if out.get("status") == "unavailable"
                            else 409)  # fmt: skip

    @app.get("/api/p/{pid}/project/files")
    def project_files(pid: str) -> JSONResponse:
        """The project's files as git sees them, the lately changed ones marked (Project mode › Files)."""
        from . import files

        root, bad = _root(pid)
        if bad is not None:
            return bad
        out = files.tree(root)
        return JSONResponse(out, status_code=200 if out["ok"] else 409)

    @app.get("/api/p/{pid}/project/file")
    def project_file(pid: str, path: str) -> JSONResponse:
        """One of them, read-only."""
        from . import files

        root, bad = _root(pid)
        if bad is not None:
            return bad
        out = files.read(root, path)
        return JSONResponse(out, status_code=200 if out["ok"] else 404)

    @app.get("/api/p/{pid}/board/{mid}")
    def board_milestone(pid: str, mid: str) -> JSONResponse:
        """One milestone: its columns, cards, open questions, plan, waves and last events."""
        return _read(pid, lambda root, m: link_turns(milestone(root, m), turns_of(pid) if turns_of else [], m), mid)

    @app.get("/api/p/{pid}/board/{mid}/card/{cid}")
    def board_card(pid: str, mid: str, cid: str) -> JSONResponse:
        def read(root: Path, m: str, c: str) -> Dict[str, Any]:
            out = card(root, m, c)
            if turns_of or terminals_of or deploys_of:
                ms = milestone(root, m, events=0)
                mine = lambda rows: [t for t in rows if _of(str(t.get("card") or ""), m, ms["doc"], ms["cards"]) == c]  # noqa: E731
                out["turns"] = mine(turns_of(pid)) if turns_of else []
                # the terminals working for it (WORKSPACE_PLAN W2)
                out["terminals"] = mine(terminals_of(pid)) if terminals_of else []
                # and the deploys made for it (W4)
                out["deploys"] = mine(deploys_of(pid)) if deploys_of else []
            return out

        return _read(pid, read, mid, cid)

    @app.post("/api/p/{pid}/board/plan")
    async def board_plan(pid: str, request: Request) -> JSONResponse:
        """A plan doc on the board (the engine's ``plan``): a milestone, a card per phase, as the doc says."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("path"), str):
            return JSONResponse({"ok": False, "status": "invalid", "message": "{path}: the plan doc"}, status_code=400)
        try:
            req = plan_request(root, body["path"])
        except BoardError as exc:
            return JSONResponse({"ok": False, "status": "invalid", "message": str(exc)}, status_code=409)
        out = await asyncio.to_thread(act, root, req, _actor(request))
        return JSONResponse(out, status_code=200 if out.get("ok") else 409 if out.get("status") != "unavailable"
                            else 503)  # fmt: skip
