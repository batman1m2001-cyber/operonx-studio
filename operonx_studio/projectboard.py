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

The studio never changes that store: every action goes through the
engine's ``operonx-project api`` (:func:`act`), where it is checked the
same way as from the CLI or Telegram. The one thing the studio runs itself
is the project's daemon (:func:`daemon_start`, :func:`daemon_stop`): the
Board's Run and Stop, for an owner who drives the project from here.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
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

__all__ = ["SCHEMA", "BoardError", "act", "available", "card", "checklist", "daemon_start", "daemon_status",
           "daemon_stop", "milestone", "milestones", "project_checklist"]

#: The newest store layout this reader knows.
SCHEMA = 2
STATE_DIR = Path(".operonx") / "project"
BRD_DIR = "docs/brd"
MATRIX = "requirements/requirements_traceability.md"
QUESTIONS = "requirements/open_questions.md"
PRACTICES = "docs/brd/practices.toml"
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
        "asks": bool(q) and row["state"] == "waiting_human" and q.get("kind") != "taken",
        "taken": (detail.get("taken") or {}).get("actor"),
        "waiting_for_submit": row["state"] == "waiting_human" and q.get("kind") == "taken",
        "heldout": len((detail.get("heldout") or {}).get("files") or []),  # a count: never the tests
        "acceptance": sorted((detail.get("acceptance") or {}).get("files") or {}),
        "checks": [{"name": r.get("name"), "ok": r.get("ok")} for r in detail.get("baseline") or []
                   if isinstance(r, dict)],
        "tdd": (detail.get("acceptance") or {}).get("tdd") or "",  # "off": no tests written for it
        "red": {k: (detail.get("red") or {}).get(k) for k in ("red", "rewritten", "passed")} if detail.get("red") else None,
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
    base = {"schema": SCHEMA, "brd": _has_brd(root), "daemon": daemon_status(root), "sandbox": _sandbox(root),
            "models": _models(root), "practices": _practices(root), "installed": _engine() is not None}
    if not _has_store(root):
        return {**base, "milestones": [], "engine": False}
    db = _connect(root)
    try:
        rows = db.execute("SELECT * FROM milestones ORDER BY created").fetchall()
        return {**base, "milestones": [_ms(db, r) for r in rows], "engine": True}
    finally:
        db.close()


# ── linked milestones (plan D17): ~/.operonx/projects.json, kept by the engine ──
def _index() -> Dict[str, str]:
    path = Path(os.environ.get("OPERONX_PROJECTS_INDEX") or Path.home() / ".operonx" / "projects.json")
    try:
        got = json.loads(path.read_text(encoding="utf-8"))
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def _ro(state: Path) -> Optional[sqlite3.Connection]:
    db = Path(state) / "project.db"
    if not db.is_file():
        return None
    try:
        return sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None


def links(root: Path, db: sqlite3.Connection, mid: str) -> Dict[str, List[Dict[str, Any]]]:
    """What milestone *mid* needs (each with its state now) and which milestones need it."""
    idx = _index()
    here_state = str(Path(root) / STATE_DIR)
    here = next((n for n, s in idx.items() if s == here_state), Path(root).name)
    needs = []
    for ref in _record(db, mid, "needs").get("needs") or []:
        name, _, m = str(ref).rpartition("#")
        state = None
        con = db if not name or name == here else _ro(Path(idx[name])) if name in idx else None
        try:
            row = con.execute("SELECT state FROM milestones WHERE id=?", (m,)).fetchone() if con else None
            state = row[0] if row else None
        except sqlite3.Error:
            pass
        finally:
            if con is not None and con is not db:
                con.close()
        needs.append({"ref": ref, "state": state})
    needed_by = []
    for name, state in idx.items():
        con = db if name == here else _ro(Path(state))
        if con is None:
            continue
        try:
            for key, data in con.execute("SELECT key, data FROM steps WHERE key LIKE 'ms:%:needs'"):
                for ref in _json(data, {}).get("needs") or []:
                    if ref == f"{here}#{mid}" or (name == here and ref == mid):
                        needed_by.append({"ref": f"{name}#{key.split(':')[1]}"})
        except sqlite3.Error:
            pass
        finally:
            if con is not db:
                con.close()
    return {"needs": needs, "needed_by": needed_by}


