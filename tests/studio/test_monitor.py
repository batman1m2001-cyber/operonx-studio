"""Monitor — P4. Every number is recomputed here from the raw runs.

Gates: tiles (runs, error rate, p50/p95, cost with the unpriced beside
it), the previous period, runs-over-time buckets, version markers, the
per-op table (percentiles across runs, share, trend, key ops first,
session-long ops marked background and kept out of the ranking), cost by
op, and errors grouped by message.
"""

from __future__ import annotations

import pytest
from operonx.core.workflow_trace import OpExecution, WorkflowTrace
from operonx.telemetry.runs import percentile
from operonx.telemetry.runs.sqlite import SqliteRunStore

from operonx_studio.monitor import DAY, monitor

pytestmark = pytest.mark.unit

NOW = 1790467200.0


def _run(tid, age_h, *, stt=40.0, reply=300.0, cost=0.002, error=None, version="v1", dirty=False):
    """A call: a heartbeat spanning it, stt, an LLM reply, tts."""
    t0, nodes = 100.0, []

    def add(op, start, ms, outputs=None, status="ok", err=None, op_type="code"):
        nodes.append(OpExecution(op_id=f"g.{op}#{tid}@{start}", op_name=op, op_full_name=f"g.{op}",
                                 ctx=("main",), start_time=start, end_time=start + ms / 1000, inputs={},
                                 outputs=outputs or {}, upstreams=[], status=status, error=err, op_type=op_type))

    total = stt + reply + 80
    add("heartbeat", t0, total)
    add("stt", t0, stt)
    add("reply", t0 + stt / 1000, reply, {"content": "hi", "cost_usd": cost,
                                           "usage": {"prompt_tokens": 10, "completion_tokens": 4}}, op_type="llm")
    add("tts", t0 + (stt + reply) / 1000, 80, status="error" if error else "ok", err=error)
    return WorkflowTrace(trace_id=tid, workflow_name="flow", started_at=t0, ended_at=t0 + total / 1000,
                         nodes=nodes, wall_started_at=NOW - age_h * 3600,
                         metadata={"origin": "service", "service": "call", "version": version,
                                   "version_dirty": dirty})


@pytest.fixture()
def store(tmp_path):
    s = SqliteRunStore(path=tmp_path / "m.sqlite")
    # this period (last 24 h): five calls, one failing, one unpriced, v1 then v2
    s.consume(_run("a", 20, stt=40))
    s.consume(_run("b", 15, stt=60, cost=None))
    s.consume(_run("c", 10, stt=50, error="Traceback\nTTSError: timeout"))
    s.consume(_run("d", 5, stt=45, version="v2", dirty=True))
    s.consume(_run("e", 1, stt=200, version="v2", error="Traceback\nTTSError: timeout"))
    # the previous period (24–48 h ago): two calls, faster stt
    s.consume(_run("p1", 30, stt=20))
    s.consume(_run("p2", 40, stt=30))
    # another service entirely, never counted
    other = _run("x", 2)
    other.metadata["service"] = "other"
    s.consume(other)
    return s


def test_tiles_are_the_raw_numbers(store):
    m = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW)
    t = m["tiles"]
    durs = [40 + 300 + 80, 60 + 300 + 80, 50 + 300 + 80, 45 + 300 + 80, 200 + 300 + 80]
    assert t["runs"] == 5 and t["errors"] == 2 and t["error_rate"] == pytest.approx(0.4)
    assert t["p50_ms"] == pytest.approx(percentile(durs, 50), abs=0.5)
    assert t["p95_ms"] == pytest.approx(percentile(durs, 95), abs=0.5)
    assert t["cost_usd"] == pytest.approx(0.008) and t["unpriced"] == 1  # four priced, one not
    assert t["cost_per_run"] == pytest.approx(0.002)
    assert t["llm_calls"] == 5 and t["tokens_in"] == 50 and t["tokens_out"] == 20
    assert m["previous"]["runs"] == 2 and m["previous"]["errors"] == 0


def test_runs_over_time_and_version_markers(store):
    m = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW, buckets=4)
    # 6 h buckets: a (20 h ago) | b (15 h) | c (10 h, failed) | d (5 h) + e (1 h, failed)
    assert [(b["ok"], b["failed"]) for b in m["series"]] == [(1, 0), (1, 0), (0, 1), (1, 1)]
    assert m["series"][0]["t0"] == pytest.approx(NOW - DAY) and m["series"][-1]["t1"] == pytest.approx(NOW)
    assert [(v["version"], v["dirty"]) for v in m["versions"]] == [("v1", False), ("v2", True)]


def test_the_op_table_ranks_work_not_the_session(store):
    m = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW)
    ops = {o["op"]: o for o in m["ops"]}
    assert ops["heartbeat"]["background"] and not ops["reply"]["background"]
    assert [o["op"] for o in m["ops"]][-1] == "heartbeat"  # ranked last, never "slowest"
    stt = [40.0, 60.0, 50.0, 45.0, 200.0]
    assert ops["stt"]["p50_ms"] == pytest.approx(percentile(stt, 50), abs=0.01)
    assert ops["stt"]["p95_ms"] == pytest.approx(percentile(stt, 95), abs=0.01)
    assert ops["stt"]["runs"] == 5 and ops["stt"]["per_run"] == 1
    # the previous period's stt was faster: the trend says slower
    assert ops["stt"]["prev_p95_ms"] == pytest.approx(percentile([20.0, 30.0], 95), abs=0.01)
    assert ops["stt"]["trend"] > 1
    assert ops["tts"]["errors"] == 2
    assert sum(o["share"] for o in m["ops"] if not o["background"]) < 1.0


