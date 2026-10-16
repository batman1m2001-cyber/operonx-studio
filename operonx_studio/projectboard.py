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

The studio never changes that store: every action goes through the
engine's ``operonx-project api`` (:func:`act`), where it is checked the
same way as from the CLI or Telegram.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# at module level: the routes' annotations are strings (__future__), which
# FastAPI resolves here — a Request imported inside register() is a query field
from fastapi import Request
from fastapi.responses import JSONResponse

__all__ = ["SCHEMA", "BoardError", "act", "available", "card", "checklist", "milestone", "milestones"]

#: The newest store layout this reader knows.
SCHEMA = 2
STATE_DIR = Path(".operonx") / "project"
#: Board columns, left to right (the engine's ``board.COLUMNS``).
COLUMNS = [("backlog", "Backlog"), ("ready", "Ready"), ("in_progress", "In progress"), ("review", "Review"),
           ("qa", "QA"), ("done", "Done"), ("blocked", "Stopped")]  # fmt: skip
_WORKING = {"discovering", "requirements", "planning", "running", "verifying"}
_STAGE_COLUMN = {"review": "review", "qa": "qa"}


class BoardError(RuntimeError):
    """The store is missing, newer than this studio, or unreadable."""


def _db(root: Path) -> Path:
    return Path(root) / STATE_DIR / "project.db"


def available(root: Path) -> bool:
    return _db(root).is_file()


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
        "heldout": len((detail.get("heldout") or {}).get("files") or []),  # a count: never the tests
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
    asks = db.execute("SELECT COUNT(*) FROM interactions WHERE milestone=? AND state='open'", (row["id"],))
    return {
        "id": row["id"], "title": row["title"], "goal": row["goal"], "state": row["state"],
        "reason": row["reason"] or "", "mode": "w1" if policy.get("horizon") == "all" else "w2",
        "cost_usd": round(row["cost_usd"] or 0.0, 4), "budget_usd": budget.get("max_usd"),
        "running_s": round(_running_s(db, row["id"]), 1), "max_hours": budget.get("max_hours"),
        "replans": row["replans"], "resume_at": row["resume_at"],
        "max_parallel": policy.get("max_parallel"), "wip": policy.get("wip") or {},
        "cards": sum(counts.values()), "done": counts.get("done", 0), "open_questions": asks.fetchone()[0],
        "updated": row["updated"],
    }  # fmt: skip


def milestones(root: Path) -> Dict[str, Any]:
    db = _connect(root)
    try:
        rows = db.execute("SELECT * FROM milestones ORDER BY created").fetchall()
        return {"schema": SCHEMA, "milestones": [_ms(db, r) for r in rows]}
    finally:
        db.close()


def _waves(cards: List[Dict[str, Any]]) -> List[List[str]]:
    """The card DAG in waves: a card runs in the wave after its last dependency."""
    ids = {c["id"] for c in cards}
    level: Dict[str, int] = {}

    def of(cid: str, seen: frozenset = frozenset()) -> int:
        if cid in level:
            return level[cid]
        if cid in seen:  # a cycle (the engine refuses them; be safe)
            return 0
        deps = [d for d in next(c for c in cards if c["id"] == cid)["deps"] if d in ids]
        level[cid] = 1 + max((of(d, seen | {cid}) for d in deps), default=-1)
        return level[cid]

    for c in cards:
        of(c["id"])
    out: List[List[str]] = [[] for _ in range(max(level.values(), default=-1) + 1)]
    for c in cards:
        out[level[c["id"]]].append(c["id"])
    return out