def overview(root: Path) -> Dict[str, Any]:
    """One project's board at a glance, for the studio's home and the title count
    (plan D18): its milestones, and the questions that wait on the owner."""
    if not _has_store(root):
        return {"milestones": [], "waiting": []}
    db = _connect(root)
    try:
        ms = [{k: m[k] for k in ("id", "title", "state", "done", "cards", "open_questions")}
              for m in (_ms(db, r) for r in db.execute("SELECT * FROM milestones ORDER BY created"))]  # fmt: skip
        waiting = []
        for r in db.execute("SELECT * FROM interactions WHERE state='open' ORDER BY created"):
            q = _question(r)
            waiting.append({"id": q["id"], "qid": q["qid"], "milestone": r["milestone"], "kind": q["kind"],
                            "card": q["card"], "problem": q["problem"][:300], "created": q["created"]})  # fmt: skip
        return {"milestones": ms, "waiting": waiting}
    finally:
        db.close()


def _toml(path: Path) -> Optional[Dict[str, Any]]:
    """A TOML file; None when missing or broken."""
    if not path.is_file():
        return None
    try:
        import tomllib
    except ImportError:  # pragma: no cover - 3.10
        import tomli as tomllib
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _settings(root: Path) -> Dict[str, Any]:
    """``.operonx/project/settings.toml`` (machine-local); {} when missing or broken."""
    return _toml(Path(root) / STATE_DIR / "settings.toml") or {}


def _practices(root: Path) -> Optional[Dict[str, Any]]:
    """The Board's chips from ``docs/brd/practices.toml`` (committed: how the project is built). A read
    for the chips only; the engine validates the file (``practices`` op), and None means no file."""
    path = Path(root) / PRACTICES
    if not path.is_file():
        return None
    got = _toml(path)
    if got is None:
        return {"error": f"{PRACTICES} does not parse"}
    arch = got.get("architecture") or {}
    return {"tdd": (got.get("tdd") or {}).get("mode") or "acceptance", "style": arch.get("style") or "",
            "layers": len(arch.get("layers") or []), "contexts": len(got.get("contexts") or []),
            "private": arch.get("private") or "allow", "forbid": len(arch.get("forbid") or []),
            "command": bool(arch.get("command")), "done": len((got.get("done") or {}).get("checks") or []),
            "lessons": (got.get("lessons") or {}).get("file") or ""}  # fmt: skip


def _sandbox(root: Path) -> bool:
    """``settings.toml``'s ``sandbox`` (default on)."""
    return bool(_settings(root).get("sandbox", True))


def _models(root: Path) -> Dict[str, Any]:
    """The owner's model choice in ``settings.toml``: every role's, and one role's."""
    got = _settings(root)
    return {"model": got.get("model"), "models": got.get("models") or {}}


# ── the daemon: Run and Stop on the Board ──────────────────────────────────
def daemon_status(root: Path) -> Dict[str, Any]:
    """Whether a daemon drives the project (its lease is live), and which."""
    path = _db(root)
    if not path.is_file():
        return {"running": False}
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            row = db.execute("SELECT owner, until FROM lease WHERE name='daemon'").fetchone()
        finally:
            db.close()
    except sqlite3.Error:
        return {"running": False}
    if row is None or row[1] <= time.time():
        return {"running": False}
    parts = str(row[0]).split(":")
    pid = int(parts[1]) if len(parts) > 2 and parts[1].isdigit() else None
    return {"running": True, "owner": row[0], "pid": pid, "here": bool(parts) and parts[0] == os.uname().nodename}


