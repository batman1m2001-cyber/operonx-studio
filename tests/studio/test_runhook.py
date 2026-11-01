"""The hook that wraps every shell call (docs/EXECUTION_PROGRESS_PLAN.md D1, D3).

Gates: a wrapped command means exactly what it meant — its output, its exit status, the directory it leaves, on
real bash, for chains, `exit`, `set -e`, heredocs, comments, `$?`, stdin — and its output also lands in the call's
file, with the shell's pid, each part's start and the end; a plain chain is split into parts and nothing else is;
a command that starts a job of its own in the background, a non-bash shell or an odd call id runs as written.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess

import pytest

from operonx_studio import runhook

pytestmark = [pytest.mark.unit, pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")]


def _wrap(cmd: str, tmp_path, call: str = "t1", **inp) -> str:
    ev = {"tool_name": "Bash", "tool_use_id": call, "tool_input": {"command": cmd, **inp}}
    return runhook.rewrite(ev, str(tmp_path))["hookSpecificOutput"]["updatedInput"]["command"]


def _run(cmd: str, cwd) -> subprocess.CompletedProcess:
    # the way the CLI runs a call: an eval in a fresh bash, stdin closed, the directory read after it
    return subprocess.run(["bash", "-c", 'eval "$1" < /dev/null; echo "<rc=$? cwd=$(pwd)>"', "_", cmd], cwd=cwd,
                          capture_output=True, text=True, timeout=30)


MEANING = [
    "echo one && echo two >&2 && false",
    "cd sub && echo in",
    "cd sub; pwd && cd ..",
    "exit 3",
    "echo a; exit 4; echo never",
    "kill -INT $$",
    "set -e; false; echo never",
    "set -e\necho a\nfalse\necho never",
    "cat <<EOF\nhello there\nEOF",
    "echo a # a comment",
    "true && false || echo recovered",
    "false; echo \"rc=$?\"",
    "false && echo no; echo after",
    "read x; echo \"got:$x\"",
    "python3 -c 'import sys; print(1); sys.exit(4)'",
    "ls /nonexistent-ox 2>&1 | head -1; echo $?",
    "a=1; echo \"a=$a\"",
    "f() { echo f; }; f",
    "printf abc",
    "echo x &&\n  echo y\necho z",
    "for i in 1 2; do echo $i; done && echo loop",
]


@pytest.mark.parametrize("cmd", MEANING)
def test_a_wrapped_command_means_what_it_meant(cmd, tmp_path, monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/bash")
    (tmp_path / "sub").mkdir()
    live = tmp_path / "live"
    live.mkdir()
    plain = _run(cmd, tmp_path)
    wrapped = _run(_wrap(cmd, live), tmp_path)
    # the wrap sends stderr where stdout goes (the CLI shows the two together anyway)
    assert sorted((wrapped.stdout + wrapped.stderr).splitlines()) == sorted((plain.stdout + plain.stderr).splitlines())
    assert wrapped.returncode == plain.returncode
    out = (live / "t1.out").read_text()
    # a marker can follow output that did not end its line: it is found by its \x1e, never by where it starts
    shown = re.sub(r"\x1eox (start|part|end) [^\n]*\n", "", out)
    assert "\x1e" not in shown
    for line in plain.stdout.splitlines():
        assert line.split("<rc=")[0] in shown


def test_the_file_has_the_pid_each_part_and_the_end(tmp_path, monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/bash")
    cmd = "cat a.txt && ls -d sub; false; cat b.txt"
    (tmp_path / "sub").mkdir()
    (tmp_path / "a.txt").write_text("lint\n")
    (tmp_path / "b.txt").write_text("build\n")
    run = _run(_wrap(cmd, tmp_path / "sub"), tmp_path)
    assert run.stdout.split("\n")[:3] == ["lint", "sub", "build"]
    out = (tmp_path / "sub" / "t1.out").read_text()
    marks = [m.split() for m in re.findall(r"\x1eox ([^\n]*)\n", out)]
    assert marks[0][0] == "start" and int(marks[0][1]) > 1 and float(marks[0][2]) > 0
    # each part says the status the part before it ended with
    assert [m[:3] for m in marks[1:5]] == [["part", "1", "0"], ["part", "2", "0"], ["part", "3", "0"],
                                           ["part", "4", "1"]]
    assert marks[-1][:2] == ["end", "0"]
    assert out.index("lint") < out.index("part 2") < out.index("sub\n") < out.index("part 4") < out.index("build")
    meta = json.loads((tmp_path / "sub" / "t1.json").read_text())
    assert meta == {"command": cmd, "parts": ["cat a.txt", "ls -d sub", "false", "cat b.txt"], "background": False}


def test_only_a_plain_chain_is_split():
    stages = runhook.stages
    assert stages("ruff check . && pytest -q && npm run build")[1] == ["ruff check .", "pytest -q", "npm run build"]
    # setting up is not a stage, and the marker keeps the operator: a failed cd still skips the tests
    assert stages("cd sub && pytest -q && ruff check .") == (
        "cd sub && __ox_m 1 && pytest -q && __ox_m 2 && ruff check .", ["pytest -q", "ruff check ."])
    assert stages("uv sync\npytest -q  # all of it\nruff check .")[1] == ["uv sync", "pytest -q", "ruff check ."]
    assert stages("make 2>&1 | tail -3; make test")[1] == ["make 2>&1 | tail -3", "make test"]
    assert stages("a &&\n  b")[1] == ["a", "b"]
    assert stages("'a;b' && c")[1] == ["'a;b'", "c"]
    assert stages("echo ${HOME} && make && make test")[1] == ["make", "make test"]
    for cmd in ["pytest -q", "for x in 1; do a; done && b", "cat <<EOF\nx\nEOF\nb", "set -e; a; b", "x=$(a) && b",
                "a & b", "(a; b)", "{ a; b; }", "a && b; case x in y) c;; esac", "f() { a; }; f; g", "a `b` && c",
                "trap 'x' ERR; a; b", "a && && b", "a &&", "echo a; echo b"]:
        assert stages(cmd) == ("", []), cmd


def test_what_is_left_as_written(tmp_path, monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/bash")
    ev = {"tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": {"command": "pytest -q", "timeout": 5}}
    out = runhook.rewrite(ev, str(tmp_path))["hookSpecificOutput"]["updatedInput"]
    assert out["timeout"] == 5 and "{ pytest -q\n}" in out["command"] and f"{tmp_path}/toolu_1.out" in out["command"]
    # every shell call now, the background ones too (the CLI keeps them running; the file shows them going)
    assert runhook.rewrite({**ev, "tool_input": {"command": "ls"}}, str(tmp_path)) is not None
    bg = runhook.rewrite({**ev, "tool_input": {"command": "pytest", "run_in_background": True}}, str(tmp_path))
    assert bg["hookSpecificOutput"]["updatedInput"]["run_in_background"] is True
    assert json.loads((tmp_path / "toolu_1.json").read_text())["background"] is True
    # a job of its own in the background would hold the copy open after the call ended
    for cmd in ["server & sleep 1; curl x", "nohup x > log 2>&1", "setsid x", ""]:
        assert runhook.rewrite({**ev, "tool_input": {"command": cmd}}, str(tmp_path)) is None, cmd
    assert runhook.rewrite({**ev, "tool_input": {"command": "echo 'a & b' 2>&1 && ls &>/dev/null"}}, str(tmp_path))
    assert runhook.rewrite({**ev, "tool_name": "Read"}, str(tmp_path)) is None
    assert runhook.rewrite({**ev, "tool_use_id": "../x"}, str(tmp_path)) is None
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert runhook.rewrite(ev, str(tmp_path)) is None


def test_a_job_left_in_the_background_by_redirect_does_not_hold_the_call(tmp_path, monkeypatch):
    # fd 9 (the copy) is closed for the command: a child that redirected its output holds nothing open
    monkeypatch.setenv("SHELL", "/bin/bash")
    cmd = "python3 -c 'import os,time; os.fork() or time.sleep(20)' > /dev/null 2>&1; echo back"
    ev = {"tool_name": "Bash", "tool_use_id": "t2", "tool_input": {"command": cmd}}
    wrapped = runhook.rewrite(ev, str(tmp_path))["hookSpecificOutput"]["updatedInput"]["command"]
    run = subprocess.run(["bash", "-c", wrapped], capture_output=True, text=True, timeout=10)
    assert run.stdout.strip() == "back"


SEEN = [  # what an mr-finance turn ran, 2026-11-01: an 18-minute suite the page never saw
    "cd w && (uv run pytest -q -p no:cacheprovider tests/ui > out/ui.log 2>&1 &); sleep 1; echo started",
    "cd w && for i in $(seq 1 28); do grep -qE \"[0-9]+ (passed|failed)\" out/ui.log && break; sleep 20; done",
    "until grep -q \"^done$\" /tmp/ff_full.log; do sleep 20; done; tail -c 600 /tmp/ff_full.log",
    "cd w && timeout 590 bash -c 'until ! pgrep -f \"pytest -q\" >/dev/null; do sleep 20; done'; tail out/full.log",
    "sleep 580; tail -c 200 /tmp/ff_full.log",
    "nohup npm run build > b.log 2>&1 &",
    "bash -c 'pytest -q > log 2>&1 &'",
]
LET = [
    "pytest -q tests",
    "for i in $(seq 1 40); do curl -s localhost:8 && break; sleep 0.5; done",   # a server coming up: short
    "server & sleep 1; curl x",
    "sleep 5; cat out.txt",
    "git commit -m 'pytest & ruff in a loop, sleep 60'",
    'git commit -m "fix pytest & ruff" && echo "sleep 99"',
]


def test_a_hidden_long_run_or_a_sleeping_wait_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/bash")
    for cmd in SEEN:
        out = runhook.rewrite({"tool_name": "Bash", "tool_use_id": "t", "tool_input": {"command": cmd}}, str(tmp_path))
        hook = out["hookSpecificOutput"]
        assert hook["permissionDecision"] == "deny" and "run_in_background" in hook["permissionDecisionReason"], cmd
    for cmd in LET:
        assert runhook.refusal(cmd, False) is None, cmd
    # in run_in_background a test run is what the rule asks for
    assert runhook.refusal("pytest -q > log 2>&1 &", True) is None


def test_a_run_piped_into_tail_or_grep_is_copied_before_the_filter():
    f, tee = runhook.filtered, '| tee -a "$__ox_o" '
    assert f("cd w && uv run pytest -q 2>&1 | tail -8") == f"cd w && uv run pytest -q 2>&1 {tee}| tail -8 >&8"
    assert f("pytest -q | grep -E 'passed|failed' && echo ok") == \
        f"pytest -q {tee}| grep -E 'passed|failed' >&8 && echo ok"
    assert f("make 2>&1 | tail -3\nmake test | tail -1  ") == f"make 2>&1 {tee}| tail -3 >&8\nmake test {tee}| tail -1 >&8  "
    for cmd in ["pytest -q", "git log | tail -3", "pytest | tee log | tail", "pytest | tail -3 > last.txt",
                "pytest | tail -3  # the end", "x=$(pytest | tail -1)", "(pytest | tail -1)", "{ pytest | tail; }",
                "for t in a b; do pytest $t | tail -1; done > log", "pytest |& tail", "pytest | head -3",
                "cat <<EOF | tail\npytest\nEOF", "pytest -q || true | tail -1"]:
        assert f(cmd) == cmd, cmd


def test_the_page_sees_a_run_through_tail_as_it_prints(tmp_path, monkeypatch):
    # what the owner's turn ran on PR #74 (`uv run pytest -q 2>&1 | tail -8`): the file stayed at its start marker
    # for the whole run; now it gets each dot as it prints, and the model still reads only the tail
    monkeypatch.setenv("SHELL", "/bin/bash")
    runner = tmp_path / "pytest"
    runner.write_text("#!/bin/bash\nfor i in 1 2 3 4 5 6; do printf .; sleep 0.25; done\n"
                      "echo ' [100%]'; echo '1 failed, 5 passed in 1.50s'; exit 1\n")
    runner.chmod(0o755)
    live = tmp_path / "live"
    live.mkdir()
    cmd = "./pytest 2>&1 | tail -1; echo rc=${PIPESTATUS[0]}"
    proc = subprocess.Popen(["bash", "-c", 'eval "$1" < /dev/null', "_", _wrap(cmd, live)], cwd=tmp_path,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        seen = ""
        for _ in range(40):         # up to 1 s: the run takes 1.5 s
            seen = (live / "t1.out").read_text() if (live / "t1.out").exists() else ""
            if "..." in seen or proc.poll() is not None:
                break
            subprocess.run(["sleep", "0.025"])
        assert "..." in seen and "passed" not in seen
    finally:
        out, _ = proc.communicate(timeout=10)
    assert out.splitlines() == ["1 failed, 5 passed in 1.50s", "rc=1"]
    file = (live / "t1.out").read_text()
    assert file.count("1 failed, 5 passed") == 1 and "......" in file and "rc=1" in file
