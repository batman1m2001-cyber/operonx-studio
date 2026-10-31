"""A test run as a fact (operonx_studio/testreport.py, docs/VISUAL_CHAT_PLAN.md D6).

The pytest, node 18 (TAP) and cargo outputs in fixtures/testoutput/ were recorded from real runs. jest, vitest, go and
the node 20+ spec reporter are not installed on the box this was written on: their samples below are SYNTHETIC,
written from each runner's documented output.
"""

from pathlib import Path

from operonx_studio import testreport

OUT = Path(__file__).parent / "fixtures" / "testoutput"


def read(name):
    return (OUT / name).read_text()


def test_pytest_recorded_failures_with_first_error_line():
    rep = testreport.parse("pytest -q", read("pytest_q_fail.txt"))
    assert (rep["runner"], rep["passed"], rep["failed"], rep["skipped"], rep["ms"]) == ("pytest", 2, 2, 1, 50)
    assert [(f["id"], f["line"]) for f in rep["failures"]] == [
        ("test_demo.py::test_lane", "KeyError: 'lane'"), ("test_demo.py::test_eq", "assert [1, 2] == [1, 3]")]
    assert "test_lane" in rep["failures"][0]["context"]


def test_pytest_recorded_pass_and_verbose():
    assert testreport.parse("uv run pytest -q -k x", read("pytest_q_pass.txt"))["passed"] == 2
    assert testreport.parse("python -m pytest", read("pytest_fail.txt"))["failed"] == 2


def test_node_tap_recorded():
    rep = testreport.parse("node --test tests/js/", read("node_fail.txt"))
    assert (rep["passed"], rep["failed"], rep["skipped"], rep["ms"]) == (1, 1, 1, 451)
    assert rep["failures"] == [{"id": "lane key", "line": "Expected values to be strictly equal:",
                                "context": rep["failures"][0]["context"]}]


def test_cargo_recorded():
    rep = testreport.parse("cargo test", read("cargo_fail.txt"))
    assert (rep["passed"], rep["failed"], rep["skipped"]) == (1, 1, 1)
    assert rep["failures"][0]["id"] == "tests::lane"
    assert "lane key" in rep["failures"][0]["line"]


def test_no_summary_no_report():
    assert testreport.parse("pytest -q", "ImportError while loading conftest") is None
    assert testreport.parse("ls -la", read("pytest_q_fail.txt")) is None, "not a test command"
    assert testreport.parse("pytest", "") is None


def test_the_whole_output_is_read_not_the_clip():
    big = "x" * 9000 + "\n" + read("pytest_q_fail.txt")
    assert testreport.parse("pytest", big)["failed"] == 2


def test_command_detection():
    for c in ["pytest -q", "cd a && uv run pytest tests/", "python3 -m pytest", "node --test tests/js/",
              "npm test", "pnpm run test", "go test ./...", "cargo test", "npx vitest run", "npx jest"]:
        assert testreport.is_test(c), c
    for c in ["git status", "cat pytest.ini", "npm run build", "echo test"]:
        assert not testreport.is_test(c), c


# SYNTHETIC samples below (the runners are not installed here)

JEST = """FAIL src/lane.test.js
  ● lanes › keeps the key

    expect(received).toBe(expected) // Object.is equality

PASS src/ok.test.js

Tests:       1 failed, 1 skipped, 5 passed, 7 total
Time:        1.234 s
"""

VITEST = """ FAIL  src/lane.test.ts > lanes > keeps the key
AssertionError: expected 1 to be 2

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 9 passed (10)
   Duration  812ms
"""

GO = """--- FAIL: TestLane (0.00s)
    lane_test.go:12: got 1, want 2
--- PASS: TestOther (0.00s)
FAIL
FAIL	example.com/lane	0.004s
"""

NODE_SPEC = """✔ ok one (0.5ms)
✖ lane key (1.2ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
ℹ tests 2
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 41.5
"""


def test_jest_synthetic():
    rep = testreport.parse("npx jest", JEST)
    assert (rep["runner"], rep["passed"], rep["failed"], rep["skipped"], rep["ms"]) == ("jest", 5, 1, 1, 1234)
    assert rep["failures"][0]["id"] == "lanes › keeps the key"
    assert rep["failures"][0]["line"].startswith("expect(received)")


