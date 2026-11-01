"""The Stop hook that holds a turn to what it says it did (docs/TURN_HONESTY_PLAN.md S1–S3).

On mr-finance PR #74 the assistant marked FF5 and the plan done at 24 flows against "< 20", called two failing
tests "pre-existing" without running them anywhere else, and ended with its own steps still open. Each was one
line in a long turn, and the owner found them only by reading everything. Before the turn ends, this reads its
transcript and, once, sends the model back when the turn:

    S1  marked a plan phase (or a plan) done        name the evidence per phase, or set it back to in_progress
    S2  ended on failing tests, never checked them   run failing_on_base: fails on base too, or new
    S3  left steps of its own pending or active      finish them, skip them with a reason, or say what is left

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
_PLAN_FILE = re.compile(r"PLAN[\w.-]*\.md$", re.I)
_PHASE_DONE = re.compile(r"\{\s*id:\s*([\w.-]+)[^}\n]*\bstatus:\s*[\"']?done\b")
_PLAN_DONE = re.compile(r"^status:\s*[\"']?done\b", re.M)
_SHELL_DONE = re.compile(r"[\w./-]*PLAN[\w.-]*\.md", re.I), re.compile(r"status:\s*[\"']?done\b")
# pytest's last line: "2 failed, 1378 passed, 3 skipped in 412.31s (0:06:52)"
_SUMMARY = re.compile(r"((?:\d+ (?:failed|passed|skipped|errors?|deselected|xfailed|xpassed|warnings?|rerun)"
                      r"(?:, )?)+) in [\d.]+s\b")
_FAILED = re.compile(r"(\d+) (?:failed|errors?)\b")
OPEN = ("pending", "active")


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


def _done(text: str) -> Tuple[set, bool]:
    return set(_PHASE_DONE.findall(text or "")), bool(_PLAN_DONE.search(text or ""))


def plans_done(evs: List[Tuple[str, Dict[str, Any], Dict[str, Any]]]) -> Dict[str, List[str]]:
    """S1: {plan file: [phases this turn set to done, "the plan" when its own status]}."""
    calls = {b.get("id"): b for kind, b, _ in evs if kind == "call"}
    found: Dict[str, List[str]] = {}

    def add(path: str, ids: set, plan: bool) -> None:
        got = found.setdefault(path, [])
        got += [i for i in sorted(ids) if i not in got]
        if plan and "the plan" not in got:
            got.append("the plan")

    for kind, b, extra in evs:
        if kind != "result" or b.get("is_error"):
            continue
        call = calls.get(b.get("tool_use_id")) or {}
        name, inp = call.get("name"), call.get("input") or {}
        path = str(inp.get("file_path") or "")
        if name in EDITS and _PLAN_FILE.search(path):
            pairs = [(inp.get("old_string"), inp.get("new_string"))] if name == "Edit" else \
                [(x.get("old_string"), x.get("new_string")) for x in inp.get("edits") or [] if isinstance(x, dict)] \
                if name == "MultiEdit" else [(extra.get("originalFile"), inp.get("content"))]
            for old, new in pairs:
                (was, plan_was), (now, plan_now) = _done(old), _done(new)
                if now - was or (plan_now and not plan_was):
                    add(path, now - was, plan_now and not plan_was)
        elif name == "Bash":
            cmd = str(inp.get("command") or "")
            m = _SHELL_DONE[0].search(cmd)
            if m and _SHELL_DONE[1].search(cmd):
                add(m.group(0), set(), False)
    return {p: ids for p, ids in found.items()}


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


def reason(lines: List[str]) -> Optional[str]:
    evs = list(events(this_turn(lines)))
    out = []
    plans = plans_done(evs)
    if plans:
        what = "; ".join(f"{p}: {', '.join(ids) or 'a phase'}" for p, ids in plans.items())
        out.append(f"You marked done: {what}. For each, quote the evidence that its exit criteria are met (the "
                   "command and the numbers it printed). If one is not met, set it back to in_progress: skipping "
                   "or deferring a phase, or changing its criteria, is the owner's call, so ask.")
    failed = failing_unchecked(evs)
    if failed:
        out.append(f"The last test run ended with \"{failed}\". Call failing_on_base with those test ids before "
                   "you call any of them pre-existing, and give the owner its answer.")
    left = steps_open(evs)
    if left:
        out.append(f"Your steps card still has {len(left)} step(s) pending or active ({'; '.join(left[:4])}). "
                   "Finish them, mark them skipped with the reason, or post the card with what is left as "
                   "waiting or blocked.")
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
