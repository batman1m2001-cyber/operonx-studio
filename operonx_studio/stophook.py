"""The Stop hook that holds a turn to what it says it did (docs/TURN_HONESTY_PLAN.md S1–S3, WORKSPACE_PLAN T1–T2, R7).

On mr-finance PR #74 the assistant marked FF5 and the plan done at 24 flows against "< 20", called two failing
tests "pre-existing" without running them anywhere else, and ended with its own steps still open. Each was one
line in a long turn, and the owner found them only by reading everything. Before the turn ends, this reads its
transcript and, once, sends the model back when the turn:

    S1  moved a card to done                         name the evidence per card, and that it was met the plan's way
    S2  ended on failing tests, never checked them   run failing_on_base: fails on base too, or new
    S3  left steps of its own pending or active      finish them, skip them with a reason, or say what is left
    T2  ends saying it has not checked something     check it now, or say why it cannot be checked
    R7  left a board.md the board cannot read        fix it (CYCLES_PLAN: cards and cycles are the board)

    python -I stophook.py      stdin: the hook's JSON; stdout: {"decision": "block", "reason": …}, or nothing

Once: when the CLI says the stop was already sent back (stop_hook_active), the turn ends as the model chose; what
it did with the reason is then in its reply. Any doubt, and the turn ends untouched.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, Iterator, List, Optional, Tuple

EDITS = ("Edit", "MultiEdit", "Write")
_BOARD_FILE = re.compile(r"(?:^|/)docs/brd/board\.md$")
_CARD_DONE = re.compile(r"^### (C\d+) · .+ · done\s*$", re.M)
_SHELL_DONE = re.compile(r"\bboard\s+(C\d+)\s+done\b")
MOVE = "mcp__studio__board_move"
# pytest's last line: "2 failed, 1378 passed, 3 skipped in 412.31s (0:06:52)"
_SUMMARY = re.compile(r"((?:\d+ (?:failed|passed|skipped|errors?|deselected|xfailed|xpassed|warnings?|rerun)"
                      r"(?:, )?)+) in [\d.]+s\b")
_FAILED = re.compile(r"(\d+) (?:failed|errors?)\b")
OPEN = ("pending", "active")
# "I haven't checked whether they exist on main." First person only: "R12 is not verified" is a BRD status.
_BREAK = re.compile(r"[.!?:](?=\s|$)|\n")  # a sentence's edge, not the dot in "notes.txt"
_A = r"[’']"
_UNCHECKED = re.compile(
    rf"\b(?:I|we)\s+(?:have\s+not|haven{_A}t|did\s+not|didn{_A}t|could\s+not|couldn{_A}t|cannot|can{_A}t|"
    rf"was\s+not\s+able\s+to|wasn{_A}t\s+able\s+to)\s+(?:yet\s+)?(?:check|verif|run|ran|test|confirm)\w*", re.I)


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(_text(b.get("text") if b.get("type") == "text" else b.get("content"))
                         for b in content if isinstance(b, dict))
    return ""


def _is_prompt(entry: Dict[str, Any]) -> bool:
    """A message the person typed: not a tool's result, not a note the CLI or the studio added."""
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return False
    text = _text(content).lstrip()
    return bool(text) and not text.startswith(("<task-notification>", "<system-reminder>", "Stop hook feedback",
                                                "<local-command", "<command-"))


def this_turn(lines: List[str]) -> List[Dict[str, Any]]:
    """The transcript's entries since the last prompt the person typed."""
    entries = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    start = max((i for i, e in enumerate(entries) if _is_prompt(e)), default=-1)
    return entries[start + 1:]


def events(entries: List[Dict[str, Any]]) -> Iterator[Tuple[str, Dict[str, Any], Dict[str, Any]]]:
    """In order: ("call", the tool_use block, {}), ("result", the tool_result block, its toolUseResult),
    ("note", {"text": …}, {}) for anything else the turn was told (a background task's end)."""
    for e in entries:
        content = (e.get("message") or {}).get("content")
        if e.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    yield "call", b, {}
        elif e.get("type") == "user":
            if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result"
                                                 for b in content):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        extra = e.get("toolUseResult")
                        yield "result", b, extra if isinstance(extra, dict) else {}
            else:
                yield "note", {"text": _text(content)}, {}


def cards_done(evs: List[Tuple[str, Dict[str, Any], Dict[str, Any]]]) -> List[str]:
    """S1: the cards this turn moved to done: ``board_move``, ``operonx-project board C4 done``, or an edit of
    ``docs/brd/board.md`` that set a card's heading to done."""
    calls = {b.get("id"): b for kind, b, _ in evs if kind == "call"}
    found: List[str] = []
    for kind, b, extra in evs:
        if kind != "result" or b.get("is_error"):
            continue
        call = calls.get(b.get("tool_use_id")) or {}
        name, inp = call.get("name"), call.get("input") or {}
        path = str(inp.get("file_path") or "")
        ids: set = set()
        if name == MOVE and inp.get("to") == "done" and not _text(b.get("content")).startswith("refused"):
            ids = {str(inp.get("card") or "")}
        elif name in EDITS and _BOARD_FILE.search(path):
            pairs = [(inp.get("old_string"), inp.get("new_string"))] if name == "Edit" else \
                [(x.get("old_string"), x.get("new_string")) for x in inp.get("edits") or [] if isinstance(x, dict)] \
                if name == "MultiEdit" else [(extra.get("originalFile"), inp.get("content"))]
            for old, new in pairs:
                ids |= set(_CARD_DONE.findall(new or "")) - set(_CARD_DONE.findall(old or ""))
        elif name == "Bash":
            ids = set(_SHELL_DONE.findall(str(inp.get("command") or "")))
        found += [i for i in sorted(ids) if i and i not in found]
    return found


