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
* **Latency** a user feels is what the service's ops measured
  (``measure(name, ms)`` → each run's ``metadata["latency_ms"]``). Runs
  carry a summary, not samples, so a range is described by its calls:
  *typical* is the median of the calls' medians, *slow calls* the p95 of
  the calls' p95. The workers beside it (busiest worker's runs, the
  busiest call's average CPU, loop lag) and the slowed runs come from the
  same metadata.
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


#: The run page's "Slowed by" rule (static/runview.js): 10 or more items
#: waiting at once on an edge AND one waiting 500 ms, or the loop late by
#: 50 ms at p95. Either half alone is normal.
QUEUE_ITEMS, QUEUE_WAIT_MS, LAG_P95_MS = 10, 500, 50


def _num(d: Any, *keys: str) -> Optional[float]:
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return float(d) if isinstance(d, (int, float)) and not isinstance(d, bool) else None


def _why_slowed(md: Dict[str, Any]) -> List[str]:
    why = []
    for edge, q in (md.get("backlog") or {}).items():
        if (_num(q, "max") or 0) >= QUEUE_ITEMS and (_num(q, "max_wait_ms") or 0) >= QUEUE_WAIT_MS:
            src, _, dst = edge.partition(" -> ")
            why.append(f"{int(q['max'])} waiting on {src.split('.')[-1]} → {dst.split('.')[-1]}, "
                       f"up to {int(q['max_wait_ms'])} ms")
    lag = _num(md, "loop_lag_ms", "p95")
    if lag is not None and lag >= LAG_P95_MS:
        why.append(f"loop late {int(lag)} ms at p95")
    return why


def _measure_stats(runs: Sequence[Any], name: str) -> Dict[str, Any]:
    p50s = [v for r in runs if (v := _num(r.metadata, "latency_ms", name, "p50")) is not None]
    p95s = [v for r in runs if (v := _num(r.metadata, "latency_ms", name, "p95")) is not None]
    return {
        "typical_ms": percentile(p50s, 50) if p50s else None,
        "slow_ms": percentile(p95s, 95) if p95s else None,
        "runs": len(p50s),
        "samples": int(sum(_num(r.metadata, "latency_ms", name, "n") or 0 for r in runs)),
    }


def _latency(runs: Sequence[Any], prev: Sequence[Any], since: float, until: float,
             buckets: int) -> Optional[Dict[str, Any]]:
    names = sorted({k for r in runs for k in ((r.metadata or {}).get("latency_ms") or {})})
    has_worker = any((r.metadata or {}).get(k) for r in runs for k in ("loop_lag_ms", "cpu_pct", "worker"))
    if not names and not has_worker:
        return None
    width = max(1.0, (until - since) / buckets)
    slots: List[List[Any]] = [[] for _ in range(buckets)]
    for r in runs:
        i = int((r.started_at - since) // width)
        if 0 <= i < buckets:
            slots[i].append(r)
    edges = [(since + i * width, since + (i + 1) * width) for i in range(buckets)]

    measures = []
    for name in names:
        series = []
        for (t0, t1), rs in zip(edges, slots):
            st = _measure_stats(rs, name)
            series.append({"t0": t0, "t1": t1, "typical_ms": st["typical_ms"], "slow_ms": st["slow_ms"]})
        before = _measure_stats(prev, name)
        measures.append({"name": name, **_measure_stats(runs, name),
                         "prev_typical_ms": before["typical_ms"], "prev_slow_ms": before["slow_ms"],
                         "series": series})

    def worker_point(rs: Sequence[Any]) -> Dict[str, Optional[float]]:
        busy = [v for r in rs if (v := _num(r.metadata, "worker", "active_runs")) is not None]
        # a call's average, not its 1 s peak: a healthy worker touches
        # 100 % now and then; an overloaded one stays above it
        cpu = [v for r in rs if (v := _num(r.metadata, "cpu_pct", "avg")) is not None]
        lag = [v for r in rs if (v := _num(r.metadata, "loop_lag_ms", "p95")) is not None]
        return {"busiest": max(busy) if busy else None, "cpu": max(cpu) if cpu else None,
                "lag_p95_ms": percentile(lag, 95) if lag else None}

    slowed = []
    for r in runs:
        why = _why_slowed(r.metadata or {})
        if why:
            slowed.append({"trace_id": r.trace_id, "started_at": r.started_at, "why": why,
                           "worker": (r.metadata.get("worker") or {}).get("pid")})
    slowed.sort(key=lambda x: -x["started_at"])
    return {
        "measures": measures,
        "workers": {**worker_point(runs), "previous": worker_point(prev),
                    "series": [{"t0": t0, "t1": t1, **worker_point(rs)} for (t0, t1), rs in zip(edges, slots)]}
        if has_worker else None,
        "slowed": {"count": len(slowed), "runs": slowed[:10]},
    }


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
        "latency": _latency(runs, prev, since, until, max(1, min(int(buckets), 120))),
        "versions": _versions(runs),
        "ops": ops,
        "cost_ops": cost_ops,
        "errors": _errors(runs),
        "truncated": len(runs) >= _MAX_RUNS,
        # Langfuse cannot total ops over a month of runs: the table holds
        # only the runs this machine also stores, and says so
        "ops_note": (
            "Per-op numbers cover the runs stored on this machine only: Langfuse cannot total "
            "ops across runs. A ClickHouse store (trace_clickhouse in [tracing]) gives them "
            "for every run."
        ) if getattr(store, "primary", None) is not None else None,
        "playground_runs": playground,
        "with_playground": bool(with_playground and playground),
    }


def score_trends(
    scores: Any,
    origin: Optional[str],
    name: Optional[str],
    since: float,
    until: float,
    buckets: int = 24,
    alerts: Sequence[Any] = (),
) -> List[Dict[str, Any]]:
    """Each score written on these runs over ``[since, until)``: per bucket,
    its mean (over scores with a value) and the share that failed (over
    scores with pass/fail) — what ``score_mean:`` / ``score_fail_rate:``
    alerts compute — with the thresholds of the alerts that watch it.
    Reviews by people (``source="human"``) are not trends; they are left out."""
    from operonx.telemetry.scores import ScoreFilter

    rows = [s for s in scores.scores(ScoreFilter(origin=origin, name=name, since=since, until=until),
                                     limit=200_000) if s.source != "human"]
    width = max(1.0, (until - since) / max(1, buckets))
    by: Dict[str, List[Any]] = {}
    for s in rows:
        by.setdefault(s.score_name, []).append(s)
    out = []
    for score, items in sorted(by.items()):
        series = [{"t0": since + i * width, "t1": since + (i + 1) * width, "_v": [], "_p": []}
                  for i in range(max(1, buckets))]
        for s in items:
            i = int((s.created_at - since) // width)
            if 0 <= i < len(series):
                if s.value is not None:
                    series[i]["_v"].append(float(s.value))
                if s.passed is not None:
                    series[i]["_p"].append(bool(s.passed))
        for b in series:
            v, p = b.pop("_v"), b.pop("_p")
            b["n"] = max(len(v), len(p))
            b["mean"] = sum(v) / len(v) if v else None
            b["fail_share"] = (sum(1 for x in p if not x) / len(p)) if p else None
        values = [float(s.value) for s in items if s.value is not None]
        passes = [s.passed for s in items if s.passed is not None]
        watched = [a for a in alerts
                   if (a.origin, a.target) == (origin, name) and a.metric.endswith(f":{score}")]
        out.append({
            "score": score,
            "data_type": items[0].data_type,
            "n": len(items),
            "mean": sum(values) / len(values) if values else None,
            "fail_share": (sum(1 for x in passes if not x) / len(passes)) if passes else None,
            "series": series,
            "mean_threshold": next((a.threshold for a in watched if a.metric.startswith("score_mean:")), None),
            "fail_threshold": next((a.threshold for a in watched if a.metric.startswith("score_fail_rate:")), None),
        })
    return out
