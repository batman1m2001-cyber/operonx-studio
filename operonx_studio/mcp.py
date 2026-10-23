"""The studio's actions, as tools the assistant can call (MCP over stdio).

The assistant is a Claude Code session. This module is the MCP server the
studio hands it (``--mcp-config``): each tool calls the studio's own HTTP
API for the project the conversation belongs to, so the agent can do what
the user can do — list and open runs, read the Monitor, compare two runs,
start a job, preview a price — and whatever it opens also opens on the
user's screen (the page polls ``/ui/actions``). It is the standard library
only: JSON-RPC 2.0, one message per line.

Run by the studio, never by hand::

    OPERONX_STUDIO_URL=http://127.0.0.1:8765 OPERONX_STUDIO_PID=… \\
    OPERONX_STUDIO_TOKEN=… python -m operonx_studio.mcp
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

__all__ = ["HOME_TOOLS", "TOOLS", "handle", "main"]

PROTOCOL = "2024-11-05"


class Studio:
    """The studio's HTTP API for one project."""

    def __init__(self, url: str, pid: str, token: str = ""):
        self.url = url.rstrip("/")
        self.pid = pid
        self.token = token

    def call(self, path: str, body: Optional[Dict[str, Any]] = None, **params: Any) -> Any:
        return self.root(f"/p/{self.pid}{path}", body, **params)

    def root(self, path: str, body: Optional[Dict[str, Any]] = None, **params: Any) -> Any:
        """Any studio API route, ``/api`` + *path*."""
        url = f"{self.url}/api{path}"
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        if clean:
            url += "?" + urllib.parse.urlencode(clean)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
        req.add_header("content-type", "application/json")
        req.add_header("x-operonx-via", "assistant")  # the Board's actor: who did it, through what
        if self.token:
            req.add_header("cookie", f"oxsession={self.token}")
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                got = json.loads(exc.read().decode("utf-8"))
                err = got.get("error") or got.get("message")
            except Exception:  # noqa: BLE001
                err = None
            raise RuntimeError(err or f"HTTP {exc.code}") from None

    def show(self, kind: str, **args: Any) -> None:
        """Put something on the user's screen (best-effort)."""
        try:
            self.call("/ui/action", {"kind": kind, "args": args})
        except Exception:  # noqa: BLE001 — showing is a courtesy, never a failure
            pass


def _money(cost: Any, unpriced: int = 0) -> str:
    if cost is None:
        return "unpriced" if unpriced else "—"
    text = f"${cost:.4f}" if cost < 0.01 else f"${cost:.2f}"
    return text + (f" + {unpriced} unpriced" if unpriced else "")


def _run_line(r: Dict[str, Any]) -> str:
    bits = [r["run"], r.get("status", "?"), f"{(r.get('duration_ms') or 0) / 1000:.2f}s",
            _money(r.get("cost_usd"), r.get("unpriced") or 0)]
    if r.get("origin") and r["origin"] != "adhoc":
        bits.append(f"{r['origin']}:{r.get('name')}")
    if r.get("key"):
        bits.append(f"key={r['key']}")
    if r.get("first_error"):
        bits.append(f"error: {r['first_error']}")
    return " | ".join(bits)


# ── the tools ──────────────────────────────────────────────────────────────


def t_list_runs(s: Studio, a: Dict[str, Any]) -> str:
    since = None
    if a.get("hours"):
        since = time.time() - float(a["hours"]) * 3600
    got = s.call("/runs", origin=a.get("origin"), name=a.get("name"), status=a.get("status"),
                 since=since, q=a.get("search"), order=a.get("order"), limit=a.get("limit") or 20)
    lines = [f"{got.get('total')} runs match; showing {len(got['runs'])} (run | status | time | cost | origin …)"]
    lines += [_run_line(r) for r in got["runs"]]
    return "\n".join(lines)


def t_open_run(s: Studio, a: Dict[str, Any]) -> str:
    run = str(a["run"])
    tree = s.call(f"/trace/{urllib.parse.quote(run, safe='')}/tree")
    s.show("open_run", run=run, mode=a.get("mode") or "tree", lens=a.get("lens"))
    sm = tree.get("summary") or {}
    out = [f"run {run}: {sm.get('status')} in {(sm.get('duration_ms') or 0) / 1000:.2f}s, "
           f"{sm.get('executions')} executions, cost {_money(sm.get('cost_usd'), sm.get('unpriced') or 0)}, "
           f"{sm.get('llm_calls')} LLM calls"]
    if sm.get("first_error"):
        out.append(f"first error: {sm['first_error']}")
    out.append("ops by total time (op: count, total ms, max ms, errors, cost):")
    for r in (tree.get("rollups") or [])[:15]:
        out.append(f"  {r['op']}: {r['count']}x, {r['total_ms']:.1f}, {r['max_ms']:.1f}, "
                   f"{r['errors']}, {_money(r.get('cost_usd'), r.get('unpriced') or 0)}")
    failed = [row for row in tree.get("rows") or [] if row.get("status") == "error"]
    for row in failed[:5]:
        out.append(f"  failed {row.get('op')} @ {row.get('ctx')}: {str(row.get('error') or '')[-300:]}")
    out.append("(the run is now open on the user's screen)")
    return "\n".join(out)


def t_op_values(s: Studio, a: Dict[str, Any]) -> str:
    run, op = str(a["run"]), str(a["op"])
    got = s.call(f"/trace/{urllib.parse.quote(run, safe='')}/op/{urllib.parse.quote(op, safe='')}",
                 limit=a.get("limit") or 5)
    return json.dumps(got, default=str)[:20000]


