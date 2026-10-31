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
