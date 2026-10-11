/* operonx studio — the canvas in motion (live and replayed runs). Split
 * from studio.js, same bundle, same order. */

/* ── the canvas in motion ─────────────────────────────────────────────
 * The flow comes alive only when something runs: a playground session
 * (its ops stream from the bridge as they finish — play.js dispatches
 * "oxops"), or a recorded run replayed from its timings. The op at work
 * carries the signal ring; when it finishes it settles green or red and
 * a particle runs each wire out of it toward its consumers, which then
 * wait, lit, for their own turn. Everything here toggles classes on
 * cards and wires already drawn — never a render(): a repaint of callbot
 * costs ~60 ms, far too much per event (docs/REFACTOR_PHASE2.md P4). */
liveCanvas = (() => {
  const MAX_PARTICLES = 24;
  let particles = 0;
  let run = null;       // {kind: "live"|"replay", label, timers, names, out, active}

  // op name → the rendered keys that stand for it (the op itself, or the
  // folded container it sits in)
  function index() {
    const names = new Map();
    const put = (name, key) => { if (!names.has(name)) names.set(name, []); names.get(name).push(key); };
    const walk = (g, key) => { for (const m of (g && g.nodes) || []) { put(m.name, key); if (m.graph) walk(m.graph, key); } };
    for (const [key, it] of state.rendered) {
      const n = it.node;
      if (!n || !n.name) continue;
      put(n.name, key);
      if (n.graph && !state.expanded.has(key)) walk(n.graph, key);
    }
    const out = new Map();   // key → paths of the wires leaving it
    for (const e of state.edgeEls) {
      // a beam is a glow, a core and a filament: the particle rides the core
      const els = (e.els || []).filter(x => x.getAttribute && x.getAttribute("d"));
      const path = els.find(x => x.classList.contains("ecore")) || els[0];
      if (!path) continue;
      if (!out.has(e.a)) out.set(e.a, []);
      out.get(e.a).push({path, glow: els.find(x => x.classList.contains("eglow")), to: e.b});
    }
    return {names, out};
  }

  function begin(kind, label) {
    stop(true);
    const ix = index();
    run = {kind, label, timers: [], active: new Map(), names: ix.names, out: ix.out, seen: 0, t0: Date.now()};
    $("#world").classList.add("live");
    paintBar();
    return run;
  }

  function stop(quiet) {
    if (!run) return;
    for (const t of run.timers) clearTimeout(t);
    for (const t of run.active.values()) clearTimeout(t);
    for (const n of document.querySelectorAll("#nodes .live-active, #nodes .live-done, #nodes .live-failed"))
      n.classList.remove("live-active", "live-done", "live-failed");
    for (const p of document.querySelectorAll("#edges path.flowing, #edgetop path.flowing")) p.classList.remove("flowing");
    for (const p of document.querySelectorAll("#edges path.particle")) p.remove();
    for (const g of document.querySelectorAll("#edges .apw.on")) g.classList.remove("on");
    particles = 0;
    $("#world").classList.remove("live");
    run = null;
    if (!quiet) paintBar();
  }

  function particle(path, failed, dur, glow) {
    if (particles + 2 > MAX_PARTICLES || !path || !path.ownerSVGElement) return;
    if (glow) glow.classList.add("flowing");
    const d = path.getAttribute("d");
    for (const trail of [false, true]) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      p.setAttribute("pathLength", "100");
      p.setAttribute("class", "particle" + (trail ? " trail" : "") + (failed ? " failed" : ""));
      p.style.setProperty("--dur", `${dur}ms`);
      particles += 1;
      const done = () => { p.remove(); particles = Math.max(0, particles - 1); };
      p.addEventListener("animationend", done, {once: true});
      setTimeout(done, dur + 600);          // reduced motion: no animationend
      path.ownerSVGElement.append(p);
    }
    path.classList.add("flowing");
  }

  const cardsOf = (op) => (run && run.names.get(op) || []).map(k => [k, state.cardEls.get(k)]).filter(([, c]) => c);

  function start(op) {
    if (!run) return;
    for (const [key, card] of cardsOf(op)) {
      card.classList.remove("live-done", "live-failed");
      card.classList.add("live-active");
      // an opened agent at work: its wires move
      const wires = state.partWires && state.partWires.get(key);
      if (wires) wires.classList.add("on");
    }
  }

  function finish(op, status, dur) {
    if (!run) return;
    run.seen += 1;
    const bad = status === "error";
    dur = Math.max(260, Math.min(900, dur || 500));
    for (const [key, card] of cardsOf(op)) {
      card.classList.remove("live-active");
      card.classList.add(bad ? "live-failed" : "live-done");
      const wires = state.partWires && state.partWires.get(key);
      if (wires) wires.classList.remove("on");
      for (const w of run.out.get(key) || []) {
        particle(w.path, bad, dur, w.glow);
        // the consumer lights as the data reaches it, until it finishes
        const target = state.cardEls.get(w.to);
        if (!target || target.classList.contains("bnode")) continue;
        const prev = run.active.get(w.to);
        if (prev) clearTimeout(prev);
        run.active.set(w.to, setTimeout(() => {
          if (!run) return;
          target.classList.remove("live-done", "live-failed");
          target.classList.add("live-active");
          // nothing more heard from it: it settles on its own
          run.active.set(w.to, setTimeout(() => target.classList.remove("live-active"), 2500));
        }, dur * 0.8));
      }
    }
    paintBar();
  }

  /* a live playground session: ops as they finish */
  function onOps(detail) {
    if (state.tab !== "flow" || !state.graph) return;
    const ops = detail.ops || [];
    const serving = serviceGraph(detail.service);
    if (serving && serving !== state.graph.name) return;
    if (!run || run.kind !== "live" || run.sid !== detail.sid) {
      begin("live", detail.service ? `${detail.service} · live session` : "Live session");
      run.sid = detail.sid;
      run.trace = detail.trace_id;
      animated.add(detail.trace_id);
    }
    // a burst arrives as one batch: spread it over ~a second so each op reads
    const gap = Math.min(120, 900 / Math.max(1, ops.length));
    ops.slice(0, 200).forEach((o, i) => {
      const me = run;
      me.timers.push(setTimeout(() => { if (run === me) finish(o.op, o.status, o.ms); }, i * gap));
    });
  }

  // the graph a service serves ("module:graph" or "graph"), to match the canvas
  function serviceGraph(service) {
    if (!service) return null;
    const sv = ((state.ir || {}).services || []).find(x => x.name === service);
    return sv && sv.graph ? String(sv.graph).split(":").pop().replace(/\[.*$/, "") : null;
  }

  /* a recorded run, replayed from its timings: the whole run in 3–12 s,
   * a two-millisecond job and a ten-minute call alike */
  async function replay(runId, speed) {
    let tl;
    try { tl = await api(`/api/p/${PID}/trace/${encodeURIComponent(runId)}/timeline`); }
    catch (e) { toast(e.message, true); return; }
    const spans = tl.spans || [];
    if (!spans.length) { toast("This run recorded no timings to replay"); return; }
    const total = Math.max(...spans.map(x => x.start + (x.dur_ms || 0) / 1000));
    const target = Math.max(3, Math.min(12, spans.length * 0.4)) / (speed || 1);
    const k = total > 0 ? target / total : 0;
    const me = begin("replay", `Replaying ${String(runId).slice(0, 12)}`);
    me.run = runId;
    me.speed = speed || 1;
    animated.add(runId);
    // an op firing again and again within a blink counts once
    const last = new Map();
    for (const x of spans) {
      const at = Math.round(x.start * k * 1000);
      if (last.has(x.op) && at - last.get(x.op) < 140) continue;
      last.set(x.op, at);
      const end = at + Math.max(200, Math.min(1200, (x.dur_ms || 0) * k));
      me.timers.push(setTimeout(() => { if (run === me) start(x.op); }, at));
      me.timers.push(setTimeout(() => { if (run === me) finish(x.op, x.status, 420 / me.speed + 200); }, end));
    }
    me.timers.push(setTimeout(() => { if (run === me) { me.over = true; paintBar(); } }, target * 1000 + 1400));
    me.timers.push(setTimeout(() => { if (run === me) stop(); }, target * 1000 + 6000));
  }

  const animated = new Set();   // runs already shown moving: a landing run is not replayed twice

  /* the pill over the canvas: what is moving, and a way to stop it */
  function paintBar() {
    let bar = $("#livebar");
    if (!run) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = el("div", "livebar");
      bar.id = "livebar";
    }
    if (bar.parentNode !== $("#stage")) $("#stage").prepend(bar);
    bar.hidden = false;
    bar.textContent = "";
    bar.classList.toggle("over", !!run.over);
    bar.append(el("span", "livedot"), el("span", "livelabel", run.over ? `${run.label} — done` : run.label));
    if (run.seen) bar.append(el("span", "livecount", `${run.seen} op${run.seen === 1 ? "" : "s"}`));
    if (run.kind === "replay") {
      const again = Icons.button("resume", undefined, "livebtn", "Replay again");
      const r0 = run.run, sp = run.speed;
      again.onclick = () => replay(r0, sp);
      bar.append(again);
    }
    const x = Icons.button("x", undefined, "livebtn", run.kind === "replay" ? "Stop the replay" : "Stop following");
    x.onclick = () => stop();
    bar.append(x);
  }

  document.addEventListener("oxops", (ev) => onOps(ev.detail || {}));
  document.addEventListener("oxsession", (ev) => {
    const d = ev.detail || {};
    if (d.state === "ended" && run && run.kind === "live" && run.sid === d.sid) {
      run.over = true;
      run.label = `${d.service || "Session"} · ${d.status === "error" ? "ended with an error" : "finished"}`;
      paintBar();
      const me = run;
      me.timers.push(setTimeout(() => { if (run === me) stop(); }, 5000));
    }
  });

  // a repaint during a run rebuilt the cards and wires: point at the new ones
  function reindex() {
    if (!run) return;
    const ix = index();
    run.names = ix.names;
    run.out = ix.out;
    $("#world").classList.add("live");
    const bar = $("#livebar");
    if (bar && bar.parentNode !== $("#stage")) $("#stage").prepend(bar);
  }

  return {replay, stop, reindex, animated, get running() { return run; }};
})();

