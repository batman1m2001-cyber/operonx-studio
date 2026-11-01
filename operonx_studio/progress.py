"""A running shell call, read from what it has printed so far (docs/EXECUTION_PROGRESS_PLAN.md D2, D3).

runhook.py copies a call's output to a file, with marker lines (\\x1eox …) for the shell's pid, the start of each
part of a plain chain, and the end. ``read`` turns that file into what the call's row shows: its stages, the share
done when the tool itself printed the total, the counts so far, and what it is doing now, in words.

    read("pytest -q", out) → {"mode": "measured", "current": 312, "total": 570, "pct": 55, "unit": "tests",
                              "activity": "tests/test_board.py", "stages": [{"id": "collect", "state": "done", …}, …],
                              "lines": 4120, "bytes": 391204, "pid": 4242, "ended": None}

Honest by construction: ``measured`` only when the tool printed a total or a percentage; anything else is
``indeterminate`` — a count and the last line, never a bar. A parser that does not recognise the output says
nothing and the generic reading stands; none of them guesses.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import testreport

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
_MARK = re.compile(r"\x1eox (start|part|end) ([^\n]*)\n")
ACTIVITY_CHARS = 120


def _lines(text: str) -> List[str]:
    """The output as lines a person would see: colours gone, a line redrawn with \\r read as its last drawing."""
    text = _ANSI.sub("", text)
    return [ln.rsplit("\r", 1)[-1] if "\r" in ln.rstrip("\r") else ln.rstrip("\r") for ln in text.split("\n")]


def _activity(lines: List[str]) -> str:
    for ln in reversed(lines):
        s = ln.strip()
        if s:
            return s[:ACTIVITY_CHARS]
    return ""


def _stage(sid: str, title: str, state: str, **more: Any) -> Dict[str, Any]:
    return {"id": sid, "title": title, "state": state, **{k: v for k, v in more.items() if v is not None}}


def _progress(mode: str = "indeterminate", **more: Any) -> Dict[str, Any]:
    return {"mode": mode, **{k: v for k, v in more.items() if v is not None}}


# ── the families (D2): each reads its own tool's words, or returns None ──

def _tests(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    live = testreport.progress(command, text)
    pytest = (live or {}).get("runner") == "pytest" or bool(re.search(r"\bpy\.?test\b", command))
    total = None
    if pytest:
        m = re.findall(r"^(?:collecting \.\.\. )?collected (\d+) items?(?: / \d+ deselected / (\d+) selected)?", text,
                       re.M)
        if m:
            total = int(m[-1][1] or m[-1][0])
    else:
        m = re.findall(r"^running (\d+) tests?$", text, re.M)        # cargo: per test binary; the last one's
        total = None if len(m) != 1 else int(m[0])
    counts = {k: (live or {}).get(k, 0) for k in ("passed", "failed", "skipped", "errors")}
    current = sum(counts.values())
    pct = (live or {}).get("pct")
    if total and current > total:
        total = None                       # the count said one thing and the run another: say neither
    activity = ""
    for ln in reversed(lines):
        f = re.match(r"^(\S+\.(?:py|js|ts|mjs|cjs|go|rs))(?:::|\s|$)", ln.strip())
        if f:
            activity = f.group(1)
            break
    if pytest:
        reported = bool(re.search(r"^=+ (short test summary|.*\b(passed|failed|error|no tests ran)\b.* in [\d.]+s)",
                                  text, re.M))
        collected = total is not None or current > 0 or bool(re.search(r"^(?:collecting \.\.\. )?collected \d+", text, re.M))
        stages = [_stage("collect", "Collect", "done" if collected else "active",
                         summary=f"{total} tests" if total else None),
                  _stage("run", "Run", "done" if reported else ("active" if collected else "pending"),
                         current=current or None, total=total),
                  _stage("report", "Report", "done" if reported else "pending")]
        if not collected:
            activity = "collecting"
    else:
        stages = []
    if not live and not total and not stages:
        return None
    measured = bool(total) or pct is not None
    if measured and pct is None and total:
        pct = min(100, current * 100 // total)
    return _progress("measured" if measured else "indeterminate", current=current, total=total, pct=pct,
                     unit="tests", activity=activity or _activity(lines), stages=stages or None,
                     tests={**counts, "runner": (live or {}).get("runner") or ("pytest" if pytest else None)})


def _uv(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    resolved = re.findall(r"^Resolved (\d+) packages?", text, re.M)
    prepared = re.findall(r"^Prepared (\d+) packages?", text, re.M)
    installed = re.findall(r"^(?:Installed|Audited) (\d+) packages?", text, re.M)
    if not (resolved or prepared or installed or re.search(r"^(Downloading|Building|Using) ", text, re.M)):
        return None
    downloads = len(re.findall(r"^\s*(Downloading|Downloaded) ", text, re.M))
    stages = [_stage("resolve", "Resolve", "done" if resolved else "active",
                     summary=f"{resolved[-1]} packages" if resolved else None),
              _stage("prepare", "Download", "done" if (prepared or installed) else ("active" if resolved else "pending"),
                     summary=f"{prepared[-1]} packages" if prepared else None, current=downloads or None),
              _stage("install", "Install", "done" if installed else ("active" if prepared else "pending"),
                     summary=f"{installed[-1]} packages" if installed else None)]
    return _progress(unit="packages", activity=_activity(lines), stages=stages)


def _pip(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    collecting = re.findall(r"^Collecting (\S+)", text, re.M)
    installing = re.search(r"^Installing collected packages: (.*)$", text, re.M)
    done = re.search(r"^Successfully installed ", text, re.M)
    if not (collecting or installing or done or re.search(r"^Requirement already satisfied", text, re.M)):
        return None
    total = len(installing.group(1).split(", ")) if installing else None
    stages = [_stage("collect", "Collect", "done" if installing or done else "active",
                     current=len(collecting) or None),
              _stage("install", "Install", "done" if done else ("active" if installing else "pending"),
                     summary=f"{total} packages" if total else None)]
    return _progress(current=len(collecting) or None, unit="packages", activity=_activity(lines), stages=stages)


def _apt(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    m = re.search(r"^(\d+) upgraded, (\d+) newly installed", text, re.M)
    gets = len(re.findall(r"^Get:\d+ ", text, re.M))
    unpacked = len(re.findall(r"^Unpacking ", text, re.M))
    set_up = len(re.findall(r"^Setting up ", text, re.M))
    if not (m or gets):
        return None
    total = int(m.group(1)) + int(m.group(2)) if m else None
    stages = [_stage("download", "Download", "done" if unpacked or set_up else "active", current=gets or None),
              _stage("unpack", "Unpack", "done" if set_up else ("active" if unpacked else "pending"),
                     current=unpacked or None, total=total),
              _stage("setup", "Set up", "active" if set_up else "pending", current=set_up or None, total=total)]
    if total and set_up <= total:
        return _progress("measured", current=set_up, total=total, pct=set_up * 100 // total if total else None,
                         unit="packages", activity=_activity(lines), stages=stages)
    return _progress(unit="packages", activity=_activity(lines), stages=stages)


def _node_install(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    added = re.search(r"^(?:added|removed|changed|up to date)[^\n]*", text, re.M)
    return _progress(activity=added.group(0)[:ACTIVITY_CHARS] if added else _activity(lines))


def _docker(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    steps = re.findall(r"^#\d+ \[(?:[\w.-]+ )?(\d+)/(\d+)\] (.*)$|^Step (\d+)/(\d+) : (.*)$", text, re.M)
    if not steps:
        return None
    last = steps[-1]
    n, total, what = (int(last[0]), int(last[1]), last[2]) if last[0] else (int(last[3]), int(last[4]), last[5])
    done = re.search(r"^#\d+ (writing image|naming to)|^Successfully built ", text, re.M)
    current = total if done else max(n - 1, 0)       # a step is done once the next one starts
    return _progress("measured", current=current, total=total, pct=current * 100 // total, unit="steps",
                     activity=what.strip()[:ACTIVITY_CHARS])


def _make(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    pcts = re.findall(r"^\[\s*(\d{1,3})%\]", text, re.M)
    if pcts:
        pct = min(100, int(pcts[-1]))
        return _progress("measured", pct=pct, unit="%", activity=_activity(lines))
    ninja = re.findall(r"^\[(\d+)/(\d+)\] ", text, re.M)
    if ninja:
        n, total = int(ninja[-1][0]), int(ninja[-1][1])
        return _progress("measured", current=n, total=total, pct=n * 100 // total, unit="steps",
                         activity=_activity(lines))
    return None


def _cargo_build(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    compiled = re.findall(r"^\s*Compiling (\S+)", text, re.M)
    if not compiled:
        return None
    return _progress(current=len(compiled), unit="crates", activity=f"Compiling {compiled[-1]}")


def _bundler(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    m = re.findall(r"(\d+) modules transformed", text)
    pct = re.findall(r"^\s*<s> \[webpack\.Progress\] (\d+)%|^\s*(\d{1,3})% building", text, re.M)
    if pct:
        p = int(pct[-1][0] or pct[-1][1])
        return _progress("measured", pct=min(100, p), unit="%", activity=_activity(lines))
    if m:
        return _progress(current=int(m[-1]), unit="modules", activity=_activity(lines))
    return None


def _fetch(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    # git (with --progress, or on a terminal): the phase it is in, with its own n/m
    git = re.findall(r"(Counting|Compressing|Receiving|Resolving|Updating) (?:objects|deltas|files):\s+(\d+)% "
                     r"\((\d+)/(\d+)\)", text)
    if git:
        phase, pct, n, total = git[-1]
        return _progress("measured", current=int(n), total=int(total), pct=int(pct), unit="objects",
                         activity=f"{phase} {'deltas' if phase == 'Resolving' else 'objects'}")
    # curl's meter: the first column is the share of the whole transfer
    curl = [ln for ln in lines if re.match(r"^\s*\d{1,3}\s+[\d.]+[kMG]?\s+\d{1,3}\s+[\d.]+[kMG]?\s", ln)]
    if curl and re.search(r"\b(curl)\b", command):
        pct = int(curl[-1].split()[0])
        return _progress("measured", pct=min(100, pct), unit="%", activity="downloading")
    wget = re.findall(r"(\d{1,3})%\[", text)
    if wget:
        return _progress("measured", pct=min(100, int(wget[-1])), unit="%", activity="downloading")
    return None


def _lint(command: str, text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    m = re.search(r"^(Found \d+ errors?.*|All checks passed!|Success: no issues found.*|\d+ problems?.*)$",
                  text, re.M)
    return _progress(activity=(m.group(1) if m else _activity(lines))[:ACTIVITY_CHARS])


# (family, the command words that pick it): the command decides first, then the parser reads the output
FAMILIES: List[Tuple[str, re.Pattern, Callable[[str, str, List[str]], Optional[Dict[str, Any]]]]] = [
    ("tests", testreport.TEST_COMMAND, _tests),
    ("install", re.compile(r"\buv\s+(sync|pip\s+install|add|lock|tool\s+install|venv)\b"), _uv),
    ("install", re.compile(r"\b(pip3?|python3?\s+-m\s+pip)\s+install\b"), _pip),
    ("install", re.compile(r"\bapt(-get)?\s+(install|upgrade|dist-upgrade)\b"), _apt),
    ("install", re.compile(r"\b(npm\s+(install|ci|i)|pnpm\s+(install|i|add)|yarn(\s+install)?\s*($|[;&|]))"),
     _node_install),
    ("build", re.compile(r"\bdocker(\s+buildx)?\s+(build|compose\s+build)\b"), _docker),
    ("build", re.compile(r"\b(make|cmake|ninja)\b"), _make),
    ("build", re.compile(r"\bcargo\s+(build|check|clippy|install)\b"), _cargo_build),
    ("build", re.compile(r"\b(vite|webpack|next|npm\s+run\s+build|pnpm\s+(run\s+)?build|yarn\s+build)\b"), _bundler),
    ("fetch", re.compile(r"\b(git\s+(clone|fetch|pull)|curl|wget)\b"), _fetch),
    ("lint", re.compile(r"\b(ruff|eslint|mypy|pyright|flake8|pylint|tsc)\b"), _lint),
]


def family(command: str) -> str:
    return next((name for name, rx, _ in FAMILIES if rx.search(command or "")), "")


def parse(command: str, text: str) -> Dict[str, Any]:
    """One command's output so far → its progress (no markers in *text*)."""
    lines = _lines(text)
    for _, rx, fn in FAMILIES:
        if rx.search(command or ""):
            got = fn(command, text, lines)
            if got is not None:
                return got
    return _progress(activity=_activity(lines))