def t_monitor(s: Studio, a: Dict[str, Any]) -> str:
    days = float(a.get("days") or 7)
    until = time.time()
    m = s.call("/monitor", origin=a.get("origin"), name=a.get("name"), since=until - days * 86400, until=until)
    s.show("open_monitor", target=f"{a['origin']}:{a['name']}" if a.get("origin") and a.get("name") else "",
           days=days)
    t, p = m["tiles"], m["previous"]
    out = [f"last {days:g} days: {t['runs']} runs (previous period {p['runs']}), error rate "
           f"{t['error_rate'] if t['error_rate'] is not None else '—'}, p50 {t['p50_ms']} ms, p95 {t['p95_ms']} ms "
           f"(previous p95 {p['p95_ms']}), cost {_money(t['cost_usd'], t['unpriced'])}"]
    out.append("ops (op: p50, p95, per run, % of run time, p95 trend vs before):")
    for o in m["ops"][:15]:
        if o["background"]:
            continue
        trend = f"{100 * o['trend']:+.0f}%" if o.get("trend") is not None else "—"
        out.append(f"  {o['op']}: {o['p50_ms']:.1f}, {o['p95_ms']:.1f}, {o['per_run']:.1f}, "
                   f"{100 * o['share']:.1f}%, {trend}")
    for e in m["errors"][:8]:
        out.append(f"  error x{e['count']}: {e['op']}: {e['message']} (latest run {e['example']})")
    return "\n".join(out)


def t_compare(s: Studio, a: Dict[str, Any]) -> str:
    got = s.call("/compare", a=a["a"], b=a["b"])
    s.show("compare", a=a["a"], b=a["b"])
    out = [f"B - A total: {got['d_ms']:+.1f} ms"]
    for o in got["ops"][:20]:
        if o.get("d_ms") is None:
            out.append(f"  {o['op']}: only in {'A' if o['a'] else 'B'}")
        else:
            out.append(f"  {o['op']}: {o['a']['total_ms']:.1f} -> {o['b']['total_ms']:.1f} ms ({o['d_ms']:+.1f})")
    return "\n".join(out)


def t_select_op(s: Studio, a: Dict[str, Any]) -> str:
    s.show("select_op", op=str(a["op"]))
    return f"{a['op']} is selected on the user's Flow canvas."


_POINTABLE = re.compile(r"^(?:status|q|qopt|plan|phase|ms|row|commit|setting|page|tab|op|run|job|eval):\S")


def t_point(s: Studio, a: Dict[str, Any]) -> str:
    """Point at one thing on the owner's screen (docs/ALIVE_ASSISTANT_PLAN.md D5): the screen goes there and rings it."""
    target = str(a.get("target") or "").strip()
    if not _POINTABLE.match(target):
        return (f"not a target: {target!r}. Use plan:docs/X_PLAN.md, phase:docs/X_PLAN.md#P2, row:<id>, q:<id>, "
                "commit:<sha>, setting:<name>, status:<needs|working|checklist|plans|changes>, op:<name>, run:<id>")
    s.show("point", target=target, words=str(a.get("words") or a.get("label") or "")[:40])
    return f"pointed at {target} on the owner's screen"


def t_run_job(s: Studio, a: Dict[str, Any]) -> str:
    got = s.call(f"/jobs/{urllib.parse.quote(str(a['name']), safe='')}/run", {"resume": bool(a.get("resume"))})
    s.show("open_jobs", job=str(a["name"]))
    return f"started {a['name']} (pid {got.get('pid')}); its runs appear in Jobs and Runs as they finish"


def t_price(s: Studio, a: Dict[str, Any]) -> str:
    got = s.call("/resources/price", {"resource": a["resource"], "input_per_1m": a["input_per_1m"],
                                      "output_per_1m": a["output_per_1m"], "apply": bool(a.get("apply"))})
    return ("applied\n" if got.get("applied") else "preview (not written)\n") + (got.get("diff") or "no change")


def t_rerun_op(s: Studio, a: Dict[str, Any]) -> str:
    """Re-run one op of a recorded run in the current code, and say how it
    compares with what it did in that run."""
    run, op = str(a["run"]), str(a["op"])
    plan = s.call("/play/rerun-plan", run=run, op=op)
    ex = plan["executions"][0]
    inputs = a.get("inputs")
    if inputs is None:
        if ex["missing"]:
            return (f"{op}'s recorded inputs are missing {', '.join(ex['missing'])} (never kept: a transient "
                    f"stream or too large). Recorded: {json.dumps(ex['inputs'], default=str)[:2000]}. "
                    "Call again with `inputs` filled in.")
        inputs = ex["inputs"]
    got = s.call("/play/rerun", {"run": run, "op": op, "inputs": inputs, "wait": True})
    then = f"{ex['status']} in {(ex.get('duration_ms') or 0):.1f} ms"
    if ex["status"] == "error":
        then += f" ({(str(ex.get('error') or '').strip().splitlines() or [''])[-1]})"
    now = f"{got.get('status')} in {got.get('ms', 0):.1f} ms"
    lines = [f"re-ran {op} of {run} in the current code: then {then}; now {now}"]
    if got.get("error"):
        lines.append(f"error now: {got['error']}")
    lines.append("outputs now: " + json.dumps(got.get("outputs"), default=str)[:6000])
    if ex["status"] != "error":
        lines.append("outputs then: " + json.dumps(ex.get("outputs"), default=str)[:6000])
    lines.append(f"(recorded as run {got.get('trace_id')}, origin playground)")
    return "\n".join(lines)


