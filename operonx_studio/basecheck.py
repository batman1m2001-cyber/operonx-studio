"""Do these failing tests also fail on the base branch? (docs/TURN_HONESTY_PLAN.md S2) Does this command? (WORKSPACE T3)

The assistant ended a turn on "2 failed, all pre-existing" with nothing that showed it. This runs the same test ids
on the base branch's merge-base, in a copy of that commit (``git archive``: the repo's worktree list stays as it
was), with the project's own interpreter, and says for each one: fails on base too, or new.

    check("/path/to/worktree", ["tests/ui/test_book.py::test_rows"])
    on_base("/path/to/worktree", "operonx-project brd check")     # any check: its exit status here and on base
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tarfile
import time
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(os.path.expanduser("~/.operonx/base-checks"))
KEEP_DAYS = 2
TAIL = 3000  # of a command's output, per side
_LINE = re.compile(r"^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S+)", re.M)


def _git(cwd: str, *args: str) -> str:
    return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, check=True,
                          timeout=60).stdout.strip()


def default_base(cwd: str) -> str:
    """origin's default branch (origin/HEAD), else origin/main, else main."""
    try:
        return _git(cwd, "rev-parse", "--abbrev-ref", "origin/HEAD")
    except subprocess.CalledProcessError:
        for ref in ("origin/main", "main", "origin/master", "master"):
            try:
                _git(cwd, "rev-parse", "--verify", "-q", ref)
                return ref
            except subprocess.CalledProcessError:
                continue
    raise ValueError("no base branch found: pass base")


def base_tree(cwd: str, sha: str) -> Path:
    """The commit's files, extracted once into ~/.operonx/base-checks/<repo>-<sha>; older copies are pruned."""
    ROOT.mkdir(parents=True, exist_ok=True)
    for old in ROOT.iterdir():
        if old.is_dir() and time.time() - old.stat().st_mtime > KEEP_DAYS * 86400:
            shutil.rmtree(old, ignore_errors=True)
    top = _git(cwd, "rev-parse", "--show-toplevel")
    dest = ROOT / f"{Path(top).name}-{sha[:12]}"
    if not (dest / ".complete").exists():
        shutil.rmtree(dest, ignore_errors=True)
        data = subprocess.run(["git", "-C", top, "archive", "--format=tar", sha], capture_output=True, check=True,
                              timeout=300).stdout
        dest.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            tar.extractall(dest, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
        (dest / ".complete").touch()
    os.utime(dest)
    return dest


def base_dir(cwd: str, sha: str) -> Path:
    """Where *cwd* sits in the base copy: a project in a subfolder of its repo runs there, not at the repo's top."""
    return base_tree(cwd, sha) / _git(cwd, "rev-parse", "--show-prefix")


def interpreter(cwd: str) -> str:
    """The project's Python: its .venv if it has one (the worktree's, then the main checkout's)."""
    top = Path(_git(cwd, "rev-parse", "--show-toplevel"))
    common = Path(_git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).parent
    for root in (Path(cwd), top, common):
        py = root / ".venv" / "bin" / "python"
        if py.exists():
            return str(py)
    return "python3"


def outcomes(output: str) -> Dict[str, str]:
    """pytest -rA's short summary → {test id: PASSED|FAILED|ERROR|…}."""
    return {m.group(2): m.group(1) for m in _LINE.finditer(output)}


def verdict(test: str, seen: Dict[str, str]) -> str:
    """One requested id (a test, or a file or class holding several) against what ran on base."""
    hits = [v for k, v in seen.items() if k == test or k.startswith(test + "::") or k.startswith(test + "[")]
    if not hits:
        return "not on base (a new test)"
    if any(v in ("FAILED", "ERROR") for v in hits):
        return "fails on base too"
    return "passes on base: NEW failure"


def _env(where: Path, py: str) -> Dict[str, str]:
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(str(p) for p in (where / "src", where) if p.exists())}
    env.pop("VIRTUAL_ENV", None)
    if os.sep in py:
        env["PATH"] = os.pathsep.join([str(Path(py).parent), env.get("PATH", "")])
    return env


def _pytest(py: str, where: Path, tests: List[str], timeout: float) -> subprocess.CompletedProcess:
    env = _env(where, py)
    return subprocess.run([py, "-m", "pytest", "-q", "-rA", "-p", "no:cacheprovider", *tests], cwd=where, env=env,
                          capture_output=True, text=True, timeout=timeout)


def check(cwd: str, tests: List[str], base: Optional[str] = None, timeout: float = 900,
          python: Optional[str] = None) -> Dict[str, object]:
    tests = [t.strip() for t in tests if t and t.strip()]
    if not tests:
        raise ValueError("tests: the failing test ids, as pytest printed them")
    base = base or default_base(cwd)
    sha = _git(cwd, "merge-base", "HEAD", base)
    where = base_dir(cwd, sha)
    py = python or interpreter(cwd)
    run = _pytest(py, where, tests, timeout)
    seen = outcomes(run.stdout + run.stderr)
    if not seen and run.returncode == 4:
        # an id that does not exist on base stops the whole run: run each id alone
        for t in tests:
            seen.update(outcomes(_pytest(py, where, [t], timeout).stdout))
    return {"base": base, "sha": sha[:12], "results": {t: verdict(t, seen) for t in tests}}


def report(r: Dict[str, object]) -> str:
    results: Dict[str, str] = r["results"]  # type: ignore[assignment]
    new = sum(not v.startswith("fails") for v in results.values())
    head = f"on {r['base']} (merge-base {r['sha']}): " + (
        f"{new} of {len(results)} fail only on this branch" if new else "none of these is new to this branch")
    return "\n".join([head, *(f"  {t}: {v}" for t, v in results.items())])


def _shell(command: str, where: str, env: Dict[str, str], timeout: float) -> Dict[str, object]:
    try:
        run = subprocess.run(["bash", "-c", command], cwd=where, env=env, capture_output=True, text=True,
                             timeout=timeout)
        return {"rc": run.returncode, "output": (run.stdout + run.stderr)[-TAIL:]}
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return {"rc": None, "output": out[-TAIL:] + f"\n(stopped after {timeout:.0f}s)"}


def on_base(cwd: str, command: str, base: Optional[str] = None, timeout: float = 900,
            python: Optional[str] = None) -> Dict[str, object]:
    """The command run here and in the merge-base copy, with the project's .venv/bin first on PATH."""
    command = (command or "").strip()
    if not command:
        raise ValueError("command: the check to run, as you ran it here")
    base = base or default_base(cwd)
    sha = _git(cwd, "merge-base", "HEAD", base)
    where = base_dir(cwd, sha)
    py = python or interpreter(cwd)
    return {"base": base, "sha": sha[:12], "command": command,
            "here": _shell(command, cwd, _env(Path(cwd), py), timeout),
            "on_base": _shell(command, str(where), _env(where, py), timeout)}


def on_base_report(r: Dict[str, object]) -> str:
    here, there = r["here"], r["on_base"]  # type: ignore[index]
    head = f"`{r['command']}` here: exit {here['rc']} · on {r['base']} (merge-base {r['sha']}): exit {there['rc']}"
    same = "the same output on both" if here["output"] == there["output"] else ""
    parts = [head + (f" — {same}" if same else "")]
    for name, got in (("here", here), ("on base", there)):
        parts += [f"--- {name} (last lines) ---", str(got["output"]).rstrip()[-1500:] or "(no output)"]
    return "\n".join(parts)