def failing_unchecked(evs: List[Tuple[str, Dict[str, Any], Dict[str, Any]]]) -> Optional[str]:
    """S2: the last test summary the turn saw, when it has failures and no failing_on_base call came after it."""
    last, at = None, -1
    for n, (kind, b, _) in enumerate(evs):
        if kind in ("result", "note"):
            text = _text(b.get("content")) if kind == "result" else b.get("text", "")
            for m in _SUMMARY.finditer(text):
                last, at = m.group(0), n
    if last is None or not sum(int(x) for x in _FAILED.findall(last)):
        return None
    if any(kind == "call" and str(b.get("name", "")).endswith("failing_on_base") for kind, b, _ in evs[at + 1:]):
        return None
    return last


def steps_open(evs: List[Tuple[str, Dict[str, Any], Dict[str, Any]]]) -> List[str]:
    """S3: the titles of the steps the turn's last steps card left pending or active."""
    last = None
    for kind, b, _ in evs:
        if kind == "call" and str(b.get("name", "")).endswith("__steps"):
            last = (b.get("input") or {}).get("steps")
    if not isinstance(last, list):
        return []
    return [str(s.get("title")) for s in last if isinstance(s, dict) and str(s.get("state") or "pending") in OPEN]


def unchecked(entries: List[Dict[str, Any]]) -> Optional[str]:
    """T2: the sentence of the turn's last reply (its text after the last tool call) that says something is
    not checked."""
    reply: List[str] = []
    for e in entries:
        content = (e.get("message") or {}).get("content")
        if e.get("type") != "assistant" or not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                reply = []
            elif isinstance(b, dict) and b.get("type") == "text":
                reply.append(str(b.get("text") or ""))
    text = "\n".join(reply)
    m = _UNCHECKED.search(text)
    if not m:
        return None
    starts = [x.end() for x in _BREAK.finditer(text, 0, m.start())]
    end = _BREAK.search(text, m.end())
    return " ".join(text[starts[-1] if starts else 0:end.start() if end else len(text)].split()).strip("*- ")


def board_unreadable(evs: List[Tuple[str, Dict[str, Any], Dict[str, Any]]]) -> Dict[str, str]:
    """R7: {board.md this turn edited: why the board cannot read it}."""
    try:
        from operonx_project import board
    except ImportError:
        return {}
    paths = {str((b.get("input") or {}).get("file_path") or "") for kind, b, _ in evs
             if kind == "call" and b.get("name") in EDITS}  # fmt: skip
    out = {}
    for path in sorted(p for p in paths if _BOARD_FILE.search(p)):
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        try:
            board.parse_all(text)
        except board.BoardError as exc:
            out[path] = str(exc)
    return out


def reason(lines: List[str]) -> Optional[str]:
    entries = this_turn(lines)
    evs = list(events(entries))
    out = []
    done = cards_done(evs)
    if done:
        out.append(f"You moved to done: {', '.join(done)}. For each, quote the evidence that its exit criteria are "
                   "met (the command and the numbers it printed), and say that you met them the way the plan says "
                   "(its table, its decisions): a target reached another way, or criteria skipped, deferred or "
                   "changed, is the owner's call, so move the card back to doing, say what you did and ask.")
    failed = failing_unchecked(evs)
    if failed:
        out.append(f"The last test run ended with \"{failed}\". Call failing_on_base with those test ids before "
                   "you call any of them pre-existing, and give the owner its answer.")
    left = steps_open(evs)
    if left:
        out.append(f"Your steps card still has {len(left)} step(s) pending or active ({'; '.join(left[:4])}). "
                   "Finish them, mark them skipped with the reason, or post the card with what is left as "
                   "waiting or blocked.")
    bad = board_unreadable(evs)
    if bad:
        out.append("The board cannot read " + "; ".join(f"{p} ({why})" for p, why in bad.items()) + ". Fix it "
                   "(board_card and board_move write it; never by hand), so the board shows the cards as they stand.")
    said = unchecked(entries)
    if said:
        out.append(f"You wrote \"{said}\". Check it now (on_base runs a command on the base branch), or say why "
                   "it cannot be checked in this turn.")
    if not out:
        return None
    return "Before you end the turn (the studio checks this once):\n- " + "\n- ".join(out)


def decide(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if event.get("stop_hook_active") or not event.get("transcript_path"):
        return None
    with open(event["transcript_path"], encoding="utf-8") as fh:
        why = reason(fh.readlines())
    return {"decision": "block", "reason": why} if why else None


def main() -> None:
    try:
        out = decide(json.load(sys.stdin))
    except Exception:  # noqa: BLE001 — a hook that fails must let the turn end
        return
    if out is not None:
        sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