def t_play(s: Studio, a: Dict[str, Any]) -> str:
    """Drive a service's door like a client: send messages, wait for the
    session to end, report what came back."""
    msgs = []
    for m in a.get("messages") or []:
        if isinstance(m, str):
            msgs.append({"kind": "text", "text": m})
        elif isinstance(m, dict) and m.get("kind") in ("text", "json"):
            msgs.append(m)
        else:
            msgs.append({"kind": "json", "value": m})
    body = {"service": a["service"], "toy": a.get("toy") or "chat", "query": a.get("query") or {},
            "send": msgs, "end": True, "wait": True, "timeout": float(a.get("timeout") or 120)}
    if a.get("replay_of"):
        body = {"replay_of": a["replay_of"], "wait": True}
    got = s.call("/play/open", body)
    events = got.get("events") or []
    out = []
    for e in events:
        if e.get("t") == "out":
            m = e["msg"]
            out.append("  ← " + (m.get("text") if m.get("kind") == "text" else json.dumps(m.get("value"), default=str))[:2000])
        elif e.get("t") == "refused":
            out.append(f"refused: {e.get('reason')}")
        elif e.get("t") == "ended":
            out.insert(0, f"session {e.get('status')} in {e.get('ms', 0):.0f} ms, run {e.get('trace_id')}"
                          + (f" — {e['error']}" if e.get("error") else ""))
    if not any(e.get("t") in ("ended", "refused") for e in events):
        out.insert(0, "the session had not ended when the wait ran out")
    return "\n".join(out) or "nothing came back"


def t_run_eval(s: Studio, a: Dict[str, Any]) -> str:
    """Run an eval to the end and report it against the run before: the
    pass rate then and now, and every case that flipped."""
    name = str(a["name"])
    before = {r["run_id"] for e in s.call("/evals")["evals"] if e["name"] == name for r in e["runs"]}
    s.call(f"/jobs/{urllib.parse.quote(name, safe='')}/run", {})
    s.show("open_eval", name=name)
    deadline = time.time() + float(a.get("timeout") or 900)
    run = None
    while time.time() < deadline:
        ev = next((e for e in s.call("/evals")["evals"] if e["name"] == name), None)
        if ev is None:
            return f"no eval named {name!r}"
        fresh = [r for r in ev["runs"] if r["run_id"] not in before]
        if fresh and fresh[0]["status"] != "running":
            run = fresh[0]
            break
        time.sleep(2)
    if run is None:
        return f"{name} is still running after the wait; its record will say when it ends"
    got = s.call(f"/evals/{urllib.parse.quote(name, safe='')}/runs/{run['run_id']}")
    s.show("open_eval", name=name, run=run["run_id"])
    now, then = got["run"].get("eval") or {}, got.get("against_eval") or {}

    def rate(e: Dict[str, Any]) -> str:
        return f"{e.get('passed')}/{e.get('cases')} ({100 * (e.get('pass_rate') or 0):.1f}%)" if e else "—"

    lines = [f"{name} run {run['run_id']}: {run['status']} — passed {rate(now)}"
             + (f"; before ({got['against']}): {rate(then)}" if then else " (no earlier run to compare)")]
    items = {i["key"]: i for i in got["items"]}
    for key, flip in sorted(got["flips"].items(), key=lambda kv: kv[1]):
        v = (items.get(key) or {}).get("verdict") or {}
        why = v.get("error") or "; ".join(f"{k}: {c.get('reason') or ('pass' if c.get('passed') else 'fail')}"
                                          for k, c in (v.get("checks") or {}).items())
        lines.append(f"  {flip}: {key} — {why}"[:400])
    failing = [k for k, i in items.items() if not (i.get("verdict") or {}).get("passed") and k not in got["flips"]]
    if failing:
        lines.append(f"  still failing: {', '.join(failing[:20])}" + (" …" if len(failing) > 20 else ""))
    return "\n".join(lines)


# ── the Board: operonx-project's milestones, cards and checklist ─────────


def _ms_line(m: Dict[str, Any]) -> str:
    asks = f", {m['open_questions']} question(s) for the owner" if m.get("open_questions") else ""
    budget = f" of ${m['budget_usd']}" if m.get("budget_usd") is not None else ""
    return (f"- {m['id']} · {m['title']} — {m['state']}{' (' + m['reason'] + ')' if m.get('reason') else ''}; "
            f"{m['done']}/{m['cards']} cards done; ${m['cost_usd']:.2f}{budget}{asks}")


def _tdd_note(c: Dict[str, Any]) -> str:
    """What test-first showed for a card: nothing to say, no tests (off), or strict's red evidence."""
    if c.get("tdd") == "off":
        return "no tests written (TDD off)"
    red = c.get("red")
    if not red:
        return ""
    if not red.get("red"):
        return f"its tests passed before the code ({red.get('passed')} passed)"
    return "red before the code" + (" (written again: the first set passed already)" if red.get("rewritten") else "")


def _retro_lines(retro: Optional[Dict[str, Any]]) -> List[str]:
    """A delivered milestone's retrospective: where its money and rounds went, and what it taught."""
    if not retro:
        return []
    rep = retro.get("report") or {}
    cards = rep.get("cards") or []
    costly = sorted((c for c in cards if c.get("rounds", 0) > 1 or c.get("questions") or c.get("rewritten")),
                    key=lambda c: -c.get("cost_usd", 0))  # fmt: skip
    stages = ", ".join(f"{k} ${v:.2f}" for k, v in (rep.get("by_stage") or {}).items())
    lines = [f"Retrospective: ${rep.get('cost_usd', 0):.2f} over {len(cards)} card(s), {rep.get('rounds', 0)} "
             f"round(s)" + (f"; stages {stages}" if stages else "")]  # fmt: skip
    for c in costly[:8]:
        bits = [f"{c['rounds']} rounds", f"${c['cost_usd']:.2f}"]
        if c.get("failed_checks"):
            bits.append("failed on " + ", ".join(c["failed_checks"]))
        bits += [f"the owner decided: {(q.get('question') or '')[:120]} → {q.get('choice') or ''} {q.get('answer') or ''}".rstrip()
                 for q in c.get("questions") or []]  # fmt: skip
        if c.get("rewritten"):
            bits.append(f"tests written again {len(c['rewritten'])}×")
        lines.append(f"  {c['id']} · {c.get('title', '')}: " + "; ".join(bits))
    for x in retro.get("lessons") or []:
        lines.append(f"  Lesson ({retro.get('file')}): {x.get('rule')} — {x.get('evidence')}")
    return lines