def test_key_ops_come_first_in_declared_order(store):
    m = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW, key_ops=["tts", "stt"])
    assert [o["op"] for o in m["ops"]][:2] == ["tts", "stt"]
    assert all(o["key"] for o in m["ops"][:2]) and not m["ops"][2]["key"]


def test_cost_by_op_and_errors_by_message(store):
    m = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW)
    (reply,) = m["cost_ops"]
    assert reply["op"] == "reply" and reply["cost_usd"] == pytest.approx(0.008) and reply["unpriced"] == 1
    (err,) = m["errors"]
    assert err == {"message": "TTSError: timeout", "op": "tts", "count": 2,
                   "first_seen": pytest.approx(NOW - 10 * 3600), "last_seen": pytest.approx(NOW - 3600),
                   "example": "e"}


def test_an_empty_range_is_empty_not_an_error(store):
    m = monitor(store, origin="service", name="call", since=NOW - 400 * DAY, until=NOW - 300 * DAY)
    assert m["tiles"]["runs"] == 0 and m["tiles"]["error_rate"] is None and m["tiles"]["cost_usd"] is None
    assert m["ops"] == [] and m["errors"] == [] and all(b["ok"] == 0 for b in m["series"])


def test_a_services_playground_sessions_count_and_are_said(store):
    # two sessions of `call` tried in the Playground: its runs too
    for tid, age in (("pl1", 3), ("pl2", 2)):
        t = _run(tid, age, stt=500)
        t.metadata["origin"] = "playground"
        store.consume(t)
    m = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW)
    assert m["tiles"]["runs"] == 7 and m["playground_runs"] == 2 and m["with_playground"]
    stt = next(o for o in m["ops"] if o["op"] == "stt")
    assert stt["runs"] == 7 and stt["max_ms"] == pytest.approx(500)

    served = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW, with_playground=False)
    assert served["tiles"]["runs"] == 5 and served["playground_runs"] == 2 and not served["with_playground"]
    assert next(o for o in served["ops"] if o["op"] == "stt")["runs"] == 5
    # a job's view, or everything, is untouched by it
    assert monitor(store, since=NOW - DAY, until=NOW)["playground_runs"] == 0


# -- latency: what the service's ops measured, and its workers ---------------

def _call(tid, age_h, *, reply=None, cpu=None, busiest=None, lag=None, backlog=None):
    t = _run(tid, age_h)
    md = t.metadata
    if reply is not None:  # (p50, p95, n)
        md["latency_ms"] = {"reply": {"p50": reply[0], "p95": reply[1], "max": reply[1], "n": reply[2]}}
    if cpu is not None:
        md["cpu_pct"] = {"avg": cpu - 20, "max": cpu}
    if busiest is not None:
        md["worker"] = {"pid": 7, "active_runs": busiest}
    if lag is not None:
        md["loop_lag_ms"] = {"p95": lag, "max": lag * 3}
    if backlog is not None:
        md["backlog"] = backlog
    return t


@pytest.fixture()
def calls(tmp_path):
    s = SqliteRunStore(path=tmp_path / "l.sqlite")
    s.consume(_call("a", 20, reply=(800, 1000, 3), cpu=70, busiest=4, lag=2))
    s.consume(_call("b", 15, reply=(900, 1200, 2), cpu=80, busiest=5, lag=3))
    # an overloaded worker: its queue grew and its loop ran late
    s.consume(_call("c", 1, reply=(4000, 6000, 2), cpu=100, busiest=12, lag=80,
                    backlog={"g.audio_in -> g.detect": {"max": 40, "max_wait_ms": 1800}}))
    # a paced consumer: items wait on purpose, not slowed
    s.consume(_call("d", 1, reply=(850, 1100, 1), cpu=60, busiest=3, lag=2,
                    backlog={"g.synth -> g.play": {"max": 3, "max_wait_ms": 8000}}))
    s.consume(_call("p", 30, reply=(700, 900, 2), cpu=50, busiest=2, lag=1))  # the previous period
    return s


def test_latency_describes_the_calls(calls):
    m = monitor(calls, origin="service", name="call", since=NOW - DAY, until=NOW, buckets=4)
    (reply,) = m["latency"]["measures"]
    assert reply["name"] == "reply" and reply["runs"] == 4 and reply["samples"] == 8
    assert reply["typical_ms"] == pytest.approx(percentile([800, 900, 4000, 850], 50))
    assert reply["slow_ms"] == pytest.approx(percentile([1000, 1200, 6000, 1100], 95))
    assert reply["prev_typical_ms"] == 700
    # 6 h buckets: a | b | - | c + d
    assert [b["typical_ms"] for b in reply["series"]][:3] == [800, 900, None]
    assert reply["series"][3]["slow_ms"] == pytest.approx(percentile([6000, 1100], 95))


def test_the_workers_and_the_slowed_calls(calls):
    m = monitor(calls, origin="service", name="call", since=NOW - DAY, until=NOW, buckets=4)
    w = m["latency"]["workers"]
    assert w["busiest"] == 12 and w["cpu"] == 80  # the overloaded call's average
    assert w["previous"]["busiest"] == 2
    assert [b["busiest"] for b in w["series"]] == [4, 5, None, 12]
    slowed = m["latency"]["slowed"]
    assert slowed["count"] == 1 and slowed["runs"][0]["trace_id"] == "c"
    assert slowed["runs"][0]["why"] == ["40 waiting on audio_in → detect, up to 1800 ms",
                                        "loop late 80 ms at p95"]


def test_no_latency_section_without_the_metadata(store):
    m = monitor(store, origin="service", name="call", since=NOW - DAY, until=NOW)
    assert m["latency"] is None