def daemon_start(root: Path, wait_s: float = 8.0) -> Dict[str, Any]:
    """Start ``operonx-project daemon`` for the project, detached; its log is
    ``.operonx/project/daemon.log``. Already running: nothing to do."""
    now = daemon_status(root)
    if now["running"]:
        return {"ok": True, "status": "running", "message": f"a daemon drives it ({now['owner']})", **now}
    argv = _engine()
    if argv is None:
        return {"ok": False, "status": "unavailable", "message": "operonx-project is not installed where the studio "
                                                                  "runs (or set OPERONX_PROJECT_BIN)"}  # fmt: skip
    state = Path(root) / STATE_DIR
    state.mkdir(parents=True, exist_ok=True)
    log = open(state / "daemon.log", "ab")
    try:
        proc = subprocess.Popen([*argv, "daemon", "--repo", str(root)], cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True)  # fmt: skip
    except OSError as exc:
        return {"ok": False, "status": "unavailable", "message": f"cannot run {argv[0]}: {exc.strerror}"}
    finally:
        log.close()
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if proc.poll() is not None:
            tail = (state / "daemon.log").read_text(encoding="utf-8", errors="replace")[-600:]
            return {"ok": False, "status": "error", "message": f"the daemon exited ({proc.returncode}): {tail}"}
        now = daemon_status(root)
        if now["running"]:
            return {"ok": True, "status": "started", "message": "the daemon drives it", **now}
        time.sleep(0.2)
    return {"ok": True, "status": "starting", "message": "the daemon is starting", "pid": proc.pid}


def daemon_stop(root: Path, wait_s: float = 20.0) -> Dict[str, Any]:
    """Stop the project's daemon: an interrupt first (running sessions are
    stopped and the lease released), then a terminate."""
    now = daemon_status(root)
    if not now["running"]:
        return {"ok": True, "status": "stopped", "message": "no daemon drives it"}
    pid = now.get("pid")
    if not pid or not now.get("here"):
        return {"ok": False, "status": "refused", "message": f"the daemon runs elsewhere ({now['owner']}): stop it there"}
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        cmdline = ""
    if "daemon" not in cmdline:
        return {"ok": False, "status": "refused", "message": f"process {pid} is not the project's daemon"}
    for sig, wait in ((signal.SIGINT, wait_s), (signal.SIGTERM, 5.0)):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        deadline = time.time() + wait
        while time.time() < deadline and Path(f"/proc/{pid}").exists():
            time.sleep(0.2)
        if not Path(f"/proc/{pid}").exists():
            break
    return {"ok": True, "status": "stopped", "message": "the daemon stopped"}


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
        # what the owner approves: a W1 plan's cards are only here until it is approved
        "plan_cards": [{"id": c.get("id"), "title": c.get("title"), "risk": c.get("risk"),
                        "intent": c.get("intent") or "", "paths": c.get("paths") or [], "deps": c.get("deps") or [],
                        "rows": c.get("rows") or [],
                        "criteria": [k.get("text", "") if isinstance(k, dict) else str(k) for k in c.get("criteria") or []]}
                       for c in plan.get("cards") or [] if isinstance(c, dict)],
        "problems": p.get("problems") or [], "notes": p.get("notes") or [],
        "created": row["created"], "flagged": bool(row["flagged"]), "delivery": row["delivery"],
    }  # fmt: skip