def t_board_practices(s: Studio, a: Dict[str, Any]) -> str:
    body = {k: a[k] for k in ("preset", "force", "toml") if k in a and a[k] not in (None, "")}
    try:
        got = s.call("/board/practices", body) if body else s.call("/board/practices", preview=a.get("preview"))
    except RuntimeError as exc:
        return f"refused: {exc}"
    if not got.get("ok"):
        return f"refused: {got.get('message')}" + (f"\nThe file now:\n{got['text']}" if got.get("text") else "")
    s.show("open_board", view="board")
    lines = [("Changed: " if body else "") + str(got.get("message")) + ".", "", str(got.get("summary") or "")]
    found = got.get("violations") or []
    if found:
        lines += ["", f"Architecture check on the checkout ({got.get('violation_count')}):"]
        lines += [f"- {v['file']}:{v['line']} {v['message']}" for v in found[:30]]
        if got.get("violation_count", 0) > 30:
            lines.append("- …")
    seen = got.get("preview")
    if seen:
        lines += ["", f"The {seen['preset']} preset would flag {seen['violation_count']} on the checkout today "
                      "(nothing written; they would be the baseline, costing no card anything):"]  # fmt: skip
        lines += [f"- {v['file']}:{v['line']} {v['message']}" for v in seen["violations"][:30]]
    if got.get("text"):
        lines += ["", f"The file ({got.get('file')}):", got["text"]]
    else:
        lines += ["", f"No {got.get('file')} yet. Presets: {', '.join(got.get('presets') or [])}."]
    return "\n".join(lines)


def t_project_status(s: Studio, a: Dict[str, Any]) -> str:
    """The engine's one status document as plain lines (PROJECT_MODE_PLAN D2): what the owner's screen shows."""
    try:
        got = s.call("/project/status", changes=int(a.get("changes") or 15))
    except RuntimeError as exc:
        return f"unavailable: {exc}"
    if got.get("text"):
        return got["text"]
    doc = got.get("project") or {}  # an engine that sends only the document
    c = doc.get("checklist") or {}
    return json.dumps({"checklist": {"verified": c.get("verified"), "total": c.get("total"), "open": c.get("open")},
                       "working_on": doc.get("working_on"), "needs_you": doc.get("needs_you"),
                       "unmarked_plans": doc.get("unmarked"), "changes": (doc.get("changes") or [])[:5]},
                      ensure_ascii=False, indent=1)  # fmt: skip


def t_board_status(s: Studio, a: Dict[str, Any]) -> str:
    mid = str(a.get("milestone") or "")
    if mid:
        got = s.call(f"/board/{urllib.parse.quote(mid)}")
        if got.get("error"):
            return f"failed: {got['error']}"
        s.show("open_board", mid=mid, view="board")
        by = {c["id"]: c for c in got["cards"]}
        lines = [_ms_line(got["milestone"])]
        for col in got["columns"]:
            if not col["cards"]:
                continue
            lines.append(f"{col['title']}:")
            for cid in col["cards"]:
                c = by[cid]
                extra = [c["stage"] or "", f"taken by {c['taken']}" if c.get("taken") else "",
                         "waits for a submit" if c.get("waiting_for_submit") else "",
                         "asks the owner" if c.get("asks") else "", (c.get("activity") or {}).get("text", ""),
                         c["reason"] if c["state"] in ("failed", "blocked") else ""]  # fmt: skip
                extra.append(_tdd_note(c))
                lines.append(f"  {cid} · {c['title']} [{c['state']}] rows {', '.join(c['rows']) or '—'}"
                             + "".join(f" — {x}" for x in extra if x))
        for q in got["questions"]:
            opts = "; ".join(f"{o['key']}) {o['label']}" for o in q["options"])
            lines.append(f"Open question {q.get('qid') or q.get('short') or q['id']} ({q['kind']}{', card ' + q['card'] if q['card'] else ''}): "
                         f"{q['problem']}" + (f" — options: {opts}" if opts else "")
                         + (f" (recommended {q['recommended']})" if q.get("recommended") else ""))
            if q.get("evidence"):  # what the engine saw (tipcalc m3/C5: the held-out failures the owner had to know)
                lines += [f"    {x}" for x in str(q["evidence"]).splitlines()[-12:]]
            if q.get("kind") == "approval":  # the plan being approved: its cards are not on the board until then
                for c in q.get("plan_cards") or []:
                    lines.append(f"  Plan {c['id']}{' [risky]' if c.get('risk') == 'high' else ''} · {c['title']}"
                                 + (f" — needs {', '.join(c['deps'])}" if c.get("deps") else "")
                                 + (f" — paths {', '.join(c['paths'])}" if c.get("paths") else ""))
                    if c.get("intent"):
                        lines.append(f"    {c['intent'][:600]}")
                    lines += [f"    - {k[:240]}" for k in (c.get("criteria") or [])[:6]]
        arch = got.get("architecture")
        if arch:
            lines.append("Architecture check: " + ("clean on the milestone's base" if arch.get("ok") else
                                                   f"{arch['violations']} violation(s) already on the milestone's "
                                                   "base (they cost its cards nothing; a new one fails a round)"))
            end = arch.get("after")
            if end:
                lines.append("  At final verification: " + ("clean" if end.get("ok") else
                                                            f"{end['violations']} violation(s)"))
        lines += _retro_lines(got.get("retro"))
        return "\n".join(lines)
    got = s.call("/board")
    if not got.get("available"):
        return ("This project has no docs/brd/ and no operonx-project state: `operonx-project brd init` "
                "(or `operonx-project adopt` for built code) makes one.")
    s.show("open_board", view="board")
    d = got.get("daemon") or {}
    lines = [f"Daemon: {'running (' + d.get('owner', '') + ')' if d.get('running') else 'stopped'}"
             + ("" if got.get("sandbox", True) else "; coders run unsandboxed")]
    lines += [_ms_line(m) for m in got.get("milestones") or []] or ["No milestones yet."]
    if got.get("brd"):
        ck = s.call("/brd")
        counts = ", ".join(f"{k} {n}" for k, n in sorted((ck.get("counts") or {}).items()))
        todo = [r["id"] for r in ck.get("rows") or [] if r["status"] not in
                ("implemented_verified", "out_of_scope_demo", "not_applicable", "superseded")]  # fmt: skip
        lines.append(f"Checklist (docs/brd on {ck.get('branch') or 'this checkout'}): {counts or 'no rows'}")
        if todo:
            lines.append("Rows not built yet: " + ", ".join(todo[:40]) + (" …" if len(todo) > 40 else ""))
    return "\n".join(lines)


