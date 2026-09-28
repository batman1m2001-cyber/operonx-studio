"""Monitor — one service's or job's health over a time range, from its RunStore.

Everything is computed from the store's two small shapes — run summaries
and per-op rollups — so a month of calls is summarised without opening a
single trace. The same range just before ("the previous period") is
computed too, so every tile can say which way it moved.

The rules that keep the numbers honest:

* **Cost** counts only calls that reported a price. Unpriced calls are
  counted and reported beside the total ("$1.24 + 3 unpriced"), never
  summed as zero; a total is ``None`` when nothing was priced at all.
* **Latency** of an op that spans the whole session (a heartbeat, a
  stream source) is not latency: such ops are marked ``background`` and
  kept out of the ranking, their time being the session's length.
* **Key ops** the service declares (``Service(key_ops=[...])``) come
  first, in the order declared.
* **A service's playground sessions** are its runs too (``origin=playground``
  under the service's name): a service's view counts them unless asked
  not to, and says how many there are.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence

from operonx.telemetry.runs import RunFilter, RunStore, combine_rollups, percentile

__all__ = ["DAY", "monitor"]

DAY = 86400.0
_MAX_RUNS = 50_000


def _summaries(store: RunStore, wheres: Sequence[RunFilter]) -> List[Any]:
    out: List[Any] = []
    for where in wheres:
        cursor = None
        while len(out) < _MAX_RUNS:
            page = store.list_runs(where, order="started_asc", limit=1000, cursor=cursor)
            out.extend(page.items)
            cursor = page.next_cursor
            if not cursor:
                break
    if len(wheres) > 1:
        out.sort(key=lambda r: r.started_at or 0)
    return out


def _op_stats(store: RunStore, wheres: Sequence[RunFilter]) -> List[Any]:
    if len(wheres) == 1:
        return store.op_stats(wheres[0])
    return combine_rollups([r for w in wheres for r in store.rollups(w)])


def _wheres(origin: Optional[str], name: Optional[str], since: float, until: float,
            with_playground: bool) -> List[RunFilter]:
    origins: List[Optional[str]] = [origin or None]
    if with_playground and origin == "service" and name:
        origins.append("playground")
    return [RunFilter(origin=o, name=name or None, since=since, until=until) for o in origins]


def _tiles(runs: Sequence[Any]) -> Dict[str, Any]:
    n = len(runs)
    durs = [r.duration_ms or 0.0 for r in runs]
    priced = [r.cost_usd for r in runs if r.cost_usd is not None]
    errors = sum(1 for r in runs if r.status == "error")
    cost = sum(priced) if priced else None
    return {
        "runs": n,
        "errors": errors,
        "error_rate": (errors / n) if n else None,
        "p50_ms": percentile(durs, 50) if n else None,
        "p95_ms": percentile(durs, 95) if n else None,
        "cost_usd": cost,
        "cost_per_run": (cost / len(priced)) if priced else None,
        "unpriced": sum(r.unpriced or 0 for r in runs),
        "llm_calls": sum(r.llm_calls or 0 for r in runs),
        "tokens_in": sum(r.tokens_in or 0 for r in runs),
        "tokens_out": sum(r.tokens_out or 0 for r in runs),
        "tokens_cached": sum(r.tokens_cached or 0 for r in runs),
    }


def _series(runs: Sequence[Any], since: float, until: float, buckets: int) -> List[Dict[str, Any]]:
    width = max(1.0, (until - since) / buckets)
    out = [{"t0": since + i * width, "t1": since + (i + 1) * width, "ok": 0, "failed": 0, "_d": []}
           for i in range(buckets)]
    for r in runs:
        i = int((r.started_at - since) // width)
        if 0 <= i < buckets:
            b = out[i]
            b["failed" if r.status == "error" else "ok"] += 1
            b["_d"].append(r.duration_ms or 0.0)
    for b in out:
        d = b.pop("_d")
        b["p95_ms"] = percentile(d, 95) if d else None
    return out


def _versions(runs: Sequence[Any]) -> List[Dict[str, Any]]:
    seen: Dict[str, Dict[str, Any]] = {}
    for r in runs:  # oldest first
        if r.version and r.version not in seen:
            seen[r.version] = {"version": r.version, "dirty": bool(r.version_dirty),
                               "first_started": r.started_at}
    return list(seen.values())


def _errors(runs: Sequence[Any], limit: int = 10) -> List[Dict[str, Any]]:
    groups: Dict[str, Dict[str, Any]] = {}
    for r in runs:
        if r.status != "error":
            continue
        msg = r.first_error or "failed"
        op, sep, text = msg.partition(": ")
        g = groups.get(msg)
        if g is None:
            g = groups[msg] = {"message": text if sep else msg, "op": op if sep else None, "count": 0,
                               "first_seen": r.started_at, "last_seen": r.started_at, "example": r.trace_id}
        g["count"] += 1
        g["first_seen"] = min(g["first_seen"], r.started_at)
        if r.started_at >= g["last_seen"]:
            g["last_seen"], g["example"] = r.started_at, r.trace_id
    return sorted(groups.values(), key=lambda g: (-g["count"], -g["last_seen"]))[:limit]


def monitor(
    store: RunStore,
    origin: Optional[str] = None,
    name: Optional[str] = None,
    since: Optional[float] = None,
    until: Optional[float] = None,
    buckets: int = 24,
    key_ops: Sequence[str] = (),
    with_playground: bool = True,
) -> Dict[str, Any]:
    """The Monitor for one origin (or everything) over ``[since, until)``."""
    until = float(until) if until is not None else time.time()
    since = float(since) if since is not None else until - 7 * DAY
    span = max(1.0, until - since)
    where = _wheres(origin, name, since, until, with_playground)
    before = _wheres(origin, name, since - span, since, with_playground)
    runs = _summaries(store, where)
    prev = _summaries(store, before)
    # how many playground sessions of this service the range holds, counted
    # even when they are left out, so the view can offer them
    playground = (store.count(RunFilter(origin="playground", name=name, since=since, until=until))
                  if origin == "service" and name else 0)

    avg_run = (sum(r.duration_ms or 0 for r in runs) / len(runs)) if runs else 0.0
    total_time = sum(r.duration_ms or 0 for r in runs) or 1.0
    prev_ops = {s.op: s for s in _op_stats(store, before)} if prev else {}
    ops = []
    for s in _op_stats(store, where) if runs else []:
        per_run = s.count / max(1, s.runs)
        background = per_run <= 2 and avg_run > 0 and (s.total_ms / max(1, s.runs)) >= 0.8 * avg_run
        p = prev_ops.get(s.op)
        ops.append({
            **s.to_dict(),
            "per_run": per_run,
            "share": s.total_ms / total_time,
            "background": background,
            "key": s.op in key_ops,
            "prev_p95_ms": p.p95_ms if p else None,
            "trend": ((s.p95_ms - p.p95_ms) / p.p95_ms) if p and p.p95_ms else None,
        })
    order = {op: i for i, op in enumerate(key_ops)}
    ops.sort(key=lambda o: (0 if o["key"] else 1, order.get(o["op"], 0),
                            1 if o["background"] else 0, -o["total_ms"]))
    cost_ops = sorted([o for o in ops if o["cost_usd"] is not None or o["unpriced"]],
                      key=lambda o: -(o["cost_usd"] or 0.0))
    return {
        "since": since,
        "until": until,
        "tiles": _tiles(runs),
        "previous": _tiles(prev),
        "series": _series(runs, since, until, max(1, min(int(buckets), 120))),
        "versions": _versions(runs),
        "ops": ops,
        "cost_ops": cost_ops,
        "errors": _errors(runs),
        "truncated": len(runs) >= _MAX_RUNS,
        "playground_runs": playground,
        "with_playground": bool(with_playground and playground),
    }