def _has_branch(root: Path, branch: str) -> bool:
    return subprocess.run(["git", "rev-parse", "--verify", "-q", f"refs/heads/{branch}"], cwd=root,
                          capture_output=True, timeout=20).returncode == 0  # fmt: skip


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
        # the live line: what each running card's session does now (the engine's throttled activity events)
        live = {r["card"]: {"text": _json(r["data"], {}).get("text", ""), "at": r["at"]} for r in db.execute(
            "SELECT card, data, at FROM events WHERE seq IN (SELECT MAX(seq) FROM events WHERE milestone=? "
            "AND kind='activity' GROUP BY card)", (mid,))}  # fmt: skip
        for c in cards:
            if c["state"] == "running" and c["id"] in live:
                c["activity"] = live[c["id"]]
        plan = _record(db, mid, "plan")
        base = _record(db, mid, "baseline")
        arch = next((r for r in base.get("results") or [] if r.get("name") == "architecture"), None)
        end = next((r for r in _record(db, mid, "final_checks").get("results") or []
                    if r.get("name") == "architecture"), None)  # fmt: skip
        retro = _record(db, mid, "retro")
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
            "shipped": _record(db, mid, "shipped") or None, "merge_granted": bool(_settings(root).get("merge")),
            # the architecture check on the milestone's base (what was there before it, never its cards' fault),
            # and at final verification: what the milestone left
            "architecture": {"ok": arch.get("ok"), "violations": len(arch.get("failures") or []),
                             "after": {"ok": end.get("ok"), "violations": len(end.get("failures") or [])}
                             if end else None} if arch else None,
            "retro": {"report": retro.get("report") or {}, "lessons": retro.get("lessons") or [],
                      "file": retro.get("file") or ""} if retro else None,
            "shippable": ms["state"] == "done" and _has_branch(root, _record(db, mid, "intake").get("branch")
                                                               or f"milestone/{mid}/main"),
            **links(root, db, mid),
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
    """A table row's cells; an escaped ``\\|`` inside a cell (a route like ``/api/policy[/verify\\|/status]``) is text."""
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def _show(root: Path, ref: str, path: str) -> Optional[str]:
    got = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=root, capture_output=True, text=True, timeout=20)
    return got.stdout if got.returncode == 0 else None


def checklist(root: Path, mid: str) -> Dict[str, Any]:
    db = _connect(root)
    try:
        if db.execute("SELECT 1 FROM milestones WHERE id=?", (mid,)).fetchone() is None:
            raise KeyError(mid)
        intake = _record(db, mid, "intake")
        brd = (intake.get("brd") or "docs/brd").strip("/")
        branch = intake.get("branch") or f"milestone/{mid}/main"  # a project in a subfolder has its own names
        asks = {r["qid"]: r["state"] for r in db.execute("SELECT qid, state FROM interactions WHERE milestone=?",
                                                         (mid,))}  # fmt: skip
    finally:
        db.close()
    if not _has_branch(root, branch):  # a milestone with no branch of its own (an adopted baseline, m0): the checkout's BRD
        here = project_checklist(root)
        return {**here, "note": here.get("note") or f"{mid} has no branch: the checklist as this checkout has it"}
    text = _show(root, branch, f"./{brd}/{MATRIX}")  # ./: from the project's folder, which may be a subfolder
    if text is None:
        return {"branch": branch, "brd": brd, "rows": [], "header": [], "counts": {},
                "note": "no requirements matrix on the milestone's branch yet (a goal-only milestone has none)"}
    return {"branch": branch, "brd": brd, **_parse(text, _show(root, branch, f"./{brd}/{QUESTIONS}") or "", asks)}


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


