"""The Stop hook that holds a turn to what it says it did (docs/TURN_HONESTY_PLAN.md S1–S3).

Gates, on transcripts shaped like the CLI's: a card moved to done (board_move, an Edit or a Write of board.md
against the file before it, ``operonx-project board C4 done``) is sent back with its ids; a card already done,
done in an earlier turn, or a refused move is not (CYCLES_PLAN K2); a last test run
with failures is sent back unless failing_on_base came after it, a passing run is not; steps left pending or
active are sent back, waiting and blocked ones are not; once only (stop_hook_active), and a broken transcript
lets the turn end. WORKSPACE_PLAN T1–T2: S1 also asks how the target was met; a last reply that says it has not
checked something is sent back with that sentence, a reply that only reports a status is not; on the PR #74
transcript, the turn that marked FF6 done is sent back for both and its last turn ("hello ?") for T2.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from operonx_studio import stophook

pytestmark = pytest.mark.unit

BOARD = "/w/docs/brd/board.md"
N = iter(range(10**6))


def prompt(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def call(name, inp):
    cid = f"t{next(N)}"
    return cid, {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": cid, "name": name,
                                                                 "input": inp}]}}


def result(cid, text="ok", extra=None, error=False):
    e = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": cid, "content": text,
                                                   "is_error": error}]}}
    if extra is not None:
        e["toolUseResult"] = extra
    return e


def turn(*steps):
    """steps: entries, or (name, input, result text[, toolUseResult]) for a call and its result."""
    out = []
    for s in steps:
        if isinstance(s, tuple):
            cid, c = call(s[0], s[1])
            out += [c, result(cid, s[2] if len(s) > 2 else "ok", s[3] if len(s) > 3 else None)]
        else:
            out.append(s)
    return [json.dumps(e) for e in out]


def edit(old, new):
    return ("Edit", {"file_path": BOARD, "old_string": old, "new_string": new})


CARD = "### {} · x · {}"


class TestCardDone:
    def test_a_move_to_done_is_sent_back_with_its_id(self):
        why = stophook.reason(turn(prompt("go"), ("mcp__studio__board_move", {"card": "C14", "to": "done"},
                                                  "C14 is done")))
        assert "You moved to done: C14." in why and "back to doing" in why

    def test_a_refused_move_or_a_move_elsewhere_is_not(self):
        assert stophook.reason(turn(prompt("go"), ("mcp__studio__board_move", {"card": "C14", "to": "done"},
                                                   "refused: C14 stays: not passing"),
                                    ("mcp__studio__board_move", {"card": "C15", "to": "doing"}, "C15 is doing"))) \
            is None

    def test_a_board_edit_and_a_write_read_against_the_file_before_it(self):
        why = stophook.reason(turn(prompt("go"), edit(CARD.format("C5", "doing"), CARD.format("C5", "done"))))
        assert ": C5." in why
        before = CARD.format("C1", "done") + "\n" + CARD.format("C6", "todo")
        after = CARD.format("C1", "done") + "\n" + CARD.format("C6", "done")
        why = stophook.reason(turn(prompt("go"), ("Write", {"file_path": BOARD, "content": after}, "ok",
                                                  {"originalFile": before})))
        assert ": C6." in why and "C1" not in why

    def test_the_cli_move(self):
        why = stophook.reason(turn(prompt("go"), ("Bash", {"command": "operonx-project board C7 done --repo ."})))
        assert ": C7." in why

    def test_a_card_already_done_or_another_file_is_not(self):
        assert stophook.reason(turn(prompt("go"), edit(CARD.format("C1", "done"), CARD.format("C1", "done") + "\n"),
                                    ("Edit", {"file_path": "/w/README.md", "old_string": "a",
                                              "new_string": CARD.format("C9", "done")}))) is None

    def test_only_this_turn_counts(self):
        assert stophook.reason(turn(prompt("go"), edit(CARD.format("C5", "todo"), CARD.format("C5", "done")),
                                    prompt("thanks"))) is None

    def test_a_refused_edit_did_nothing(self):
        cid, c = call("Edit", {"file_path": BOARD, "old_string": "", "new_string": CARD.format("C5", "done")})
        lines = [json.dumps(e) for e in (prompt("go"), c, result(cid, "refused", error=True))]
        assert stophook.reason(lines) is None


class TestFailingTests:
    def test_failures_never_checked_on_base(self):
        why = stophook.reason(turn(prompt("go"), ("Bash", {"command": "pytest -q"},
                                                  "...\n2 failed, 1378 passed, 3 skipped in 412.31s (0:06:52)")))
        assert '"2 failed, 1378 passed, 3 skipped in 412.31s"' in why and "failing_on_base" in why

    def test_a_background_run_told_by_a_notification_counts(self):
        why = stophook.reason(turn(prompt("go"), {"type": "user", "message": {"content": (
            "<task-notification>done\n=== 1 failed, 9 passed in 3.0s ===</task-notification>")}}))
        assert "1 failed" in why

    def test_checked_on_base_or_a_later_green_run_is_fine(self):
        red = ("Bash", {"command": "pytest"}, "2 failed, 9 passed in 3.0s")
        assert stophook.reason(turn(prompt("go"), red, ("mcp__studio__failing_on_base", {"tests": ["a"]}))) is None
        assert stophook.reason(turn(prompt("go"), red, ("Bash", {"command": "pytest"}, "11 passed in 3.1s"))) is None

    def test_errors_count_as_failures(self):
        assert "1 error" in stophook.reason(turn(prompt("go"), ("Bash", {"command": "pytest"}, "3 passed, 1 error in 1.0s")))


class TestOpenSteps:
    def steps(self, *states):
        return ("mcp__studio__steps", {"steps": [{"title": f"s{i}", "state": s} for i, s in enumerate(states, 1)]})

    def test_pending_or_active_steps_are_sent_back(self):
        why = stophook.reason(turn(prompt("go"), self.steps("active", "pending", "pending"),
                                   self.steps("done", "active", "pending")))
        assert "2 step(s) pending or active (s2; s3)" in why

    def test_finished_skipped_waiting_or_blocked_is_fine(self):
        assert stophook.reason(turn(prompt("go"), self.steps("done", "skipped", "failed", "waiting"))) is None


def say(*texts, tool=False):
    content = [{"type": "text", "text": t} for t in texts]
    if tool:
        content.append({"type": "tool_use", "id": f"t{next(N)}", "name": "Bash", "input": {"command": "ls"}})
    return {"type": "assistant", "message": {"content": content}}


class TestUnchecked:
    def test_the_last_reply_saying_it_did_not_check_is_sent_back(self):
        why = stophook.reason(turn(prompt("go"), say("Done.\n\n**Still open:** `brd check` reports 4 errors. "
                                                     "I haven\u2019t checked whether they exist on main.")))
        assert "\"I haven't checked whether notes.txt exists\"" in stophook.reason(
            turn(prompt("go"), say("Wrote it. I haven't checked whether notes.txt exists.")))
        assert "\"I haven\u2019t checked whether they exist on main\"" in why and "on_base" in why

    def test_only_the_reply_after_the_last_call_counts(self):
        assert stophook.reason(turn(prompt("go"), say("I didn't run it yet.", tool=True), say("Ran it: 3 passed."))) \
            is None

    def test_a_status_is_not_an_unchecked_claim(self):
        assert stophook.reason(turn(prompt("go"), say("R12 is not verified in the matrix; R13 stays unverified."))) \
            is None

    def test_a_card_done_asks_how_the_target_was_met(self):
        why = stophook.reason(turn(prompt("go"), edit(CARD.format("C6", "doing"), CARD.format("C6", "done"))))
        assert "the way the plan says (its table, its decisions)" in why


def test_a_board_the_board_cannot_read_is_sent_back(tmp_path):
    """R7, on the board: an edit by hand that leaves board.md unreadable is sent back."""
    pytest.importorskip("operonx_project.board")
    f = tmp_path / "docs" / "brd" / "board.md"
    f.parent.mkdir(parents=True)
    f.write_text("# Board\n\n## FF · flows · open\n\n### C1 · a · todo\n\n## FF · again · open\n")
    wrote = ("Write", {"file_path": str(f), "content": f.read_text()})
    why = stophook.reason(turn(prompt("go"), wrote))
    assert f"The board cannot read {f}" in why and "FF" in why
    f.write_text("# Board\n\n## FF · flows · open\n\n### C1 · a · todo\n")
    assert stophook.reason(turn(prompt("go"), wrote)) is None


PR74 = Path("/root/.claude/projects/-home-thanglq-mr-finance/06cd02b8-f31b-448d-93ad-5592b19ceb3e.jsonl")


@pytest.mark.skipif(not PR74.exists(), reason="the PR #74 transcript is on the owner's machine")
def test_the_pr74_turns_are_sent_back():
    lines = PR74.read_text().splitlines()
    ff6 = stophook.reason(lines[:550])  # FF6 was a plan phase then; a card's move is TestCardDone's
    assert "I haven't checked whether they exist on main" in ff6
    assert "I haven't checked them against main" in stophook.reason(lines)


def _hook(tmp_path: Path, lines, active=False) -> str:
    t = tmp_path / "t.jsonl"
    t.write_text("\n".join(lines) + "\n")
    ev = json.dumps({"transcript_path": str(t), "stop_hook_active": active, "hook_event_name": "Stop"})
    hook = Path(stophook.__file__)
    return subprocess.run([sys.executable, "-I", str(hook)], input=ev, capture_output=True, text=True).stdout


def test_the_hook_blocks_once(tmp_path):
    lines = turn(prompt("go"), edit(CARD.format("C5", "todo"), CARD.format("C5", "done")))
    out = json.loads(_hook(tmp_path, lines))
    assert out["decision"] == "block" and "C5" in out["reason"]
    assert _hook(tmp_path, lines, active=True) == ""


def test_a_clean_turn_or_a_broken_transcript_ends_untouched(tmp_path):
    assert _hook(tmp_path, turn(prompt("go"), ("Bash", {"command": "ls"}))) == ""
    assert subprocess.run([sys.executable, "-I", stophook.__file__], input="{not json", capture_output=True,
                          text=True).stdout == ""