def marks(raw: str) -> Tuple[Dict[str, Any], List[Tuple[int, int, Optional[float], str]], str]:
    """The wrap's marker lines → ({pid, t0, ended, t1}, [(part, the status before it, when, its output)], the
    output before any part); every marker is taken out of the output."""
    head: Dict[str, Any] = {}
    parts: List[Tuple[int, int, Optional[float], str]] = []
    out, at = [], 0
    for m in _MARK.finditer(raw):
        out.append(raw[at:m.start()])
        at = m.end()
        kind, fields = m.group(1), m.group(2).split()
        try:
            if kind == "start":
                head["pid"] = int(fields[0])
                head["t0"] = float(fields[1]) if len(fields) > 1 else None
            elif kind == "part":
                parts.append((int(fields[0]), int(fields[1]), float(fields[2]) if len(fields) > 2 else None, ""))
                out.append("\x00")       # where this part's output begins
            elif kind == "end":
                head["ended"] = int(fields[0])
                head["t1"] = float(fields[1]) if len(fields) > 1 else None
        except (ValueError, IndexError):
            continue
    out.append(raw[at:])
    pieces = "".join(out).split("\x00")
    before, rest = pieces[0], pieces[1:]
    parts = [(n, rc, t, rest[i] if i < len(rest) else "") for i, (n, rc, t, _) in enumerate(parts)]
    return head, parts, before


