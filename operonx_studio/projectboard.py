"""The Board tab: the project's ``docs/brd/board.md``, read and moved through operonx-project's ``board``.

The board is a file in git (LEAN_PROJECT_PLAN §5): one card per heading, four fields (``req``, ``after``,
``files``, ``done``), four states (``todo``, ``doing``, ``needs you``, ``done``). The studio reads it with the
engine's own parser and adds what only the studio knows, by card id: the assistant's turns that named the card,
the one running now and the step it is on, the evidence they left, the terminals and deploys made for it.

A project with a BRD folder (``docs/brd/``) has a board before its first card: :func:`project_checklist` reads
the matrix from the checkout. The project's status document is the engine's ``status``, called in-process.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

# at module level: the routes' annotations are strings (__future__), which
# FastAPI resolves here — a Request imported inside register() is a query field
from fastapi import Request
from fastapi.responses import JSONResponse

from operonx_project import board as _board

__all__ = ["available", "board", "brd_questions", "card", "overview", "project_checklist"]

BRD_DIR = "docs/brd"
MATRIX = "requirements/requirements_traceability.md"
QUESTIONS = "requirements/open_questions.md"


def available(root: Path) -> bool:
    """A board: ``docs/brd/board.md``, or a BRD folder (a project before its first card)."""
    return (Path(root) / _board.PATH).is_file() or (Path(root) / BRD_DIR / MATRIX).is_file()


def _of(ref: Any) -> str:
    """The card id a turn, terminal or deploy names: ``C4`` (``docs/brd/board.md#C4`` and ``C4 · title`` too)."""
    m = re.search(r"\bC\d+\b", str(ref or ""))
    return m.group(0) if m else ""


def board(root: Path, turns: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """The cards by state (:func:`operonx_project.board.view`), each with the turns that worked it (newest first):
    ``turns``, ``working`` and ``now`` (the step it is on) while one runs, ``asks``/``question`` when the newest
    ended on a question to the owner, and ``evidence``: ``tests`` when the newest test run was green, ``red`` when
    not, ``none`` for a card done with turns and nothing run."""
    cards = _board.read(root)
    out = _board.view(cards or [])
    by: Dict[str, List[Dict[str, Any]]] = {}
    for t in turns or []:
        if _of(t.get("card")):
            by.setdefault(_of(t.get("card")), []).append(t)
    for c in out["cards"]:
        mine = by.get(c["id"], [])
        c["turns"] = len(mine)
        running = next((t for t in mine if t["state"] == "running"), None)
        if running:
            c["working"], c["now"] = True, running.get("now") or ""
        if mine and mine[0].get("asks"):
            c["asks"], c["question"] = True, mine[0]["asks"]
        runs = [e for t in reversed(mine) for e in t.get("evidence") or [] if e["kind"] == "tests"]
        if runs:
            c["evidence"] = "tests" if not runs[-1]["failed"] else "red"
        elif c["state"] == "done" and mine:
            c["evidence"] = "none"
    out["file"] = _board.PATH if cards is not None else ""
    out["turns_key"] = ",".join(f"{t['id']}:{t['state']}:{t.get('now') or ''}:{len(t.get('evidence') or [])}"
                                for t in turns or [])  # fmt: skip
    return out


def card(root: Path, cid: str) -> Dict[str, Any]:
    got = next((c for c in board(root)["cards"] if c["id"] == cid), None)
    if got is None:
        raise KeyError(cid)
    return got


def overview(root: Path) -> Dict[str, Any]:
    """One project's board at a glance, for the studio's home and the title count: its counts per state, and
    what waits on the owner: the cards that need you and the BRD's open questions."""
    cards = _board.read(root) or []
    waiting = [{"id": f"card:{c.id}", "qid": "", "kind": "card", "card": c.id,
                "problem": (c.note or c.title)[:300], "created": "", "source": "board"}
               for c in cards if c.state == "needs you"]  # fmt: skip
    return {"counts": {s: sum(1 for c in cards if c.state == s) for s in _board.STATES},
            "waiting": waiting + brd_questions(root)}  # fmt: skip


def brd_questions(root: Path) -> List[Dict[str, Any]]:
    """The BRD's open questions (``requirements/open_questions.md``, state ``open``) in the checkout."""
    qfile = Path(root) / BRD_DIR / QUESTIONS
    if not qfile.is_file():
        return []
    return [{"id": f"brd:{q['id']}", "qid": q["id"], "kind": q["type"] or "question", "card": "",
             "problem": q["topic"][:300], "created": "", "source": "brd"}
            for q in _parse("", qfile.read_text(encoding="utf-8"), {})["questions"]
            if q["state"].strip().lower() == "open"]  # fmt: skip


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


# ── the routes ──────────────────────────────────────────────────────────────
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
        except _board.BoardError as exc:
            return JSONResponse({"available": True, "error": str(exc)}, status_code=409)

    @app.get("/api/p/{pid}/board")
    def board_cards(pid: str) -> JSONResponse:
        """The board: every card with its lane, kind, what it waits on, and the assistant's work on it."""
        return _read(pid, lambda root: board(root, turns_of(pid) if turns_of else []))

    @app.get("/api/p/{pid}/board/card/{cid}")
    def board_card(pid: str, cid: str) -> JSONResponse:
        """One card, with the turns, terminals and deploys made for it (WORKSPACE_PLAN W1–W4)."""
        def read(root: Path, c: str) -> Dict[str, Any]:
            turns = turns_of(pid) if turns_of else []
            got = next((x for x in board(root, turns)["cards"] if x["id"] == c), None)
            if got is None:
                raise KeyError(c)
            mine = lambda rows: [t for t in rows if _of(t.get("card")) == c]  # noqa: E731
            return {"card": got, "turns": mine(turns), "terminals": mine(terminals_of(pid)) if terminals_of else [],
                    "deploys": mine(deploys_of(pid)) if deploys_of else []}  # fmt: skip

        return _read(pid, read, cid)

    @app.post("/api/p/{pid}/board/card")
    async def board_put(pid: str, request: Request) -> JSONResponse:
        """Add a card (no ``card``) or change one's title and fields; or move it (``to``, with a ``note``).
        A move to done runs the card's ``done`` tests first and refuses while one is red."""
        root, bad = _root(pid)
        if bad is not None:
            return bad
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "message": "a JSON object"}, status_code=400)
        if body.get("to") == "done":
            # done means its tests pass: run them first, here, with the project's own python
            import asyncio

            from operonx_project.adopt import run_tests

            cid = str(body.get("card") or "")
            card = next((c for c in _board.read(root) or [] if c.id == cid), None)
            if card is not None and card.done:
                ran = await asyncio.to_thread(run_tests, root, card.done)
                red = [t for t in card.done if not ran.get(t)]
                if red:
                    return JSONResponse({"ok": False, "message": f"{cid} stays: not passing (or not found): "
                                         + ", ".join(red), "red": red}, status_code=409)  # fmt: skip
        try:
            if body.get("to"):
                c = _board.move(root, str(body.get("card") or ""), str(body["to"]),
                                note=body["note"] if isinstance(body.get("note"), str) else None)  # fmt: skip
            else:
                fields = {k: [str(x) for x in body[k]] for k in _board.FIELDS if isinstance(body.get(k), list)}
                c = _board.put(root, str(body.get("card") or ""), str(body.get("title") or ""), **fields)
        except (_board.BoardError, FileNotFoundError) as exc:
            return JSONResponse({"ok": False, "message": str(exc) or "no board here"}, status_code=409)
        return JSONResponse({"ok": True, "card": c.id, "state": c.state, "note": c.note})

    @app.get("/api/p/{pid}/brd")
    def board_project(pid: str) -> JSONResponse:
        """The project's checklist from its checkout's ``docs/brd``."""
        return _read(pid, project_checklist)

    @app.get("/api/p/{pid}/project/status")
    async def project_status(pid: str, changes: int = 15) -> JSONResponse:
        """Where the project stands (the engine's ``status`` op, PROJECT_MODE_PLAN D2): the checklist, the
        board, the plans, what needs the owner, what is in progress, the last commits. The engine only reads."""
        import asyncio

        root, bad = _root(pid)
        if bad is not None:
            return bad
        from operonx_project.status import status, text

        doc = await asyncio.to_thread(status, root, max(1, min(changes, 100)))
        out = {"ok": True, "project": doc, "text": text(doc)}
        if out.get("ok") and asks_of is not None and isinstance(out.get("project"), dict):
            # what the assistant asked the owner and was not answered, beside the board's and the BRD's (W1.5)
            out["project"]["needs_you"] = list(out["project"].get("needs_you") or []) + [
                {"source": "assistant", "id": w["id"], "kind": "assistant", "text": w["problem"], "card": w["card"],
                 "session": w["session"], "title": w["title"]} for w in asks_of(pid)]  # fmt: skip
        return JSONResponse(out)

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