def t_board_card(s: Studio, a: Dict[str, Any]) -> str:
    mid, cid = str(a["milestone"]), str(a["card"])
    got = s.call(f"/board/{urllib.parse.quote(mid)}/card/{urllib.parse.quote(cid)}")
    if got.get("error"):
        return f"failed: {got['error']}"
    s.show("open_board", mid=mid, card=cid)
    c = got["card"]
    lines = [f"{c['id']} · {c['title']} [{c['state']}{' / ' + c['stage'] if c['stage'] else ''}] — {c['intent']}",
             f"rows {', '.join(c['rows']) or '—'}; deps {', '.join(c['deps']) or '—'}; "
             f"files {', '.join(c['paths']) or 'anywhere'}; ${c['cost_usd']:.2f}"]  # fmt: skip
    lines += [f"  - {x}" for x in c["criteria"]]
    if c["reason"]:
        lines.append(f"reason: {c['reason']}")
    for e in got["events"][-int(a.get("events") or 15):]:
        text = e["data"].get("text") or e["data"].get("message") or e["data"].get("to") or ""
        lines.append(f"  {e['kind']}{' (' + e['actor'] + ')' if e.get('actor') else ''}{': ' + str(text) if text else ''}")
    return "\n".join(lines)


def _board_act(s: Studio, mid: str, body: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return s.call(f"/board/{urllib.parse.quote(mid)}/act", body)
    except RuntimeError as exc:  # the engine's refusal comes back as the HTTP error's message
        return {"ok": False, "message": str(exc)}


def t_board_start(s: Studio, a: Dict[str, Any]) -> str:
    body = {k: a[k] for k in ("title", "rows", "goal", "mode", "max_usd", "from_board", "needs")
            if a.get(k) not in (None, "", [])}
    try:
        got = s.call("/board/new", body)
    except RuntimeError as exc:
        return f"refused: {exc}"
    if not got.get("ok"):
        return f"refused: {got.get('message')}"
    if got.get("milestone"):
        s.show("open_board", mid=got["milestone"], view="board")
    return (f"{got.get('message') or 'queued'}. The daemon plans it, then the plan waits for the owner's approval "
            "(board_act approve) — it must be running (board_daemon start).")


def t_board_request(s: Studio, a: Dict[str, Any]) -> str:
    body = {k: a[k] for k in ("text", "title", "mode", "max_usd", "needs") if a.get(k) not in (None, "", [])}
    try:
        got = s.call("/board/request", body)
    except RuntimeError as exc:
        return f"refused: {exc}"
    if not got.get("ok"):
        return f"refused: {got.get('message')}"
    s.show("open_board", mid=got["milestone"], view="board")
    return (f"{got['message']}. The words are {got.get('source')} in the BRD. The daemon must be running "
            "(board_daemon start); when the plan waits, show it to the owner (board_status) — approving is theirs.")


ACTS = ("answer", "approve", "pause", "unpause", "cancel", "replan", "retry", "prioritize", "release", "ship", "merge")


def t_board_act(s: Studio, a: Dict[str, Any]) -> str:
    op = str(a.get("op") or "")
    if op not in ACTS:
        return f"no op {op!r}; there are: {', '.join(ACTS)} (take and submit are board_take and board_submit)"
    body = {k: a[k] for k in ("op", "ref", "answer", "notes", "card", "priority", "usd", "hours") if k in a}
    got = _board_act(s, str(a["milestone"]), body)
    s.show("open_board", mid=str(a["milestone"]))
    return ("done: " if got.get("ok") else "refused: ") + str(got.get("message") or got.get("status"))


def t_board_daemon(s: Studio, a: Dict[str, Any]) -> str:
    action = str(a.get("action") or "")
    if action not in ("start", "stop", "status"):
        return "action: start, stop or status"
    if action == "status":
        d = s.call("/board").get("daemon") or {}
        return f"running ({d.get('owner')})" if d.get("running") else "stopped"
    try:
        got = s.call("/board/daemon", {"action": action})
    except RuntimeError as exc:
        return f"failed: {exc}"
    return str(got.get("message") or got.get("status"))


def t_board_models(s: Studio, a: Dict[str, Any]) -> str:
    body = {k: a[k] for k in ("model", "models") if k in a}
    try:
        got = s.call("/board/settings", body) if body else s.call("/board/settings")
    except RuntimeError as exc:
        return f"refused: {exc}"
    if not got.get("ok"):
        return f"refused: {got.get('message')}"
    by: Dict[str, List[str]] = {}
    for role, m in (got.get("effective") or {}).items():
        by.setdefault(m, []).append(role)
    lines = [("Changed. " if body else "") + "The next sessions run on:"]
    lines += [f"- {m}: {', '.join(roles)}" for m, roles in sorted(by.items())]
    lines.append("Running sessions keep their model; the daemon needs no restart.")
    return "\n".join(lines)


def _settle(s: Studio, mid: str, cid: str, wait: float, done: Callable[[Dict[str, Any]], bool]) -> Dict[str, Any]:
    deadline = time.time() + wait
    while True:
        brief = _board_act(s, mid, {"op": "card", "card": cid})
        if not brief.get("ok", True) and brief.get("message"):
            return brief
        brief = brief.get("brief") or brief
        if done(brief) or time.time() >= deadline:
            return brief
        time.sleep(1.5)


_ENDED = ("verified", "done", "failed", "cancelled")


def _brief_text(mid: str, b: Dict[str, Any]) -> str:
    lines = [f"{b['card']} · {b['title']} — yours ({(b.get('taken') or {}).get('actor', '')}), round {b.get('round')}",
             f"Work in {b['worktree']} (branch {b['branch']}); commit nothing outside its files: "
             f"{', '.join(b.get('paths') or []) or 'anywhere in the project'}.",
             f"Intent: {b.get('intent')}", f"Rows: {', '.join(b.get('rows') or []) or '—'}",
             f"Acceptance tests (written for you, do not change them): {b.get('acceptance_tests') or '—'}",
             "Criteria:"] + [f"  - {c}" for c in b.get("criteria") or []]  # fmt: skip
    if b.get("feedback"):
        lines.append("The last round found:\n" + b["feedback"])
    lines.append(f"When the criteria pass there, call board_submit(milestone={mid!r}, card={b['card']!r}, summary=…).")
    return "\n".join(lines)


def t_board_take(s: Studio, a: Dict[str, Any]) -> str:
    mid, cid = str(a["milestone"]), str(a["card"])
    got = _board_act(s, mid, {"op": "take", "card": cid})
    if not got.get("ok"):
        return f"refused: {got.get('message')}"
    s.show("open_board", mid=mid, card=cid)
    b = _settle(s, mid, cid, float(a.get("wait") or 60),
                lambda b: b.get("waiting_for_submit") or b.get("state") in _ENDED or b.get("state") == "pending")
    if b.get("state") == "pending":  # taken ahead: its dependencies first
        return (f"{cid} is yours, taken ahead: {got.get('message')}. When it is ready the engine starts it and parks "
                f"it for you; call board_take(milestone={mid!r}, card={cid!r}) again then for its brief.")
    if not b.get("waiting_for_submit"):
        return f"{cid} is {b.get('state')} ({b.get('reason') or got.get('message')}); the daemon has not parked it for you yet"
    return _brief_text(mid, b)


def t_board_submit(s: Studio, a: Dict[str, Any]) -> str:
    mid, cid = str(a["milestone"]), str(a["card"])
    got = _board_act(s, mid, {"op": "submit", "card": cid, "summary": str(a.get("summary") or "")})
    if not got.get("ok"):
        return f"refused: {got.get('message')}"
    s.show("open_board", mid=mid, card=cid)
    time.sleep(2.0)  # the daemon takes the submit before the card leaves its park
    b = _settle(s, mid, cid, float(a.get("wait") or 600),
                lambda b: b.get("state") in _ENDED or (b.get("waiting_for_submit") and bool(b.get("feedback"))))
    if b.get("waiting_for_submit"):
        return "Not passed yet — it is yours again.\n" + _brief_text(mid, b)
    if b.get("state") in _ENDED:
        return f"{cid}: {b['state']}{' — ' + b['reason'] if b.get('reason') else ''}"
    return f"{cid} is still being checked ({b.get('state')}/{b.get('stage')}); board_card shows where it is."


# ── with no project open (the home page's assistant) ─────────────────────


def t_list_projects(s: Studio, a: Dict[str, Any]) -> str:
    got = s.root("/projects")
    rows = [f"- {p['name']} — {p['root']} (studio:project/{p['id']})" + ("" if p.get("exists") else " [missing]")
            for p in got.get("projects") or []]
    return "\n".join(rows) or "The studio knows no projects yet."


def t_new_project(s: Studio, a: Dict[str, Any]) -> str:
    import os.path

    templates = {t["id"]: t for t in s.root("/templates").get("templates") or []}
    template = str(a.get("template") or "blank")
    if template not in templates:
        return f"no template {template!r}; there are: " + ", ".join(templates)
    parent = os.path.expanduser(str(a.get("path") or "~"))
    got = s.root("/new", {"path": parent, "name": str(a["name"]), "template": template})
    return (f"Created {got['name']} at {got['root']} from the {template} template and added it to the studio. "
            f"Link it for the user as [{got['name']}](studio:project/{got['id']}).")


HOME_TOOLS: Dict[str, Dict[str, Any]] = {}


def _schema(props: Dict[str, Any], required: List[str] = ()) -> Dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(required)}


