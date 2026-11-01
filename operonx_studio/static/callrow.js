/* A running shell call's row (docs/EXECUTION_PROGRESS_PLAN.md D3–D5): what
   its progress event says, in words the row and the status line show.

     accept(item, ev)     → true when the event is newer than what the row has
     view(item, nowS)     → {bar, counter, activity, elapsed, chip, stages, tests}
       bar: null (indeterminate) · {kind: "measured", pct} · {kind: "estimated", pct, last}
     status(item, nowS)   → "Running · pytest · 312 / 570 tests" or "Waiting · <task> · …"
     bridge(item)         → a running call's test counts as item.tests (live), the shape testReport and the
                            step meter already read

   A bar only when the tool printed a total or a percentage, or a past run
   gives an estimate; never a made-up one. No DOM here, so
   tests/js/callrow.test.mjs runs it in node. */
const oxCallRow = (() => {
  const secs = (s) => {
    s = Math.max(0, Math.floor(s));
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
      : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  };
  const num = (n) => Number(n).toLocaleString("en-US");

  // the row takes an event only while the call runs, and only a newer one (D5: out of order, after the end)
  function accept(item, ev) {
    if (!item || item.kind !== "tool" || item.status !== "running" || !ev || !ev.progress) return false;
    const had = item.progress && item.progress.rev;
    return !(had && ev.rev <= had);
  }

  function counter(p) {
    if (p.current == null || p.unit === "%") return null;
    return p.total ? `${num(p.current)} / ${num(p.total)} ${p.unit || ""}`.trim() : `${num(p.current)} ${p.unit || ""}`.trim();
  }

  function chip(p, nowS) {
    const live = p.live;
    if (!live || live.state === "active") return null;
    if (live.state === "ended") return {tone: "done", text: "finished, waiting for the result"};
    const quiet = live.since != null ? secs(nowS - live.since) : null;
    if (live.state === "busy") return {tone: "busy", text: quiet ? `working · no output for ${quiet}` : "working"};
    if (live.state === "idle") return {tone: "idle", text: quiet ? `waiting · no output or CPU for ${quiet}` : "waiting"};
    if (live.state === "stalled") return {tone: "stalled", text: quiet ? `may be stuck · nothing for ${quiet}` : "may be stuck"};
    return null;
  }

  function stages(p, nowS) {
    return (p.stages || []).map((s) => ({
      title: s.title, state: s.state,
      ms: s.t0 != null && s.t1 != null ? Math.round((s.t1 - s.t0) * 1000)
        : s.t0 != null && s.state === "active" ? Math.round((nowS - s.t0) * 1000) : null,
      counter: s.state === "active" ? null : counter(s),
    }));
  }

  function view(item, nowS) {
    const p = item.progress || {};
    const elapsed = item.t0 != null ? Math.max(0, nowS - item.t0) : null;
    let bar = null;
    if (p.mode === "measured" && p.pct != null) bar = {kind: "measured", pct: Math.max(0, Math.min(100, p.pct))};
    else if (p.mode === "estimated" && p.est_ms && elapsed != null) {
      // past the last run's time the bar holds short of the end: the run is late, not done
      bar = {kind: "estimated", pct: Math.min(95, Math.round(elapsed * 100000 / p.est_ms)), last: secs(p.est_ms / 1000),
        over: elapsed * 1000 > p.est_ms};
    }
    const st = stages(p, nowS);
    const active = st.find((s) => s.state === "active");
    // runhook's parts of a chain are commands; a tool's own stages (Resolve, Download) are not
    const chain = (p.stages || []).some((s) => /^part\d/.test(s.id || ""));
    return {chain, bar, counter: counter(p), activity: p.activity || null, elapsed, chip: chip(p, nowS), stages: st,
      stage: active ? active.title : null, tests: p.tests || null, pct: bar && bar.kind === "measured" ? bar.pct : null};
  }

  function status(item, nowS, label) {
    const v = view(item, nowS);
    const what = item.task ? "Waiting" : "Running";
    // a chain is named by the command it is on, not the whole line; one command keeps its name
    const bits = [what, v.chain && v.stage ? v.stage : label || item.label || item.name];
    if (v.stage && !v.chain) bits.push(v.stage);
    if (v.counter) bits.push(v.counter);
    else if (v.bar && v.bar.kind === "measured") bits.push(`${v.bar.pct}%`);
    return bits.filter(Boolean).join(" · ");
  }

  function bridge(item) {
    const p = item.progress;
    if (item.status === "running" && p && p.tests) item.tests = {...p.tests, live: true, pct: p.pct != null ? p.pct : null};
    return item;
  }

  const api = {accept, view, status, bridge, counter, secs};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
if (typeof window !== "undefined") window.oxCallRow = oxCallRow;