def act(root: Path, request: Dict[str, Any], actor: str) -> Dict[str, Any]:
    """Run one action through ``operonx-project api``; its JSON answer, or why there is none."""
    argv = _engine()
    wait = 300 if request.get("op") in ("ship", "merge") else 60  # a push and gh take their time
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

    @app.get("/api/p/{pid}/brd")
    def board_project(pid: str) -> JSONResponse:
        """The project's checklist from its checkout's ``docs/brd`` (no milestone needed)."""
        return _read(pid, project_checklist)

    # before /board/{mid}: "practices" is no milestone
    @app.get("/api/p/{pid}/board/practices")
    async def board_practices(pid: str, preview: str = "") -> JSONResponse:
        """How the project is built (the engine's ``practices`` op): the file, in words, and the
        architecture check on the checkout; ``?preview=<preset>``: what that preset would flag."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        req = {"op": "practices", **({"preview": preview} if preview else {})}
        out = await asyncio.to_thread(act, root, req, "studio")
        return JSONResponse(out, status_code=200 if out.get("ok") else 503 if out.get("status") == "unavailable"
                            else 409)  # fmt: skip

    @app.post("/api/p/{pid}/board/practices")
    async def board_practices_set(pid: str, request: Request) -> JSONResponse:
        """Set them: ``{"preset": "operonx"}`` (``force``: over the file) or ``{"toml": "…"}``; the engine
        validates, writes and commits that file alone on the checkout's branch."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "status": "invalid", "message": "a JSON object"}, status_code=400)
        req = {"op": "practices", **{k: body[k] for k in ("preset", "force", "toml") if k in body}}
        out = await asyncio.to_thread(act, root, req, _actor(request))
        return JSONResponse(out, status_code=200 if out.get("ok") else 503 if out.get("status") == "unavailable"
                            else 409)  # fmt: skip

    # before /board/{mid}: "settings" is no milestone
    @app.get("/api/p/{pid}/board/settings")
    async def board_settings(pid: str) -> JSONResponse:
        """The models each role's session runs on (the engine's ``settings`` op)."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        out = await asyncio.to_thread(act, root, {"op": "settings"}, "studio")
        return JSONResponse(out, status_code=200 if out.get("ok") else 503 if out.get("status") == "unavailable"
                            else 409)  # fmt: skip

    @app.post("/api/p/{pid}/board/settings")
    async def board_settings_set(pid: str, request: Request) -> JSONResponse:
        """Change them: ``{"model": "sonnet"}`` for every role, ``{"models": {role: model}}`` for one ("" clears)."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "status": "invalid", "message": "a JSON object"}, status_code=400)
        req = {"op": "settings", **{k: body[k] for k in ("model", "models") if k in body}}
        out = await asyncio.to_thread(act, root, req, _actor(request))
        return JSONResponse(out, status_code=200 if out.get("ok") else 503 if out.get("status") == "unavailable"
                            else 409)  # fmt: skip

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

    @app.post("/api/p/{pid}/board/daemon")
    async def board_daemon(pid: str, request: Request) -> JSONResponse:
        """Run or Stop the project's daemon (``{"action": "start" | "stop"}``)."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        action = body.get("action") if isinstance(body, dict) else None
        if action not in ("start", "stop"):
            return JSONResponse({"ok": False, "status": "invalid", "message": "action: start or stop"}, status_code=400)
        out = await asyncio.to_thread(daemon_start if action == "start" else daemon_stop, root)
        return JSONResponse(out, status_code=200 if out.get("ok") else 409 if out.get("status") != "unavailable"
                            else 503)  # fmt: skip

    @app.post("/api/p/{pid}/board/new")
    async def board_new(pid: str, request: Request) -> JSONResponse:
        """A new milestone for rows of the checklist (or a goal): the engine's ``start``."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "status": "invalid", "message": "a JSON object"}, status_code=400)
        out = await asyncio.to_thread(act, root, {**body, "op": "start"}, _actor(request))
        return JSONResponse(out, status_code=200 if out.get("ok") else 409 if out.get("status") != "unavailable"
                            else 503)  # fmt: skip

    @app.post("/api/p/{pid}/board/request")
    async def board_request(pid: str, request: Request) -> JSONResponse:
        """The owner's words become rows (the engine's ``request``): a BRD source, its requirements, and a
        milestone scoped to them that waits for the owner's approval."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "status": "invalid", "message": "a JSON object"}, status_code=400)
        out = await asyncio.to_thread(act, root, {**body, "op": "request"}, _actor(request))
        return JSONResponse(out, status_code=200 if out.get("ok") else 409 if out.get("status") != "unavailable"
                            else 503)  # fmt: skip

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
        out = await asyncio.to_thread(act, root, {**body, "milestone": mid}, _actor(request))
        return JSONResponse(out, status_code=200 if out.get("ok") else 409 if out.get("status") != "unavailable"
                            else 503)  # fmt: skip