def read(command: str, raw: str, parts: Optional[List[str]] = None) -> Dict[str, Any]:
    """The call's file → its progress: with *parts* (runhook's split), one stage per part, each read by its own
    family; without, the command's own stages."""
    head, marked, before = marks(raw)
    text = before + "".join(seg for *_, seg in marked)
    lines = _lines(text)
    base = {"lines": text.count("\n"), "bytes": len(text.encode("utf-8", "replace")),
            **{k: v for k, v in head.items() if v is not None}}
    if not parts:
        return {**parse(command, text), **base}
    ended = head.get("ended")
    stages, active = [], None
    seen = {n: (rc, t, seg) for n, rc, t, seg in marked}
    for i, title in enumerate(parts, 1):
        if i not in seen:
            state = "skipped" if ended is not None else "pending"
            stages.append(_stage(f"part{i}", title, state))
            continue
        _, t0, seg = seen[i]
        after = seen.get(i + 1)
        if after is not None:
            state, t1 = ("done" if after[0] == 0 else "failed"), after[1]
        elif ended is not None:
            state, t1 = ("done" if ended == 0 else "failed"), head.get("t1")
        else:
            state, t1 = "active", None
        got = parse(title, seg)
        stage = _stage(f"part{i}", title, state, t0=t0, t1=t1,
                       **{k: got.get(k) for k in ("mode", "current", "total", "pct", "unit", "activity", "tests")})
        if state == "active":
            active = (i, got)
        stages.append(stage)
    if active is not None:
        i, got = active
        top = {**got, "stage": i}
    else:
        top = _progress(activity=_activity(lines))
    top.pop("stages", None)
    return {**top, "stages": stages, **base}


