"""progress.py: a running call's output → its row (docs/EXECUTION_PROGRESS_PLAN.md E2).

The fixtures in fixtures/progress are real runs through runhook's wrap (marker lines included); the short samples
below stand in for tools this box cannot run (apt, cmake, ninja, wget, vite)."""

import json
from pathlib import Path

import pytest

from operonx_studio import progress

FIX = Path(__file__).parent / "fixtures" / "progress"


def fixture(name):
    meta = json.loads((FIX / f"{name}.json").read_text())
    return meta["command"], (FIX / f"{name}.out").read_text(), meta["parts"]


def cut(raw, upto):
    """The file as it stood while the call ran: everything before the *upto*-th marker or text."""
    return raw[:raw.index(upto)]


# ── one command, read whole and part way ──

def test_pytest_counts_against_the_collected_total():
    command, raw, _ = fixture("pytest_q")
    got = progress.read(command, raw)
    assert (got["mode"], got["current"], got["total"], got["pct"]) == ("measured", 5, 5, 100)
    assert got["tests"] == {"passed": 3, "failed": 1, "skipped": 1, "errors": 0, "runner": "pytest"}
    assert [(s["id"], s["state"]) for s in got["stages"]] == [("collect", "done"), ("run", "done"),
                                                            ("report", "done")]
    assert got["ended"] == 1 and got["pid"] > 0

    mid = progress.read(command, cut(raw, "suite/test_b.py"))
    assert (mid["mode"], mid["current"], mid["total"]) == ("measured", 3, 5)
    assert [s["state"] for s in mid["stages"]] == ["done", "active", "pending"]
    assert mid["activity"] == "suite/test_a.py" and "ended" not in mid


def test_pytest_percent_follows_the_count_not_the_line_end():
    # pytest prints [ 1%] at the end of a line of dots: 20 tests into a 60-test file it still says 1%
    out = "collected 61 items\n\ntests/test_base.py .                [  1%]\ntests/test_slow.py " + "." * 20
    got = progress.read("pytest tests", out)
    assert (got["current"], got["total"], got["pct"]) == (21, 61, 34)


def test_pytest_before_it_has_collected_is_not_a_bar():
    command, raw, _ = fixture("pytest_v")
    got = progress.read(command, cut(raw, "collecting ..."))
    assert got["mode"] == "indeterminate" and "pct" not in got
    assert [s["state"] for s in got["stages"]] == ["active", "pending", "pending"]


def test_pytest_verbose_counts_each_test():
    command, raw, _ = fixture("pytest_v")
    got = progress.read(command, cut(raw, "suite/test_b.py::test_four"))
    assert (got["current"], got["total"], got["pct"]) == (3, 5, 60)
    assert got["tests"]["failed"] == 1


def test_node_test_counts_without_a_total():
    command, raw, _ = fixture("node_test")
    got = progress.read(command, cut(raw, "# Subtest: fails"))
    assert got["mode"] == "indeterminate" and got["current"] == 1 and "total" not in got


def test_cargo_test_total_only_with_one_binary():
    one = "running 4 tests\ntest a ... ok\ntest b ... ok\n"
    got = progress.parse("cargo test", one)
    assert (got["mode"], got["current"], got["total"]) == ("measured", 2, 4)
    two = one + "test result: ok. 4 passed\n\nrunning 3 tests\ntest c ... ok\n"
    assert progress.parse("cargo test", two)["mode"] == "indeterminate"


def test_uv_and_pip_stages():
    command, raw, parts = fixture("uv_pip")
    got = progress.parse(parts[1], progress.marks(raw)[1][1][3])
    assert [(s["id"], s["state"]) for s in got["stages"]] == [("resolve", "done"), ("prepare", "done"),
                                                             ("install", "done")]
    assert got["mode"] == "indeterminate"
    early = progress.parse("uv sync", "Resolved 40 packages in 1ms\n   Downloading numpy\n")
    assert [s["state"] for s in early["stages"]] == ["done", "active", "pending"]

    command, raw, parts = fixture("pip")
    seg = progress.marks(raw)[1][1][3]
    assert [s["state"] for s in progress.parse(parts[1], seg)["stages"]] == ["done", "done"]
    mid = progress.parse(parts[1], cut(seg, "Installing"))
    assert [s["state"] for s in mid["stages"]] == ["active", "pending"] and mid["current"] == 1


APT = """Reading package lists...
The following NEW packages will be installed:
  jq libjq1 libonig5
0 upgraded, 3 newly installed, 0 to remove and 12 not upgraded.
Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 libonig5 amd64 6.9.9-1 [172 kB]
Get:2 http://archive.ubuntu.com/ubuntu noble/main amd64 libjq1 amd64 1.7.1-3 [141 kB]
Get:3 http://archive.ubuntu.com/ubuntu noble/main amd64 jq amd64 1.7.1-3 [65.7 kB]
Unpacking libonig5:amd64 (6.9.9-1build1) ...
Unpacking libjq1:amd64 (1.7.1-3build1) ...
Unpacking jq (1.7.1-3build1) ...
Setting up libonig5:amd64 (6.9.9-1build1) ...
Setting up libjq1:amd64 (1.7.1-3build1) ...
"""


def test_apt_measures_setting_up_against_what_it_said_it_would_install():
    got = progress.parse("apt-get install -y jq", APT)
    assert (got["mode"], got["current"], got["total"], got["pct"]) == ("measured", 2, 3, 66)
    assert [s["state"] for s in got["stages"]] == ["done", "done", "active"]
    assert progress.parse("apt-get install -y jq", "Reading package lists...\n")["mode"] == "indeterminate"


