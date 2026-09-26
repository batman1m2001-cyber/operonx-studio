"""The review queue's two halves: a run read as a conversation, and the
reviews people leave on runs.

**Reviews** are one JSON line each in ``<project>/.operonx/reviews.jsonl``
— the run, good or bad, labels, a note, who, when — kept beside the runs
they judge; the latest line for a run is its review. Recording the user
from the first line is what lets a team server share them later.

**A conversation** is what a reviewer reads instead of a trace tree. It is
read out of the run's own rows, by rules that hold for any product: what a
playground toy sent (its script) and anything recorded as a
``transcript`` are the user's turns; what the service sent through its
egress door, or an op answered in a text output (``reply``,
``response``, ``answer``, ``text``, ``content``), is the bot's. Each turn
names the op it came from, so a reviewer can go from the sentence to the
execution.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

__all__ = ["ReviewLog", "conversation"]

USER_KEYS = ("transcript",)
BOT_KEYS = ("reply", "response", "answer", "text", "content", "message")


class ReviewLog:
    """``.operonx/reviews.jsonl`` — append-only; the last line per run wins."""

    def __init__(self, root: Path):
        self.path = Path(root) / ".operonx" / "reviews.jsonl"

    def latest(self) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        if not self.path.is_file():
            return out
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and rec.get("run"):
                    out[str(rec["run"])] = rec
        return out

    def get(self, run: str) -> Optional[Dict[str, Any]]:
        return self.latest().get(run)

    def put(self, run: str, *, verdict: Optional[str], labels: Iterable[str], note: str, user: str) -> Dict[str, Any]:
        if verdict not in (None, "good", "bad"):
            raise ValueError("a verdict is good, bad, or none")
        rec = {"run": run, "verdict": verdict, "labels": sorted({str(x).strip() for x in labels if str(x).strip()}),
               "note": str(note or "")[:4000], "user": user, "at": round(time.time(), 3)}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec


def _text(value: Any) -> Optional[str]:
    if isinstance(value, str):
        s = value.strip()
        # a recorded placeholder is not something anyone said
        if not s or (s.startswith("<") and s.endswith(">")):
            return None
        return s
    if isinstance(value, dict):
        for key in ("text", "reply", "content", "message"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
    return None


def conversation(rows: List[Dict[str, Any]], metadata: Dict[str, Any], egress: Iterable[str] = ()) -> List[Dict[str, Any]]:
    """The run as turns: ``{"who": "user"|"bot", "text", "op", "at"}``, in order."""
    egress = set(egress)
    turns: List[Dict[str, Any]] = []
    for m in metadata.get("playground_script") or []:
        text = m.get("text") if m.get("kind") == "text" else (
            json.dumps(m.get("value"), ensure_ascii=False) if m.get("kind") == "json" else None)
        if text:
            turns.append({"who": "user", "text": text, "op": "playground", "at": m.get("at")})
    sent_by_door = False
    for r in rows:
        at = r.get("wall_start")
        outs = r.get("outputs") or {}
        ins = r.get("inputs") or {}
        if r.get("op_name") in egress:
            text = _text(ins.get("item"))
            if text:
                turns.append({"who": "bot", "text": text, "op": r.get("op_name"), "at": at})
                sent_by_door = True
            continue
        for key in USER_KEYS:
            text = _text(outs.get(key))
            if text:
                turns.append({"who": "user", "text": text, "op": r.get("op_name"), "at": at})
    if not sent_by_door:
        # no door recorded what it sent: an op's text answer is the reply
        for r in rows:
            outs = r.get("outputs") or {}
            for key in BOT_KEYS:
                text = _text(outs.get(key))
                if text:
                    turns.append({"who": "bot", "text": text, "op": r.get("op_name"), "at": r.get("wall_start")})
                    break
    # a script recorded before its messages carried times: a chat
    # alternates, so message i goes just before the i-th reply
    untimed = [t for t in turns if t["op"] == "playground" and t.get("at") is None]
    if untimed:
        replies = sorted(t["at"] for t in turns if t["who"] == "bot" and t.get("at") is not None)
        last = replies[-1] if replies else 0.0
        for i, t in enumerate(untimed):
            t["at"] = replies[i] - 1e-3 if i < len(replies) else last + (i + 1) * 1e-3
    turns.sort(key=lambda t: (t.get("at") is None, t.get("at") or 0))
    return turns