_S = {"type": "string"}
_N = {"type": "number"}
TOOLS: Dict[str, Dict[str, Any]] = {
    "list_runs": {"fn": t_list_runs,
                  "description": "List the project's recorded runs, newest first unless ordered otherwise. "
                                 "Filter by origin (service|job|eval|playground|adhoc), name (the service or "
                                 "job), status (ok|error), hours (only the last N hours), search (ids, keys) "
                                 "and order (started_desc|duration_desc|cost_desc|errors_desc).",
                  "schema": _schema({"origin": _S, "name": _S, "status": _S, "hours": _N, "search": _S,
                                     "order": _S, "limit": _N})},
    "open_run": {"fn": t_open_run,
                 "description": "Open one run: its verdict, its ops by time and cost, and its failures. Also "
                                "opens it on the user's screen (mode conversation|tree|timeline|workflow|data; lens path|time|cost — failures are always marked).",
                 "schema": _schema({"run": _S, "mode": _S, "lens": _S}, ["run"])},
    "op_values": {"fn": t_op_values,
                  "description": "The recorded inputs and outputs of one op's executions in one run.",
                  "schema": _schema({"run": _S, "op": _S, "limit": _N}, ["run", "op"])},
    "monitor": {"fn": t_monitor,
                "description": "Health of one service or job (or everything) over the last N days: runs, "
                               "error rate, p50/p95 with the previous period, per-op latency and trend, cost, "
                               "grouped errors. Opens the Monitor on the user's screen.",
                "schema": _schema({"origin": _S, "name": _S, "days": _N})},
    "compare_runs": {"fn": t_compare,
                     "description": "Compare two runs op by op (time per op and the difference).",
                     "schema": _schema({"a": _S, "b": _S}, ["a", "b"])},
    "select_op": {"fn": t_select_op,
                  "description": "Select an op on the user's Flow canvas, to point at it.",
                  "schema": _schema({"op": _S}, ["op"])},
    "point": {"fn": t_point,
              "description": "Point at the one thing your answer is about, on the owner's screen: it goes to that page "
                             "and rings it with your two or three words. Targets: plan:docs/X_PLAN.md, "
                             "phase:docs/X_PLAN.md#P2, row:<requirement id>, q:<question id>, commit:<sha>, "
                             "setting:<name>, status:<needs|working|checklist|plans|changes>, op:<op name>, run:<run id>. "
                             "Once per answer at most; never as decoration. It only shows where: the answer "
                             "still says everything in words.",
              "schema": _schema({"target": _S, "words": _S}, ["target"])},
    "run_job": {"fn": t_run_job,
                "description": "Start one of the application's jobs (or a job of steps); resume=true reruns only "
                               "what the last run did not finish.",
                "schema": _schema({"name": _S, "resume": {"type": "boolean"}}, ["name"])},
    "rerun_op": {"fn": t_rerun_op,
                 "description": "Re-run one op of a recorded run in the CURRENT code, with the inputs it had "
                                "(or `inputs` you give), and compare with what it did then. The way to check a fix "
                                "to one op without making a call or running a job. The result is recorded as a "
                                "playground run.",
                 "schema": _schema({"run": _S, "op": _S, "inputs": {"type": "object"}}, ["run", "op"])},
    "play": {"fn": t_play,
             "description": "Drive one of the application's services like a client, in the playground: send "
                            "`messages` (strings are text; objects are JSON items) through its real door, then "
                            "report what came back. `query` is the connection's query string (it fills the graph's "
                            "parameters). `replay_of` replays a recorded run instead (a playground session, or a real one of a service declared with replay=True). Each session is a "
                            "recorded run.",
             "schema": _schema({"service": _S, "messages": {"type": "array"}, "query": {"type": "object"},
                                "toy": _S, "replay_of": _S, "timeout": _N}, ["service"])},
    "run_eval": {"fn": t_run_eval,
                 "description": "Run one of the project's evals (a dataset, the system under test, evaluators) to "
                                "the end and report the pass rate against the run before it, with every case that "
                                "flipped (fixed / regressed). The way to verify a change end to end.",
                 "schema": _schema({"name": _S, "timeout": _N}, ["name"])},
    "set_llm_price": {"fn": t_price,
                      "description": "Preview (apply=false) or write (apply=true) an LLM resource's prices in "
                                     "USD per 1M tokens, in the project's resources file. 0 declares a free "
                                     "(in-house) model; leave a model unpriced rather than guessing.",
                      "schema": _schema({"resource": _S, "input_per_1m": _N, "output_per_1m": _N,
                                         "apply": {"type": "boolean"}}, ["resource", "input_per_1m", "output_per_1m"])},
    "project_status": {"fn": t_project_status,
                       "description": "Where the project stands, as the owner's screen shows it: the checklist (verified "
                                      "of total, the open rows), the plans and milestones with their phases, what "
                                      "waits for the owner, what is in progress, the last commits, the setup, and the "
                                      "plan docs with no status block. Answer \"where are we\", \"what's next\", "
                                      "\"what needs me\" from it, never from memory; call it again after a change.",
                       "schema": _schema({"changes": _N})},
    "board_status": {"fn": t_board_status,
                     "description": "The project's Board (operonx-project): the daemon, each milestone's state, cards "
                                    "and spend, and the checklist's rows not built yet. With milestone: its cards by "
                                    "column, what each running card does now, and the questions waiting on the owner. "
                                    "Opens the Board on the user's screen.",
                     "schema": _schema({"milestone": _S})},
    "board_card": {"fn": t_board_card,
                   "description": "One card of a milestone: intent, rows, criteria, files, and its last events.",
                   "schema": _schema({"milestone": _S, "card": _S, "events": _N}, ["milestone", "card"])},
    "board_start": {"fn": t_board_start,
                    "description": "Start a new milestone for checklist rows (rows: their IDs) and/or a goal in "
                                   "words; mode w2 (default, a few cards at a time) or w1 (all at once); max_usd "
                                   "caps its spend; from_board seeds it with an earlier milestone's cards; needs "
                                   "lists milestones it waits for (\"operonx-studio#m3\" in another project, "
                                   "\"m2\" here): it starts when they are done. The plan waits for the owner's "
                                   "approval.",
                    "schema": _schema({"title": _S, "rows": {"type": "array", "items": _S}, "goal": _S, "mode": _S,
                                       "max_usd": _N, "from_board": _S, "needs": {"type": "array", "items": _S}},
                                      ["title"])},
    "board_request": {"fn": t_board_request,
                      "description": "The owner asks for something new in their own words: text is the words as they "
                                     "gave them (do not rewrite them into requirements; the engine extracts those). "
                                     "It becomes a BRD source, its requirements continue the checklist's numbering, "
                                     "and a milestone scoped to them is planned and waits for the owner's approval. "
                                     "title is optional; mode w1 (default) or w2; max_usd caps it.",
                      "schema": _schema({"text": _S, "title": _S, "mode": _S, "max_usd": _N,
                                         "needs": {"type": "array", "items": _S}}, ["text"])},
    "board_act": {"fn": t_board_act,
                  "description": "An owner's action on a milestone, checked by the engine: answer (ref: a question's "
                                 "short id or a card, answer: an option key, words, or {\"choice\": key, \"text\": words} for "
                                 "both; the reply says which option was taken), approve, pause, unpause, cancel, "
                                 "replan (notes), retry (usd or hours of extra budget), prioritize (card, priority; "
                                 "lower runs first), release (a taken card back to the engine), ship (a done milestone: "
                                 "push its branch, open the PR or the GitLab link), merge (its PR, once checks "
                                 "pass, where the repo grants it). Approve, cancel, answers, ship and merge are the "
                                 "owner's calls: do them only when the owner asked for that.",
                  "schema": _schema({"milestone": _S, "op": _S, "ref": _S, "answer": {}, "notes": _S, "card": _S,
                                     "priority": _N, "usd": _N, "hours": _N}, ["milestone", "op"])},
    "board_daemon": {"fn": t_board_daemon,
                     "description": "Run (start), Stop (stop) or check (status) the project's operonx-project daemon, "
                                    "which plans milestones and works their cards.",
                     "schema": _schema({"action": _S}, ["action"])},
    "board_models": {"fn": t_board_models,
                     "description": "Read or change the models the project's sessions (planner, reviewers, "
                                    "implementer…) run on. model: one for every role (sonnet, opus, haiku, fable or a "
                                    "claude-… id; \"\" back to the defaults); models: {role: model} for one role. "
                                    "No arguments: read them. Applies to the next session.",
                     "schema": _schema({"model": _S, "models": {"type": "object"}})},
    "board_practices": {"fn": t_board_practices,
                        "description": "How the project is built (docs/brd/practices.toml, committed): TDD mode "
                                       "(acceptance | strict | off), the architecture the engine checks on every "
                                       "round (layers, forbidden imports, bounded contexts, private access), the "
                                       "glossary and lessons every session reads, and Definition-of-Done checks. "
                                       "No arguments: read it, with the architecture check run on the checkout; "
                                       "preview (a preset): also what that preset's rules would flag today, "
                                       "nothing written — the evidence for a recommendation. "
                                       "preset (operonx | clean; force over an existing file) or toml (the whole "
                                       "file, edited from what a read returned): the engine validates it and commits "
                                       "that file alone. Milestones discovered after it use it. Recommend from the "
                                       "decision guide and set it only when the owner agreed.",
                        "schema": _schema({"preview": _S, "preset": _S, "force": {"type": "boolean"}, "toml": _S})},
    "board_take": {"fn": t_board_take,
                   "description": "Take a card to work it yourself instead of the engine's implementer (also ahead of "
                                  "its dependencies: it is reserved). Waits until the daemon parks it for you, then says where (its worktree), what (criteria, "
                                  "acceptance tests) and what the last round found. Then edit there and board_submit.",
                   "schema": _schema({"milestone": _S, "card": _S, "wait": _N}, ["milestone", "card"])},
    "board_submit": {"fn": t_board_submit,
                     "description": "Submit a taken card's work: the engine runs the same checks, review and held-out "
                                    "tests as for its own implementer, and waits (up to wait seconds, default 600) "
                                    "for the verdict — done, or the card is yours again with what failed.",
                     "schema": _schema({"milestone": _S, "card": _S, "summary": _S, "wait": _N},
                                       ["milestone", "card", "summary"])},
}