def test_docker_counts_steps():
    command, raw, parts = fixture("docker_build")
    seg = progress.marks(raw)[1][0][3]
    got = progress.parse(parts[0], seg)
    assert (got["mode"], got["current"], got["total"]) == ("measured", 2, 2)
    mid = progress.parse(parts[0], cut(seg, "#5 [2/2]"))
    assert (mid["current"], mid["total"], mid["activity"]) == (0, 2, "COPY a /a")
    legacy = progress.parse("docker build .", "Step 1/4 : FROM python\nStep 2/4 : COPY . /app\n")
    assert (legacy["current"], legacy["total"], legacy["pct"]) == (1, 4, 25)


def test_make_and_ninja():
    got = progress.parse("cmake --build build", "[  8%] Building C object a.o\n[ 42%] Building C object b.o\n")
    assert (got["mode"], got["pct"]) == ("measured", 42)
    got = progress.parse("ninja -C build", "[3/120] Building CXX object x.o\n[17/120] Linking y\n")
    assert (got["current"], got["total"], got["pct"]) == (17, 120, 14)
    assert progress.parse("make", "cc -c a.c\n")["mode"] == "indeterminate"


def test_cargo_build_counts_crates_without_a_bar():
    command, raw, parts = fixture("cargo_build")
    got = progress.parse(parts[1], progress.marks(raw)[1][1][3])
    assert (got["mode"], got["current"], got["activity"]) == ("indeterminate", 1, "Compiling oxprobe")


def test_bundlers():
    assert progress.parse("npx vite build", "transforming...\n✓ 412 modules transformed.\n")["current"] == 412
    got = progress.parse("npx webpack", "<s> [webpack.Progress] 37% building\n")
    assert (got["mode"], got["pct"]) == ("measured", 37)


def test_fetch_git_curl_wget():
    command, raw, _ = fixture("git_clone")
    got = progress.read(command, raw)
    assert (got["mode"], got["pct"], got["activity"]) == ("measured", 100, "Resolving deltas")
    mid = progress.read(command, cut(raw, "Receiving objects:  50%"))
    assert mid["activity"] == "Receiving objects" and mid["total"] == 1231 and mid["pct"] == 49

    command, raw, _ = fixture("curl")
    assert progress.read(command, raw)["pct"] == 100
    meter = ("  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n"
             "                                 Dload  Upload   Total   Spent    Left  Speed\n"
             "\r  0  100M    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0"
             "\r 23  100M   23 23.4M    0     0  20.1M      0  0:00:04  0:00:01  0:00:03 20.1M")
    assert progress.parse("curl -O https://x/big.bin", meter)["pct"] == 23
    assert progress.parse("wget https://x/big.bin", "big.bin    37%[=====>     ]  37.0M  20MB/s\r")["pct"] == 37


def test_lint_and_unknown_say_the_last_line():
    assert progress.parse("ruff check .", "a.py:1:1: F401\nFound 1 error.\n")["activity"] == "Found 1 error."
    got = progress.parse("python train.py", "epoch 1\n\x1b[32mepoch 2\x1b[0m\n\n")
    assert got == {"mode": "indeterminate", "activity": "epoch 2"}
    assert progress.parse("./run.sh", "step\rstep 2\rstep 3\n")["activity"] == "step 3"


def test_family_names():
    assert [progress.family(c) for c in ("pytest -q", "uv sync", "docker build .", "git clone x", "ruff check",
                                         "ls")] == ["tests", "install", "build", "fetch", "lint", ""]


# ── markers and chains ──

def test_marks_find_markers_mid_line():
    raw = "\x1eox start 7 1.5\nno newline\x1eox part 1 0 2.0\nout\n\x1eox end 3 4.0\n"
    head, parts, before = progress.marks(raw)
    assert head == {"pid": 7, "t0": 1.5, "ended": 3, "t1": 4.0}
    assert parts == [(1, 0, 2.0, "out\n")] and before == "no newline"


def test_a_chain_is_one_stage_per_part():
    command, raw, parts = fixture("chain")
    got = progress.read(command, raw, parts)
    assert [(s["title"].split()[0], s["state"]) for s in got["stages"]] == [("python", "failed"), ("node", "failed"),
                                                                          ("git", "skipped")]
    assert got["stages"][0]["tests"]["failed"] == 1 and got["stages"][0]["t1"] > got["stages"][0]["t0"]
    assert got["ended"] == 1 and "stage" not in got

    mid = progress.read(command, cut(raw, "\x1eox part 2"), parts)
    assert [s["state"] for s in mid["stages"]] == ["active", "pending", "pending"]
    assert mid["stage"] == 1 and mid["tests"]["passed"] == 3 and mid["unit"] == "tests"


@pytest.mark.parametrize("name", sorted(p.stem for p in FIX.glob("*.out")))
def test_never_a_bar_without_a_total_or_a_percentage(name):
    command, raw, parts = fixture(name)
    for at in range(0, len(raw) + 1, max(1, len(raw) // 40)):
        got = progress.read(command, raw[:at], parts)
        for row in [got, *got.get("stages", [])]:
            if row.get("mode") == "measured":
                assert row.get("total") or row.get("pct") is not None, (name, at, row)
            assert "\x1e" not in json.dumps(row)