def _question(row: sqlite3.Row) -> Dict[str, Any]:
    p = _json(row["payload"], {})
    options = [{"key": o.get("key"), "label": o.get("label") or o.get("key"), "description": o.get("description")}
               for o in p.get("options") or [] if isinstance(o, dict) and o.get("key")]  # fmt: skip
    plan = p.get("plan") or {}
    return {
        "id": row["id"], "short": row["short"], "qid": row["qid"], "kind": row["kind"], "card": row["card"],
        "version": row["version"], "problem": p.get("problem") or p.get("reason") or "", "why": p.get("why") or "",
        "tried": p.get("tried") or "", "evidence": p.get("evidence") or "", "options": options,
        "recommended": p.get("recommended"), "safe_default": bool(p.get("safe_default")),
        "plan_cards": [{"id": c.get("id"), "title": c.get("title"), "risk": c.get("risk")}
                       for c in plan.get("cards") or []],
        "problems": p.get("problems") or [], "notes": p.get("notes") or [],
        "created": row["created"], "flagged": bool(row["flagged"]), "delivery": row["delivery"],
    }  # fmt: skip


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
        asks = [_question(r) for r in db.execute(
            "SELECT * FROM interactions WHERE milestone=? AND state='open' ORDER BY created", (mid,))]  # fmt: skip
        plan = _record(db, mid, "plan")
        evs = [{"seq": r["seq"], "at": r["at"], "kind": r["kind"], "card": r["card"], "actor": r["actor"],
                "data": _json(r["data"], {})}
               for r in db.execute("SELECT * FROM events WHERE milestone=? ORDER BY seq DESC LIMIT ?", (mid, events))]
        return {
            "milestone": ms, "cards": cards, "columns": cols, "questions": asks,
            "plan": {"rounds": plan.get("rounds"), "passed": plan.get("passed"), "notes": plan.get("notes") or [],
                     "problems": plan.get("problems") or [],
                     "architecture": (plan.get("plan") or {}).get("architecture") or ""},
            "graph": {"waves": _waves(cards), "edges": [[d, c["id"]] for c in cards for d in c["deps"]]},
            "events": evs[::-1], "cursor": evs[0]["seq"] if evs else 0,
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


# ── the checklist: the requirements matrix on the milestone's branch ─────────
_ROW = re.compile(r"^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\|")
_TEST = re.compile(r"tests/(?:[\w.-]+/)*test_\w+\.py::test_\w+")


def _cells(line: str) -> List[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _show(root: Path, ref: str, path: str) -> Optional[str]:
    got = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=root, capture_output=True, text=True, timeout=20)
    return got.stdout if got.returncode == 0 else None


def checklist(root: Path, mid: str) -> Dict[str, Any]:
    db = _connect(root)
    try:
        if db.execute("SELECT 1 FROM milestones WHERE id=?", (mid,)).fetchone() is None:
            raise KeyError(mid)
        brd = (_record(db, mid, "intake").get("brd") or "docs/brd").strip("/")
        asks = {r["qid"]: r["state"] for r in db.execute("SELECT qid, state FROM interactions WHERE milestone=?",
                                                         (mid,))}  # fmt: skip
    finally:
        db.close()
    branch = f"milestone/{mid}/main"
    text = _show(root, branch, f"{brd}/requirements/requirements_traceability.md")
    if text is None:
        return {"branch": branch, "brd": brd, "rows": [], "header": [], "counts": {},
                "note": "no requirements matrix on the milestone's branch yet (a goal-only milestone has none)"}
    header: List[str] = []
    rows: List[Dict[str, Any]] = []
    for line in text.splitlines():
        if not header and line.startswith("|") and re.search(r"\|\s*ID\s*\|", line, re.I):
            header = _cells(line)
            continue
        if _ROW.match(line):
            cells = _cells(line)
            named = {h.lower(): cells[i] for i, h in enumerate(header) if i < len(cells)} if header else {}
            status = named.get("status") or (cells[1] if len(cells) > 1 else "")
            rows.append({"id": cells[0], "status": status, "cells": cells, "tests": _TEST.findall(line),
                         "questions": re.findall(r"Q-\d{2,3}", line)})  # fmt: skip
    questions = []
    qtext = _show(root, branch, f"{brd}/requirements/open_questions.md") or ""
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
    return {"branch": branch, "brd": brd, "header": header, "rows": rows, "counts": counts, "questions": questions}


# ── actions: the engine's own door ──────────────────────────────────────────
def _engine() -> Optional[List[str]]:
    """How to run ``operonx-project``: ``OPERONX_PROJECT_BIN``, or on PATH."""
    explicit = os.environ.get("OPERONX_PROJECT_BIN")
    if explicit:
        return explicit.split()
    found = shutil.which("operonx-project")
    return [found] if found else None


def act(root: Path, request: Dict[str, Any], actor: str) -> Dict[str, Any]:
    """Run one action through ``operonx-project api``; its JSON answer, or why there is none."""
    argv = _engine()
    if argv is None:
        return {"ok": False, "status": "unavailable",
                "message": "operonx-project is not installed where the studio runs (or set OPERONX_PROJECT_BIN)"}
    try:
        got = subprocess.run([*argv, "api", "--repo", str(root), "--actor", actor, "-"], input=json.dumps(request),
                             capture_output=True, text=True, timeout=60, cwd=root)  # fmt: skip
    except OSError as exc:  # OPERONX_PROJECT_BIN names nothing runnable
        return {"ok": False, "status": "unavailable", "message": f"cannot run {argv[0]}: {exc.strerror}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "status": "error", "message": "operonx-project did not answer within 60 s"}
    try:
        out = json.loads(got.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"ok": False, "status": "error", "message": (got.stderr or got.stdout or "no answer")[-600:]}
    return out if isinstance(out, dict) else {"ok": False, "status": "error", "message": "not an object"}


# ── the routes ──────────────────────────────────────────────────────────────
def register(app: Any, *, watcher_of: Any) -> None:
    """The Board routes. ``watcher_of(pid)`` is the project's watcher (its root)."""

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

    @app.get("/api/p/{pid}/board/{mid}")
    def board_milestone(pid: str, mid: str) -> JSONResponse:
        """One milestone: its columns, cards, open questions, plan, waves and last events."""
        return _read(pid, milestone, mid)

    @app.get("/api/p/{pid}/board/{mid}/checklist")
    def board_checklist(pid: str, mid: str) -> JSONResponse:
        """The requirements matrix and the BRD's questions, from the milestone's branch."""
        return _read(pid, checklist, mid)

    @app.get("/api/p/{pid}/board/{mid}/card/{cid}")
    def board_card(pid: str, mid: str, cid: str) -> JSONResponse:
        return _read(pid, card, mid, cid)

    @app.post("/api/p/{pid}/board/{mid}/act")
    async def board_act(pid: str, mid: str, request: Request) -> JSONResponse:
        """An owner's action, run by the engine (``operonx-project api``): its checks, its answer."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "status": "invalid", "message": "a JSON object"}, status_code=400)
        who = getattr(request.state, "user", None) or {}
        actor = f"studio:{who.get('username') or 'local'}"
        out = await asyncio.to_thread(act, root, {**body, "milestone": mid}, actor)
        return JSONResponse(out, status_code=200 if out.get("ok") else 409 if out.get("status") != "unavailable"
                            else 503)  # fmt: skip
