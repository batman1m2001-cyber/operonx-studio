/* operonx studio — a run as a line (docs/RUN_LINE_PLAN.md). Pure: the flow's
 * graph and the run's tree rows in, stations and lanes out — no browser.
 *
 * A station is an op of the flow, in the order the run reached it; an open
 * GraphOp is a station whose ops follow it, indented. The lanes are the
 * flow's own wires, drawn like a commit graph: a fork opens lanes, a join
 * merges them, a branch's route that was not taken is a lane that fades.
 * Run: node --test tests/js/runline.test.mjs */
(function (global) {
  "use strict";

  /* "<engine>.prepare.memory.task#main.[0]" and "graph:prepare.memory#…"
   * both name the op at "prepare.memory[.task]" in the flow. */
  function rowPath(r) {
    const bare = String((r && r.id) || "").split("#")[0];
    if (bare.startsWith("graph:")) return bare.slice(6);
    const i = bare.indexOf(".");
    return i < 0 ? bare : bare.slice(i + 1);
  }

  const inTurn = (r, turn) => !turn || (r.ctx || "") === turn || (r.ctx || "").startsWith(turn + ".");

  /* A GraphOp is open by default when its inside has a shape to see: a
   * branch, a fork or a join. A chain (task → agent → run) stays one station. */
  function shaped(g) {
    const outs = new Map(), ins = new Map();
    for (const e of (g && g.edges) || []) {
      outs.set(e.src, (outs.get(e.src) || 0) + 1);
      ins.set(e.dst, (ins.get(e.dst) || 0) + 1);
    }
    return ((g && g.nodes) || []).some(n => (n.routes && n.routes.length) || outs.get(n.id) > 1 || ins.get(n.id) > 1);
  }

  /* A node's path in the run: its id without the engine's name. A loop's
   * ops carry the loop's hidden group ("review.__loop_0__.s"), as their
   * rows do. */
  function keyOf(n, prefix) {
    const id = String(n.id || "");
    const i = id.indexOf(".");
    if (i > 0 && id.endsWith("." + n.name)) return id.slice(i + 1);
    return prefix ? `${prefix}.${n.name}` : n.name;
  }

  function defaultOpen(graph) {
    const open = new Set();
    (function walk(g, prefix) {
      for (const n of (g && g.nodes) || []) {
        const path = keyOf(n, prefix);
        if (n.graph) {
          if (shaped(n.graph)) open.add(path);
          walk(n.graph, path);
        }
      }
    })(graph, "");
    return open;
  }

  function kindOf(n) {
    const t = `${n.op_type || ""} ${n.kind || ""}`.toLowerCase();
    if (n.routes && n.routes.length || /branch/.test(t)) return "branch";
    if (/agent/.test(t)) return "agent";
    if (n.graph || /graph/.test(t)) return "graph";
    if (/llm/.test(t)) return "llm";
    if (/emit/.test(t)) return "emit";
    if (/vector|retriev|embed/.test(t)) return "data";
    return "func";
  }

  /* The flow flattened: a station per op shown, edges between them. An open
   * GraphOp feeds its entries; what leaves it leaves from its exits. */
  function flatten(graph, open) {
    const st = new Map(), order = [], edges = [];
    function add(g, prefix, depth, parent) {
      const ent = new Map(), ex = new Map(), byId = new Map();
      for (const n of g.nodes || []) {
        byId.set(n.id, n.name);
        byId.set(n.name, n.name);
        const path = keyOf(n, prefix);
        const s = {key: path, name: n.name, node: n, depth, parent, kind: kindOf(n),
                   group: !!n.graph, open: false, gen: !!n.is_gen,
                   loop: n.loop ? n.loop.group : null};
        st.set(path, s);
        order.push(path);
        if (n.graph && open.has(path)) {
          s.open = true;
          const inner = add(n.graph, path, depth + 1, path);
          for (const k of inner.entries) edges.push({from: path, to: k, type: "normal", inside: true});
          ent.set(n.name, [path]);
          ex.set(n.name, inner.exits.length ? inner.exits : [path]);
        } else {
          ent.set(n.name, [path]);
          ex.set(n.name, [path]);
        }
      }
      const hasIn = new Set(), hasOut = new Set();
      for (const e of g.edges || []) {
        const a = byId.get(e.src), b = byId.get(e.dst);
        if (a == null || b == null) continue;
        hasOut.add(a); hasIn.add(b);
        for (const x of ex.get(a)) for (const y of ent.get(b)) {
          edges.push({from: x, to: y, route: e.kind === "branch" ? e.route : null,
                      label: e.kind === "branch" ? e.label : null,
                      type: e.type === "error" ? "error" : e.soft ? "soft" : "normal",
                      back: !!e.back, origin: e.origin || null});
        }
      }
      const names = (g.nodes || []).map(n => n.name);
      const entries = (g.entries && g.entries.length ? g.entries : names.filter(n => !hasIn.has(n)))
        .filter(n => ent.has(n)).flatMap(n => ent.get(n));
      const exits = (g.exits && g.exits.length ? g.exits : names.filter(n => !hasOut.has(n)))
        .filter(n => ex.has(n)).flatMap(n => ex.get(n));
      return {entries, exits};
    }
    add(graph, "", 0, null);
    return {st, order, edges};
  }

  /* What the run did at each station: its executions (in the turn), when,
   * how long, and under it: LLM calls, tool calls, errors. */
  function attach(st, rows, turn) {
    const byPath = new Map();
    const under = [];
    for (const r of rows || []) {
      if (r.kind === "stand-in" || !inTurn(r, turn)) continue;
      const p = rowPath(r);
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(r);
      if (r.op_type === "llm" || r.op_type === "tool" || r.op_type === "graph" || r.status === "error") under.push([p, r]);
    }
    for (const s of st.values()) {
      let mine = (byPath.get(s.key) || []).filter(r => r.kind === "record" || r.kind === "container" || r.step);
      // a loop inside a GraphOp echoes the GraphOp's container once per lap (no op_type): not a run
      const typed = mine.filter(r => r.kind !== "container" || r.op_type);
      if (typed.length) mine = typed;
      const execs = mine.filter(r => r.status !== "retried").sort((a, b) => a.start_ms - b.start_ms);
      s.execs = execs;
      s.retries = mine.length - execs.length;
      s.llm = 0; s.tools = new Map(); s.errors = 0;
      const pre = s.key + ".";
      for (const [p, r] of under) {
        if (p !== s.key && !p.startsWith(pre)) continue;
        if (r.op_type === "llm" && !(p === s.key && s.gen)) s.llm += 1;
        if (r.op_type === "tool") s.tools.set(r.op, (s.tools.get(r.op) || 0) + 1);
        if (r.op_type === "graph" && !s.group && s.kind !== "agent" && p.split(".").length === s.key.split(".").length + 1) {
          const nm = p.split(".").pop();
          s.invoked = s.invoked || new Map();
          s.invoked.set(nm, (s.invoked.get(nm) || 0) + 1);
        }
        if (r.status === "error") s.errors += 1;
      }
      // a subgraph recorded before operonx 1.22.3 has no row of its own:
      // it ran when an op inside it did
      if (!execs.length && s.group) {
        let lo = Infinity, hi = -Infinity;
        for (const [p, rs] of byPath) {
          if (!p.startsWith(pre)) continue;
          for (const r of rs) { lo = Math.min(lo, r.start_ms); hi = Math.max(hi, r.start_ms + (r.dur_ms || 0)); }
        }
        if (lo < Infinity) s.span = [lo, hi];
      }
      s.ran = execs.length > 0 || !!s.span;
      s.start = execs.length ? execs[0].start_ms : s.span ? s.span[0] : null;
      s.end = execs.length ? Math.max(...execs.map(r => r.start_ms + (r.dur_ms || 0))) : s.span ? s.span[1] : null;
      s.took = execs.length ? execs.reduce((t, r) => t + (r.dur_ms || 0), 0) : s.span ? s.span[1] - s.span[0] : 0;
      s.errors += execs.filter(r => r.status === "error").length;
      if (s.gen && s.llm === 0 && s.kind === "llm" && execs.length) s.llm = 1;
      s.failed = execs.some(r => r.status === "error");
    }
  }

  /* Edges that close a cycle (a loop's way back) are kept apart: the line
   * runs forward, the station says where it went back to. */
  function dropBackEdges(order, edges) {
    const out = new Map(order.map(k => [k, []]));
    for (const e of edges) if (out.has(e.from)) out.get(e.from).push(e);
    const mark = new Map(), back = new Set();
    const visit = (k) => {
      mark.set(k, 1);
      for (const e of out.get(k) || []) {
        const m = mark.get(e.to);
        if (m === 1) back.add(e);
        else if (!m) visit(e.to);
      }
      mark.set(k, 2);
    };
    for (const k of order) if (!mark.get(k)) visit(k);
    for (const e of edges) if (e.back) back.add(e);
    return {fwd: edges.filter(e => !back.has(e)), back: [...back]};
  }

  /* Rows in the order the run reached them: a station that ran sits at its
   * start; one that did not, right after what leads to it — a route not
   * taken shows beside the branch, not at the end. */
  function sequence(st, order, edges) {
    const idx = new Map(order.map((k, i) => [k, i]));
    const preds = new Map(order.map(k => [k, []])), succs = new Map(order.map(k => [k, []]));
    for (const e of edges) { preds.get(e.to).push(e); succs.get(e.from).push(e); }
    const kahn = (prio) => {
      const deg = new Map(order.map(k => [k, preds.get(k).length]));
      const ready = order.filter(k => !deg.get(k));
      const out = [];
      while (ready.length) {
        ready.sort((a, b) => prio(a) - prio(b) || idx.get(a) - idx.get(b));
        const k = ready.shift();
        out.push(k);
        for (const e of succs.get(k)) { deg.set(e.to, deg.get(e.to) - 1); if (!deg.get(e.to)) ready.push(e.to); }
      }
      return out;
    };
    const rank = new Map();
    for (const e of edges) if (e.route != null) rank.set(e.to, e.route);
    const key = new Map();
    for (const k of kahn(k => idx.get(k))) {
      const s = st.get(k);
      const before = preds.get(k).map(e => key.get(e.from)).filter(v => v != null);
      key.set(k, s.ran ? s.start : (before.length ? Math.max(...before) : 0));
    }
    const flat = kahn(k => key.get(k) + (rank.get(k) || 0) * 1e-6);
    // a group's rows stay together: an op that started while it ran comes
    // before or after the whole group, never between its rows
    const pos = new Map(flat.map((k, i) => [k, i]));
    const kids = new Map();
    for (const k of flat) {
      const p = st.get(k).parent || "";
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(k);
    }
    const first = new Map();
    const reach = (k) => {
      if (first.has(k)) return first.get(k);
      const v = Math.min(pos.get(k), ...(kids.get(k) || []).map(reach));
      first.set(k, v);
      return v;
    };
    const rows = [];
    const emit = (p) => {
      for (const k of (kids.get(p) || []).slice().sort((a, b) => reach(a) - reach(b))) { rows.push(k); emit(k); }
    };
    emit("");
    return {rows, preds, succs};
  }

  /* The lanes, one row at a time (a commit graph's walk): the station takes
   * the leftmost lane that leads to it, the other lanes into it merge, its
   * first way out (one that ran, if any) goes straight on, the others fork
   * to free lanes on its right. */
  function lanes(st, rows, succs) {
    const slots = [];
    const at = rows.map((k) => {
      const s = st.get(k);
      const inc = [];
      slots.forEach((x, j) => { if (x && x.to === k) inc.push(j); });
      let lane = inc.length ? inc[0] : slots.indexOf(null);
      if (lane < 0) lane = slots.length;
      const through = [];
      slots.forEach((x, j) => { if (x && x.to !== k) through.push({lane: j, edge: x}); });
      const merges = inc.map(j => ({lane: j, edge: slots[j]}));
      for (const j of inc) slots[j] = null;
      const outs = [...succs.get(k)].sort((a, b) => {
        const ra = st.get(a.to).ran ? 0 : 1, rb = st.get(b.to).ran ? 0 : 1;
        return ra - rb || rows.indexOf(a.to) - rows.indexOf(b.to);
      });
      const forks = [];
      outs.forEach((e, i) => {
        let j = lane;
        if (i > 0) {
          j = slots.findIndex((x, jj) => x === null && jj > lane);
          if (j < 0) j = Math.max(slots.length, lane + 1);
        }
        while (slots.length <= j) slots.push(null);
        const to = st.get(e.to);
        const ran = e.type === "error" ? s.failed && to.ran : s.ran && !s.failed && to.ran;
        // a race: a soft wire that landed after its op had already gone
        const late = ran && e.type === "soft" && s.end != null && to.start != null && s.end > to.start + 1;
        const edge = {...e, ran: ran && !late, late};
        slots[j] = edge;
        forks.push({lane: j, edge});
      });
      while (slots.length && slots[slots.length - 1] === null) slots.pop();
      return {key: k, lane, merges, through, forks};
    });
    const width = Math.max(1, ...at.map(r => 1 + Math.max(r.lane, ...r.merges.map(m => m.lane),
      ...r.through.map(t => t.lane), ...r.forks.map(f => f.lane))));
    return {at, width};
  }

  /* A join's early arrivals waited for the last one in. */
  function waits(st, preds) {
    for (const [k, es] of preds) {
      const j = st.get(k);
      if (!j.ran) continue;
      const live = es.filter(e => e.type !== "error" || st.get(e.from).failed);
      const ins = live.map(e => st.get(e.from)).filter(s => s.ran && s.end != null && !s.failed);
      if (ins.length < 2) continue;
      if (live.every(e => e.type === "soft")) {
        // soft wires (a race, a branch's arms): the first one in fired it
        const late = ins.filter(s => s.end > j.start + 1);
        if (late.length) j.raced = {won: ins.reduce((a, b) => (b.end < a.end ? b : a)).name, late: late.map(s => s.name)};
        continue;
      }
      // a mixed join waits for all that came, a branch arm's soft wire included
      const hard = ins;
      const last = hard.reduce((a, b) => (b.end > a.end ? b : a));
      const first = hard.reduce((a, b) => (b.end < a.end ? b : a));
      if (last.end - first.end > 50) j.waited = {ms: last.end - first.end, for: last.name, n: hard.length};
      for (const s of hard) if (s !== last) s.idle = last.end - s.end;
    }
  }

  /* A branch: the routes it had, the one it took. */
  function routes(st, succs) {
    for (const s of st.values()) {
      if (s.kind !== "branch") continue;
      const out = succs.get(s.key) || [];
      s.took = null;
      s.routes = out.map(e => ({to: st.get(e.to).name, ran: st.get(e.to).ran, route: e.route, label: e.label}));
      s.matched = s.ran && out.length > 0 && !s.routes.some(q => q.ran) ? false : null;
    }
  }

  function layout(graph, rows, opts) {
    const o = opts || {};
    let open = o.open || defaultOpen(graph);
    let {st, order, edges} = flatten(graph, open);
    attach(st, rows, o.turn || null);
    if (!o.open) {
      // a GraphOp that did not run stays closed: nothing inside it happened
      const shut = [...open].filter(k => st.get(k) && !st.get(k).ran);
      if (shut.length) {
        open = new Set([...open].filter(k => !shut.some(c => k === c || k.startsWith(c + "."))));
        ({st, order, edges} = flatten(graph, open));
        attach(st, rows, o.turn || null);
      }
    }
    const {fwd, back} = dropBackEdges(order, edges);
    for (const e of back) {
      const s = st.get(e.from);
      (s.loops = s.loops || []).push(st.get(e.to).name);
    }
    for (const err of o.errors || []) {
      if (err.op_id) continue;
      const p = String(err.op || "").slice(String(err.op || "").indexOf(".") + 1);
      const inside = [...st.values()].filter(s => s.key === p || s.key.startsWith(p + "."));
      const at = inside.find(s => s.loops) || inside[inside.length - 1];
      if (at) at.stopped = {type: err.type, message: err.message};
    }
    const seq = sequence(st, order, fwd);
    routes(st, seq.succs);
    waits(st, seq.preds);
    const ln = lanes(st, seq.rows, seq.succs);
    return {stations: st, rows: ln.at, width: ln.width, open, edges: fwd, preds: seq.preds, succs: seq.succs};
  }

  /* The stations around one: what fed it, what it fed, the GraphOps it is
   * in — what lights up when it is picked. */
  function around(lay, key) {
    const near = new Set([key]);
    for (const e of lay.preds.get(key) || []) near.add(e.from);
    for (const e of lay.succs.get(key) || []) near.add(e.to);
    for (let s = lay.stations.get(key); s && s.parent; s = lay.stations.get(s.parent)) near.add(s.parent);
    return near;
  }

  const api = {rowPath, keyOf, defaultOpen, layout, around};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.RunLine = api;
})(typeof window !== "undefined" ? window : globalThis);
