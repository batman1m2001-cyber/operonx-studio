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
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

__all__ = ["TOOLS", "handle", "main"]

PROTOCOL = "2024-11-05"


class Studio:
    """The studio's HTTP API for one project."""

    def __init__(self, url: str, pid: str, token: str = ""):
        self.url = url.rstrip("/")
        self.pid = pid
        self.token = token

    def call(self, path: str, body: Optional[Dict[str, Any]] = None, **params: Any) -> Any:
        url = f"{self.url}/api/p/{self.pid}{path}"
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        if clean:
            url += "?" + urllib.parse.urlencode(clean)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
        req.add_header("content-type", "application/json")
        if self.token:
            req.add_header("cookie", f"oxsession={self.token}")
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                err = json.loads(exc.read().decode("utf-8")).get("error")
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


def t_run_job(s: Studio, a: Dict[str, Any]) -> str:
    got = s.call(f"/jobs/{urllib.parse.quote(str(a['name']), safe='')}/run", {"resume": bool(a.get("resume"))})
    s.show("open_jobs", job=str(a["name"]))
    return f"started {a['name']} (pid {got.get('pid')}); its runs appear in Jobs and Runs as they finish"


def t_price(s: Studio, a: Dict[str, Any]) -> str:
    got = s.call("/resources/price", {"resource": a["resource"], "input_per_1m": a["input_per_1m"],
                                      "output_per_1m": a["output_per_1m"], "apply": bool(a.get("apply"))})
    return ("applied\n" if got.get("applied") else "preview (not written)\n") + (got.get("diff") or "no change")


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
                                "opens it on the user's screen (mode tree|workflow; lens path|time|errors|cost|values).",
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
    "run_job": {"fn": t_run_job,
                "description": "Start one of the application's jobs (or runbooks); resume=true reruns only "
                               "what the last run did not finish.",
                "schema": _schema({"name": _S, "resume": {"type": "boolean"}}, ["name"])},
    "set_llm_price": {"fn": t_price,
                      "description": "Preview (apply=false) or write (apply=true) an LLM resource's prices in "
                                     "USD per 1M tokens, in the project's resources file. 0 declares a free "
                                     "(in-house) model; leave a model unpriced rather than guessing.",
                      "schema": _schema({"resource": _S, "input_per_1m": _N, "output_per_1m": _N,
                                         "apply": {"type": "boolean"}}, ["resource", "input_per_1m", "output_per_1m"])},
}


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
                            for n, t in TOOLS.items()]}
    elif method == "tools/call":
        params = msg.get("params") or {}
        tool = TOOLS.get(params.get("name"))
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