def test_vitest_synthetic():
    rep = testreport.parse("npx vitest run", VITEST)
    assert (rep["runner"], rep["passed"], rep["failed"], rep["ms"]) == ("vitest", 9, 1, 812)
    assert rep["failures"][0]["line"] == "AssertionError: expected 1 to be 2"


def test_go_synthetic():
    rep = testreport.parse("go test ./...", GO)
    assert (rep["passed"], rep["failed"], rep["ms"]) == (1, 1, 4)
    assert rep["failures"] == [{"id": "TestLane", "line": "lane_test.go:12: got 1, want 2",
                                "context": rep["failures"][0]["context"]}]


def test_node_spec_synthetic_via_npm():
    rep = testreport.parse("npm test", NODE_SPEC)
    assert (rep["runner"], rep["passed"], rep["failed"], rep["ms"]) == ("node --test", 1, 1, 42)
    assert rep["failures"][0]["id"] == "lane key"
    assert "strictly equal" in rep["failures"][0]["line"]


def test_a_failure_context_is_its_own_section_only():
    rep = testreport.parse("pytest", read("pytest_fail.txt"))
    lane = rep["failures"][0]["context"]
    assert "KeyError" in lane and "test_eq" not in lane


# ── a run still going (D6, live) ──────────────────────────────────────────

def test_progress_counts_what_ran_so_far():
    # pytest -q prints its dots without a newline: a growing line counts as it grows
    assert testreport.progress("pytest -q", "")  is None
    r = testreport.progress("pytest -q tests", ".......F...")
    assert (r["runner"], r["passed"], r["failed"], r["live"], r["pct"]) == ("pytest", 10, 1, True, None)
    r = testreport.progress("pytest -v", "tests/a.py::t1 PASSED   [ 10%]\ntests/a.py::t2 FAILED   [ 20%]\ntests/a.py::t3 PASS")
    assert (r["passed"], r["failed"], r["pct"]) == (1, 1, 20)
    r = testreport.progress("pytest", "tests/test_a.py ..s.F                          [ 40%]\n")
    assert (r["passed"], r["failed"], r["skipped"], r["pct"]) == (3, 1, 1, 40)
    assert testreport.progress("cargo test", "test a ... ok\ntest b ... FAILED\n")["failed"] == 1
    assert testreport.progress("go test -v ./...", "--- PASS: TestA (0.00s)\n")["passed"] == 1
    assert testreport.progress("node --test", "ok 1 - a\nnot ok 2 - b\n")["failed"] == 1
    assert testreport.progress("ls", "...") is None


def test_the_hook_rewrites_only_a_foreground_test_command(tmp_path, monkeypatch):
    from operonx_studio import testhook
    monkeypatch.setenv("SHELL", "/bin/bash")
    ev = {"tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": {"command": "pytest -q", "timeout": 5}}
    out = testhook.rewrite(ev, str(tmp_path))["hookSpecificOutput"]["updatedInput"]
    assert out["timeout"] == 5 and "{ pytest -q\n}" in out["command"] and f"{tmp_path}/toolu_1.out" in out["command"]
    assert testhook.rewrite({**ev, "tool_input": {"command": "ls"}}, str(tmp_path)) is None
    assert testhook.rewrite({**ev, "tool_input": {"command": "pytest", "run_in_background": True}}, str(tmp_path)) is None
    assert testhook.rewrite({**ev, "tool_use_id": "../x"}, str(tmp_path)) is None
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert testhook.rewrite(ev, str(tmp_path)) is None


def test_the_rewritten_command_keeps_its_status_output_and_cwd(tmp_path, monkeypatch):
    import subprocess
    from operonx_studio import testhook
    monkeypatch.setenv("SHELL", "/bin/bash")
    (tmp_path / "sub").mkdir()
    cmd = "cd sub && echo one && echo two >&2 && false # pytest"
    wrapped = testhook.rewrite({"tool_name": "Bash", "tool_use_id": "t1", "tool_input": {"command": cmd}},
                               str(tmp_path))["hookSpecificOutput"]["updatedInput"]["command"]
    run = subprocess.run(["bash", "-c", 'eval "$1"; echo "rc=$? cwd=$(pwd)"', "_", wrapped], cwd=tmp_path,
                         capture_output=True, text=True)
    assert run.stdout.split("\n")[:2] == ["one", "two"]
    assert f"rc=1 cwd={tmp_path}/sub" in run.stdout
    assert (tmp_path / "t1.out").read_text() == "one\ntwo\n"
