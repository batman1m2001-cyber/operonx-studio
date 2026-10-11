"""The review queue's two halves: a run read as a conversation, and the
reviews people leave on runs.

**Reviews** are one JSON line each in ``<project>/.operonx/reviews.jsonl``
— the run, good or bad, labels, a note, who, when — kept beside the runs
they judge; the latest line for a run is its review. Recording the user
from the first line is what lets a team server share them later.

**A conversation** is what a reviewer reads instead of a trace tree. It is
read out of the run's own rows, by rules that hold for any product — a
callbot, a chatbot, anything with a door:

* the **user's** turns: what came in through the ingress door (the item an
  op downstream of it received — the door itself is transient and records
  no item), what a playground toy sent (its script, which then stands for
  the door), and anything recorded as a ``transcript``;
* the **bot's**: what the service sent through its egress door or, with no
  door that recorded it, an op's text answer (``reply``, ``response``,
  ``answer``, ``text``, ``content``) — unless it is the user's own words
  passing through the pipeline.

The same words on the same side one after another are one turn naming
every op that produced them. Each turn names its op (and its step, when
the row says which execution it was), so a reader can go from the
sentence to the execution.
"""

from __future__ import annotations

import json
import re
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
        # a recorded placeholder (`<audio …>`) or a marker word (`[Silent]`)
        # is not something anyone said
        if not s or (s.startswith("<") and s.endswith(">")) or re.fullmatch(r"\[[^\]\s]+\]", s):
            return None
        return s
    if isinstance(value, dict):
        for key in ("text", "reply", "content", "message"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
    return None


def sent_script(metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
    """What the user sent in a run, as toy messages: a playground session's
    script, or a replayable service's (``Service(replay=True)``)."""
    return list(metadata.get("playground_script") or metadata.get("replay_script") or [])


def sent_query(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """The connection query that came with :func:`sent_script`."""
    return dict(metadata.get("playground_query") or metadata.get("replay_query") or {})


def _step(row: Dict[str, Any]) -> Optional[str]:
    """The execution a row records, as the run page names it."""
    if row.get("op_id"):
        return str(row["op_id"])
    if not row.get("op_full_name"):
        return None
    ctx = row.get("ctx")
    if isinstance(ctx, (list, tuple)):
        ctx = ".".join(str(c) for c in ctx)
    return f"{row['op_full_name']}#{ctx}"


def _turn(who: str, text: str, row: Dict[str, Any]) -> Dict[str, Any]:
    t = {"who": who, "text": text, "op": row.get("op_name"), "at": row.get("wall_start")}
    step = _step(row)
    if step:
        t["step"] = step
    return t


def _merged(turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The same words on the same side, one after another, as one turn: a
    greeting an op wrote and the next op passed on is said once."""
    out: List[Dict[str, Any]] = []
    for t in turns:
        last = out[-1] if out else None
        if last and last["who"] == t["who"] and last["text"] == t["text"]:
            ops = last.setdefault("ops", [last["op"]])
            if t["op"] not in ops:
                ops.append(t["op"])
            continue
        out.append(t)
    for t in out:
        if len(t.get("ops") or []) < 2:
            t.pop("ops", None)
    return out


def conversation(rows: List[Dict[str, Any]], metadata: Dict[str, Any], egress: Iterable[str] = (),
                 ingress: Iterable[str] = ()) -> List[Dict[str, Any]]:
    """The run as turns: ``{"who": "user"|"bot", "text", "op", "at"}`` (and
    ``step``, ``ops`` when known), in order."""
    egress, ingress = set(egress), set(ingress)
    turns: List[Dict[str, Any]] = []
    script = sent_script(metadata)
    for m in script:
        text = m.get("text") if m.get("kind") == "text" else (
            json.dumps(m.get("value"), ensure_ascii=False) if m.get("kind") == "json" else None)
        if text:
            turns.append({"who": "user", "text": text, "op": "playground" if "playground_script" in metadata else "client",
                          "at": m.get("at")})
    sent_by_door = False
    heard: set = set()        # the ingress items already read (one turn each)
    fed: List[Dict[str, Any]] = []   # what came in through the door, in order
    for r in rows:
        outs = r.get("outputs") or {}
        ins = r.get("inputs") or {}
        if r.get("op_name") in egress:
            text = _text(ins.get("item"))
            if text:
                turns.append(_turn("bot", text, r))
                sent_by_door = True
            continue
        if ingress:
            # the door is transient: its item is what the op it fed received
            for u in r.get("upstreams") or []:
                src = u.get("from_op_name") or u.get("from")
                key = u.get("from_op_id") or src
                if src in ingress and u.get("from_key", "item") == "item" and key not in heard:
                    heard.add(key)
                    text = _text(ins.get(u.get("to_key")))
                    if text:
                        fed.append(_turn("user", text, r))
        for key in USER_KEYS:
            text = _text(outs.get(key))
            if text:
                turns.append(_turn("user", text, r))
    if script:
        # the script already holds what was sent; its messages open the
        # steps their items fed, in order
        sent = [t for t in turns if t["who"] == "user" and t["op"] in ("playground", "client")]
        for t, f in zip(sent, fed):
            if t["text"] == f["text"] and f.get("step"):
                t["step"] = f["step"]
    else:
        turns.extend(fed)
    if not sent_by_door:
        # no door recorded what it sent: an op's text answer is the reply —
        # unless it is the user's own words passing through the pipeline
        said = {t["text"] for t in turns if t["who"] == "user"}
        for r in rows:
            outs = r.get("outputs") or {}
            for key in BOT_KEYS:
                text = _text(outs.get(key))
                if text:
                    if text not in said:
                        turns.append(_turn("bot", text, r))
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
    return _merged(turns)