# ── alive, quiet, stalled (D4): from the call's own processes, never from its words ──

QUIET_S = 15          # no output for this long: no longer "active"
STALL_S = 120         # no output and no CPU for this long: "stalled"
_TICK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def tree(pid: int) -> Optional[Tuple[int, float]]:
    """(processes, CPU seconds) of *pid* and everything under it, from /proc; None once it has gone, or where
    there is no /proc. Only the call's own pids are read, and only their stat and children."""
    root = Path("/proc")
    if not (root / str(pid)).exists():
        return None
    seen, todo, cpu = set(), [pid], 0.0
    while todo and len(seen) < 512:
        p = todo.pop()
        if p in seen:
            continue
        seen.add(p)
        try:
            stat = (root / str(p) / "stat").read_text()
            fields = stat[stat.rindex(")") + 2:].split()
            if fields[0] == "Z":
                continue
            cpu += (int(fields[11]) + int(fields[12])) / _TICK
            for task in (root / str(p) / "task").iterdir():
                todo += [int(c) for c in (task / "children").read_text().split()]
        except (OSError, ValueError, IndexError):
            continue
    return len(seen), cpu


class Liveness:
    """One running call's state, fed once a second: the newest output and CPU time decide it."""

    def __init__(self, now: float) -> None:
        self.out_at = now          # the last time the output grew (wall clock)
        self.busy_at = now         # the last time its processes used CPU
        self.cpu: Optional[float] = None

    def see(self, now: float, grew: bool, pid: Optional[int], ended: bool) -> Optional[Dict[str, Any]]:
        if grew:
            self.out_at = now
        if ended:
            return {"state": "ended"}
        if pid is None:
            return None                            # no pid yet: the wrap has not started
        got = tree(pid)
        if got is None:
            return {"state": "ended"} if Path("/proc").exists() else None
        if self.cpu is not None and got[1] > self.cpu + 0.01:
            self.busy_at = now
        self.cpu = got[1]
        if now - self.out_at < QUIET_S:
            return {"state": "active"}
        quiet = max(self.out_at, self.busy_at)
        if now - self.busy_at < QUIET_S:
            return {"state": "busy", "since": round(self.out_at, 3)}
        return {"state": "stalled" if now - quiet >= STALL_S else "idle", "since": round(quiet, 3)}