/* The Flow tab follows new runs of the graph on screen: each one replays
 * as it lands (a live playground session already moved the canvas, so
 * its run is not shown twice). Off in the canvas bar, remembered. */
const flowLive = {
  on: recall("flowLive", true),
  newest: null,
  landed(id, info) {
    const first = this.newest === null;
    if (id === this.newest) return;
    this.newest = id;
    if (first || !this.on || liveCanvas.animated.has(id) || liveCanvas.running) return;
    if (info && state.graph && !graphServes(info)) return;
    liveCanvas.replay(id, 2);
  },
};
function graphServes(info) {
  // the run belongs to the graph on screen: its service's or job's graph
  const ir = state.ir || {};
  const list = info.origin === "service" || info.origin === "playground" ? ir.services || [] : ir.jobs || [];
  const decl = list.find(x => x.name === info.name);
  const g = decl && decl.graph ? String(decl.graph).split(":").pop().replace(/\[.*$/, "") : null;
  return !g || g === state.graph.name;
}

const liveBtn = $("#btn-live");
function paintLiveBtn() {
  liveBtn.classList.toggle("active", flowLive.on);
  liveBtn.setAttribute("aria-pressed", String(flowLive.on));
}
liveBtn.onclick = () => {
  flowLive.on = !flowLive.on;
  store("flowLive", flowLive.on);
  if (!flowLive.on) liveCanvas.stop();
  paintLiveBtn();
  toast(flowLive.on ? "Live: new runs replay on the canvas as they land" : "Live off");
};
paintLiveBtn();

/* a run to replay, from the run view's header */
function replayControl(runId) {
  const box = el("span", "replayctl");
  const go = Icons.button("play", "Replay", "small", "Replay this run on the canvas, from its recorded timings");
  go.onclick = () => liveCanvas.replay(runId, 1);
  const fast = el("button", "small ghost", "4×");
  fast.type = "button";
  fast.title = "Replay four times faster";
  fast.onclick = () => liveCanvas.replay(runId, 4);
  box.append(go, fast);
  return box;
}