HOME_TOOLS.update({
    "list_projects": {"fn": t_list_projects,
                      "description": "The projects this studio knows: name, folder, and the studio link to each.",
                      "schema": _schema({})},
    "new_project": {"fn": t_new_project,
                    "description": "Create a working operonx project from a studio template and add it to the "
                                   "studio. template is a template id from the briefing (blank if unsure); path is the parent folder (default: the user's home); name is the "
                                   "new folder's name (letters, digits, underscores).",
                    "schema": _schema({"name": _S, "template": _S, "path": _S}, ["name"])},
})


def _tools(studio: Studio) -> Dict[str, Dict[str, Any]]:
    """A project's tools inside a project; the home tools outside one."""
    return TOOLS if studio.pid and studio.pid != "home" else HOME_TOOLS


# ── JSON-RPC ───────────────────────────────────────────────────────────────


def handle(msg: Dict[str, Any], studio: Studio) -> Optional[Dict[str, Any]]:
    """One JSON-RPC request → its response (None for a notification)."""
    method = msg.get("method")
    mid = msg.get("id")
    if mid is None:
        return None
    if method == "initialize":
        result: Any = {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                       "serverInfo": {"name": "operonx-studio", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": n, "description": t["description"], "inputSchema": t["schema"]}
                            for n, t in _tools(studio).items()]}
    elif method == "tools/call":
        params = msg.get("params") or {}
        tool = _tools(studio).get(params.get("name"))
        if tool is None:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown tool"}}
        try:
            text = tool["fn"](studio, params.get("arguments") or {})
            result = {"content": [{"type": "text", "text": text}]}
        except Exception as exc:  # noqa: BLE001 — a tool's failure is its answer
            result = {"content": [{"type": "text", "text": f"failed: {exc}"}], "isError": True}
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main() -> int:
    studio = Studio(os.environ.get("OPERONX_STUDIO_URL", "http://127.0.0.1:8765"),
                    os.environ.get("OPERONX_STUDIO_PID", ""), os.environ.get("OPERONX_STUDIO_TOKEN", ""))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        out = handle(msg, studio)
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
