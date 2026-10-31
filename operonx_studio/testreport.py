"""A test run as a fact (docs/VISUAL_CHAT_PLAN.md D6).

When a shell call that ran a test runner ends, the relay reads its **whole** output here, before the item keeps
only the first 4,000 characters of it: the runner's summary line and the failing tests, each with its first error
line and the output around it. No summary line, no report: the row stays a plain run.

    parse("pytest -q", out) → {"runner": "pytest", "passed": 137, "failed": 3, "skipped": 0, "errors": 0,
                               "ms": 4200, "failures": [{"id": "tests/test_a.py::test_x", "line": "KeyError: 'lane'",
                                                         "context": "…"}]}
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

# a command that runs tests; npm/pnpm/yarn test wrap one of the runners below, so the output decides which
TEST_COMMAND = re.compile(
    r"(^|[\s;&|(/])(pytest|py\.test|jest|vitest)(?=\s|$|;|&)|python3?\s+-m\s+(pytest|unittest)\b|\bnode\s+(--[\w-]+\s+)*--test\b"
    r"|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b")

MAX_FAILURES = 50
CONTEXT_LINES = 14
CONTEXT_CHARS = 1500

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_NEXT = re.compile(r"^(_{5,}|={5,}|---- \S+ stdout ----|# Subtest:|\s*● |\s*--- FAIL|not ok \d+|failures:$|test result:)")


def is_test(command: str) -> bool:
    return bool(TEST_COMMAND.search(command or ""))


def _report(runner: str, **counts: Any) -> Dict[str, Any]:
    out = {"runner": runner, "passed": 0, "failed": 0, "skipped": 0, "errors": 0, "ms": None, "failures": []}
    out.update({k: v for k, v in counts.items() if v is not None})
    return out


def _secs(text: str) -> Optional[int]:
    """'0.41s', '1.2 s', '450ms', '1m 3s' → milliseconds"""
    text = text.strip()
    m = re.fullmatch(r"(?:(\d+)m\s*)?([\d.]+)\s*(ms|s)?", text)
    if not m:
        return None
    v = float(m.group(2)) * (1 if m.group(3) == "ms" else 1000)
    return round(v + int(m.group(1) or 0) * 60000)


def _around(lines: List[str], name: str, headers: List[str]) -> str:
    """The output about one failure: its section when the runner heads one, else the lines after its first mention."""
    short = re.escape(name.split("::")[-1].split(" › ")[-1].split(" > ")[-1].strip())
    at = None
    for h in headers:
        rx = re.compile(h.replace("{n}", short))
        at = next((i for i, ln in enumerate(lines) if rx.search(ln)), None)
        if at is not None:
            break
    if at is None:
        at = next((i for i, ln in enumerate(lines) if name in ln or (short and re.search(short, ln))), None)
    if at is None:
        return ""
    block = [lines[at]]
    for ln in lines[at + 1:at + CONTEXT_LINES]:
        if _NEXT.match(ln) and name.split("::")[-1] not in ln:     # the next failure's section: this one ends
            break
        block.append(ln)
    while block and not block[-1].strip():
        block.pop()
    return "\n".join(block)[:CONTEXT_CHARS]


def _pytest(text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    summary = None
    for ln in lines:
        m = re.match(r"^=*\s*((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)"
                     r"(?:, )?)+)\s+in\s+([\d.]+)s", ln.strip())
        if m:
            summary = m
    if not summary:
        if re.search(r"^=+ no tests ran in", text, re.M):
            return _report("pytest", ms=None)
        return None
    counts = {w: int(n) for n, w in re.findall(r"(\d+) (\w+)", summary.group(1))}
    rep = _report("pytest", passed=counts.get("passed", 0) + counts.get("xpassed", 0),
                  failed=counts.get("failed", 0), skipped=counts.get("skipped", 0) + counts.get("xfailed", 0),
                  errors=counts.get("error", 0) + counts.get("errors", 0), ms=_secs(summary.group(2) + "s"))
    for ln in lines:
        m = re.match(r"^(FAILED|ERROR) (\S+)(?: - (.*))?$", ln.strip())
        if m:
            rep["failures"].append({"id": m.group(2), "line": (m.group(3) or m.group(1).lower()).strip()})
    return rep


def _cargo(text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    found = re.findall(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;.*?finished in ([\d.]+)s",
                       text)
    if not found:
        return None
    rep = _report("cargo test", passed=sum(int(f[0]) for f in found), failed=sum(int(f[1]) for f in found),
                  skipped=sum(int(f[2]) for f in found), ms=round(sum(float(f[3]) for f in found) * 1000))
    for i, ln in enumerate(lines):
        m = re.match(r"^---- (\S+) stdout ----$", ln.strip())
        if m:
            after = [x.strip() for x in lines[i + 1:i + 8] if x.strip()]
            msg = next((x for j, x in enumerate(after) if j and "panicked at" in after[j - 1]), "") or \
                next((x for x in after if "panicked" not in x), "")
            rep["failures"].append({"id": m.group(1), "line": msg})
    return rep


def _jest(text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    m = re.search(r"^Tests:\s+(.*?)(\d+) total", text, re.M)
    if not m:
        return None
    counts = {w: int(n) for n, w in re.findall(r"(\d+) (\w+)", m.group(1))}
    t = re.search(r"^Time:\s+([\d.]+ ?m?s)", text, re.M)
    rep = _report("jest", passed=counts.get("passed", 0), failed=counts.get("failed", 0),
                  skipped=counts.get("skipped", 0) + counts.get("todo", 0), ms=_secs(t.group(1)) if t else None)
    for i, ln in enumerate(lines):
        f = re.match(r"^\s*● (.+?)\s*$", ln)
        if f and "Console" not in f.group(1):
            after = next((x.strip() for x in lines[i + 1:i + 6] if x.strip()), "")
            rep["failures"].append({"id": f.group(1), "line": after})
    return rep


def _vitest(text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    m = re.search(r"^\s*Tests\s+(.*?)\((\d+)\)\s*$", text, re.M)
    if not m:
        return None
    counts = {w: int(n) for n, w in re.findall(r"(\d+) (\w+)", m.group(1))}
    d = re.search(r"^\s*Duration\s+([\d.]+ ?m?s)", text, re.M)
    rep = _report("vitest", passed=counts.get("passed", 0), failed=counts.get("failed", 0),
                  skipped=counts.get("skipped", 0) + counts.get("todo", 0), ms=_secs(d.group(1)) if d else None)
    for i, ln in enumerate(lines):
        f = re.match(r"^\s*FAIL\s+(.+?)\s*$", ln)
        if f and ">" in f.group(1):
            after = next((x.strip() for x in lines[i + 1:i + 6] if x.strip()), "")
            rep["failures"].append({"id": f.group(1), "line": after})
    return rep


def _node(text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    # node --test: TAP ("# pass 3", node 18) or the spec reporter ("ℹ pass 3", node 20+)
    counts: Dict[str, float] = {}
    for ln in lines:
        m = re.match(r"^[#ℹ]\s+(tests|pass|fail|skipped|cancelled|todo|duration_ms)\s+([\d.]+)\s*$", ln.strip())
        if m:
            counts[m.group(1)] = float(m.group(2))
    if "pass" not in counts or "fail" not in counts:
        return None
    rep = _report("node --test", passed=int(counts["pass"]), failed=int(counts["fail"]),
                  skipped=int(counts.get("skipped", 0) + counts.get("todo", 0)), errors=int(counts.get("cancelled", 0)),
                  ms=round(counts["duration_ms"]) if "duration_ms" in counts else None)
    seen = set()
    for i, ln in enumerate(lines):
        tap = re.match(r"^\s*not ok \d+ - (.+?)\s*$", ln)
        spec = re.match(r"^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$", ln)
        name = (tap or spec).group(1) if (tap or spec) else None
        if not name or name in seen or name == "failing tests:":
            continue
        # a file-level "not ok" wraps its subtests: the subtest is the failure
        if tap and re.search(r"\.(m?js|cjs|ts)$", name) and any(f["id"] != name for f in rep["failures"]):
            continue
        seen.add(name)
        msg = ""
        for j in range(i + 1, min(i + 25, len(lines))):
            s = lines[j].strip()
            e = re.match(r"^error:\s*(?:\|-?)?\s*(.*)$", s)
            if e:
                msg = e.group(1).strip("'\" ") or next((x.strip() for x in lines[j + 1:j + 6] if x.strip()), "")
                break
            if spec and s and not s.startswith(("at ", "{")):
                msg = s
                break
        rep["failures"].append({"id": name, "line": msg})
    return rep


def _go(text: str, lines: List[str]) -> Optional[Dict[str, Any]]:
    fails = re.findall(r"^\s*--- FAIL: (\S+)", text, re.M)
    passes = re.findall(r"^\s*--- PASS: (\S+)", text, re.M)
    skips = re.findall(r"^\s*--- SKIP: (\S+)", text, re.M)
    pkgs = re.findall(r"^(ok|FAIL)\s+\S+\s+([\d.]+)s", text, re.M)
    if not (fails or passes or pkgs):
        return None
    rep = _report("go test", passed=len(passes) or (len([p for p in pkgs if p[0] == "ok"]) if not fails else 0),
                  failed=len(fails), skipped=len(skips), ms=round(sum(float(p[1]) for p in pkgs) * 1000) if pkgs else None)
    for name in fails:
        i = next(k for k, ln in enumerate(lines) if f"--- FAIL: {name}" in ln)
        msg = next((x.strip() for x in lines[i + 1:i + 6] if x.strip() and not x.strip().startswith("---")), "")
        rep["failures"].append({"id": name, "line": msg})
    return rep


_PARSERS: List[Callable[[str, List[str]], Optional[Dict[str, Any]]]] = [_pytest, _cargo, _jest, _vitest, _node, _go]
_HEADERS = [r"^_{3,} .*\b{n}\b.* _{3,}$", r"^---- \S*{n} stdout ----$", r"^# Subtest: {n}$", r"^\s*● .*{n}",
            r"^\s*--- FAIL: {n}\b", r"^\s*✖ {n}"]


def parse(command: str, output: str) -> Optional[Dict[str, Any]]:
    """The report of a test run, or None when the command ran no tests or the output has no summary line."""
    if not is_test(command) or not output:
        return None
    text = _ANSI.sub("", output.replace("\r\n", "\n"))
    lines = text.split("\n")
    for parser in _PARSERS:
        rep = parser(text, lines)
        if rep is not None:
            fails = rep["failures"][:MAX_FAILURES]
            for f in fails:
                f["line"] = f["line"][:300]
                f["context"] = _around(lines, f["id"], _HEADERS)
            rep["failures"] = fails
            return rep
    return None
