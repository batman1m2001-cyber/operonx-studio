"""What a turn leaves behind (docs/TURN_HONESTY_PLAN.md S1–S3).

Gates: each turn's settings hand the CLI the Stop hook (and the shell hook), each switch off on its own; the
worktrees a turn created are found against its snapshot, a card's own are not; Remove keeps git's checks — a
worktree with changes stays, an unmerged branch stays, a merged one goes — and only a linked worktree of the
project can be named.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from operonx_studio import chat
from operonx_studio.assistant import ChatStore, Relay, Turn

pytestmark = pytest.mark.unit


def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True,
                   capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_WORKTREES", str(tmp_path / "cards"))
    (tmp_path / "cards").mkdir()
    r = tmp_path / "repo"
    r.mkdir()
    (r / "a.txt").write_text("a\n")
    _git(r, "init", "-q", "-b", "main")
    _git(r, "add", ".")
    _git(r, "commit", "-qm", "base")
    return r


def test_the_worktrees_a_turn_made_are_found_and_a_cards_are_not(repo, tmp_path):
    _git(repo, "worktree", "add", "-q", "-b", "old", str(tmp_path / "old"))
    snap = chat.snapshot(repo)
    _git(repo, "worktree", "add", "-q", "-b", "ff/a", str(tmp_path / "ff-a"))
    _git(repo, "worktree", "add", "-q", "--detach", str(tmp_path / "ff-b"))
    _git(repo, "worktree", "add", "-q", "-b", "card", str(tmp_path / "cards" / "m1-C1"))
    got = chat.worktrees_since(repo, snap)
    assert got == [{"path": str(tmp_path / "ff-a"), "branch": "ff/a"}, {"path": str(tmp_path / "ff-b"), "branch": ""}]


def test_remove_keeps_gits_checks(repo, tmp_path):
    for name in ("merged", "ahead", "dirty"):
        _git(repo, "worktree", "add", "-q", "-b", name, str(tmp_path / name))
    (tmp_path / "ahead" / "b.txt").write_text("b\n")
    _git(tmp_path / "ahead", "add", ".")
    _git(tmp_path / "ahead", "commit", "-qm", "ahead")
    (tmp_path / "dirty" / "a.txt").write_text("changed\n")

    assert chat.remove_worktree(repo, str(tmp_path / "merged")) == {"removed": True, "branch": "merged",
                                                                     "branch_deleted": True}
    assert chat.remove_worktree(repo, str(tmp_path / "ahead")) == {"removed": True, "branch": "ahead",
                                                                    "branch_deleted": False}
    kept = chat.remove_worktree(repo, str(tmp_path / "dirty"))
    assert kept["removed"] is False and "modified or untracked" in kept["error"]
    assert (tmp_path / "dirty" / "a.txt").read_text() == "changed\n"
    assert chat.remove_worktree(repo, str(repo))["error"] == "not a linked worktree of this project"
    assert chat.remove_worktree(repo, "/etc")["removed"] is False


@pytest.mark.parametrize("live,checks,want", [("on", "on", {"PreToolUse", "Stop"}), ("off", "on", {"Stop"}),
                                              ("on", "off", {"PreToolUse"}), ("off", "off", None)])
def test_each_turns_settings_carry_the_hooks(tmp_path, monkeypatch, live, checks, want):
    monkeypatch.setenv("OPERONX_STUDIO_LIVE_TESTS", live)
    monkeypatch.setenv("OPERONX_STUDIO_TURN_CHECKS", checks)
    relay = Relay(ChatStore(tmp_path / "chat.sqlite"))
    path = relay._live_calls(Turn(id="t1", session="s", scope="home"))
    if want is None:
        assert path is None
        return
    hooks = json.loads(Path(path).read_text())["hooks"]
    assert set(hooks) == want
    if "Stop" in hooks:
        assert hooks["Stop"][0]["hooks"][0]["command"].endswith("stophook.py")


def test_the_owner_sees_the_turn_was_sent_back(tmp_path):
    relay = Relay(ChatStore(tmp_path / "chat.sqlite"))
    turn = Turn(id="t1", session="s", scope="home")
    relay._translate(turn, {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": (
        "Stop hook feedback:\nBefore you end the turn (the studio checks this once):\n- Run failing_on_base.\n"
        "- Your steps card still has 1 step(s) pending.")}]}})
    (note,) = turn.items.values()
    assert note["kind"] == "note"
    assert note["text"] == ("The studio sent this turn back once: Run failing_on_base. · "
                            "Your steps card still has 1 step(s) pending.")
