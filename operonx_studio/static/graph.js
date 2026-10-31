/* Graphs and charts the assistant draws (docs/VISUAL_CHAT_PLAN.md D9, D10):
   ```ox-graph and ```ox-chart fences, registered with blocks.js.

     ox-graph  {id?, title?, direction: down|right, groups: {id: title},
                nodes: [{id, label, group?, state?, detail?, file? | op? | point?}],
                edges: [[from, to, label?]], highlight: [ids]}
     ox-chart  {id?, type: bar|line|spark|stack, unit?, title?, note?,
                series: [{name, points: [[x, y], …]}]}
     update    {id, update: {node: state | {state, detail, label}}}   a graph drawn earlier
               {id, append: [{name, points}]}                          a chart drawn earlier

   The logic (validate, layout, update) has no DOM: tests/js/graph.test.mjs
   runs it in node. The drawing below it runs only in the page. */
const oxGraph = (() => {
  const STATES = ["done", "ok", "failed", "error", "active", "running", "pending", "blocked", "skipped", "waiting", "warning"];
  const MAX_NODES = 500;
  const INLINE_NODES = 12;
  const LIST_NODES = 60;
  const NODE_H = 30;
  const GAP = 16;            // between nodes in a layer
  const LAYER_GAP = 40;      // between layers
  const GROUP_PAD = 10;
  const GROUP_TITLE = 16;

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const parse = (body) => {
    try { return {ok: true, value: JSON.parse(body)}; }
    catch (e) { return {ok: false, reason: "not JSON: " + String(e.message || e).split("\n")[0].slice(0, 80)}; }
  };

  /* ── ox-graph: the schema ─────────────────────────────────────────── */
  function validate(body) {
    const p = typeof body === "string" ? parse(body) : {ok: true, value: body};
    if (!p.ok) return p;
    const g = p.value;
    if (!isObj(g)) return {ok: false, reason: "a graph is an object"};
    if (g.update !== undefined) {
      if (!g.id) return {ok: false, reason: "an update names the graph's id"};
      if (!isObj(g.update)) return {ok: false, reason: "update is {node: state}"};
      return {ok: true, value: {id: String(g.id), update: g.update}};
    }
    if (!Array.isArray(g.nodes) || !g.nodes.length) return {ok: false, reason: "no nodes"};
    if (g.nodes.length > MAX_NODES) return {ok: false, reason: `over ${MAX_NODES} nodes`};
    const ids = new Set();
    const nodes = [];
    for (const n of g.nodes) {
      if (!isObj(n) || n.id == null || n.id === "") return {ok: false, reason: "a node without an id"};
      const id = String(n.id);
      if (ids.has(id)) return {ok: false, reason: `node ${id} twice`};
      ids.add(id);
      const state = n.state ? String(n.state).toLowerCase() : "";
      if (state && !STATES.includes(state)) return {ok: false, reason: `node ${id}: unknown state ${n.state}`};
      nodes.push({id, label: String(n.label ?? n.id), group: n.group != null ? String(n.group) : "", state,
        detail: n.detail ? String(n.detail) : "", file: n.file ? String(n.file) : "", op: n.op ? String(n.op) : "",
        point: n.point ? String(n.point) : ""});
    }
    const edges = [];
    for (const e of g.edges || []) {
      const [from, to, label] = Array.isArray(e) ? e : isObj(e) ? [e.from, e.to, e.label] : [];
      if (!ids.has(String(from)) || !ids.has(String(to))) return {ok: false, reason: `edge ${from} → ${to}: no such node`};
      edges.push({from: String(from), to: String(to), label: label != null ? String(label) : ""});
    }
    const groups = isObj(g.groups) ? Object.fromEntries(Object.entries(g.groups).map(([k, v]) => [k, String(v)])) : {};
    return {ok: true, value: {id: g.id != null ? String(g.id) : "", title: g.title ? String(g.title) : "",
      direction: ["right", "down"].includes(g.direction) ? g.direction : "auto", groups, nodes, edges,
      highlight: Array.isArray(g.highlight) ? g.highlight.map(String) : []}};
  }

  /* an update: {node: "done"} or {node: {state, detail, label}} → the ids it changed */
  function applyUpdate(g, update) {
    const changed = [];
    for (const [id, v] of Object.entries(update || {})) {
      const n = g.nodes.find((x) => x.id === id);
      if (!n) continue;
      const u = isObj(v) ? v : {state: v};
      if (u.state != null) {
        const s = String(u.state).toLowerCase();
        if (STATES.includes(s)) n.state = s;
      }
      if (u.detail != null) n.detail = String(u.detail);
      if (u.label != null) n.label = String(u.label);
      changed.push(id);
    }
    return changed;
  }

  /* ── the layered layout ───────────────────────────────────────────── */
  const nodeW = (label, dot) => Math.max(64, Math.min(200, Math.round(String(label).length * 6.6 + 26 + (dot ? 18 : 0))));

  /* the edges that close a cycle (found by a depth-first walk), drawn as back edges */
  function backEdges(nodes, edges) {
    const out = new Map(nodes.map((n) => [n.id, []]));
    edges.forEach((e, i) => out.get(e.from).push([e.to, i]));
    const mark = new Map();
    const back = new Set();
    const walk = (id) => {
      mark.set(id, 1);
      for (const [to, i] of out.get(id)) {
        if (mark.get(to) === 1) back.add(i);
        else if (!mark.get(to)) walk(to);
      }
      mark.set(id, 2);
    };
    for (const n of nodes) if (!mark.get(n.id)) walk(n.id);
    return back;
  }

  /* direction "auto" (none given): whichever way fits the reply's box (640 × 260 by default) at the larger scale */
  function layout(g, box = {w: 640, h: 260}) {
    if (g.direction === "down" || g.direction === "right") return layoutDir(g, g.direction === "down");
    const scale = (L) => Math.min(1, box.w / L.width, box.h / L.height);
    const d = layoutDir(g, true), r = layoutDir(g, false);
    return scale(r) > scale(d) + 0.05 ? r : d;
  }

  function layoutDir(g, down) {
    const back = backEdges(g.nodes, g.edges);
    const fwd = g.edges.filter((e, i) => !back.has(i) && e.from !== e.to);
    // layer = longest path from a source
    const layer = new Map(g.nodes.map((n) => [n.id, 0]));
    for (let pass = 0; pass < g.nodes.length; pass++) {
      let moved = false;
      for (const e of fwd) {
        if (layer.get(e.to) < layer.get(e.from) + 1) { layer.set(e.to, layer.get(e.from) + 1); moved = true; }
      }
      if (!moved) break;
    }
    const nLayers = Math.max(...layer.values()) + 1;
    // groups keep their own band across every layer, so a group's frame never crosses another's
    const groupOrder = [];
    for (const n of g.nodes) if (!groupOrder.includes(n.group)) groupOrder.push(n.group);
    // order inside a layer: the barycentre of the parents' positions, a few sweeps
    const rows = Array.from({length: nLayers}, () => []);
    g.nodes.forEach((n, i) => rows[layer.get(n.id)].push({n, key: i}));
    const pos = new Map();
    const parents = new Map(g.nodes.map((n) => [n.id, []]));
    const children = new Map(g.nodes.map((n) => [n.id, []]));
    for (const e of fwd) { parents.get(e.to).push(e.from); children.get(e.from).push(e.to); }
    const sortRow = (row, near) => {
      for (const r of row) {
        const ps = near.get(r.n.id).filter((p) => pos.has(p));
        if (ps.length) r.key = ps.reduce((a, p) => a + pos.get(p), 0) / ps.length;
      }
      row.sort((a, b) => groupOrder.indexOf(a.n.group) - groupOrder.indexOf(b.n.group) || a.key - b.key);
      row.forEach((r, i) => pos.set(r.n.id, i));
    };
    rows.forEach((row) => row.forEach((r, i) => pos.set(r.n.id, i)));
    for (let s = 0; s < 4; s++) {
      for (let l = 1; l < nLayers; l++) sortRow(rows[l], parents);
      for (let l = nLayers - 2; l >= 0; l--) sortRow(rows[l], children);
    }
    for (let l = 1; l < nLayers; l++) sortRow(rows[l], parents);
    // sizes: across = along the layer, along = between layers
    const size = new Map(g.nodes.map((n) => [n.id, {w: nodeW(n.label, !!n.state), h: NODE_H}]));
    const across = (id) => (down ? size.get(id).w : size.get(id).h);
    const along = (id) => (down ? size.get(id).h : size.get(id).w);
    const grouped = groupOrder.some((k) => k);
    const pad = grouped ? GROUP_PAD : 0;
    // band widths: the widest row a group has in any layer
    const band = new Map();
    for (const k of groupOrder) {
      let wmax = 0;
      for (const row of rows) {
        const rs = row.filter((r) => r.n.group === k);
        const w = rs.reduce((a, r) => a + across(r.n.id), 0) + Math.max(0, rs.length - 1) * GAP;
        wmax = Math.max(wmax, w);
      }
      band.set(k, wmax + (k ? 2 * pad : 0));
    }
    const bandStart = new Map();
    let off = 0;
    for (const k of groupOrder) { bandStart.set(k, off); off += band.get(k) + (grouped ? GAP : 0); }
    const crossTotal = off - (grouped ? GAP : 0);
    // layer depth: the deepest node in it
    const depth = rows.map((row) => Math.max(0, ...row.map((r) => along(r.n.id))));
    const top = grouped ? GROUP_TITLE + pad : 0;
    const layerAt = [];
    let a = top;
    // left to right, an edge's label sits in the gap after its source's layer: the gap makes room for it
    const gapAfter = Array.from({length: nLayers}, () => LAYER_GAP);
    if (!down) for (const e of fwd) if (e.label) gapAfter[layer.get(e.from)] = Math.max(gapAfter[layer.get(e.from)], e.label.length * 6 + 30);
    for (let l = 0; l < nLayers; l++) { layerAt.push(a); a += depth[l] + gapAfter[l]; }
    const alongTotal = a - gapAfter[nLayers - 1] + (grouped ? pad : 0);
    const placed = new Map();
    rows.forEach((row, l) => {
      for (const k of groupOrder) {
        const rs = row.filter((r) => r.n.group === k);
        const w = rs.reduce((s, r) => s + across(r.n.id), 0) + Math.max(0, rs.length - 1) * GAP;
        let c = bandStart.get(k) + (band.get(k) - w) / 2;
        for (const r of rs) {
          const id = r.n.id;
          const cA = c, cL = layerAt[l] + (depth[l] - along(id)) / 2;
          placed.set(id, down ? {x: cA, y: cL, w: size.get(id).w, h: size.get(id).h, layer: l}
            : {x: cL, y: cA, w: size.get(id).w, h: size.get(id).h, layer: l});
          c += across(id) + GAP;
        }
      }
    });
    const nodes = g.nodes.map((n) => ({id: n.id, ...placed.get(n.id)}));
    const P = (id) => placed.get(id);
    const edges = g.edges.map((e, i) => {
      const s = P(e.from), t = P(e.to);
      const isBack = back.has(i) || e.from === e.to || P(e.to).layer <= P(e.from).layer;
      let pts;
      if (!isBack) {
        pts = down ? [[s.x + s.w / 2, s.y + s.h], [t.x + t.w / 2, t.y]] : [[s.x + s.w, s.y + s.h / 2], [t.x, t.y + t.h / 2]];
      } else {
        // a back edge leaves and enters on the far side, curving around
        pts = down ? [[s.x + s.w, s.y + s.h / 2], [t.x + t.w, t.y + t.h / 2]] : [[s.x + s.w / 2, s.y + s.h], [t.x + t.w / 2, t.y + t.h]];
      }
      return {from: e.from, to: e.to, label: e.label, back: isBack, points: pts};
    });
    const groups = [];
    for (const k of groupOrder) {
      if (!k) continue;
      const ns = nodes.filter((n) => g.nodes.find((x) => x.id === n.id).group === k);
      const x0 = Math.min(...ns.map((n) => n.x)) - pad, y0 = Math.min(...ns.map((n) => n.y)) - pad - GROUP_TITLE;
      const x1 = Math.max(...ns.map((n) => n.x + n.w)) + pad, y1 = Math.max(...ns.map((n) => n.y + n.h)) + pad;
      groups.push({id: k, title: g.groups[k] || k, x: x0, y: y0, w: x1 - x0, h: y1 - y0});
    }
    const backRoom = edges.some((e) => e.back) ? 36 : 0;
    const width = (down ? crossTotal : alongTotal) + (down ? backRoom : 0);
    const height = (down ? alongTotal : crossTotal) + (down ? 0 : backRoom);
    // groups may reach above 0 by their title; shift everything into view
    const minX = Math.min(0, ...groups.map((r) => r.x)), minY = Math.min(0, ...groups.map((r) => r.y));
    const shift = (o) => { o.x -= minX; o.y -= minY; };
    nodes.forEach(shift);
    groups.forEach(shift);
    edges.forEach((e) => { e.points = e.points.map(([x, y]) => [x - minX, y - minY]); });
    return {nodes, edges, groups, width: Math.ceil(width - minX), height: Math.ceil(height - minY), down};
  }

  /* ── ox-chart: the schema ─────────────────────────────────────────── */
  const CHART_TYPES = ["bar", "line", "spark", "stack"];
  const MAX_SERIES = 8;       // the categorical palette's slots (dataviz reference palette)
  function validateChart(body) {
    const p = typeof body === "string" ? parse(body) : {ok: true, value: body};
    if (!p.ok) return p;
    const c = p.value;
    if (!isObj(c)) return {ok: false, reason: "a chart is an object"};
    if (c.append !== undefined) {
      if (!c.id) return {ok: false, reason: "an append names the chart's id"};
      const v = validateChart({type: "line", series: c.append});
      return v.ok ? {ok: true, value: {id: String(c.id), append: v.value.series}} : v;
    }
    const type = c.type || "bar";
    if (!CHART_TYPES.includes(type)) return {ok: false, reason: `type is one of ${CHART_TYPES.join(", ")}`};
    if (!Array.isArray(c.series) || !c.series.length) return {ok: false, reason: "no series"};
    if (c.series.length > MAX_SERIES) return {ok: false, reason: `over ${MAX_SERIES} series: fold the rest into "Other"`};
    const series = [];
    for (const s of c.series) {
      if (!isObj(s) || !Array.isArray(s.points)) return {ok: false, reason: "a series is {name, points: [[x, y]]}"};
      const points = [];
      for (const pt of s.points) {
        const [x, y] = Array.isArray(pt) ? pt : typeof pt === "number" ? [points.length, pt] : [];
        if (typeof y !== "number" || !isFinite(y)) return {ok: false, reason: `${s.name || "a series"}: y must be a number`};
        points.push([x, y]);
      }
      if (!points.length) return {ok: false, reason: `${s.name || "a series"}: no points`};
      series.push({name: String(s.name ?? `series ${series.length + 1}`), points});
    }
    return {ok: true, value: {id: c.id != null ? String(c.id) : "", type, unit: c.unit ? String(c.unit) : "",
      title: c.title ? String(c.title) : "", note: c.note ? String(c.note) : "", series}};
  }

  function appendPoints(chart, add) {
    for (const s of add) {
      const t = chart.series.find((x) => x.name === s.name);
      if (t) t.points.push(...s.points);
      else if (chart.series.length < MAX_SERIES) chart.series.push({name: s.name, points: [...s.points]});
    }
  }

  /* nice round ticks from 0 (or the data's floor) to its top */
  function ticks(lo, hi, n = 3) {
    if (hi === lo) hi = lo + 1;
    const raw = (hi - lo) / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const t0 = Math.floor(lo / step) * step;
    const out = [];
    for (let v = t0; v <= hi + step * 0.001; v += step) out.push(+v.toFixed(10));
    if (out[out.length - 1] < hi) out.push(+(out[out.length - 1] + step).toFixed(10));
    return out;
  }

  /* ── updates by id, across a session (D10) ────────────────────────── */
  // id → {kind, value (as drawn now), body (the first drawing's), updates: [bodies], hosts: Set, at}
  const drawn = new Map();
  function remember(kind, value, redraw) {
    if (!value.id) return null;
    const key = kind + ":" + value.id;
    const was = drawn.get(key);
    const entry = {kind, value, redraw, updates: was ? was.updates : [], at: was ? was.at : 0};
    // a re-drawing of the first fence (the text re-rendered) keeps the updates that came after it
    for (const u of entry.updates) kind === "graph" ? applyUpdate(value, u) : appendPoints(value, u);
    drawn.set(key, entry);
    return entry;
  }
  function update(kind, id, body, now) {
    const e = drawn.get(kind + ":" + id);
    if (!e) return null;
    const sig = JSON.stringify(body);
    if (e.updates.some((u) => JSON.stringify(u) === sig)) return {entry: e, changed: [], again: true};
    e.updates.push(body);
    const changed = kind === "graph" ? applyUpdate(e.value, body) : (appendPoints(e.value, body), body.map((s) => s.name));
    e.at = now || Date.now();
    if (e.redraw) e.redraw(changed);
    return {entry: e, changed};
  }
  const reset = () => drawn.clear();

  const api = {validate, applyUpdate, layout, validateChart, appendPoints, ticks, remember, update, reset,
    INLINE_NODES, LIST_NODES, STATES};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
if (typeof window !== "undefined") window.oxGraph = oxGraph;

/* ── drawing: inline SVG in the studio's tokens, the page only ──────── */
(() => {
  if (typeof window === "undefined" || !window.oxBlocks) return;
  const B = window.oxBlocks, G = oxGraph;
  const NS = "http://www.w3.org/2000/svg";
  const S = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const GLYPH = {ok: "✓", err: "✕", warn: "!", blocked: "⊘", skip: "»", pending: "·", run: "◌", info: "i"};
  const hhmm = (t) => new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  const fit = (label, w) => {
    const n = Math.max(3, Math.round((w - 26) / 6.6));
    return label.length > n ? label.slice(0, n - 1) + "…" : label;
  };
  let uid = 0;

  /* the files this session's turns changed: a node naming one is "affected" */
  function changedFiles(ctx) {
    const out = new Set();
    for (const it of (ctx.A && ctx.A.items) || []) {
      if (it.kind === "changes") for (const f of it.files || []) if (!f.deleted) out.add(f.path);
    }
    return out;
  }
  const affects = (file, changed) => {
    if (!file) return false;
    const f = file.replace(/^\.?\//, "");
    for (const p of changed) if (p === f || p.endsWith("/" + f) || f.endsWith("/" + p)) return true;
    return false;
  };
  const targetOf = (n) => (n.file ? ["file", n.file] : n.op ? ["op", n.op] : n.point ? ["point", n.point] : null);

  /* the graph as one <svg>; nodes are focusable buttons */
  function drawSvg(g, L, opts) {
    const id = "oxg" + ++uid;
    const svg = S("svg", {viewBox: `0 0 ${L.width} ${L.height}`, class: "ax-graph-svg", role: "group",
      "aria-label": g.title || "Graph"});
    const defs = S("defs");
    const mk = S("marker", {id: id + "a", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7,
      orient: "auto-start-reverse"});
    mk.append(S("path", {d: "M0 0 L8 4 L0 8 z", class: "ax-g-arrow"}));
    defs.append(mk);
    svg.append(defs);
    for (const r of L.groups) {
      svg.append(S("rect", {x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, class: "ax-g-group"}));
      svg.append(S("text", {x: r.x + 8, y: r.y + 12, class: "ax-g-gtitle"}, r.title));
    }
    const view = S("g");
    for (const e of L.edges) {
      const [[x0, y0], [x1, y1]] = e.points;
      let d;
      if (e.back) {
        const out = 26;
        d = L.down ? `M${x0} ${y0} C${x0 + out} ${y0} ${Math.max(x0, x1) + out} ${(y0 + y1) / 2} ${x1 + 2} ${y1}`
          : `M${x0} ${y0} C${x0} ${y0 + out} ${(x0 + x1) / 2} ${Math.max(y0, y1) + out} ${x1} ${y1 + 2}`;
      } else {
        const m = L.down ? (y1 - y0) / 2 : (x1 - x0) / 2;
        d = L.down ? `M${x0} ${y0} C${x0} ${y0 + m} ${x1} ${y1 - m} ${x1} ${y1 - 1}`
          : `M${x0} ${y0} C${x0 + m} ${y0} ${x1 - m} ${y1} ${x1 - 1} ${y1}`;
      }
      const hot = opts.highlight.has(e.from) && opts.highlight.has(e.to);
      view.append(S("path", {d, class: "ax-g-edge" + (e.back ? " back" : "") + (hot ? " hot" : ""),
        "marker-end": `url(#${id}a)`}));
      if (e.label) {
        const lx = e.back ? (L.down ? Math.max(x0, x1) + 20 : (x0 + x1) / 2) : (x0 + x1) / 2;
        const ly = e.back ? (L.down ? (y0 + y1) / 2 : Math.max(y0, y1) + 20) : (y0 + y1) / 2;
        view.append(S("text", {x: lx + 4, y: ly + 3, class: "ax-g-elabel"}, e.label));
      }
    }
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const nodeEls = new Map();
    for (const p of L.nodes) {
      const n = byId.get(p.id);
      const st = n.state ? B.status(n.state) : null;
      const cls = ["ax-g-node", st ? "st-" + st.tone : "", st ? "has-st" : "", n.state === "active" || n.state === "running" ? "pulse" : "",
        opts.highlight.has(n.id) ? "hot" : "", opts.affected(n) ? "affected" : "", opts.flash.has(n.id) ? "flash" : ""].filter(Boolean).join(" ");
      const gN = S("g", {class: cls, transform: `translate(${p.x} ${p.y})`, tabindex: opts.focusable ? 0 : null,
        role: opts.focusable ? "button" : null, "data-id": n.id,
        "aria-label": `${n.label}${st ? ", " + st.word : ""}${opts.affected(n) ? ", file modified" : ""}`});
      gN.append(S("title", null, [n.label, st && st.word, n.detail].filter(Boolean).join(" — ")));
      gN.append(S("rect", {width: p.w, height: p.h, rx: 7, class: "ax-g-box"}));
      let tx = p.w / 2;
      if (st) {
        gN.append(S("circle", {cx: 13, cy: p.h / 2, r: 7, class: "ax-g-dot"}));
        gN.append(S("text", {x: 13, y: p.h / 2 + 3.5, class: "ax-g-glyph"}, GLYPH[st.tone] || "·"));
        tx = p.w / 2 + 8;
      }
      gN.append(S("text", {x: tx, y: p.h / 2 + 4, class: "ax-g-label"}, fit(n.label, st ? p.w - 18 : p.w)));
      if (opts.affected(n)) {
        gN.append(S("circle", {cx: p.w - 1, cy: 1, r: 6, class: "ax-g-mod"}));
        gN.append(S("text", {x: p.w - 1, y: 4.5, class: "ax-g-modt"}, "M"));
      }
      nodeEls.set(n.id, gN);
      view.append(gN);
    }
    svg.append(view);
    return {svg, view, nodeEls};
  }

  /* move to the nearest node in an arrow's direction */
  function nearest(L, fromId, key) {
    const c = (p) => [p.x + p.w / 2, p.y + p.h / 2];
    const a = L.nodes.find((p) => p.id === fromId);
    if (!a) return null;
    const [ax, ay] = c(a);
    const dir = {ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1]}[key];
    let best = null, bd = Infinity;
    for (const p of L.nodes) {
      if (p.id === fromId) continue;
      const [x, y] = c(p);
      const along = (x - ax) * dir[0] + (y - ay) * dir[1];
      if (along <= 0) continue;
      const side = Math.abs((x - ax) * dir[1]) + Math.abs((y - ay) * dir[0]);
      const d = along + side * 2;
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  }
  // the progress card draws a plan with dependencies the same way (VISUAL_CHAT_PLAN D12)
  G.draw = drawSvg;
  G.nearest = nearest;

  /* the line under a graph about the selected node; its target opens on a second click */
  function detailOf(n, ctx) {
    const box = ctx.el("div", "ax-graph-detail");
    if (!n) { box.append(ctx.el("span", "ax-graph-hint", "Select a node for its detail")); return box; }
    const st = n.state ? B.status(n.state) : null;
    if (st) {
      const chip = ctx.el("span", `ax-graph-st st-${st.tone}`);
      if (st.icon) chip.append(ctx.icon(st.icon));
      chip.append(ctx.el("span", null, st.word));
      box.append(chip);
    }
    box.append(ctx.el("b", null, n.label));
    if (n.detail) box.append(ctx.el("span", "ax-graph-dtext", n.detail));
    const t = targetOf(n);
    if (t) box.append(ctx.studioLink(t[1], `studio:${t[0]}/${t[1]}`));
    return box;
  }

  /* wire selection and keys on a drawn svg */
  function wire(D, g, L, ctx, onSelect) {
    let sel = null;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const pick = (id, open) => {
      if (open && sel === id) {
        const t = targetOf(byId.get(id));
        if (t) ctx.studioLink(t[1], `studio:${t[0]}/${t[1]}`).click();
        return;
      }
      sel = id;
      for (const [k, el] of D.nodeEls) el.classList.toggle("sel", k === id);
      onSelect(byId.get(id));
    };
    for (const [id, el] of D.nodeEls) {
      el.addEventListener("click", (ev) => { ev.stopPropagation(); pick(id, true); });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(id, true); }
        else if (ev.key.startsWith("Arrow")) {
          ev.preventDefault();
          const to = nearest(L, id, ev.key);
          if (to) { D.nodeEls.get(to).focus(); pick(to, false); }
        }
      });
    }
    return {pick, get sel() { return sel; }};
  }

  /* ── the expanded view: zoom, pan, select, fit; a searchable list past 60 nodes ── */
  function openOverlay(g, ctx, entry) {
    const back = document.activeElement;
    const ov = ctx.el("div", "ax-graph-ov");
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", g.title || "Graph");
    const bar = ctx.el("div", "ax-graph-ovbar");
    const title = ctx.el("b", null, g.title || "Graph");
    const btn = (label, ic, fn) => {
      const b = ctx.el("button", "ax-graph-btn");
      b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
      b.append(ic ? ctx.icon(ic) : ctx.el("span", null, label));
      b.onclick = fn;
      return b;
    };
    const stage = ctx.el("div", "ax-graph-stage");
    const side = ctx.el("div", "ax-graph-side");
    const L = G.layout(g);
    const D = drawSvg(g, L, {highlight: new Set(g.highlight), affected: (n) => affects(n.file, changedFiles(ctx)),
      flash: new Set(), focusable: true});
    D.svg.removeAttribute("viewBox");
    D.svg.setAttribute("width", "100%");
    D.svg.setAttribute("height", "100%");
    // the groups' frames are outside the view <g>: move them in so they zoom too
    for (const r of [...D.svg.querySelectorAll(".ax-g-group, .ax-g-gtitle")]) D.view.insertBefore(r, D.view.firstChild);
    stage.append(D.svg);
    let k = 1, tx = 0, ty = 0;
    const apply = () => D.view.setAttribute("transform", `translate(${tx} ${ty}) scale(${k})`);
    const fitView = () => {
      const r = stage.getBoundingClientRect();
      k = Math.min(2, Math.max(0.1, Math.min((r.width - 32) / L.width, (r.height - 32) / L.height)));
      tx = (r.width - L.width * k) / 2; ty = (r.height - L.height * k) / 2;
      apply();
    };
    const zoomAt = (f, cx, cy) => {
      const nk = Math.min(4, Math.max(0.1, k * f));
      tx = cx - (cx - tx) * (nk / k); ty = cy - (cy - ty) * (nk / k); k = nk;
      apply();
    };
    const mid = () => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
    stage.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    }, {passive: false});
    // drag pans; two fingers pinch
    const pts = new Map();
    let pinch = null;
    stage.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".ax-g-node")) return;
      stage.setPointerCapture(ev.pointerId);
      pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
      stage.classList.add("grab");
    });
    stage.addEventListener("pointermove", (ev) => {
      if (!pts.has(ev.pointerId)) return;
      const [px, py] = pts.get(ev.pointerId);
      pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const r = stage.getBoundingClientRect();
        if (pinch) zoomAt(d / pinch, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
        pinch = d;
        return;
      }
      tx += ev.clientX - px; ty += ev.clientY - py;
      apply();
    });
    const up = (ev) => { pts.delete(ev.pointerId); pinch = null; if (!pts.size) stage.classList.remove("grab"); };
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    const detail = ctx.el("div", "ax-graph-ovdetail");
    const show = (n) => { detail.replaceChildren(detailOf(n, ctx)); };
    const W = wire(D, g, L, ctx, show);
    show(null);
    side.append(detail);
    if (g.nodes.length > G.LIST_NODES) {
      const q = ctx.el("input", "ax-graph-q");
      q.type = "search"; q.placeholder = `Find among ${g.nodes.length} nodes`; q.setAttribute("aria-label", "Find a node");
      const list = ctx.el("div", "ax-graph-list");
      const fill = () => {
        const s = q.value.trim().toLowerCase();
        list.replaceChildren(...g.nodes.filter((n) => !s || n.label.toLowerCase().includes(s) || n.id.toLowerCase().includes(s))
          .slice(0, 200).map((n) => {
            const b = ctx.el("button", "ax-graph-li", n.label);
            b.type = "button";
            b.onclick = () => {
              W.pick(n.id, false);
              const p = L.nodes.find((x) => x.id === n.id);
              const r = stage.getBoundingClientRect();
              k = Math.max(k, 1);
              tx = r.width / 2 - (p.x + p.w / 2) * k; ty = r.height / 2 - (p.y + p.h / 2) * k;
              apply();
            };
            return b;
          }));
      };
      q.oninput = fill;
      fill();
      side.append(q, list);
    }
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); if (back && back.focus) back.focus(); };
    const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    bar.append(title, ctx.el("span", "ax-graph-n", `${g.nodes.length} nodes`),
      btn("Zoom out", null, () => zoomAt(1 / 1.25, ...mid())), btn("Zoom in", null, () => zoomAt(1.25, ...mid())),
      btn("Fit", null, fitView), btn("Close", "x", close));
    bar.children[2].firstChild.textContent = "−";
    bar.children[3].firstChild.textContent = "+";
    const body = ctx.el("div", "ax-graph-ovbody");
    body.append(stage, side);
    ov.append(bar, body);
    document.body.append(ov);
    fitView();
    bar.lastChild.focus();
    return {close};
  }

  /* ── ox-graph inline ──────────────────────────────────────────────── */
  function renderGraph(value, ctx) {
    const box = ctx.el("figure", "ax-graph");
    const entry = G.remember("graph", value, null);
    const head = ctx.el("figcaption", "ax-graph-head");
    const stamp = ctx.el("span", "ax-graph-upd");
    const draw = (flash) => {
      const g = entry ? entry.value : value;
      const L = G.layout(g, {w: Math.max(240, Math.min(640, (window.innerWidth || 640) - 70)), h: 260});
      const big = g.nodes.length > G.INLINE_NODES;
      const changed = changedFiles(ctx);
      const D = drawSvg(g, L, {highlight: new Set(g.highlight), affected: (n) => affects(n.file, changed),
        flash: new Set(flash || []), focusable: !big});
      D.svg.style.maxWidth = `${L.width}px`;
      if (big) D.svg.classList.add("overview");
      const detail = ctx.el("div");
      detail.append(detailOf(null, ctx));
      const old = box.querySelector(".ax-graph-body");
      const bodyEl = ctx.el("div", "ax-graph-body");
      bodyEl.append(D.svg);
      if (big) {
        bodyEl.append(ctx.el("div", "ax-graph-hint", `${g.nodes.length} nodes: open it to read them`));
        D.svg.onclick = () => openOverlay(g, ctx, entry);
      } else {
        wire(D, g, L, ctx, (n) => detail.replaceChildren(detailOf(n, ctx)));
        bodyEl.append(detail);
      }
      if (old) old.replaceWith(bodyEl); else box.append(bodyEl);
      if (entry && entry.at) stamp.textContent = `updated ${hhmm(entry.at)}`;
    };
    if (entry) entry.redraw = (changed) => draw(changed);
    head.append(ctx.el("span", "ax-graph-title", value.title || "Graph"), stamp);
    const open = ctx.el("button", "ax-graph-btn ax-graph-open");
    open.type = "button";
    open.title = "Open the graph: zoom, pan, select";
    open.append(ctx.el("span", null, "Open"));
    open.onclick = () => openOverlay(entry ? entry.value : value, ctx, entry);
    head.append(open);
    box.append(head);
    draw();
    return box;
  }

  /* an update fence: the earlier graph changes in place; here, a quiet line says what changed */
  function renderUpdate(kind, value, ctx) {
    const body = kind === "graph" ? value.update : value.append;
    const r = G.update(kind, value.id, body);
    const line = ctx.el("div", "ax-graph-note");
    line.append(ctx.icon(r ? "refresh" : "info"));
    if (!r) {
      line.append(ctx.el("span", null, `No ${kind} “${value.id}” earlier in this conversation to update`));
      return line;
    }
    const what = kind === "graph"
      ? Object.entries(body).map(([id, v]) => `${id} → ${typeof v === "object" ? v.state || "changed" : v}`).join(", ")
      : body.map((s) => `${s.points.length} point${s.points.length === 1 ? "" : "s"} to ${s.name}`).join(", ");
    line.append(ctx.el("span", null, `Updated ${kind} “${r.entry.value.title || value.id}”: ${what}`));
    return line;
  }

  B.register("ox-graph", {
    validate: (body) => G.validate(body),
    render: (v, ctx) => (v.update ? renderUpdate("graph", v, ctx) : renderGraph(v, ctx)),
    partial: (body, ctx) => B.placeholder("ox-graph", ctx, /"update"\s*:/.test(body) ? 0 : 120),
  });

  /* ── ox-chart ─────────────────────────────────────────────────────── */
  const CW = 360;
  const fmtN = (v, unit) => {
    const a = Math.abs(v);
    const s = a >= 1e6 ? (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M" : a >= 1e4 ? (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "k"
      : Number.isInteger(v) ? String(v) : v.toFixed(a < 1 ? 2 : 1);
    return unit ? `${s} ${unit}` : s;
  };
  // a bar with its data end rounded (4px) and its baseline end square
  const barPath = (x, y0, w, y1, r) => {
    const h = y0 - y1;
    if (h <= 0) return "";
    r = Math.min(r, w / 2, h);
    return `M${x} ${y0} V${y1 + r} Q${x} ${y1} ${x + r} ${y1} H${x + w - r} Q${x + w} ${y1} ${x + w} ${y1 + r} V${y0} Z`;
  };

  function drawChart(c) {
    const spark = c.type === "spark";
    const H = spark ? 36 : 150;
    const padL = spark ? 2 : 40, padR = spark ? 40 : 8, padT = 8, padB = spark ? 4 : 20;
    const svg = S("svg", {viewBox: `0 0 ${CW} ${H}`, class: "ax-chart-svg" + (spark ? " spark" : ""), role: "img",
      "aria-label": c.title || `${c.type} chart`});
    const xs = [];
    for (const s of c.series) for (const [x] of s.points) if (!xs.some((v) => v === x)) xs.push(x);
    const numericX = xs.every((x) => typeof x === "number") && (c.type === "line" || spark);
    if (numericX) xs.sort((a, b) => a - b);
    const ys = c.series.flatMap((s) => s.points.map((p) => p[1]));
    let lo = Math.min(0, ...ys), hi = Math.max(...ys);
    if (c.type === "stack") {
      hi = Math.max(...xs.map((x) => c.series.reduce((a, s) => a + Math.max(0, (s.points.find((p) => p[0] === x) || [0, 0])[1]), 0)));
      lo = 0;
    }
    if ((c.type === "line" || spark) && Math.min(...ys) > 0 && Math.min(...ys) > hi * 0.5) lo = Math.min(...ys);
    const T = spark ? [lo, hi] : G.ticks(lo, hi);
    const y0 = T[0], y1 = T[T.length - 1] === y0 ? y0 + 1 : T[T.length - 1];
    const Y = (v) => padT + (H - padT - padB) * (1 - (v - y0) / (y1 - y0));
    const plotW = CW - padL - padR;
    if (!spark) {
      for (const t of T) {
        svg.append(S("line", {x1: padL, x2: CW - padR, y1: Y(t), y2: Y(t), class: "ax-ch-grid" + (t === 0 ? " zero" : "")}));
        svg.append(S("text", {x: padL - 6, y: Y(t) + 3.5, class: "ax-ch-tick", "text-anchor": "end"}, fmtN(t, "")));
      }
    }
    const color = (i) => `var(--ch-${i + 1})`;
    const title = (s, p) => `${c.series.length > 1 ? s.name + " · " : ""}${p[0]}: ${fmtN(p[1], c.unit)}`;
    if (c.type === "bar" || c.type === "stack") {
      const slot = plotW / xs.length;
      const inner = Math.min(slot * 0.72, 48 * (c.type === "stack" ? 1 : c.series.length));
      xs.forEach((x, i) => {
        const left = padL + slot * i + (slot - inner) / 2;
        if (c.type === "bar") {
          const bw = (inner - 2 * (c.series.length - 1)) / c.series.length;
          c.series.forEach((s, si) => {
            const p = s.points.find((q) => q[0] === x);
            if (!p) return;
            const bx = left + si * (bw + 2);
            const path = p[1] >= 0 ? barPath(bx, Y(0), bw, Y(p[1]), 4) : "";
            const m = S("path", {d: path || `M${bx} ${Y(0)} h${bw} v1 h-${bw} z`, fill: color(si), class: "ax-ch-mark"});
            m.append(S("title", null, title(s, p)));
            svg.append(m);
          });
        } else {
          let acc = 0;
          const segs = c.series.map((s, si) => [s, si, s.points.find((q) => q[0] === x)]).filter(([, , p]) => p && p[1] > 0);
          segs.forEach(([s, si, p], k) => {
            const top = k === segs.length - 1;
            const yA = Y(acc), yB = Y(acc + p[1]);
            acc += p[1];
            const gap = k ? 2 : 0;
            const d = top ? barPath(left, yA - gap, inner, yB, 4) : `M${left} ${yA - gap} V${yB} H${left + inner} V${yA - gap} Z`;
            const m = S("path", {d, fill: color(si), class: "ax-ch-mark"});
            m.append(S("title", null, title(s, p)));
            svg.append(m);
          });
        }
        if (xs.length <= 12 || i % Math.ceil(xs.length / 8) === 0) {
          svg.append(S("text", {x: padL + slot * i + slot / 2, y: H - 6, class: "ax-ch-tick", "text-anchor": "middle"}, String(x)));
        }
      });
    } else {
      const X = numericX
        ? (x) => padL + (xs.length > 1 ? (x - xs[0]) / (xs[xs.length - 1] - xs[0] || 1) : 0.5) * plotW
        : (x) => padL + (xs.length > 1 ? xs.indexOf(x) / (xs.length - 1) : 0.5) * plotW;
      c.series.forEach((s, si) => {
        const pts = s.points.slice().sort((a, b) => (numericX ? a[0] - b[0] : xs.indexOf(a[0]) - xs.indexOf(b[0])));
        svg.append(S("polyline", {points: pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" "), stroke: color(si),
          class: "ax-ch-line"}));
        if (!spark && pts.length <= 24) {
          for (const p of pts) {
            const m = S("circle", {cx: X(p[0]), cy: Y(p[1]), r: 3.5, fill: color(si), class: "ax-ch-dot"});
            m.append(S("title", null, title(s, p)));
            svg.append(m);
          }
        }
        if (spark) {
          const last = pts[pts.length - 1];
          svg.append(S("circle", {cx: X(last[0]), cy: Y(last[1]), r: 3, fill: color(si)}));
          svg.append(S("text", {x: CW - padR + 6, y: Y(last[1]) + 4, class: "ax-ch-val"}, fmtN(last[1], c.unit)));
          const hit = S("rect", {x: 0, y: 0, width: CW, height: H, fill: "transparent"});
          hit.append(S("title", null, pts.map((p) => title(s, p)).join("\n")));
          svg.append(hit);
        }
      });
      if (!spark) {
        const every = Math.ceil(xs.length / 6);
        xs.forEach((x, i) => {
          if (i % every && i !== xs.length - 1) return;
          svg.append(S("text", {x: X(x), y: H - 6, class: "ax-ch-tick", "text-anchor": i === 0 ? "start" : i === xs.length - 1 ? "end" : "middle"},
            String(x)));
        });
      }
    }
    return svg;
  }

  function renderChart(value, ctx) {
    const box = ctx.el("figure", "ax-chart");
    const entry = G.remember("chart", value, null);
    const head = ctx.el("figcaption", "ax-graph-head");
    const stamp = ctx.el("span", "ax-graph-upd");
    const name = value.title || (value.series.length === 1 ? value.series[0].name : "");
    head.append(ctx.el("span", "ax-graph-title", name), value.unit ? ctx.el("span", "ax-chart-unit", value.unit) : "", stamp);
    box.append(head);
    const draw = () => {
      const c = entry ? entry.value : value;
      const old = box.querySelector(".ax-chart-body");
      const body = ctx.el("div", "ax-chart-body");
      body.append(drawChart(c));
      if (c.series.length > 1) {
        const leg = ctx.el("div", "ax-chart-legend");
        c.series.forEach((s, i) => {
          const it = ctx.el("span", "ax-chart-key");
          const sw = ctx.el("i", "ax-chart-sw");
          sw.style.background = `var(--ch-${i + 1})`;
          it.append(sw, ctx.el("span", null, s.name));
          leg.append(it);
        });
        body.append(leg);
      }
      if (c.note) body.append(ctx.el("div", "ax-chart-note", c.note));
      if (old) old.replaceWith(body); else box.append(body);
      if (entry && entry.at) stamp.textContent = `updated ${hhmm(entry.at)}`;
    };
    if (entry) entry.redraw = draw;
    draw();
    return box;
  }

  B.register("ox-chart", {
    validate: (body) => G.validateChart(body),
    render: (v, ctx) => (v.append ? renderUpdate("chart", v, ctx) : renderChart(v, ctx)),
    partial: (body, ctx) => B.placeholder("ox-chart", ctx, /"append"\s*:/.test(body) ? 0 : 100),
  });
})();
