/* operonx studio — the canvas: the Workflow and Data Flow views, cards,
 * wires, loops, the agent cell, pan and zoom. Split from studio.js, same
 * bundle, same order (docs/STUDIO_EXPERIENCE_PLAN.md P1). */

/* ── two views of one graph: Workflow and Data Flow ─────────────────
 * Workflow is the control flow (graph.edges): what runs before what.
 * Data Flow is lineage (the inputs' bindings): what each op reads and
 * feeds. The two are never shown at full strength together. In Workflow
 * a selected node reveals only its own bindings (a tray beside it, tags
 * on its partners); in Data Flow every card lists its bound ports and one
 * connector joins each pair of nodes that pass data, while the control
 * edges fade. A port click shows that port's lineage in either view.
 * Model: static/dataflow.js. Plan: docs/WORKFLOW_DATAFLOW_VIEWS_PLAN.md */
let canvasView = recall(`canvasView:${PID}`, "workflow") === "data" ? "data" : "workflow";
let dfPort = null;   // {key, port, dir}: the port whose lineage is shown
let dfPlatePin = null;    // {key, port, dir}: a selected GraphOp's plate, clicked
/* A variable's pill singles out its wires: every drawn wire registers
 * with the pills at its two ends, and pointing at a pill lights just its
 * wires and fades the rest — classes only, no redraw, so the sparks keep
 * running. A clicked plate holds it (dfRowPinned). */
let dfRowWires = new Map(), dfRowPinned = null;
function dfRowHot(row, on) {
  if (!on && row === dfRowPinned) return;
  const held = dfRowPinned && dfRowPinned !== row ? dfRowPinned : null;
  // another pill takes the light from the held one while it is pointed at
  if (on && held) { for (const f of dfRowWires.get(held) || []) f(false); held.classList.remove("hot"); }
  for (const f of dfRowWires.get(row) || []) f(on);
  row.classList.toggle("hot", on);
  $("#world").classList.toggle("dftpick", on);
  if (!on && held) dfRowHot(held, true);
}

function setCanvasView(v) {
  if (v === canvasView) return;
  canvasView = v;
  dfPort = null;
  store(`canvasView:${PID}`, v);
  showViewSeg();
  render();
}
function showViewSeg() {
  for (const b of document.querySelectorAll(".viewseg button")) {
    const on = b.dataset.view === canvasView;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}

// a binding's source, in words: "rank.top", "START.question", "scratch.clock"
function dfSourceLabel(b) {
  if (b.from.kind === "scratch") return `scratch.${b.from.port}`;
  if (b.from.kind === "input") {
    if (!b.from.key) return `START.${b.from.port}`;
    const c = state.rendered.get(b.from.key);
    return `${c ? c.node.name : "graph"}.${b.from.port}`;
  }
  const s = state.rendered.get(b.from.key);
  return `${s ? s.node.name : b.from.key}.${b.from.port}`;
}
const dfTargetLabel = (b) => {
  if (b.to.end) return `END.${b.to.port}`;
  const t = state.rendered.get(b.to.key);
  return `${t ? t.node.name : b.to.key}.${b.to.port}`;
};

/* An open op's PLUG PLATES: every variable is a plug hole. Inputs sit on
 * the left zone of the op (its input plate), outputs on the right zone
 * (its output plate), each hole level with its variable's name. A wire
 * plugs straight into a hole. A variable fed from the mains — a graph
 * input (▶) or the run's SCRATCH (✎) — has its hole lit with that glyph
 * and no wire. */
function dfPortsBlock(it, only) {
  const nb0 = DataFlow.nodeBindings(state.dfB || [], it.key);
  // a partner opened for the selected op lists only what they share
  const keep = (b) => !only || only.has(b.id);
  const nb = {ins: nb0.ins.filter(keep), outs: nb0.outs.filter(keep), exports: nb0.exports};
  const ins = [...new Map(nb.ins.map(b => [b.to.port, b])).values()];
  const outs = [...new Set(nb.outs.map(b => b.from.port))];
  if (!ins.length && !outs.length) return null;
  const box = el("div", "dfports");
  const cin = el("div", "dfcol in"), cout = el("div", "dfcol out");
  const row = (dir, port, mains, tip) => {
    const r = el("button", `dfport ${dir}`);
    r.type = "button";
    r.dataset.port = port;
    r.dataset.dir = dir;
    const hole = el("span", "dfhole" + (mains ? ` mains ${mains}` : ""), mains === "start" ? "▶" : mains === "scratch" ? "✎" : "");
    r.append(hole, el("span", "dfname mono", port));
    r.title = tip;
    // pointing at a variable singles out its wires
    r.onmouseenter = () => dfRowHot(r, true);
    r.onmouseleave = () => dfRowHot(r, false);
    r.onclick = (ev) => {
      ev.stopPropagation();
      dfPort = dfPort && dfPort.key === it.key && dfPort.port === port && dfPort.dir === dir ? null : {key: it.key, port, dir};
      drawDataLayer();
    };
    return r;
  };
  for (const b of ins) {
    const mains = DataFlow.isBroadcast(b) ? (b.from.kind === "scratch" ? "scratch" : "start") : null;
    cin.append(row("in", b.to.port, mains, `${b.to.port} ← ${dfSourceLabel(b)}`));
  }
  for (const port of outs) {
    const readers = nb.outs.filter(b => b.from.port === port).map(dfTargetLabel);
    cout.append(row("out", port, null, `${port} → ${readers.join(", ")}`));
  }
  box.append(cin, cout);
  return box;
}

/* A wire's energy: ONE electric spark racing source -> reader, about
 * 8x the control dots' speed. A single dashed copy of the wire: a few
 * short crackle dashes growing into a bright head at the front, sliding
 * along with CSS and flickering. One element per wire. */
// a stack's copies wear their card's own skin — a real card behind it, not
// a tint. A copy, not a class, so they follow the theme by being re-read
// when it changes (a page drawn dark and switched to light kept dark copies)
function skinStacks() {
  for (const g of document.querySelectorAll("#stacks .genghost")) {
    const cs = getComputedStyle(g.card);
    g.style.borderRadius = cs.borderRadius;
    g.style.background = cs.background;
    g.style.borderColor = cs.borderTopColor;
  }
}
document.addEventListener("oxtheme", () => requestAnimationFrame(skinStacks));

const DF_SPEED = 560;   // px per second
// the spark, back to front: crackle, crackle, crackle, head (dash, gap)…
const DF_SPARK = [1, 3.5, 1.6, 3, 2.4, 2.4, 6];
const DF_SPARK_LEN = DF_SPARK.reduce((p, q) => p + q, 0);
function dfComet(wire, d, cls) {
  const q = document.createElementNS(SVGNS, "path");
  q.setAttribute("d", d);
  q.setAttribute("class", `dfflow spark ${cls}`.trim());
  wire.after(q);
  let len = 0;
  try { len = q.getTotalLength(); } catch { len = 0; }
  if (len < 30) { q.remove(); return []; }
  q.style.strokeDasharray = `${DF_SPARK.join(" ")} ${len + 40}`;
  q.style.setProperty("--a", DF_SPARK_LEN);
  q.style.setProperty("--b", -len);
  q.style.animationDuration = `${Math.max(.2, len / DF_SPEED).toFixed(2)}s, .16s`;
  q.style.animationDelay = `${(-Math.random() * .8).toFixed(2)}s, ${(-Math.random() * .16).toFixed(2)}s`;
  return [q];
}

/* A data wire is SILK: a faint hairline between two holes; the spark
 * running along it says where the data goes. */

/* The data layer, drawn after the cards are placed. Every wire runs from
 * an output hole to an input hole: out of a right-hand plate, into a
 * left-hand one. Cheap: it reads positions, never moves a card. */
function drawDataLayer() {
  const svg = $("#dflinks"), over = $("#dfover");
  if (!svg || !over) return;
  svg.textContent = ""; over.textContent = "";
  const world = $("#world");
  const B = state.dfB || [];
  const R = (k) => state.rendered.get(k);
  // a clicked terminal (START, SCRATCH, END) lights everything it touches
  const termIds = state.dfTerm ? B.filter(b => state.dfTerm === "start" ? (b.from.kind === "input" && !b.from.key)
    : state.dfTerm === "scratch" ? b.from.kind === "scratch" : !!b.to.end).map(b => b.id) : null;
  const lv = dfPort ? DataFlow.lineage(B, dfPort) : termIds ? new Map(termIds.map(id => [id, 1])) : null;
  world.classList.toggle("dfsel", !!lv);
  // a redraw replaces the wire under the pointer, whose leave never fires:
  // its hover state and label go with it
  world.classList.remove("dfwirehot");
  { const t = document.getElementById("dfwirelabel"); if (t) t.hidden = true; }
  dfRowWires = new Map(); dfRowPinned = null;
  world.classList.remove("dfpin", "dfpeek", "dftpick");
  for (const c of state.cardEls.values()) c.classList.remove("dfpeer");
  for (const r of document.querySelectorAll(".dfport.lit, .dfport.lit2, .dfport.picked, .dfport.remote")) r.classList.remove("lit", "lit2", "picked", "remote");
  // wires ride above the cards: they end in holes on the plates
  const wsvg = document.createElementNS(SVGNS, "svg");
  wsvg.setAttribute("class", "wires dflinks dfwires");
  over.append(wsvg);
  /* A wire is ROUTED like a circuit trace and never crosses a card:
   *   out of its hole → a free column beside the source → the clear channel
   *   under the source's row → a free column down (or up) to the channel
   *   above the reader's row → the reader's own gutter → into the hole.
   * Every vertical and horizontal run is checked against every card, and
   * against the runs already laid, so no two wires share a track. */
  const obst = [...state.rendered.values()]
    .filter(it2 => !it2.inner && it2.kind !== "knob" && state.cardEls.get(it2.key))
    .map(it2 => { const c = state.cardEls.get(it2.key);
      // a serve door (INGRESS / EGRESS) is its dashed frame, not just its card
      const door = it2.node && (it2.node.serve_role === "ingress" || it2.node.serve_role === "egress") && !it2.key.includes("/");
      if (door) return {key: it2.key, l: it2.x - 12 - 10, t: it2.y - 26 - 10,
        r: it2.x + Math.max(it2.w, c.offsetWidth) + 12 + 10, b: it2.y + Math.max(it2.h, c.offsetHeight) + 12 + 10};
      return {key: it2.key, l: it2.x - 16, t: it2.y - 16, r: it2.x + c.offsetWidth + 16, b: it2.y + c.offsetHeight + 16}; });
  const usedV = [], usedH = [];
  // a run keeps 7px from every run of another wire; only the wires of one
  // source share anything, and only the line from the source to its hub
  let grp = null, relaxed = false;
  /* A data run never lies ALONG a control edge (a branch card's sides
   * carry its branch edges): it keeps 8px off one, or crosses it square.
   * Cells mark where control edges run steeply and where flat. */
  // indexed by column (steep runs) and by row (flat runs): a check is a
  // binary search per nearby column/row, not a walk along the span
  let ctrlByCol = null, ctrlByRow = null;
  const CC = 6;
  const ctrlIndex = () => {
    if (ctrlByCol) return;
    ctrlByCol = new Map(); ctrlByRow = new Map();
    const put = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const pl of ctrlPolys()) for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i];
      if (Math.abs(b.y - a.y) >= Math.abs(b.x - a.x)) put(ctrlByCol, Math.floor(b.x / CC), b.y);
      else put(ctrlByRow, Math.floor(b.y / CC), b.x);
    }
    for (const m of [ctrlByCol, ctrlByRow]) for (const v of m.values()) v.sort((p, q) => p - q);
  };
  const anyIn = (arr, lo, hi) => {
    let l = 0, h = arr.length;
    while (l < h) { const m = (l + h) >> 1; if (arr[m] < lo) l = m + 1; else h = m; }
    return l < arr.length && arr[l] <= hi;
  };
  const alongCtrl = (vertical, c, a0, a1) => {
    ctrlIndex();
    const m = vertical ? ctrlByCol : ctrlByRow;
    if (!m.size) return false;
    const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    for (let k = Math.floor((c - 8) / CC); k <= Math.floor((c + 8) / CC); k++) {
      const arr = m.get(k);
      if (arr && anyIn(arr, lo, hi)) return true;
    }
    return false;
  };
  const clearV = (x, y0, y1) => {
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    if (obst.some(o => x > o.l && x < o.r && hi > o.t && lo < o.b && !(o.ring && grp && (o.lane ? grp === o.ring : grp.startsWith(o.ring))))) return false;
    if (!relaxed && alongCtrl(true, x, lo, hi)) return false;
    // relaxed: a run may come close to another, but never lie on it
    const sep = relaxed ? 3.5 : 7;
    return !usedV.some(u => u.g !== grp && Math.abs(u.x - x) < sep && hi > u.lo - 4 && lo < u.hi + 4);
  };
  // (the stub out of a hole starts inside its own card: that card is skipped)
  const clearH = (y, x0, x1, own) => {
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    if (obst.some(o => !o.vonly && o.key !== own && y > o.t && y < o.b && hi > o.l && lo < o.r && !(o.ring && grp && grp.startsWith(o.ring)))) return false;
    if (!relaxed && alongCtrl(false, y, lo, hi)) return false;
    const sep = relaxed ? 3.5 : 7;
    return !usedH.some(u => u.g !== grp && Math.abs(u.y - y) < sep && hi > u.lo - 4 && lo < u.hi + 4);
  };
  let lastRoute = null;

  // a card's box, read once: every wire appended dirties the layout, and a
  // fresh offsetWidth after it would force a reflow per wire
  const boxCache = new Map();
  const boxOf = (pt) => {
    const it2 = pt && pt.key && !pt.plate && R(pt.key);
    if (!it2 || it2.inner) return {left: pt.x, right: pt.x, top: pt.y, bottom: pt.y};
    if (!boxCache.has(it2.key)) {
      const c = state.cardEls.get(it2.key);
      boxCache.set(it2.key, {left: it2.x, right: it2.x + (c ? c.offsetWidth : it2.w), top: it2.y, bottom: it2.y + (c ? c.offsetHeight : it2.h)});
    }
    return boxCache.get(it2.key);
  };
  // a free track if there is one; else one shared with another wire (a
  // shared track is better than a wire across a card); else the first try
  const twice = (find) => {
    let v = find();
    if (v !== null) return v;
    relaxed = true; v = find(); relaxed = false;
    return v;
  };
  const scan = (from, step, ok, n = 160) => {
    const v = twice(() => { for (let i = 0; i < n; i++) { const t = from + i * step; if (ok(t)) return t; } return null; });
    return v === null ? from : v;
  };
  const scan2 = (from, ok, step = 6, n = 160) => {
    const v = twice(() => { for (let i = 0; i < n; i++) for (const t of i ? [from - i * step, from + i * step] : [from]) if (ok(t)) return t; return null; });
    return v === null ? from : v;
  };
  /* ONE split point per variable. A variable read by one op is a plain
   * wire. A variable read by several runs as ONE line from its hole to its
   * HUB — a small ring placed among its readers — and splits there, once:
   * each reader gets a short spoke of its own that never meets its
   * siblings again. Variables never share a hub. Lanes are dealt before
   * anything is routed: a card side's lowest hole takes the innermost
   * lanes; arriving, the highest hole takes the innermost column. */
  const hubs = new Map();       // hole → {n, off, a, targets, hx, hy, cls}
  const branchOf = new Map();   // target hole → {g, k}
  const joinOf = new Map();     // target hole → {jg, k}: one of several sources into it
  const laneIn = new Map();
  const side2 = (pt, dir) => `${pt.key}|${dir}|${Math.round(pt.x)}`;
  const hubKey = (a) => `${a.own || a.key}|${Math.round(a.x)}|${Math.round(a.y)}`;
  let solo = 0;
  const prepLanes = (pairs) => {
    const groups = new Map(), ins = new Map();
    for (const [a, b] of pairs) {
      const g = hubKey(a);
      if (!groups.has(g)) groups.set(g, {g, a, side: side2(a, "o"), list: []});
      groups.get(g).list.push(b);
      const ki = side2(b, "i");
      if (!ins.has(ki)) ins.set(ki, new Set()); ins.get(ki).add(Math.round(b.y));
    }
    const bySide = new Map();
    for (const G of groups.values()) { if (!bySide.has(G.side)) bySide.set(G.side, []); bySide.get(G.side).push(G); }
    for (const list of bySide.values()) {
      list.sort((p, q) => q.a.y - p.a.y);
      list.forEach((G, off) => {
        G.list.forEach((b, k) => branchOf.set(b, {g: G.g, k}));
        hubs.set(G.g, {n: G.list.length, off, a: G.a, targets: G.list});
      });
    }
    for (const [k, ys] of ins) [...ys].sort((p, q) => p - q).forEach((y, i) => laneIn.set(`${k}|${y}`, i));
    // ONE join point per hole fed by several sources (alternative branches
    // into one export, say): each arrives on its own lane into a ring
    // beside the hole, and one short line goes in
    const into = new Map();
    for (const [a, b] of pairs) {
      const Bi = branchOf.get(b);
      if (Bi && hubs.get(Bi.g) && hubs.get(Bi.g).n > 1) continue;   // a spoke already
      const jk = `join|${b.own || b.key}|${Math.round(b.x)}|${Math.round(b.y)}`;
      if (!into.has(jk)) into.set(jk, []);
      into.get(jk).push([a, b]);
    }
    for (const [jk, list] of into) {
      if (list.length < 2) continue;
      list.sort((p, q) => p[0].x - q[0].x);
      // (a plate's hole is one shared object: key by the pair, not the hole)
      list.forEach(([a, b], k) => { if (!joinOf.has(b)) joinOf.set(b, new Map()); joinOf.get(b).set(a, {jg: jk, k}); });
      hubs.set(jk, {n: list.length, join: true, b: list[0][1], shift: 0});
    }
    // rings down one side of a card (an op's stacked outputs) step left,
    // each lower one past the one above: their arrival lanes drop past the
    // rings above them, so no two rings may share a lane's column
    const stack = new Map();
    for (const [jk, J] of hubs) if (J.join) {
      const sk = J.b.key;
      if (!stack.has(sk)) stack.set(sk, []);
      stack.get(sk).push(J);
    }
    for (const list of stack.values()) {
      list.sort((p, q) => p.b.y - q.b.y);
      // one base column for the lot (plates differ in width)
      const x0 = Math.min(...list.map(J => Math.min(J.b.x, boxOf(J.b).left)));
      let at = 0;
      for (const J of list) { J.x0 = x0; J.shift = at; at += LANE * J.n + 14; }
    }
    /* Every ring stands before anything is routed. A lone ring stands
     * beside its hole. The rings of one op's stacked outputs stand in ONE
     * row, at or above the top one, stepping left: each runs a trunk down
     * its own column and along its hole's row, so no trunk meets another,
     * and every lane arrives above every ring. Each needs a row per lane
     * above it, clear of every card and control edge; the lanes' last
     * drop is fenced: only the ring's own sources come there. */
    const hits = (l, t, r, bt, own) => obst.some(o => o.key !== own && r > o.l && l < o.r && bt > o.t && t < o.b);
    const half = (J) => LANE * (J.n - 1) / 2;
    // (lanes: how many arrive over this ring's row, each needing a row of its own)
    const room = (J, x, y, lanes = J.n) => {
      const h = half(J), b = J.b;
      if (x + h + 8 > b.x) return false;   // the ring stays on the hole's entry side
      // (a card's wires need the columns beside it: the lanes keep clear of them)
      if (hits(x - h - 24, y - SPOKE - 26 - 8 * lanes, x + h + 24, y + 8, b.own)) return false;
      if (y !== b.y && hits(x - 3, Math.min(y, b.y), x + 3, Math.max(y, b.y), b.own)) return false;
      if (hits(x, b.y - 3, b.x - 4, b.y + 3, b.own)) return false;
      return !onCtrl(x, y);
    };
    for (const list of stack.values()) {
      const at = (dx, dy) => {   // the row's spots, top output first
        let x = list[0].x0 - 30 + dx;
        // neighbours a lane's gap and a fence apart
        return list.map(J => { const h = half(J), p = [x - h, list[0].b.y + dy]; x -= 2 * h + 13; return p; });
      };
      const nAll = list.reduce((t, J) => t + J.n, 0);
      let best = null;
      for (let r = 0; r <= 60 && !best; r++) for (let i = 0; i <= r && !best; i++) {
        const dy = -6 * i, dxs = [-6 * (r - i), 6 * (r - i)];
        for (const dx of dxs) { const spots = at(dx, dy); if (spots.every(([x, y], k) => room(list[k], x, y, nAll))) { best = spots; break; } }
      }
      list.forEach((J, k) => { [J.hx, J.hy] = best ? best[k] : [J.x0 - 30 - half(J) - J.shift, J.b.y]; J.above = best ? nAll : J.n; });
    }
    for (const [jk, J] of hubs) if (J.join) {
      const b = J.b;
      J.trunk = J.hy === b.y ? `M ${J.hx} ${J.hy} L ${b.x} ${b.y}`
        : `M ${J.hx} ${J.hy}` + rounded(clean([[J.hx, J.hy], [J.hx, b.y], [b.x, b.y]]));
      grp = `${jk}#trunk`;
      keep(clean([[J.hx, J.hy], [J.hx, b.y], [b.x, b.y]]));
      const h = half(J);
      obst.push({key: `hub:${jk}`, ring: `${jk}#`, l: J.hx - h - 5, t: J.hy - SPOKE - 20, r: J.hx + h + 5, b: J.hy + 6});
      // and each lane's column, up through the rows the lanes arrive on:
      // another wire (a sibling lane too) may cross it, never run down it
      for (let k = 0; k < J.n; k++) {
        const lx = J.hx + LANE * (k - (J.n - 1) / 2);
        obst.push({key: `lane:${jk}#${k}`, ring: `${jk}#${k}`, lane: true, vonly: true, l: lx - 3.5, t: J.hy - SPOKE - 26 - 8 * (J.above || J.n), r: lx + 3.5, b: J.hy - SPOKE});
      }
    }
  };
  // a join's lanes are laid before anything else: crowded among other
  // wires' columns, its sources found no lane of their own and shared one
  const joinFirst = (list) => list.sort((p, q) => (joinOf.get(q[1])?.has(q[0]) ? 1 : 0) - (joinOf.get(p[1])?.has(p[0]) ? 1 : 0));
  /* Where a data run crosses a control edge it HOPS: a small arc over it,
   * the wiring-diagram sign for "these cross, they do not join". The
   * control edges are sampled once per draw, as polylines. */
  let ctrlLines = null;
  function ctrlPolys() {
    if (ctrlLines) return ctrlLines;
    ctrlLines = [];
    const seen = new Set();
    for (const p of document.querySelectorAll("#edges path, #edgetop path")) {
      const d = p.getAttribute("d");
      if (!d || seen.has(d)) continue;
      seen.add(d);
      const smp = pathSampler(d);
      if (!smp || smp.len < 10) continue;
      const pl = [];
      for (let t = 0; t <= smp.len; t += 4) pl.push(smp.at(t));
      pl.push(smp.at(smp.len));
      ctrlLines.push(pl);
    }
    return ctrlLines;
  }
  const HOP = 5;
  // a horizontal stretch at y from x0 to x1: where it crosses control edges
  // control segments bucketed by height, so a stretch looks at its own band
  let segBands = null;
  const BAND = 32;
  const bandsOf = () => {
    if (segBands) return segBands;
    segBands = new Map();
    for (const pl of ctrlPolys()) for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i];
      for (let k = Math.floor(Math.min(a.y, b.y) / BAND); k <= Math.floor(Math.max(a.y, b.y) / BAND); k++) {
        if (!segBands.has(k)) segBands.set(k, []);
        segBands.get(k).push([a, b]);
      }
    }
    return segBands;
  };
  const hopsOn = (y, x0, x1) => {
    const lo = Math.min(x0, x1) + HOP + 3, hi = Math.max(x0, x1) - HOP - 3, xs = [];
    if (hi <= lo) return xs;
    for (const [a, b] of bandsOf().get(Math.floor(y / BAND)) || []) {
      if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue;
      const x = a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);
      // a steep crossing only: a control edge running along is not a hop
      if (x > lo && x < hi && Math.abs(b.y - a.y) > Math.abs(b.x - a.x) * .5) xs.push(x);
    }
    xs.sort((p, q) => p - q);
    return xs.filter((x, i) => i === 0 || x - xs[i - 1] > 2 * HOP + 2);
  };
  const lineTo = (fx, fy, tx, ty) => {
    if (fy !== ty || fx === tx) return ` L ${tx} ${ty}`;
    const dir = tx > fx ? 1 : -1;
    let d = "";
    for (const x of (dir > 0 ? hopsOn(fy, fx, tx) : hopsOn(fy, tx, fx).reverse()))
      d += ` L ${x - dir * HOP} ${fy} A ${HOP} ${HOP} 0 0 ${dir > 0 ? 1 : 0} ${x + dir * HOP} ${fy}`;
    return d + ` L ${tx} ${ty}`;
  };
  // a polyline with rounded corners, from its first point on
  const rounded = (pts) => {
    const r = 7, sx = (u, v) => (v > u ? 1 : -1);
    let d = "", [fx, fy] = pts[0];
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
      const r1 = Math.min(r, Math.abs(cx - px) / 2 + Math.abs(cy - py) / 2, Math.abs(nx - cx) / 2 + Math.abs(ny - cy) / 2);
      const inx = cx - (cx !== px ? sx(px, cx) * r1 : 0), iny = cy - (cy !== py ? sx(py, cy) * r1 : 0);
      const outx = cx + (nx !== cx ? sx(cx, nx) * r1 : 0), outy = cy + (ny !== cy ? sx(cy, ny) * r1 : 0);
      d += lineTo(fx, fy, inx, iny) + ` Q ${cx} ${cy} ${outx} ${outy}`;
      [fx, fy] = [outx, outy];
    }
    const [lx, ly] = pts[pts.length - 1];
    return d + lineTo(fx, fy, lx, ly);
  };
  const clean = (pts) => {
    // a sub-pixel step is no step: two columns 0.2px apart made the corner
    // rounding draw a long slanted line. Snap it (the ends never move)
    pts = pts.map(q => [...q]);
    for (let i = 1; i < pts.length; i++) for (const c of [0, 1]) {
      const d = pts[i][c] - pts[i - 1][c];
      if (d !== 0 && Math.abs(d) < 1) { if (i < pts.length - 1) pts[i][c] = pts[i - 1][c]; else if (i > 1) pts[i - 1][c] = pts[i][c]; }
    }
    pts = pts.filter((q, i) => i === 0 || Math.abs(q[0] - pts[i - 1][0]) + Math.abs(q[1] - pts[i - 1][1]) > 0.5);
    return pts.filter((q, i) => i === 0 || i === pts.length - 1
      || !((q[0] === pts[i - 1][0] && q[0] === pts[i + 1][0]) || (q[1] === pts[i - 1][1] && q[1] === pts[i + 1][1])));
  };
  const keep = (pts) => {
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i];
      if (px === cx) usedV.push({x: cx, lo: Math.min(py, cy), hi: Math.max(py, cy), g: grp});
      else usedH.push({y: cy, lo: Math.min(px, cx), hi: Math.max(px, cx), g: grp});
    }
    return pts;
  };
  const ownOf = (h) => h.own || (h.plate ? null : h.key);
  /* Where a wire comes in. A plug row is entered from the card's left. A
   * branch condition's chip is entered from the side its row's branch
   * edge does NOT leave by: from the right, the wire runs in through the
   * gap above its row and drops into the chip's hole. */
  const entryX = (b) => b.entry === "right" ? Math.max(b.x, boxOf(b).right) + 20 : Math.min(b.x, boxOf(b).left) - 20;
  const viaGap = (b) => b.entry === "right" || b.entry === "over";
  const by = (b) => viaGap(b) ? b.gapY : b.y;
  const tailOf = (b, x2) => viaGap(b) ? [[x2, b.gapY], [b.x, b.gapY], [b.x, b.y]] : [[x2, b.y], [b.x, b.y]];
  // the reader's own gutter: the column it is plugged in from
  const gutter = (b) => {
    if (b.fromTop) return {yB0: b.y - 26, x2: b.x};
    const Bx = boxOf(b), yB0 = Bx.top - 22;
    const li = laneIn.get(`${side2(b, "i")}|${Math.round(b.y)}`) || 0;
    const dir = b.entry === "right" ? 1 : -1;
    return {yB0, x2: scan(entryX(b) + dir * 8 * li, dir * 4, x => clearV(x, yB0, by(b)) && clearH(by(b), x, b.x, ownOf(b)))};
  };
  /* A circuit trace from a to b that never crosses a card: out of a's hole
   * → a free column beside it → the clear channel under it → a free column
   * down (or up) → the channel above b's row → b's gutter → into the hole.
   * `col` starts the trace already in its column (a spoke out of a hub). */
  let orthoBad = false;
  const ortho = (a, b, col, depth = 0) => {
    const A = boxOf(a);
    const {yB0, x2} = gutter(b);
    const yA0 = (col != null ? a.y + 8 : A.bottom + 22) + LANE * depth;
    let xc = scan2(x2, x => clearV(x, yA0, yB0));
    const chan = (x, y) => clearH(y, x, xc) && clearV(x, a.y, y) && clearV(xc, y, yB0);
    // a column beside the source that reaches a free channel all the way
    // down — not just one clear for its first few px, which would then share
    // a run lower down with a wire already there
    let x1 = col, ymA = null;
    if (col == null) {
      const x0 = Math.max(a.x, A.right) + 20;
      for (let i = 0; i < 60 && ymA === null; i++) {
        const x = x0 + 4 * i;
        if (!(clearV(x, a.y, yA0) && clearH(a.y, a.x, x, ownOf(a)))) continue;
        for (let j = 0; j < 200; j++) if (chan(x, yA0 + 4 * j)) { x1 = x; ymA = yA0 + 4 * j; break; }
      }
      if (ymA === null) x1 = scan(x0, 4, x => clearV(x, a.y, yA0) && clearH(a.y, a.x, x, ownOf(a)));
    }
    if (ymA === null) ymA = scan(yA0, 4, y => chan(x1, y), 200);
    const okB = (y) => clearH(y, xc, x2) && clearV(x2, y, by(b));
    const ymB = scan(yB0, -4, okB, 200);
    // a column moved here stretches both channels to it: they must still
    // run clear (checked while the column stood elsewhere, a stretched one
    // lay on another wire's run)
    if (!clearV(xc, ymA, ymB)) xc = scan2(xc, x => clearV(x, ymA, ymB) && clearH(ymA, x1, x) && clearH(ymB, x, x2));
    // no row of its own, even a close one: the trace would lie on another
    relaxed = true; orthoBad = !(okB(ymB) && clearH(ymA, x1, xc) && clearV(xc, ymA, ymB)); relaxed = false;
    return keep(clean([[a.x, a.y], [x1, a.y], [x1, ymA], [xc, ymA], [xc, ymB], [x2, ymB], ...tailOf(b, x2)]));
  };
  /* A reader straight ahead — its hole right of the source's, nothing
   * between — takes ONE jog: across, down (or up) a free column, across
   * into the hole. Columns are taken left to right, and wires are laid
   * from the lowest source up, so a jog never crosses its neighbours'. */
  const zig = (a, b) => {
    if (viaGap(b) || b.fromTop) return null;
    const lim = Math.min(b.x, boxOf(b).left) - 6;
    // a free column, else one close beside another (still apart)
    const x = twice(() => {
      for (let x = a.x + 10; x <= lim; x += 2)
        if (clearH(a.y, a.x, x, ownOf(a)) && clearV(x, a.y, b.y) && clearH(b.y, x, b.x, ownOf(b))) return x;
      return null;
    });
    return x === null ? null : keep(clean([[a.x, a.y], [x, a.y], [x, b.y], [b.x, b.y]]));
  };
  const SPOKE = 16;   // how far a spoke curves out of its hub before it runs straight
  const LANE = 9;     // the gap between two spokes of one fan
  const median = (v) => { const s = [...v].sort((p, q) => p - q); return s[Math.floor((s.length - 1) / 2)]; };
  /* A hub stands where its readers begin: in the channel above the first
   * of them (so no spoke climbs back past the line that brought it),
   * across from the middle of them, nudged to the nearest spot clear of
   * every card and every other hub. The line arrives from above; the
   * spokes leave left, right and down:
   *   - left: one lane each, the farthest reader on the top lane, so a lane
   *     that turns off early never crosses one that runs on;
   *   - right: the same, mirrored;
   *   - down: side by side, in reader order. */
  // where the control edges run: a hub never sits on one
  let ctrlCells = null;
  const onCtrl = (x, y) => {
    if (!ctrlCells) {
      ctrlCells = new Set();
      // parsed, not measured: getPointAtLength on every edge cost seconds
      const seen = new Set();
      for (const p of document.querySelectorAll("#edges path, #edgetop path")) {
        const d = p.getAttribute("d");
        if (!d || seen.has(d)) continue;
        seen.add(d);
        const smp = pathSampler(d);
        if (!smp) continue;
        for (let t = 0; t <= smp.len; t += 6) { const q = smp.at(t); ctrlCells.add(`${Math.floor(q.x / 12)},${Math.floor(q.y / 12)}`); }
      }
    }
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (ctrlCells.has(`${Math.floor(x / 12) + i},${Math.floor(y / 12) + j}`)) return true;
    return false;
  };
  const placeHub = (H, g) => {
    const a = H.a, A = boxOf(a);
    const xs = H.targets.map(entryX), ys = H.targets.map(b => boxOf(b).top - 22);
    const x0 = median([Math.max(a.x, A.right) + 20, ...xs]);
    const below = ys.filter(y => y >= A.bottom + 22);
    const y0 = below.length ? Math.min(...below) : A.bottom + 22;
    const side0 = (b) => { const x = entryX(b); return x < x0 - 30 ? "L" : x > x0 + 30 ? "R" : "D"; };
    const nL = H.targets.filter(b => side0(b) === "L").length, nR = H.targets.filter(b => side0(b) === "R").length;
    const hh = LANE * Math.max(nL, nR, 1) / 2 + 6, hw = LANE * H.targets.filter(b => side0(b) === "D").length / 2 + 8;
    grp = g;
    // every lane of the fan must run clear for a good stretch, not just leave
    const lanes = (n) => [...Array(n).keys()].map(k => LANE * (k - (n - 1) / 2));
    const ok = (x, y) => !onCtrl(x, y) && clearV(x, y - hh - 26, y + hh)
      && lanes(nL).every(d => clearH(y + d, x - SPOKE - 120, x - 4))
      && lanes(nR).every(d => clearH(y + d, x + 4, x + SPOKE + 120))
      && clearH(y + SPOKE, x - hw, x + hw);
    let best = null;
    for (let r = 0; r <= 60 && !best; r++) {
      for (let i = -r; i <= r && !best; i++) for (const [dx, dy] of [[i, -r], [i, r], [-r, i], [r, i]]) {
        if (ok(x0 + dx * 6, y0 + dy * 6)) { best = [x0 + dx * 6, y0 + dy * 6]; break; }
      }
    }
    [H.hx, H.hy] = best || [x0, y0];
    // the variable runs as one line to its hub, in from above
    const pts = ortho(a, {x: H.hx, y: H.hy, fromTop: true});
    H.trunk = `M ${a.x} ${a.y}` + rounded(pts);
    obst.push({key: `hub:${g}`, l: H.hx - 6, t: H.hy - 6, r: H.hx + 6, b: H.hy + 6});
    // sides again, from where the hub really stands: a reader below whose
    // column is blocked leaves sideways instead
    const side2b = (b) => {
      const x = entryX(b);
      if (x < H.hx - 30) return "L";
      if (x > H.hx + 30) return "R";
      grp = g;
      return clearV(x, H.hy + SPOKE, boxOf(b).top - 22) ? "D" : x <= H.hx ? "L" : "R";
    };
    const sides = new Map(H.targets.map(b => [b, side2b(b)]));
    const side = (b) => sides.get(b);
    H.spoke = new Map();
    const L = H.targets.filter(b => side(b) === "L").sort((p, q) => entryX(p) - entryX(q));
    const Rt = H.targets.filter(b => side(b) === "R").sort((p, q) => entryX(q) - entryX(p));
    const D = H.targets.filter(b => side(b) === "D").sort((p, q) => entryX(p) - entryX(q));
    L.forEach((b, k) => H.spoke.set(b, {dir: -1, y: H.hy + LANE * (k - (L.length - 1) / 2)}));
    Rt.forEach((b, k) => H.spoke.set(b, {dir: 1, y: H.hy + LANE * (k - (Rt.length - 1) / 2)}));
    D.forEach((b, k) => H.spoke.set(b, {dir: 0, x: H.hx + LANE * (k - (D.length - 1) / 2)}));
  };
  const route = (a, b) => {
    const Jo = joinOf.get(b) && joinOf.get(b).get(a);
    if (Jo) {
      // the ring stands just outside the hole, on its entry side (placed
      // in prepLanes); the arrival lanes sit side by side above it, in
      // source order
      const J = hubs.get(Jo.jg);
      grp = `${Jo.jg}#${Jo.k}`;
      lastRoute = {grp, hub: Jo.jg};
      const ax0 = J.hx + LANE * (Jo.k - (J.n - 1) / 2), ay = J.hy - SPOKE;
      // sources run left to right into lanes left to right; the leftmost
      // takes the lowest channel, so no drop crosses another's run. A lane
      // whose trace finds no row of its own tries the columns beside it
      // (a ring among others leaves some lanes boxed in); a failed try is
      // taken back
      // (outside the ring's own lanes: each sibling's column stays its own)
      const half = LANE * (J.n - 1) / 2, tries = [ax0];
      for (let i = 1; i <= 2; i++) tries.push(...(Jo.k < J.n / 2 ? [J.hx - half - i * LANE, J.hx + half + i * LANE] : [J.hx + half + i * LANE, J.hx - half - i * LANE]));
      let ax = ax0, pts = null;
      for (const c of tries) {
        const nV = usedV.length, nH = usedH.length;
        pts = ortho(a, {x: c, y: ay, fromTop: true}, null, J.n - 1 - Jo.k);
        if (!orthoBad) { ax = c; break; }
        usedV.length = nV; usedH.length = nH; pts = null;
      }
      if (!pts) pts = ortho(a, {x: ax0, y: ay, fromTop: true}, null, J.n - 1 - Jo.k);
      return `M ${a.x} ${a.y}` + rounded(pts)
        + ` C ${ax} ${ay + SPOKE * .55} ${J.hx} ${J.hy - SPOKE * .45} ${J.hx} ${J.hy}`;
    }
    const Bi = branchOf.get(b);
    const g = Bi ? Bi.g : null;
    const H = g ? hubs.get(g) : null;
    if (!H || H.n < 2) {
      grp = `solo${++solo}`;
      lastRoute = {grp, hub: null};
      return `M ${a.x} ${a.y}` + rounded(zig(a, b) || ortho(a, b));
    }
    if (H.hx == null) placeHub(H, g);
    grp = `${g}#${Bi.k}`;
    const sp = H.spoke.get(b);
    const {yB0, x2} = gutter(b);
    lastRoute = {grp, hub: g};
    let head, pts;
    if (sp.dir) {
      // out sideways on its own lane, then down the first free column that
      // reaches the channel above its reader
      const sx = H.hx + sp.dir * SPOKE, ly = sp.y;
      head = `M ${H.hx} ${H.hy} C ${H.hx + sp.dir * SPOKE * .5} ${H.hy} ${H.hx + sp.dir * SPOKE * .5} ${ly} ${sx} ${ly}`;
      const xc = scan2(x2, x => clearV(x, ly, yB0) && clearH(ly, sx, x));
      const ymB = scan(yB0, -4, y => clearH(y, xc, x2) && clearV(x2, y, by(b)), 200);
      if (clearH(ly, sx, xc) && clearV(xc, ly, ymB)) {
        pts = keep(clean([[sx, ly], [xc, ly], [xc, ymB], [x2, ymB], ...tailOf(b, x2)]));
        return head + rounded(pts);
      }
      pts = ortho({x: sx, y: ly}, b, sx);
      return head + rounded(pts);
    }
    // straight down in its own column
    const sy = H.hy + SPOKE, xk = sp.x;
    head = `M ${H.hx} ${H.hy} C ${H.hx} ${H.hy + SPOKE * .5} ${xk} ${H.hy + SPOKE * .5} ${xk} ${sy}`;
    const ym = scan(yB0, -4, y => clearV(xk, sy, y) && clearH(y, xk, x2) && clearV(x2, y, by(b)), Math.max(4, Math.abs(yB0 - sy) / 4));
    if (clearV(xk, sy, ym) && clearH(ym, xk, x2) && clearV(x2, ym, by(b))) pts = keep(clean([[xk, sy], [xk, ym], [x2, ym], ...tailOf(b, x2)]));
    else pts = ortho({x: xk, y: sy}, b, xk);
    return head + rounded(pts);
  };
  // the hubs and the lines into them, under their fans
  const drawHubs = (layer) => {
    for (const H of hubs.values()) {
      if (!H.cls || H.hx == null) continue;
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", H.trunk);
      p.setAttribute("class", `${H.cls} trunk`);
      layer.prepend(p);
      H.trunkEl = p;
      H.flow = dfComet(p, H.trunk, (/\b(focus|lit)\b/.test(H.cls) && !/\b(peek|dim|far)\b/.test(H.cls) ? "on" : "")
        + (/\blit\b/.test(H.cls) ? " lit" : ""));
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", H.hx); c.setAttribute("cy", H.hy); c.setAttribute("r", 4);
      c.setAttribute("class", "dfhub" + (/\blit\b/.test(H.cls) ? " lit" : "") + (/\bpeek\b/.test(H.cls) ? " peek" : ""));
      c.append(Object.assign(document.createElementNS(SVGNS, "title"), {textContent: H.join ? `${H.n} sources → one input` : `one value → ${H.n} readers`}));
      layer.append(c);
      H.el = c;
    }
  };
  const wire = (a, b, cls, under, label) => {
    if (!a || !b) return null;
    const p = document.createElementNS(SVGNS, "path");
    const d = route(a, b);
    p.setAttribute("d", d);
    // a hub wears its brightest branch: lit if any is, dim only if all are
    const route0 = lastRoute;
    if (route0.hub) {
      const H = hubs.get(route0.hub);
      if (!H.cls || (/\bdim\b/.test(H.cls) && !/\bdim\b/.test(cls)) || (/\blit\b/.test(cls) && !/\blit\b/.test(H.cls))) H.cls = cls.replace(/\bfar\b/, "");
    }
    // hovering a wire singles it out: just it, its two plugs, its name
    const hit = document.createElementNS(SVGNS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "dfhit");
    const hot = (on) => {
      world.classList.toggle("dfwirehot", on);
      if (on) p.dfFlowMake();
      p.classList.toggle("hot", on); for (const f of flow) f.classList.toggle("hot", on);
      // its line from the source and its hub light with it
      if (route0.hub) { const H = hubs.get(route0.hub); H.trunkEl?.classList.toggle("hot", on); H.el?.classList.toggle("hot", on); }
      for (const h of [a, b]) if (h.row) h.row.classList.toggle("hot", on);
    };
    for (const h of [a, b]) if (h.row) { if (!dfRowWires.has(h.row)) dfRowWires.set(h.row, []); dfRowWires.get(h.row).push(hot); }
    hit.addEventListener("mouseenter", (ev) => {
      hot(true);
      if (label) { const t = dfWireLabel(); t.textContent = label; t.hidden = false; dfWireLabelMove(ev); }
    });
    hit.addEventListener("mousemove", dfWireLabelMove);
    hit.addEventListener("mouseleave", () => {
      hot(false);
      if (dfRowPinned) dfRowHot(dfRowPinned, true);
      const t = dfWireLabel(); t.hidden = true;
    });
    queueMicrotask(() => { if (p.parentNode && !p.classList.contains("far")) p.parentNode.append(hit); });
    p.setAttribute("class", cls);
    p.dfRoute = route0;
    // the energy pulse: tiny bright beads running from source to reader
    // beads only run where the wire itself shows
    const flowCls = (/\b(focus|lit)\b/.test(cls) && !/\b(peek|dim|far)\b/.test(cls) ? "on" : "") + (/\blit\b/.test(cls) ? " lit" : "");
    // a wire that shows at rest gets its comet now; one that only lights
    // on hover gets it then (measuring every wire up front is slow)
    let flow = [];
    p.dfFlow = flow;
    p.dfFlowMake = () => { if (!p.dfFlowMade && p.parentNode) { p.dfFlowMade = true; flow.push(...dfComet(p, d, flowCls)); } };
    if (/\bon\b/.test(flowCls)) queueMicrotask(p.dfFlowMake);
    // Data Flow's many wires run UNDER the cards and surface into their
    // holes; a focused op's few wires ride above
    (under ? svg : wsvg).append(p);
    return p;
  };
  // a hole's centre in world coordinates (the canvas may be zoomed)
  // from layout offsets, not screen boxes: a card's hover lift or highlight
  // transform must never move where its wires plug in
  const holePt = (card, it, hole) => {
    let x = hole.offsetWidth / 2, y = hole.offsetHeight / 2, e = hole;
    while (e && e !== card) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    // offsets inside the card start at its padding edge; the card's x/y is
    // its outer edge: add its border (2px on an open card put every wire
    // 2px up and left of its hole's centre)
    if (e === card) { x += card.clientLeft; y += card.clientTop; }
    if (e !== card) {   // the card is not the hole's offset parent chain: fall back
      const cr = card.getBoundingClientRect(), hr = hole.getBoundingClientRect(), k = state.view.scale || 1;
      return {x: it.x + (hr.left + hr.width / 2 - cr.left) / k, y: it.y + (hr.top + hr.height / 2 - cr.top) / k};
    }
    return {x: it.x + x, y: it.y + y};
  };
  const cardHole = (key, dir, port) => {
    const it = R(key), card = state.cardEls.get(key);
    const r = card && card.querySelector(`.dfport.${dir}[data-port="${CSS.escape(port)}"]`);
    if (!it || !r) return null;
    const brow = r.classList.contains("brchip") && r.closest(".brrow");
    let at;
    if (brow) {
      // a chip sits in the condition's text, where offsets are not to be
      // trusted: measure the hole against its own card's box (a hover lift
      // moves both alike)
      const hr = r.querySelector(".dfhole").getBoundingClientRect(), cr = card.getBoundingClientRect(), k = state.view.scale || 1;
      at = {x: it.x + (hr.left + hr.width / 2 - cr.left) / k, y: it.y + (hr.top + hr.height / 2 - cr.top) / k};
    } else at = holePt(card, it, r.querySelector(".dfhole"));
    const h = {...at, row: r, key};
    if (brow) {
      // a chip in a condition: in from the side its row's edge does not use
      let top = 0, e = brow;
      while (e && e !== card) { top += e.offsetTop; e = e.offsetParent; }
      if (brow.closest(".cols")) {
        // a column's chip: in from the left along the strip over the
        // columns, then down into the hole (the text starts at the column's
        // head, so the chip does). A chip further right takes a higher lane:
        // no run passes over another's turn.
        const k = [...card.querySelectorAll(".brrow")].filter(c => c.querySelector(".dfport.brchip")).indexOf(brow);
        h.entry = "over";
        h.gapY = it.y + card.clientTop + top - 3 - 3 * Math.max(0, k);
      } else {
        h.entry = brow.classList.contains("left") ? "right" : "left";
        h.gapY = it.y + top - 5;
      }
    }
    return h;
  };
  // an opened GraphOp's plates, on its frame: a hole has an outside face
  // (outer wires) and an inside face (its own ops)
  const plates = new Map();
  const containerHole = (key, dir, port) => {
    const C = R(key);
    if (!C || !C.inner) return null;
    if (!plates.has(key)) {
      const ins = [...new Set(B.filter(b => (b.to.key === key && !b.to.export) || (b.from.kind === "input" && b.from.key === key))
        .map(b => b.to.key === key && !b.to.export ? b.to.port : b.from.port))];
      const outs = [...new Set(B.filter(b => (b.to.key === key && b.to.export) || (b.from.kind === "op" && b.from.key === key))
        .map(b => b.to.key === key && b.to.export ? b.to.port : b.from.port))];
      const map = new Map();
      // inputs enter by its START (top left), outputs leave by its END
      // (bottom right) — where the values really go in and come out
      const put = (list, dir2) => list.forEach((port2, i) => {
        const x = dir2 === "in" ? C.x : C.x + C.w;
        const y = dir2 === "in" ? C.y + 52 + i * 26 : C.y + C.h - 28 - (list.length - 1 - i) * 26;
        const tagEl = el("div", `dfplate ${dir2}`);
        const feed = dir2 === "in" && B.find(b => b.to.key === key && !b.to.export && b.to.port === port2);
        const mains = feed && DataFlow.isBroadcast(feed) ? (feed.from.kind === "scratch" ? "scratch" : "start") : null;
        const hole = el("span", "dfhole" + (mains ? ` mains ${mains}` : ""), mains === "start" ? "▶" : mains === "scratch" ? "✎" : "");
        // the hole on the frame line itself: an input's at the plate's left
        // end, an output's at its right end
        // a pass-through plug: a hole on each face
        const inHole = el("span", "dfhole dfinner");
        if (dir2 === "in") tagEl.append(hole, el("span", "dfname mono", port2), inHole);
        else tagEl.append(inHole, el("span", "dfname mono", port2), hole);
        over.append(tagEl);
        // from the plate's outer edge: its border too (see holePt)
        const ho = tagEl.clientLeft + hole.offsetLeft + hole.offsetWidth / 2;
        const hi = tagEl.clientLeft + inHole.offsetLeft + inHole.offsetWidth / 2;
        const tw = tagEl.offsetWidth, th = tagEl.offsetHeight, tl = x - ho;
        tagEl.style.top = `${y - th / 2}px`;
        tagEl.style.left = `${tl}px`;
        // a plate is a pass-through with two faces: the hole on the frame
        // line takes the outside wire, the plate's inner end the inside one
        const own = `plate:${key}:${dir2}:${port2}`;
        // (a pill, not a card: a wire may pass a few px off its ends — a
        // wide margin walled the plate column off from the op beside it)
        obst.push({key: own, l: tl - 4, t: y - th / 2 - 8, r: tl + tw + 4, b: y + th / 2 + 8});
        const inner = {x: tl + hi, y, row: tagEl, key, plate: true, own};
        map.set(dir2 + "|" + port2, {x, y, row: tagEl, key, plate: true, own, inner});
      });
      put(ins, "in"); put(outs, "out");
      plates.set(key, map);
    }
    return plates.get(key).get(dir + "|" + port) || null;
  };
  /* The root graph's TERMINALS: START's plugs (one per graph input), the
   * SCRATCH pad (one per key the run's ops read), END's plugs (one per
   * graph output). START and SCRATCH grow upward from the START pill (to
   * its right and left), END downward from the END pill — where nothing
   * else is drawn. */
  const terms = new Map();
  const termHole = (kind, port) => {
    if (!terms.has(kind)) {
      const pill = document.querySelector(`#nodes > .bnode.b-${kind === "end" ? "end" : "start"}:not(.knob)`);
      const ports = [...new Set(B.filter(b => kind === "end" ? b.to.end
        : kind === "scratch" ? b.from.kind === "scratch" : (b.from.kind === "input" && !b.from.key))
        .map(b => kind === "end" ? b.to.port : b.from.port))];
      const map = new Map();
      terms.set(kind, map);
      if (!pill || !ports.length) return null;
      const px = parseFloat(pill.style.left), py = parseFloat(pill.style.top), pw = pill.offsetWidth, ph = pill.offsetHeight;
      const panel = el("div", `dfterm ${kind}`);
      // START and END become the terminal itself: the pill grows into a
      // capsule holding its plugs, its label where the control flow meets it
      const label = kind === "scratch" ? el("div", "dftermhead", "✎ SCRATCH")
        : el("div", "dftermlabel", kind === "start" ? "START" : "END");
      if (kind !== "scratch") label.prepend(el("span", "dftermglyph"));
      if (kind !== "start") panel.append(label);
      for (const port2 of ports) {
        const r = el("div", "dfport dftermrow " + (kind === "end" ? "in" : "out"));
        r.dataset.port = port2;
        const hole = el("span", "dfhole");
        if (kind === "end") r.append(hole, el("span", "dfname mono", port2));
        else r.append(el("span", "dfname mono", port2), hole);
        // one variable's wiring: hover shows it, a click pins it
        r.onmouseenter = () => { if (state.dfTerm !== kind || state.dfTermHover === port2) return; state.dfTermHover = port2; drawDataLayer(); };
        r.onmouseleave = () => { if (state.dfTermHover == null) return; state.dfTermHover = null; drawDataLayer(); };
        r.onclick = (ev) => {
          if (state.dfTerm !== kind) return;
          ev.stopPropagation();
          state.dfTermPort = state.dfTermPort === port2 ? null : port2;
          drawDataLayer();
        };
        panel.append(r);
      }
      if (kind === "start") panel.append(label);
      panel.title = kind === "scratch" ? "SCRATCH — click: every op that reads it" : `${kind.toUpperCase()} — click: every op its values reach`;
      panel.onclick = (ev) => { ev.stopPropagation(); toggleTerm(kind); };
      over.append(panel);
      panel.style.minWidth = `${pw + 24}px`;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      // START grows upward from its pill, END downward, both centred on it;
      // the SCRATCH pad stands to START's left
      // (the pad stands clear of START's capsule, not just of its pill)
      // the pad stands clear of where START's capsule is or would be
      let capL = px;
      if (kind === "scratch") {
        const cap = over.querySelector(".dfterm.start");
        if (cap) capL = parseFloat(cap.style.left);
        else {
          const names = [...new Set(B.filter(b => b.from.kind === "input" && !b.from.key).map(b => b.from.port))];
          const longest = Math.max(0, ...names.map(n => n.length));
          const cw = Math.max(pw + 24, longest * 7 + 58);
          capL = px + pw / 2 - cw / 2;
        }
      }
      const left = kind === "scratch" ? capL - 24 - w : px + pw / 2 - w / 2;
      const top = kind === "end" ? py - 4 : py + ph + 4 - h;
      if (kind !== "scratch") pill.classList.add("dfhosted");
      panel.style.left = `${left}px`; panel.style.top = `${top}px`;
      const own = `term:${kind}`;
      obst.push({key: own, l: left - 16, t: top - 16, r: left + w + 16, b: top + h + 16});
      const ex = state.extent;
      if (ex) {
        const before = `${ex.minX},${ex.minY},${ex.maxX},${ex.maxY}`;
        ex.minX = Math.min(ex.minX, left - 30); ex.minY = Math.min(ex.minY, top - 30);
        ex.maxX = Math.max(ex.maxX, left + w + 30); ex.maxY = Math.max(ex.maxY, top + h + 30);
        if (`${ex.minX},${ex.minY},${ex.maxX},${ex.maxY}` !== before) requestAnimationFrame(applyView);
      }
      for (const r of panel.children) {
        if (!r.dataset.port) continue;
        const hole = r.querySelector(".dfhole");
        let hx = hole.offsetWidth / 2, hy = hole.offsetHeight / 2, e = hole;
        while (e && e !== panel) { hx += e.offsetLeft; hy += e.offsetTop; e = e.offsetParent; }
        if (e === panel) { hx += panel.clientLeft; hy += panel.clientTop; }   // its border (see holePt)
        map.set(r.dataset.port, {x: left + hx, y: top + hy, row: r, key: own, plate: true, own});
      }
    }
    return terms.get(kind).get(port) || null;
  };
  const srcHole = (b) => b.from.kind === "scratch" ? termHole("scratch", b.from.port)
    : b.from.kind === "input" && !b.from.key ? termHole("start", b.from.port)
    : b.from.kind === "op"
    ? (R(b.from.key) && R(b.from.key).inner ? containerHole(b.from.key, "out", b.from.port) : cardHole(b.from.key, "out", b.from.port))
    : (containerHole(b.from.key, "in", b.from.port) || {}).inner || null;
  const dstHole = (b) => b.to.end ? termHole("end", b.to.port)
    : b.to.export ? (containerHole(b.to.key, "out", b.to.port) || {}).inner || null
    : R(b.to.key) && R(b.to.key).inner ? containerHole(b.to.key, "in", b.to.port) : cardHole(b.to.key, "in", b.to.port);
  const litCls = (b) => {
    if (!lv) return "";
    const l = lv.get(b.id) || 0;
    return l === 1 ? " lit" : l === 2 ? " lit2" : " dim";
  };
  const markRows = () => {
    if (!lv) return;
    for (const [id, l] of lv) {
      const b = B[id];
      for (const h of [srcHole(b), dstHole(b)]) if (h && h.row) h.row.classList.add(l === 1 ? "lit" : "lit2");
      for (const k of [b.from.key, b.to.key]) { const c = state.cardEls.get(k); if (c) c.classList.add("dfpeer"); }
    }
    const pc = state.cardEls.get(dfPort.key);
    const pr = pc && pc.querySelector(`.dfport.${dfPort.dir}[data-port="${CSS.escape(dfPort.port)}"]`);
    if (pr) pr.classList.add("picked");
    if (pc) pc.classList.add("dfpeer");
  };

  if (canvasView === "data") {
    // One wire per variable, hole to hole. A NEAR wire (into the next row
    // down) is drawn; a FAR one — rows away, or back up — is not, at rest:
    // its holes wear a dashed ring ("plugged into something further
    // away"), and hovering the variable draws it, a click its lineage.
    const byRow = new Map();   // hole row element → its wires
    const addTo = (row, p) => { if (!row) return; if (!byRow.has(row)) byRow.set(row, []); byRow.get(row).push(p); };
    const plan = [];
    for (const k of ["start", "scratch", "end"]) termHole(k, "");
    for (const b of B) {
      const a = srcHole(b), z = dstHole(b);
      if (!a || !z) continue;
      const A = boxOf(a), Z = boxOf(z);
      const gap = Z.top - A.bottom;
      // a broadcast (START, SCRATCH) or an output to END reaches far: shown
      // on hover and in a lineage, not at rest
      const far = DataFlow.isBroadcast(b) || !!b.to.end || gap < -4 || gap > 230;
      plan.push({b, a, z, far, len: Math.abs(z.y - a.y) + Math.abs(z.x - a.x)});
    }
    // short, visible wires claim their tracks first
    // bottom holes first: they take the inner lanes, so a card's wires nest
    // like brackets instead of crossing
    // what is visible routes first: a lit lineage, then near wires, then far
    // ones hidden at rest — so the wires on screen get the free lanes
    const rank = (x) => (lv && lv.has(x.b.id)) ? 0 : x.far ? 2 : 1;
    plan.sort((p, q) => (rank(p) - rank(q)) || (q.a.y - p.a.y) || (q.z.y - p.z.y));
    prepLanes(plan.filter(x => rank(x) < 2).map(x => [x.a, x.z]));
    const draw = ({b, a, z, far}) => {
      const p = wire(a, z, "dfconn" + litCls(b) + (far ? " far" : ""), true, `${dfSourceLabel(b)} → ${dfTargetLabel(b)}`);
      if (!p) return null;
      const tip = document.createElementNS(SVGNS, "title");
      tip.textContent = `${dfSourceLabel(b)} → ${dfTargetLabel(b)}`;
      p.append(tip);
      return p;
    };
    // a far wire hidden at rest is routed the first time it is asked for
    // (its variable hovered): routing every one up front cost seconds
    const later = new Map();   // hole row → its unrouted far wires
    for (const x of plan) {
      const {a, z, far} = x;
      if (far) for (const h of [a, z]) if (h.row) h.row.classList.add("remote");
      if (far && rank(x) === 2) {
        for (const r of [a.row, z.row]) if (r) { if (!later.has(r)) later.set(r, []); later.get(r).push(x); }
        continue;
      }
      const p = draw(x);
      if (p) { addTo(a.row, p); addTo(z.row, p); }
    }
    for (const [row, xs] of later) if (!byRow.has(row)) byRow.set(row, []);
    for (const [row, ps] of byRow) {
      // a hovered variable lights its wires, with the line to their hub
      const parts = (on) => { for (const p of ps) {
        p.classList.toggle("hot", on);
        if (on && p.dfFlowMake) p.dfFlowMake();
        for (const f of p.dfFlow || []) f.classList.toggle("hot", on);
        const r0 = p.dfRoute;
        if (r0 && r0.hub) { const H = hubs.get(r0.hub); H.trunkEl?.classList.toggle("hot", on); H.el?.classList.toggle("hot", on); }
      } };
      row.onmouseenter = () => {
        for (const x of later.get(row) || []) {
          if (x.p !== undefined) continue;
          x.p = draw(x);
          if (x.p) for (const r of [x.a.row, x.z.row]) if (r && byRow.has(r)) byRow.get(r).push(x.p);
        }
        parts(true);
      };
      row.onmouseleave = () => parts(false);
    }
    drawHubs(svg);
    markRows();
    return;
  }

  // Workflow. A click opens the op (its plates are part of the card, the
  // flow laid out again round it) and every partner shows a plug tag with
  // its own hole on the matching side; the rest steps back. A hover only
  // peeks: faint wires to the op's sides, nothing moves.
  /* An open terminal lights every op its values reach and their holes,
   * but wires ONE variable at a time: the one under the pointer, or the
   * one clicked (pinned) — a whole terminal wired at once is a hairball. */
  if (canvasView === "workflow" && !state.sel && state.dfTerm && termIds) {
    world.classList.add("dfpin");
    const pick = state.dfTermHover ?? state.dfTermPort ?? null;
    const portOf = (b) => state.dfTerm === "end" ? b.to.port : b.from.port;
    const pairs = [];
    for (const id of termIds) {
      const b = B[id], a = srcHole(b), z = dstHole(b);
      for (const k of [b.from.key, b.to.key]) if (k) state.cardEls.get(k)?.classList.add("dfpeer");
      const on = pick != null && portOf(b) === pick;
      // the far end of every value lights; the picked value's ends glow
      const far = state.dfTerm === "end" ? a : z;
      if (far && far.row) far.row.classList.add(on ? "picked" : "lit");
      if (on && a && z) pairs.push([a, z, "dfconn focus lit", `${dfSourceLabel(b)} → ${dfTargetLabel(b)}`]);
    }
    over.querySelector(`.dfterm.${state.dfTerm}`)?.classList.toggle("haspick", pick != null);
    world.classList.toggle("dftpick", pick != null);
    for (const r of over.querySelectorAll(`.dfterm.${state.dfTerm} .dftermrow`)) {
      r.classList.toggle("picked", r.dataset.port === pick);
      r.classList.toggle("pinned", r.dataset.port === state.dfTermPort);
    }
    pairs.sort((p, q) => (q[0].y - p[0].y) || (q[1].y - p[1].y));
    prepLanes(pairs);
    joinFirst(pairs);
    for (const [a, z, cls, label] of pairs) wire(a, z, cls, false, label);
    drawHubs(wsvg);
    over.querySelector(`.dfterm.${state.dfTerm}`)?.classList.add("picked");
    return;
  }
  const pinned = !!state.sel;
  const key = state.sel || state.dfHover || null;
  const it = key && R(key);
  if (it && it.inner && pinned) {
    // a selected opened GraphOp: into its frame, through it, and out
    world.classList.add("dfpin");
    state.cardEls.get(it.key)?.classList.add("dfpeer");
    containerHole(it.key, "in", "");   // its plates exist even when no wire comes
    const rel = B.filter(b => b.to.key === it.key || b.from.key === it.key);
    // the plate a binding passes through: in by its START side, out by END
    const plateOf = (b) => b.to.key === it.key ? {dir: b.to.export ? "out" : "in", port: b.to.port}
      : {dir: b.from.kind === "input" ? "in" : "out", port: b.from.port};
    // every wire shows; a plate under the pointer, or clicked, singles
    // out its own
    const pairs = [];
    for (const b of rel) {
      const a = srcHole(b), z = dstHole(b);
      for (const k of [b.from.key, b.to.key]) state.cardEls.get(k)?.classList.add("dfpeer");
      for (const h of [a, z]) if (h && h.row && !h.plate) h.row.classList.add("lit");
      if (a && z) pairs.push([a, z, "dfconn focus" + litCls(b), `${dfSourceLabel(b)} → ${dfTargetLabel(b)}`]);
    }
    let pinRow = null;
    for (const [k2, P] of plates.get(it.key) || []) {
      const [dir2, port2] = [k2.slice(0, k2.indexOf("|")), k2.slice(k2.indexOf("|") + 1)];
      const row = P.row;
      row.classList.add("pickable");
      if (dfPlatePin && dfPlatePin.key === it.key && dfPlatePin.port === port2 && dfPlatePin.dir === dir2) pinRow = row;
      row.onmouseenter = () => dfRowHot(row, true);
      row.onmouseleave = () => dfRowHot(row, false);
      row.onclick = (ev) => {
        ev.stopPropagation();
        const same = dfPlatePin && dfPlatePin.key === it.key && dfPlatePin.port === port2 && dfPlatePin.dir === dir2;
        dfPlatePin = same ? null : {key: it.key, port: port2, dir: dir2};
        const was = dfRowPinned;
        dfRowPinned = null;
        if (was) dfRowHot(was, false);
        if (!same) { dfRowPinned = row; dfRowHot(row, true); }
      };
    }
    pairs.sort((p, q) => (q[0].y - p[0].y) || (q[1].y - p[1].y));
    prepLanes(pairs);
    joinFirst(pairs);
    for (const [a, z, cls, label] of pairs) wire(a, z, cls, false, label);
    drawHubs(wsvg);
    markRows();
    if (pinRow) { dfRowPinned = pinRow; dfRowHot(pinRow, true); }
    return;
  }
  if (!it || it.inner || it.kind === "knob" || (it.node && it.node.boundary)) return;
  const nb = DataFlow.nodeBindings(B, it.key);
  if (!nb.ins.length && !nb.outs.length) return;
  world.classList.add(pinned ? "dfpin" : "dfpeek");
  const card = state.cardEls.get(it.key);
  if (card) card.classList.add("dfpeer");
  const plugCount = new Map();
  // a partner's plug: [name ◉] on its right edge (it feeds), [◉ name] on
  // its left edge (it reads)
  const plug = (pkey, dir, text) => {
    const P = R(pkey);
    if (!P) return null;
    if (P.inner) return containerHole(pkey, dir, text);
    if (pinned) { const h = cardHole(pkey, dir, text); if (h) { state.cardEls.get(pkey)?.classList.add("dfpeer"); return h; } }
    const n = plugCount.get(pkey + dir) || 0;
    plugCount.set(pkey + dir, n + 1);
    const t = el("div", `dfplug ${dir}` + (pinned ? "" : " peek"));
    const hole = el("span", "dfhole");
    if (dir === "out") t.append(el("span", "dfname mono", text), hole);
    else t.append(hole, el("span", "dfname mono", text));
    over.append(t);
    const w = t.offsetWidth, h = t.offsetHeight;
    const y = P.y + Math.min(P.h - h - 4, 8 + n * (h + 4));
    // fully outside the partner: never over its name or its plugs
    const x = dir === "out" ? P.x + P.w + 5 : P.x - w - 5;
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    const pc = state.cardEls.get(pkey);
    if (pc) pc.classList.add("dfpeer");
    return {x: dir === "out" ? x + w - 9 : x + 9, y: y + h / 2, key: pkey, plate: true};
  };
  const cls0 = "dfconn focus" + (pinned ? "" : " peek");
  const side = (dir) => ({x: dir === "in" ? it.x : it.x + it.w, y: it.y + it.h / 2, key: it.key, plate: true});
  // a peek names each partner once: its first variable, and how many more
  if (!pinned) {
    const once = (list, pk) => {
      const seen = new Map();
      for (const b of list) { const k = pk(b); if (!seen.has(k)) seen.set(k, {b, n: 0}); seen.get(k).n++; }
      return [...seen.values()];
    };
    // a peek: one faint wire per partner, card edge to card edge, the
    // partners lit — no tags to land on the cards around them
    const edgeOf = (pkey, dir) => {
      const P = R(pkey);
      if (!P || P.inner) return null;
      state.cardEls.get(pkey)?.classList.add("dfpeer");
      return {x: dir === "out" ? P.x + P.w : P.x, y: P.y + P.h / 2, key: pkey, own: pkey, plate: true};
    };
    const jobs2 = [];
    for (const {b, n} of once(nb.ins.filter(b => b.from.kind === "op"), b => b.from.key)) {
      const a = edgeOf(b.from.key, "out");
      if (a) jobs2.push([a, {...side("in"), own: it.key}, cls0, `${b.from.port}${n > 1 ? ` +${n - 1}` : ""} → ${it.node.name}`]);
    }
    for (const {b, n} of once(nb.outs.filter(b => !b.to.end && !b.to.export), b => b.to.key)) {
      const z = edgeOf(b.to.key, "in");
      if (z) jobs2.push([{...side("out"), own: it.key}, z, cls0, `${it.node.name} → ${b.to.port}${n > 1 ? ` +${n - 1}` : ""}`]);
    }
    // each peek wire lands on its own point down the op's side
    const spreadEnds = (list, end) => list.forEach((j, i) => {
      j[end] = {...j[end], y: it.y + it.h * (i + 1) / (list.length + 1)};
    });
    // a busy op's peek only lights its partners: faint wires to many of
    // them would cross each other — a click shows them all
    if (jobs2.length > 5) return;
    spreadEnds(jobs2.filter(j => j[1].own === it.key), 1);
    spreadEnds(jobs2.filter(j => j[0].own === it.key), 0);
    prepLanes(jobs2);
    joinFirst(jobs2);
    for (const [a, z, cls, label] of jobs2) wire(a, z, cls, false, label);
    return;
  }
  const jobs = [];
  for (const b of nb.ins) {
    const a = b.from.kind === "op" ? plug(b.from.key, "out", b.from.port) : srcHole(b);
    const end = pinned ? cardHole(it.key, "in", b.to.port) : side("in");
    if (a && end) jobs.push([a, end, cls0 + litCls(b), `${dfSourceLabel(b)} → ${dfTargetLabel(b)}`, {dir: "in", port: b.to.port}]);
  }
  for (const b of nb.outs) {
    const start = pinned ? cardHole(it.key, "out", b.from.port) : side("out");
    const z = b.to.end || b.to.export ? dstHole(b) : plug(b.to.key, "in", b.to.port);
    if (start && z) jobs.push([start, z, cls0 + " feed" + litCls(b), `${dfSourceLabel(b)} → ${dfTargetLabel(b)}`, {dir: "out", port: b.from.port}]);
  }
  jobs.sort((p, q) => (q[0].y - p[0].y) || (q[1].y - p[1].y));
  prepLanes(jobs);
  joinFirst(jobs);
  for (const [a, z, cls, label] of jobs) wire(a, z, cls, false, label);
  drawHubs(wsvg);
  markRows();
}

// the floating name of a hovered wire
function dfWireLabel() {
  let t = document.getElementById("dfwirelabel");
  if (!t) { t = el("div", "dfwirelabel mono"); t.id = "dfwirelabel"; t.hidden = true; document.body.append(t); }
  return t;
}
function dfWireLabelMove(ev) {
  const t = dfWireLabel();
  t.style.left = `${ev.clientX + 14}px`;
  t.style.top = `${ev.clientY - 30}px`;
}

// a hover's peek ends a beat after the pointer leaves the op
function dfHoverEnter(key) {
  clearTimeout(state.dfHoverOff);
  if (canvasView !== "workflow" || state.sel || state.dfHover === key) return;
  state.dfHover = key;
  drawDataLayer();
}
function dfHoverLeave(key) {
  clearTimeout(state.dfHoverOff);
  state.dfHoverOff = setTimeout(() => {
    if (state.dfHover !== key) return;
    state.dfHover = null;
    drawDataLayer();
  }, 160);
}

function flowDot(svg, path, cls) {
  if (!flowDotsOn || svg.querySelectorAll(".eflow").length >= FLOW_DOTS_MAX) return;
  const d = path.getAttribute("d");
  const s = d && pathSampler(d);
  const len = s ? s.len : 0;
  if (len < 40) return;
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("r", "3.2");
  dot.setAttribute("class", ("eflow " + (cls || "")).trim());
  const anim = document.createElementNS(SVGNS, "animateMotion");
  anim.setAttribute("path", d);
  anim.setAttribute("dur", `${Math.max(1.6, Math.min(7, len / 70)).toFixed(2)}s`);
  anim.setAttribute("repeatCount", "indefinite");
  // stagger, so neighbouring wires don't pulse in step
  anim.setAttribute("begin", `${(-Math.random() * 4).toFixed(2)}s`);
  if ((cls || "").includes("back")) {
    // a loop's return runs bottom to top: its path is drawn from the last
    // step to the first, so keep the path's own direction
    anim.setAttribute("calcMode", "linear");
  }
  dot.append(anim);
  svg.append(dot);
}

document.addEventListener("visibilitychange", () => {
  for (const s of document.querySelectorAll("svg.wires")) {
    if (document.hidden) s.pauseAnimations?.(); else s.unpauseAnimations?.();
  }
});

function energySparks(svg, path, cls) {
  let s = pathSampler(path.getAttribute("d") || "");
  if (!s) {
    try { s = {len: path.getTotalLength(), at: (v) => path.getPointAtLength(v)}; } catch { return; }
  }
  const len = s.len;
  if (!len || len < 130) return;
  const count = Math.max(1, Math.min(3, Math.round(len / 240)));
  for (let i = 0; i < count; i++) {
    const at = ((i + 0.5) / count) * len;
    const pt = s.at(at);
    const tail = s.at(Math.max(0, at - 7));
    const t = document.createElementNS(SVGNS, "circle");
    t.setAttribute("cx", tail.x); t.setAttribute("cy", tail.y); t.setAttribute("r", 1.6);
    t.setAttribute("class", ("espark tailspark " + cls).trim());
    svg.append(t);
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y); c.setAttribute("r", 2.8);
    c.setAttribute("class", ("espark " + cls).trim());
    svg.append(c);
  }
}


function serveFor(graph) {
  // the transport serving this graph, if any — the thing an ingress
  // door wears as its name
  return (state.ir.serves || [])
    .find(s => s.graph === graph.name && s.kind !== "asgi") || null;
}

function serveNodesFor(graph) {
  // A [[serve]] naming this graph is its front door; drawing it is the
  // whole reason the manifest block exists — no pipeline begins from
  // nowhere. One serve fans into every entry op, because starting the run
  // is what dispatches the entry set.
  return (state.ir.serves || [])
    .filter(s => s.graph === graph.name && s.kind !== "asgi")
    .map((s, i) => ({
      id: `__serve_${i}`,
      serve: s,
      x: 40 + i * (NODE_W + 50),
      y: -NODE_H - 110,
    }));
}

/* ── rendering ────────────────────────────────────────────────────── */

/* A canvas that is not on screen (another tab, the assistant in focus)
 * measures every card as 0 × 0: laid out then, decision wires left from
 * the cards' top-left corners, names kept their guessed widths, and
 * nothing redrew when the canvas came back (docs/LAYOUT_HOTFIX_PLAN.md).
 * So a render while hidden only marks the canvas stale; it is drawn the
 * moment it shows again. */
const canvasShown = () => $("#stage").getClientRects().length > 0;
function flushCanvas() {
  if (!canvasShown()) return;
  if (state.renderPending) render();
  // the Flow tab's view, never inside a run's pane (which fits its own):
  // exactly as it was left when a run's pane borrowed the canvas, else
  // the saved or landing view
  if (state.viewPending && !state.workflowOn) {
    state.viewPending = false;
    const v = state.flowView;
    if (!v) { initView(); return; }
    state.view.scale = v.scale;
    applyView();
    $("#stage").scrollLeft = v.x;
    $("#stage").scrollTop = v.y;
  }
}

function render() {
  const g = state.graph;
  const gname = $("#graph-name");
  if (gname) gname.textContent = g ? g.name : "no graph";
  if (!canvasShown()) { state.renderPending = true; return; }
  state.renderPending = false;
  const nodesBox = $("#nodes");
  const svg = $("#edges");
  nodesBox.textContent = "";
  svg.textContent = "";
  $("#edgetop").textContent = "";
  state.rendered.clear();
  state.cardEls.clear();
  state.edgeEls = [];
  state.dfB = g ? DataFlow.dataBindings(g, state.expanded) : [];
  state.dfHover = null;
  // Workflow: a click opens the op AND its partners — each partner showing
  // only the variables it shares with the op — so every wire runs from a
  // hole on one open op to a hole on another
  state.dfOpen = new Map();
  if (canvasView === "workflow" && !state.sel && state.dfTerm) {
    for (const b of state.dfB) {
      const hit = state.dfTerm === "start" ? (b.from.kind === "input" && !b.from.key)
        : state.dfTerm === "scratch" ? b.from.kind === "scratch" : !!b.to.end;
      if (!hit) continue;
      const k = state.dfTerm === "end" ? b.from.key : b.to.key;
      if (!k) continue;
      if (!state.dfOpen.has(k)) state.dfOpen.set(k, new Set());
      state.dfOpen.get(k).add(b.id);
    }
  }
  if (canvasView === "workflow" && state.sel) {
    // every binding touching the selection — for an opened GraphOp that is
    // what crosses its frame both ways and what its own ops read and export
    state.dfOpen.set(state.sel, null);   // null: every bound variable
    for (const b of state.dfB) {
      if (DataFlow.isBroadcast(b)) continue;
      if (b.to.key !== state.sel && b.from.key !== state.sel) continue;
      const pk = b.to.key === state.sel ? b.from.key : b.to.key;
      if (!pk || pk === state.sel) continue;
      if (!state.dfOpen.has(pk)) state.dfOpen.set(pk, new Set());
      state.dfOpen.get(pk).add(b.id);
    }
  }
  $("#world").classList.toggle("dfview", canvasView === "data");

  // ── cards first, measured; then ONE layout places everything ──
  // Every card goes into the DOM before anything is placed: the layout
  // (flowlayout.js) works from each card's REAL size — its name line, a
  // decision card's condition rows — and reserves a clear path for every
  // wire around exactly those boxes. Nothing moves after it: an opened
  // GraphOp is laid out with its siblings, not shifted into them.
  const leaves = [];
  // an opened agent is its card AND its parts (each the op it is)
  const visit = (n, key, depth) => {
    if (n.graph && state.expanded.has(key)) { walk(n.graph, key + "/", depth + 1); return; }
    leaves.push({key, node: n, depth, inner: null, x: 0, y: 0, w: NODE_W, h: NODE_H});
    if (n.parts && state.expanded.has(key)) for (const p of n.parts) visit(p, key + "/" + p.id, depth + 1);
  };
  function walk(gr, prefix, depth) {
    for (const n of gr.nodes || []) visit(n, prefix + n.id, depth);
  }
  walk(g, "", 0);
  const cardOf = new Map();
  for (const it of leaves) {
    const card = opCard(it);
    cardOf.set(it.key, card);
    nodesBox.append(card);
  }
  // WIDTH pass first: a card is exactly as wide as its name line (and, on
  // a decision card, its longest condition) needs, clamped 180–310.
  // Reads and writes are BATCHED: one class switches every measured line
  // to max-content at once, all widths are read in one layout, all
  // laid-out widths in a second, and only then is anything written
  // (docs/REFACTOR_PHASE2.md P4).
  const measured = [];
  for (const it of leaves) {
    const card = cardOf.get(it.key);
    // a decision card's columns side by side are one line to fit
    let els = [...card.querySelectorAll(card.classList.contains("cols") ? ".ntext, .brlist, .dfports" : ".ntext, .brcond, .dfports")];
    // gates: plain name line, plus the transport line below it
    if (!els.length) els = [".nname", ".nkind"].map(sel => card.querySelector(sel)).filter(Boolean);
    measured.push({it, card, els});
  }
  nodesBox.classList.add("measuring");
  const natural = measured.map(m => m.els.map(e => e.offsetWidth));
  nodesBox.classList.remove("measuring");
  const laidOut = measured.map(m => ({shown: !!m.card.offsetHeight, widths: m.els.map(e => e.clientWidth)}));
  measured.forEach((m, i) => {
    if (!laidOut[i].shown || !m.els.length) return;
    // an agent's cell is as wide as its own content (max-content, capped)
    if (m.card.classList.contains("agentcell")) return;
    // a port row sits in one of two equal columns: the card must grow by
    // twice its deficit for that column to gain it
    const need = Math.max(...m.els.map((_, j) => natural[i][j] - laidOut[i].widths[j]));
    const want = Math.ceil(m.it.w + need + 8);
    // a router is as wide as its zones: they never fold or cut
    const cap = m.card.classList.contains("cols") ? 2000 : m.card.querySelector(".dfports") ? 420 : 310;
    const w = Math.max(180, Math.min(cap, want));
    if (want > cap) {
      // a name cut short says itself in full on hover
      m.card.dataset.capped = "";
      for (const e of m.els) if (e.classList.contains("ntext")) e.title = e.textContent;
    }
    if (w !== m.it.w) { m.it.w = w; m.card.style.width = `${w}px`; }
  });
  // heights and the decision rows (card-relative), all read in one layout
  for (const it of leaves) {
    const card = cardOf.get(it.key);
    // the card's real height: the layout's 64 px is only a guess
    if (card.offsetHeight) it.h = card.offsetHeight;
    // an agent's cell keeps its parts on one row: it is as wide as they are
    if (card.classList.contains("agentcell") && card.offsetWidth) it.w = card.offsetWidth;
    if (it.node.routes && it.node.routes.length) {
      const down = card.classList.contains("cols");
      if (down) drawCondTrees(card);
      it.rows = [...card.querySelectorAll(".brrow")].map(rrow => ({
        el: rrow, target: rrow.dataset.target,
        route: rrow.dataset.route != null ? Number(rrow.dataset.route) : null,
        left: rrow.offsetLeft, top: rrow.offsetTop, w: rrow.offsetWidth, h: rrow.offsetHeight,
        // a zone's exit: on the card's bottom edge, under its tree's stem
        down, cx: card.clientLeft + rrow.offsetLeft + rrow.clientLeft + Number(rrow.dataset.stem || rrow.clientWidth / 2),
      }));
    }
  }
  const sized = new Map(leaves.map(it => [it.key, it]));
  // GraphOps whose plates will show get side room for them: every opened
  // one in Data Flow; in Workflow those the selection's data crosses
  const platePad = new Map();
  {
    const B = state.dfB || [];
    const wants = new Set();
    if (canvasView === "data") for (const k of state.expanded) wants.add(k);
    else if (state.sel) {
      if (state.expanded.has(state.sel)) wants.add(state.sel);
      for (const b of B) if (b.to.key === state.sel || b.from.key === state.sel)
        for (const k of [b.from.key, b.to.key]) if (state.expanded.has(k)) wants.add(k);
    }
    for (const k of wants) {
      const names = B.filter(b => b.to.key === k || b.from.key === k).map(b => b.to.key === k ? b.to.port : b.from.port);
      // the plates' width, and a column for each wire that runs on from a
      // plate to the cards inside (a fan into one op runs out of room)
      const ins = new Set(B.filter(b => b.to.key === k && !b.to.export).map(b => b.to.port)).size;
      const outs = new Set(B.filter(b => b.to.key === k && b.to.export).map(b => b.to.port)).size;
      if (names.length) platePad.set(k, Math.max(...names.map(n => n.length)) * 6.6 + 52 + 8 * Math.max(ins, outs));
    }
  }
  const dataShown = canvasView === "data" || !!state.sel || !!state.dfTerm;
  const L = FlowLayout.layout(g, {
    expanded: state.expanded,
    padOf: (key) => platePad.get(key) || 0,
    spacing: dataShown ? {H_GAP: 92, V_GAP: 110} : null,
    textWidth: zoneTextWidth,
    sizeOf: (key) => { const it = sized.get(key); return it ? {w: it.w, h: it.h, rows: it.rows || []} : null; },
  });
  // in paint order: a container before its members, so they sit on its box
  // — and a loop's zone between the two: over the box, under its cards
  nodesBox.textContent = "";
  const stacksBox = $("#stacks");
  if (stacksBox) stacksBox.textContent = "";
  const zoneDrawn = new Set();
  for (const it of L.items) {
    state.rendered.set(it.key, it);
    if (it.zone && !zoneDrawn.has(it.zone)) {
      zoneDrawn.add(it.zone);
      nodesBox.append(loopZone(it.zone));
    }
    let card;
    if (it.inner) card = containerCard(it);
    else if (it.kind === "knob") card = boundaryCard(it);
    else {
      card = cardOf.get(it.key);
      card.style.left = `${it.x}px`;
      card.style.top = `${it.y}px`;
    }
    state.cardEls.set(it.key, card);
    nodesBox.append(card);
    // a generator is a STACK: two copies of its card stepped down and right
    // behind it, each a shade deeper — a deck, "many results"; an op open on
    // its plugs drops it. Plain decorations, not cards: they copy
    // the drawn card's outline and hue, and nothing that looks for cards
    // (find, the audits, dimming) ever sees them.
    if (stacksBox && !it.inner && it.kind !== "knob" && it.node && it.node.is_gen && !card.classList.contains("dfcard")) {
      const ghosts = [];
      for (const k of [2, 1]) {
        const ghost = el("div", `genghost g${k}`);
        ghost.setAttribute("aria-hidden", "true");
        ghost.style.left = `${it.x + 6 * k}px`;
        ghost.style.top = `${it.y + 6 * k}px`;
        ghost.style.width = `${card.offsetWidth || it.w}px`;
        ghost.style.height = `${card.offsetHeight || it.h}px`;
        ghost.card = card;
        ghosts.push(ghost);
        stacksBox.append(ghost);
      }
      // the stack lives under the wires (a wire out of the card's port must
      // not vanish behind it), so it mirrors its card's dimming by class
      const mirror = () => { for (const g of ghosts) for (const c of ["dimmed", "dfpeer", "selected"]) g.classList.toggle(c, card.classList.contains(c)); };
      mirror();
      new MutationObserver(mirror).observe(card, {attributes: true, attributeFilter: ["class"]});
    }
  }
  if (stacksBox) skinStacks();
  // each condition row's port DOT on the side its wire leaves by — the
  // side the layout chose (where its target lies; END left, a loop's
  // return right) — and where that dot is, card-relative
  for (const [key, sides] of L.rowSides) {
    const it = state.rendered.get(key);
    if (!it) continue;
    it.condPorts = {};
    it.condDots = [];
    for (const {row, side} of sides) {
      if (row.down) {
        // the exit bead sits on the card's bottom edge (card-relative: the
        // column's box starts one border in, the card's two)
        const card = state.cardEls.get(key);
        const port = row.el.querySelector(".brport");
        if (port && card) port.style.top = `${it.h - card.clientTop - row.top - row.el.clientTop}px`;
        const dot = {x: row.cx, y: it.h};
        it.condDots.push(dot);
        if (!(row.target in it.condPorts)) it.condPorts[row.target] = {...dot, side: 0};
        if (row.route != null) it.condPorts["#" + row.route] = {...dot, side: 0};
        continue;
      }
      row.el.classList.toggle("left", side < 0);
      // its chip's hole faces the side the data comes in by: the other one
      for (const ch of row.el.querySelectorAll(".dfport.brchip")) ch.classList.toggle("holeR", side < 0);
      const dot = {x: side < 0 ? row.left - 1 : row.left + row.w + 1, y: row.top + row.h / 2};
      it.condDots.push(dot);
      if (!(row.target in it.condPorts)) it.condPorts[row.target] = {...dot, side};
      if (row.route != null) it.condPorts["#" + row.route] = {...dot, side};
    }
  }
  const flat = {nodes: L.items};

  // The serve boundary stands apart from the flow: each door in its own
  // tinted frame — the picture reads client → ingress → flow → egress.
  const gatesIn = flat.nodes.filter(x => x.depth === 0 && x.node.serve_role === "ingress");
  const gatesOut = flat.nodes.filter(x => x.depth === 0 && x.node.serve_role === "egress");

  const maxX = Math.max(L.w, ...flat.nodes.map(n => n.x + n.w));
  const maxY = Math.max(L.h, ...flat.nodes.map(n => n.y + n.h));
  const startIt = L.start, endIt = L.end;
  // where the flow begins: a view that cannot show it all lands here
  state.startAt = startIt ? {x: startIt.x + startIt.w / 2, y: startIt.y} : null;
  let minY = gatesIn.length
    ? Math.min(...gatesIn.map(x => x.y)) - 70
    : -NODE_H - 140;
  if (startIt) minY = Math.min(minY, startIt.y - 40);
  let bottom = maxY + 175;
  if (endIt) bottom = Math.max(bottom, endIt.y + B_H + 40);
  // width includes the right margin where loop returns bulge
  state.extent = {minX: -40, minY, maxX: maxX + 150, maxY: bottom};

  for (const layer of [svg, $("#edgetop"), $("#dflinks")]) {
    layer.setAttribute("width", maxX + 620);
    layer.setAttribute("height", maxY + 640);
    layer.style.left = "-200px";
    layer.style.top = "-320px";
    layer.setAttribute("viewBox", `-200 -320 ${maxX + 620} ${maxY + 640}`);
  }

  // Door frames paint first among the wires, everything sits on top. A
  // frame hugs ITS gate only — a full-height band through a wrapped
  // layout would slice rows that have nothing to do with the boundary.
  const doorFrame = (it, label) => {
    const rect = document.createElementNS(SVGNS, "rect");
    rect.setAttribute("x", it.x - 12); rect.setAttribute("y", it.y - 26);
    // a generator's stack stands inside the door too
    rect.setAttribute("width", it.w + 24 + (it.node && it.node.is_gen ? 12 : 0)); rect.setAttribute("height", it.h + 38 + (it.node && it.node.is_gen ? 12 : 0));
    rect.setAttribute("rx", 16);
    rect.setAttribute("class", "zoneband");
    svg.append(rect);
    // label sits IN the frame's top-left corner, anchored left, well
    // off the wire's path — ties and edges enter through the centre
    edgeGlyph(svg, it.x - 2, it.y - 13, label, "zonelabel");
  };
  for (const gi of gatesIn) doorFrame(gi, "INGRESS");
  for (const go of gatesOut) doorFrame(go, "EGRESS");
  state._hasIngress = gatesIn.length > 0;

  if (!state._hasIngress) {
    // no declared door — the transport card is the only face the
    // client boundary has, so keep it and its fan to the entries
    const serves = serveNodesFor(g);
    const entryItems = (g.entries || [])
      .map(name => flat.nodes.find(it => it.depth === 0 && it.node.name === name))
      .filter(Boolean);
    for (const s of serves) {
      for (const t of entryItems) {
        const p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", bezier(s.x + 95, s.y + NODE_H, portCX(t), t.y));
        p.setAttribute("class", "serve");
        svg.append(p);
      }
    }
    state._serves = serves;
  } else {
    // the ingress IS the transport: one door, wearing the transport's
    // name — no second card, no wire fan, and no orphan stubs: with
    // their labels gone the dangling dashes explained nothing
    state._serves = [];
  }

  // The main graph has terminals too — the flow, like every opened
  // GraphOp, begins at a START contact and ends at an END one; their quiet
  // ties come from the layout with every other wire.
  if (startIt) nodesBox.append(boundaryCard(startIt));
  if (endIt) nodesBox.append(boundaryCard(endIt));

  // Glyphs and labels buffer here and draw AFTER every path, so no
  // later beam ever paints over a word.
  const glyphJobs = [];
  const addGlyph = (x, y, text, cls, tip) => glyphJobs.push([x, y, text, cls, tip]);
  const along = (path, fraction, dy) => {
    // labels sit BESIDE a mostly-vertical wire, not on it
    // sampled in JS from the path's own `d`: getTotalLength on a wire of
    // many segments cost ~110 ms a render on qc_flow with everything open
    const s = pathSampler(path.getAttribute("d") || "");
    if (!s) return null;
    const pt = s.at(s.len * fraction);
    return [pt.x + 12, pt.y + dy + 3];
  };

  // every wire (every open level draws its own), along the path the
  // layout reserved for it. One beam per edge id: a branch carries one
  // edge PER ROUTE, each its own wire out of its own condition row.
  for (const W of L.wires) {
    const {e, a, b} = W;
    // a boundary tie: START → entries, exits → END. Structural, quiet —
    // not an energy beam.
    if (W.tie) {
      const bp = document.createElementNS(SVGNS, "path");
      bp.setAttribute("d", W.d);
      bp.setAttribute("class", "bedge" + (W.exit ? " bexit" : ""));
      svg.append(bp);
      if (W.exit) {
        const at = exitPoint(bp, W.exit);
        const x = W.exit.info.exits.find(q => q.from === a.node.name && q.target === "END");
        if (at) addGlyph(at[0], at[1], "exit loop", "exit-label " + at[2],
                         x ? "leaves the loop: " + FlowLayout.exitText(x) : "leaves the loop");
      }
      const els = [bp];
      if (W.fromRow) overCard(a, els);
      if (a.kind !== "pill" && b.kind !== "pill") state.edgeEls.push({a: a.key, b: b.key, els});
      continue;
    }
    // an expanded container's knobs stand in for its rim
    const A = a.bOut || a, B = b.bIn || b;
    const p = document.createElementNS(SVGNS, "path");
    let cls = e.soft ? "soft" : "";
    let sheath = null;
    // an if/else route gets its own beam: branch amber, the ELSE
    // fallback dashed and laserless — the condition text stays OFF the
    // wire (hover the edge, or open the router's route table).
    let condLabels = [], isElse = false;
    const routeOf = a.node.routes && e.route != null ? a.node.routes[e.route] : null;
    if (routeOf) {
      condLabels = [routeOf.condition];
      isElse = routeOf.condition === "else";
    } else if (a.node.routes && e.type === "condition") {
      condLabels = a.node.routes
        .filter(r => r.target === b.node.name).map(r => r.condition);
      isElse = condLabels.length > 0 && condLabels.every(c => c === "else");
    }
    p.setAttribute("d", W.d);
    if (W.fromRow) p.dataset.fromRow = "1";
    if (W.back) {
      cls += " back";
      if (!e.soft) sheath = "back";
      addGlyph(W.label.x, W.label.y, "next turn", "back-label",
               "back to the start of the loop for another turn");
    } else if (!e.soft) {
      sheath = condLabels.length ? (isElse ? "cond relse" : "cond") : "";
    }
    let drawn = p;
    const made = [];
    const faded = state.run && (!ranInRun(a.node) || !ranInRun(b.node));
    if (sheath !== null) {
      drawn = energyEdge(svg, p.getAttribute("d"), sheath.trim(), made);
      // no sparks on an else-fallback, nor into an op that never ran
      if (!sheath.includes("relse") && !faded) energySparks(svg, drawn, sheath.trim());
      if (!faded) flowDot(svg, drawn, sheath.trim());
    } else {
      p.setAttribute("class", cls.trim());
      svg.append(p);
      made.push(p);
    }
    // a decision wire starts INSIDE the card, at its condition row's dot
    if (p.dataset.fromRow === "1") overCard(A, made);
    if (faded) for (const el2 of made) el2.classList.add("dorm");
    // selection highlights and ←/→ walking work off this ledger, so a
    // click never needs to redraw the whole canvas
    state.edgeEls.push({a: a.key, b: b.key, id: e.id, route: e.route, els: made});
    // the node's own port bead is the terminal; an extra circle on top of
    // it was clutter. Only a loop's flank, which has no port, gets one.
    if (W.back) {
      bouton(svg, B.x + B.w, B.y + B.h / 2, "b-back");
      // the loop re-enters its first step: an arrowhead on the flank, pointing in
      const hx = B.x + B.w + 3, hy = B.y + B.h / 2;
      const head = document.createElementNS(SVGNS, "path");
      head.setAttribute("d", `M ${hx + 11} ${hy - 6} L ${hx} ${hy} L ${hx + 11} ${hy + 6} Z`);
      head.setAttribute("class", "loop-head");
      svg.append(head);
      made.push(head);
    }

    if (!W.back) {
      // glyphs anchor to the drawn path itself, wherever it routed
      if (a.node.is_gen) {
        const at = along(drawn, 0.5, -7);
        if (at) addGlyph(at[0], at[1], "≋", "");
        cls += " stream";
      }
      const consume = consumeOf(e, a, b);
      if (consume) {
        const at = along(drawn, 0.55, -7);
        if (at) addGlyph(at[0], at[1],
          consume.mode === "collect" ? "⧉ collect"
          : `∥ parallel${consume.max ? "≤" + consume.max : ""}`, "");
      }
      if (W.exit) {
        // where the route leaves the loop's zone: say so, just outside it
        const at = exitPoint(drawn, W.exit);
        if (at) addGlyph(at[0], at[1], "exit loop", "exit-label " + at[2],
                         `leaves the loop: ${FlowLayout.exitText(W.exit.info.exits.find(x => x.from === a.node.name) || {from: a.node.name, condition: condLabels.join(" | "), target: b.node.name})}`);
      }
      if (condLabels.length) {
        const tip = document.createElementNS(SVGNS, "title");
        tip.textContent = condLabels.join(" | ");
        drawn.append(tip);
        // the ? pill only when the wire does NOT leave a decision row —
        // a row already shows its condition in full
        if (p.dataset.fromRow !== "1") {
          const at = along(drawn, 0.45, 4);
          if (at) addGlyph(at[0], at[1], "?",
                           "condglyph" + (isElse ? " relse" : ""),
                           condLabels.join(" | "));
        }
      }
    }
  }
  // an opened agent's sockets, wired to its parts
  drawAgentParts(svg, L.parts);
  for (const [x, y, text, cls, tip] of glyphJobs) edgeGlyph(svg, x, y, text, cls, tip);

  // serve transport cards (only when no declared ingress wears it)
  for (const s of state._serves || []) {
    const card = el("div", "node serve-node");
    card.style.left = `${s.x}px`;
    card.style.top = `${s.y}px`;
    card.append(el("div", "nname", `⟶ ${s.serve.kind}`));
    card.append(el("div", "nkind mono", s.serve.path || ""));
    const badges = el("div", "badges");
    if (s.serve.description) card.title = s.serve.description;
    badges.append(el("span", "badge", "serve"));
    card.append(badges);
    card.append(Object.assign(el("span", "port out"), {}));
    card.onclick = (ev) => { ev.stopPropagation(); inspectServe(s.serve); };
    nodesBox.append(card);
  }

  // (op cards were placed before the wires — see the top of render —
  // flatten order still draws a container before its members, so
  // members paint on top of their box without z-index bookkeeping)

  // The world grows to hold every wire (a loop's lane and its label run
  // right of the cards): from the layout's own points — a curve stays
  // inside its control points' hull — not svg.getBBox(), which forced the
  // whole wire layer's geometry mid-render (~110 ms on qc_flow, all open).
  {
    const ex = state.extent;
    for (const W of L.wires) for (const [x, y] of W.pts) {
      if (x - 16 < ex.minX) ex.minX = Math.floor(x) - 16;
      if (y - 16 < ex.minY) ex.minY = Math.floor(y) - 16;
      if (x + 16 > ex.maxX) ex.maxX = Math.ceil(x) + 16;
      if (y + 16 > ex.maxY) ex.maxY = Math.ceil(y) + 16;
    }
    for (const W of L.wires) if (W.label) ex.maxX = Math.max(ex.maxX, Math.ceil(W.label.x) + 70);
  }

  // a very big graph keeps its membranes but not their soft blurred
  // shadows: a zoom re-rasters every visible cell each frame, and on the
  // 302-op graph the blur cost 26 ms a frame against 19 without
  // (measured, docs/ASSISTANT_NEXT_PLAN.md §8). Graphs of real size keep all of it.
  $("#world").classList.toggle("big", state.cardEls.size >= BIG_GRAPH_CELLS);
  refreshSelection();
  applyView();
  if (liveCanvas) liveCanvas.reindex();
}

/* Selection is a class toggle, not a redraw — clicking around a big
 * flow must not blink the whole canvas. */
function refreshSelection() {
  for (const [k, c] of state.cardEls) c.classList.toggle("selected", k === state.sel);
  if (canvasView === "workflow" && dfPort && dfPort.key !== state.sel) dfPort = null;
  state.dfHover = null;
  drawDataLayer();
  paintEdges();
}

/* Which wires are lit: the selected op's. A picked route lights only its
 * own wire out of the router; a hovered route lights its wire too. */
function paintEdges() {
  const pick = state.route, peek = state.routePeek;
  for (const g of state.edgeEls) {
    let hot = !!state.sel && (g.a === state.sel || g.b === state.sel);
    if (hot && pick && g.a === pick.key && g.route != null) hot = g.route === pick.ri;
    if (peek && g.a === peek.key && g.route === peek.ri) hot = true;
    for (const e of g.els) e.classList.toggle("hot", hot);
  }
}

/* A router's route, picked on the canvas: the router is selected, its
 * row in the decision table is marked, and only that route's wire lights.
 * Clicking the same route again lets it go. */
function pickRoute(key, ri) {
  const again = state.sel === key && state.route && state.route.key === key && state.route.ri === ri;
  if (state.sel !== key) select(key);
  state.route = again ? null : {key, ri};
  paintRoute();
}
function paintRoute() {
  for (const c of document.querySelectorAll(".brrow.picked, #inspector .drow.dpicked")) c.classList.remove("picked", "dpicked");
  const pick = state.route;
  if (pick && pick.key === state.sel) {
    const card = state.cardEls.get(pick.key);
    const col = card && card.querySelector(`.brrow[data-route="${pick.ri}"]`);
    if (col) col.classList.add("picked");
    const row = document.querySelector(`#inspector .drow[data-route="${pick.ri}"]`);
    if (row) { row.classList.add("dpicked"); row.scrollIntoView({block: "nearest"}); }
  }
  paintEdges();
}

/* A rotated condition, said in full the moment the pointer is on it. */
function routeTip(ev, key, ri, r) {
  let t = document.getElementById("routetip");
  if (!t) { t = el("div", "routetip"); t.id = "routetip"; t.hidden = true; document.body.append(t); }
  if (!ev) {
    t.hidden = true;
    if (state.routePeek) { state.routePeek = null; paintEdges(); }
    return;
  }
  t.textContent = "";
  t.append(el("span", "rtcond mono", r.condition), el("span", "rtarr", "→"), el("span", "rttgt mono", r.target));
  t.classList.toggle("relse", r.condition === "else");
  t.hidden = false;
  routeTipMove(ev);
  state.routePeek = {key, ri};
  paintEdges();
}
function routeTipMove(ev) {
  const t = document.getElementById("routetip");
  if (!t || t.hidden) return;
  t.style.left = `${ev.clientX + 14}px`;
  t.style.top = `${ev.clientY - 34}px`;
}

/* Opening or closing an op lays the flow out again (its plugs need room).
 * The op the reader is looking at stays where it is on screen — otherwise
 * the canvas jumps, and an Esc can leave the view on empty space. */
function renderKeeping(key) {
  const before = key && state.cardEls.get(key), stage = $("#stage");
  let r0 = before && before.isConnected ? before.getBoundingClientRect() : null;
  // only an op in view is held in place: one off screen (a find's target)
  // is the caller's to bring in
  const sr = stage.getBoundingClientRect();
  if (r0 && (r0.right < sr.left || r0.left > sr.right || r0.bottom < sr.top || r0.top > sr.bottom)) r0 = null;
  render();
  if (!r0) return;
  const c = state.cardEls.get(key);
  if (!c || !c.isConnected) return;
  const r1 = c.getBoundingClientRect();
  stage.scrollLeft += r1.left - r0.left;
  stage.scrollTop += r1.top - r0.top;
}

function deselect() {
  dfPlatePin = null;
  state.route = null;
  const before = state.sel;
  state.sel = null;
  if (canvasView === "workflow" && before) renderKeeping(before);
  refreshSelection();
  pushView();
  renderFlowInfo();
}

/* Nothing selected: the panel belongs to the flow itself — what this
 * graph is, its doors, and the painted run if any. */
function renderFlowInfo() {
  if (state.sel) return;
  // an execution is open in the run's tree: a code reload (the assistant
  // editing, say) must not wipe the panel the user is working in
  if (state.tab === "traces" && !state.workflowOn && state.execPanelRun && state.execPanelRun === state._tlrun) return;
  const panel = $("#inspector");
  panel.textContent = "";
  panel.scrollTop = 0;
  // the Traces list (or a run's tree) has no flow on screen: say what
  // the panel will show instead of describing a canvas nobody sees
  if (state.tab === "traces" && !state.workflowOn) {
    const hint = el("div", "sidehint");
    hint.append(el("div", "sidehint-title", "Nothing selected"));
    hint.append(el("p", null, state._tlrun
      ? "Pick an execution in the tree to see what went in, what came out, and what fed it."
      : "Open a run to read it as a tree, or as the flow with its values painted on every card."));
    panel.append(hint);
    return;
  }
  const g = state.graph;
  if (!g) return;

  const head = el("div", "phead");
  head.append(el("h3", null, g.name || "flow"));
  const chips = el("div", "chips");
  const flowChip = el("span", "chip kindchip", "main flow");
  flowChip.style.setProperty("--kind", "var(--accent)");
  chips.append(flowChip);
  chips.append(el("span", "chip", `${(g.nodes || []).length} ops`));
  const nested = (g.nodes || []).filter(n => n.graph).length;
  if (nested) chips.append(el("span", "chip", `▣ ${nested} nested`));
  chips.append(el("span", "chip", `${(g.edges || []).length} edges`));
  head.append(chips);
  panel.append(head);

  if (state.ir && state.ir.description) {
    panel.append(el("div", "rolenote", state.ir.description));
  }

  const t = serveFor(g);
  if (t) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Serve"));
    sec.append(el("div", "srcline mono",
      `⟶ ${t.kind}${t.path ? " " + t.path : ""} — the client's transport`));
    if (t.description) sec.append(el("div", "srcline", t.description));
    panel.append(sec);
  }

  const doors = el("section");
  doors.append(el("div", "stitle", "Boundary"));
  const dIn = el("div", "outrow");
  for (const name of g.entries || []) dIn.append(el("span", "outchip mono", `⇥ ${name}`));
  const dOut = el("div", "outrow");
  for (const name of g.exits || []) dOut.append(el("span", "outchip mono", `${name} ⇥`));
  if (dIn.childNodes.length) doors.append(el("div", "plabel", "entries"), dIn);
  if (dOut.childNodes.length) doors.append(el("div", "plabel", "exits"), dOut);
  panel.append(doors);

  const sec = el("section");
  if (state.run) {
    sec.append(el("div", "stitle", `Painted run · ${state.run.run}`));
    // the graph's ops that ran, and apart from them the steps an agent op
    // recorded under itself (its turns, model and tool calls)
    const steps = (state.runRows || []).filter(r => r.kind === "record" && r.child).length;
    const bits = [`${AgentSteps.rootOps(state.run).length} ops ran`];
    if (steps) bits.push(`${steps} agent steps`);
    bits.push(`${state.run.records ?? "?"} records`);
    if (state.run.wall_s != null) bits.push(`${state.run.wall_s.toFixed(1)}s`);
    // the run's failure records (a list, one per failing op), or a count
    const failed = Array.isArray(state.run.errors)
      ? state.run.errors.reduce((sum, e) => sum + (e.count || 1), 0) : state.run.errors;
    if (failed) bits.push(`${failed} errors`);
    sec.append(el("div", "srcline", bits.join(" · ")));
    sec.append(el("div", "note",
      "Click any lit op for its recorded inputs and outputs; faded ops did not run."));
  } else {
    sec.append(el("div", "stitle", "Traces"));
    sec.append(el("div", "note",
      "Paint a run from the Traces tab to light this flow up with real "
      + "timings, values and errors."));
  }
  panel.append(sec);
}

function toggleExpand(key) {
  if (state.expanded.has(key)) {
    state.expanded.delete(key);
    // children of a closed box close with it, or reopening later surprises
    for (const k of [...state.expanded]) if (k.startsWith(key + "/")) state.expanded.delete(k);
  } else {
    state.expanded.add(key);
  }
  render();
}

/* ── loops, in plain words ──
 * A loop's members sit in ONE light-violet zone (laid out by flowlayout.js,
 * which also keeps every other card out of it); the zone's header says what
 * repeats and where it stops — the exit is a branch inside the loop whose
 * route leads out of it. No per-card badges: the zone says it once. */
let zoneCtx = null;
function zoneTextWidth(text) {
  if (!zoneCtx) {
    zoneCtx = document.createElement("canvas").getContext("2d");
    const fam = getComputedStyle(document.body).fontFamily || "sans-serif";
    zoneCtx.font = `600 11px ${fam}`;
  }
  return Math.ceil(zoneCtx.measureText(text).width * 1.04) + 4;
}

function loopZone(z) {
  const box = el("div", "loopzone");
  box.dataset.members = z.members.join("|");
  box.style.left = `${z.x}px`;
  box.style.top = `${z.y}px`;
  box.style.width = `${z.w}px`;
  box.style.height = `${z.h}px`;
  const head = el("div", "lzhead");
  head.style.left = `${z.head.x - z.x}px`;
  head.style.top = `${z.head.y - z.y}px`;
  for (const line of z.lines) head.append(el("div", "lzline", line));
  head.title = loopSentence(z.info) + "\n" + loopDetail(z.info);
  box.append(head);
  return box;
}

function loopSentence(info) {
  const ex = (info && info.exits) || [];
  let s = "Part of a loop: runs again every turn.";
  if (!ex.length) s += " It repeats until no step continues.";
  else s += " The loop " + ex.map((x, i) => (i ? "or " : "") + FlowLayout.exitText(x)).join(", ") + ".";
  if (info && !info.synthetic && info.max_iterations != null) s += ` At most ${info.max_iterations} turns.`;
  return s;
}

function loopDetail(info) {
  if (!info) return "";
  return info.synthetic
    ? `Compiler view: the authored cycle is rewritten into a synthetic loop '${info.group}' so the scheduler sees no cycle; its safety cap is ${info.max_iterations ?? "none"} iterations — not the flow's own turn limit.`
    : `Authored loop '${info.group}' (${info.mode})${info.until != null ? `, until ${info.until}` : ""}${info.max_iterations != null ? `, max ${info.max_iterations} iterations` : ""}.`;
}

function loopNote(n, zone) {
  const info = zone ? zone.info : {group: n.loop.group, mode: n.loop.mode,
    synthetic: n.loop.mode === "synthetic", max_iterations: n.loop.max_iterations, exits: []};
  const box = el("div", "rolenote loopnote");
  box.append(el("div", null, loopSentence(info)));
  const fold = el("details", "loopdetail");
  fold.append(el("summary", null, "details"));
  fold.append(el("div", "mono", loopDetail(info)));
  box.append(fold);
  return box;
}

function authoredLoop(it) {
  const parent = it.key.split("/").slice(0, -1).join("/");
  const g = parent ? state.rendered.get(parent)?.node.graph : state.graph;
  const lp = g && g.loops ? g.loops[it.node.id] : null;
  return lp && !lp.synthetic ? lp : null;
}

/* Where a wire leaves its loop's zone: a label spot just outside that
 * edge, beside the wire — [x, y, anchor]. */
function exitPoint(path, z) {
  const s = pathSampler(path.getAttribute("d") || "");
  if (!s) return null;
  const inside = (q) => q.x > z.x && q.x < z.x + z.w && q.y > z.y && q.y < z.y + z.h;
  const n = Math.max(20, Math.round(s.len / 6));
  for (let i = 1; i <= n; i++) {
    const q = s.at(s.len * i / n);
    if (inside(q)) continue;
    if (q.x <= z.x + 1) return [q.x - 6, q.y - 7, "end"];
    if (q.x >= z.x + z.w - 1) return [q.x + 6, q.y - 7, "start"];
    return [q.x + 8, q.y + 13, "start"];
  }
  return null;
}

/* What an opened container holds, in its own words: a nested graph's ops,
 * an agent's turns, a turn's steps. */
function containerKind(n) {
  const k = n.subgraph_ops;
  if (n.agentSteps) return `agent · ${k} turn${k === 1 ? "" : "s"}`;
  if (n.step) return `${n.kind} · ${k} step${k === 1 ? "" : "s"}`;
  // an agent's tool: the rack it hangs on already says it is one
  if (n.part === "tool") return `${TOOL_KIND_WORDS[(n.tool || {}).kind] || "@graph"} · ${k} ops`;
  return `${n.kind} · ${k} ops`;
}

function containerCard(it) {
  const n = it.node;
  const card = el("div", "node container");
  card.dataset.name = n.name;
  card.style.left = `${it.x}px`;
  card.style.top = `${it.y}px`;
  card.style.width = `${it.w}px`;
  card.style.height = `${it.h}px`;
  card.style.setProperty("--kind", kindColor(n));
  if (it.key === state.sel) card.classList.add("selected");

  if (state.run && !ranInRun(n)) card.classList.add("dormant");

  const head = el("div", "chead");
  // an agent opened (a painted run) onto the turns it took
  if (n.agentSteps) {
    // it keeps its hive cell: the same edge, the bee
    card.classList.add("agentframe");
    card.append(agentFrameEdge(it.w, it.h));
    head.append(beeMark());
    head.append(el("span", "nname", n.name));
    head.append(el("span", "nkind", containerKind(n)));
  } else {
    const promoter = el("span", "promoter", "↱");
    promoter.title = "An operon: one promoter, the genes inside transcribed together.";
    head.append(promoter);
    head.append(el("span", "nname", n.name));
    head.append(el("span", "nkind", containerKind(n)));
  }
  // an AUTHORED loop (classic / until — not the compiler's rewrite of a
  // cycle, which is drawn as a zone) is this container: say it repeats
  const lp = authoredLoop(it);
  if (lp) {
    const info = {group: n.name, mode: lp.mode, synthetic: false, until: lp.until,
                  max_iterations: lp.max_iterations, exits: []};
    const t = el("span", "lzline cloopnote", FlowLayout.loopHeader(info, 1e9)[0]);
    t.title = loopSentence(info) + "\n" + loopDetail(info);
    head.append(t);
  }
  const close = el("button", "collapse", "▾ collapse");
  close.title = "Collapse this graph back into a single node";
  close.onclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
  head.append(close);
  head.onclick = (ev) => { ev.stopPropagation(); select(it.key); };
  card.append(head);

  // no rim ports: the START/END pills inside are the container's ports now
  return card;
}

/* ── the agent op: a hive cell ──────────────────────────────────────
 * An agent is the op that decides for itself, so it does not look like
 * the others: an octagon cell with a glossy steel edge and a soft glow,
 * a faint honeycomb inside, and the bee. On its right edge, three round
 * sockets: ✧ the model it thinks with, the database of its memory, ⚒ its
 * tools. Opened, each socket is wired to the real op behind it, drawn as
 * the card that op is anywhere else (extract.py `_agent_parts`): the
 * model's LLM cell, its session store, each tool — an @op's cell, a
 * @graph's card that opens like any GraphOp, another agent's cell that
 * opens like this one. The wires are the agent's own, never the flow's:
 * the model's a nerve with one spike, memory's three lanes of bandwidth,
 * the tools' a rack — one trunk to a bus, a straight branch to each.
 * With a run painted the pips fill with the turns it took; a live run
 * sweeps a light along the edge and sets the wires moving. */
const TOOL_ICONS = {function: "ƒ", op: "◈", graph: "▣", agent: "✺", mcp: "⇄"};
const TOOL_KIND_WORDS = {function: "function", op: "@op", graph: "@graph", agent: "agent",
                         mcp: "MCP tool"};

/* An opened agent's edge: an octagon outline the size of the frame, so
 * the wires inside stay visible (a filled layer would cover them). */
let agentFrameSeq = 0;
function agentFrameEdge(w, h) {
  const NS = "http://www.w3.org/2000/svg";
  const cut = 22, id = `agfr${++agentFrameSeq}`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "aframe");
  svg.setAttribute("width", w); svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const pts = [[cut, 1], [w - cut, 1], [w - 1, cut], [w - 1, h - cut], [w - cut, h - 1],
               [cut, h - 1], [1, h - cut], [1, cut]].map(p => p.join(",")).join(" ");
  svg.innerHTML = `<defs>
      <linearGradient id="${id}e" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="var(--ag-e4)"/><stop offset=".3" stop-color="var(--ag-e2)"/>
        <stop offset=".45" stop-color="var(--ag-e1)"/><stop offset=".6" stop-color="var(--ag-e2)"/>
        <stop offset="1" stop-color="var(--ag-e4)"/></linearGradient>
      <pattern id="${id}c" width="28" height="48.5" patternUnits="userSpaceOnUse">
        <path d="M14 0l14 8.08v16.17L14 32.33 0 24.25V8.08z M14 32.33v16.17" fill="none"
          stroke="var(--ag-e2)" stroke-opacity=".14" stroke-width="1"/></pattern></defs>
    <polygon points="${pts}" fill="var(--ag-frame)"/>
    <polygon points="${pts}" fill="url(#${id}c)"/>
    <polygon class="aedge" points="${pts}" fill="none" stroke="url(#${id}e)" stroke-width="2.5"/>`;
  return svg;
}

function beeMark() {
  const b = el("span", "abee");
  b.setAttribute("aria-hidden", "true");
  return b;
}

function agentSub(n) {
  const a = n.agent || {};
  const model = (a.model || [])[0];
  const tools = (a.tools || []).length;
  return `agent${model ? " · " + model : ""} · ${tools} tool${tools === 1 ? "" : "s"}`;
}

/* How many turns this agent took in the painted run: its `turn` steps. */
function agentTurns(n) {
  if (!state.run) return 0;
  const rows = state.runRows || [];
  const mine = rows.filter(r => r.kind === "record" && r.op === "turn"
    && typeof r.id === "string" && r.id.startsWith(n.id + ".turn#"));
  if (mine.length) return mine.length;
  const t = state.run.ops && state.run.ops.turn;
  return t ? t.runs : 0;
}

function agentPips(n) {
  const cap = ((n.agent || {}).limits || {}).turns;
  const took = agentTurns(n);
  const row = el("span", "apips");
  if (!cap && !took) return row;
  const shown = Math.min(cap || took, 8);
  for (let i = 0; i < shown; i++) {
    row.append(el("span", "apip" + (i < took ? " done" : "")));
  }
  if (cap > 8) row.append(el("span", "apipmore", `≤${cap}`));
  row.title = cap ? `${took ? took + " of " : "at most "}${cap} turns` : `${took} turns`;
  return row;
}

function agentCard(card, it) {
  const n = it.node;
  card.classList.add("agentcell");
  card.append(el("span", "ahull"), el("span", "abody"));
  const head = el("div", "ahead");
  head.append(beeMark());
  const who = el("div", "awho");
  who.append(el("div", "nname ntext", n.name));
  who.append(el("div", "asub", agentSub(n)));
  head.append(who);
  head.append(agentPips(n));
  card.append(head);
  const open = state.expanded.has(it.key);
  if (n.parts && n.parts.length) {
    card.append(agentSockets(n, it.key));
    const b = el("button", "aopen", open ? "▾" : "▸");
    b.title = open ? "Fold its parts back into the agent."
      : "Open the agent: its model, its memory and each tool, as the ops they are.";
    b.onclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
    head.append(b);
  }
  card.title = `${n.name} — ${agentSub(n)}. Double-click to ${open ? "fold" : "open"} it.`;
}

/* The agent's three sockets, top to bottom: model, memory, tools. A
 * socket with nothing behind it (no session store: each run starts
 * fresh) is shown empty; clicking one opens the agent. */
const SOCK_DY = {model: -26, memory: 0, tool: 26};
function agentSockets(n, key) {
  const a = n.agent || {};
  const have = new Set((n.parts || []).map(p => p.part));
  const tools = (a.tools || []).length;
  const box = el("span", "asocks");
  const sock = (part, icon, tip) => {
    const s = el("span", `asock s-${part}` + (have.has(part) ? "" : " empty"));
    s.style.top = `calc(50% + ${SOCK_DY[part]}px)`;
    if (typeof icon === "string") s.textContent = icon; else s.append(icon);
    s.title = tip;
    s.onclick = (ev) => { ev.stopPropagation(); toggleExpand(key); };
    box.append(s);
  };
  sock("model", "✧", `model: ${(a.model || []).join(" → ") || "?"}`);
  sock("memory", dbIcon(), have.has("memory")
    ? "memory: a conversation kept per session_id"
    : "memory: none — each run starts fresh (sessions= gives it one)");
  sock("tool", "⚒", `tools: ${tools ? (a.tools || []).map(t => t.name).join(", ") : "none — it only answers"}`);
  return box;
}

/* A database, the memory's icon: on its socket and on its card. */
function dbIcon() {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "dbicon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<ellipse cx="8" cy="3.6" rx="5.6" ry="2.2"/>'
    + '<path d="M2.4 3.6v8.6c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2V3.6M2.4 7.9c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2"/>';
  return svg;
}

/* The wires from an opened agent's sockets to its parts. Thin, in the
 * socket's colour, each ending in a ring on the part's card: the model's
 * a nerve (one spike mid-way; impulses run to the LLM), memory's three
 * lanes of bandwidth (data blocks stream into the store), the tools' a
 * rack (a trunk into a bus beside the tools, a straight branch with a
 * joint to each; a call runs out to a tool and back). What moves sits in
 * `.apw-anim`, shown only while a run is live (liveCanvas). */
let apwSeq = 0;
function drawAgentParts(svg, parts) {
  state.partWires = new Map();
  const byAgent = new Map();
  for (const P of parts || []) {
    if (!byAgent.has(P.agent)) byAgent.set(P.agent, []);
    byAgent.get(P.agent).push(P);
  }
  const mk = (tag, attrs, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  };
  const f = (v) => v.toFixed(1);
  const bez = (e, t) => {
    const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = e, u = 1 - t;
    return [u*u*u*x0 + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*x1, u*u*u*y0 + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*y1];
  };
  const angle = (e, t) => {
    const p = bez(e, Math.max(0, t - 0.01)), q = bez(e, Math.min(1, t + 0.01));
    return Math.atan2(q[1] - p[1], q[0] - p[0]);
  };
  const offset = (e, off) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, q = bez(e, t), r = angle(e, t);
      pts.push(`${f(q[0] - Math.sin(r) * off)} ${f(q[1] + Math.cos(r) * off)}`);
    }
    return "M" + pts.join(" L");
  };
  const ride = (g, shape, attrs, id, dur, begin, extra = {}) => {
    const m = mk(shape, attrs, g);
    const an = mk("animateMotion", {dur, begin, repeatCount: "indefinite", ...extra}, m);
    mk("mpath", {href: `#${id}`}, an);
  };
  const anchor = (it) => ({x: it.x, y: it.inner ? it.y + 17 : it.y + Math.min(it.h / 2, 32)});
  for (const [A, mine] of byAgent) {
    const g = mk("g", {class: "apw", "data-agent": A.key}, svg);
    const anim = mk("g", {class: "apw-anim"});
    state.partWires.set(A.key, g);
    const sx = A.x + A.w + 11, sy = (part) => A.y + A.h / 2 + SOCK_DY[part];
    for (const P of mine.filter(q => q.part !== "tool")) {
      const to = anchor(P.item), y0 = sy(P.part), x1 = to.x - 6;
      const e = [sx, y0, sx + 52, y0, x1 - 52, to.y, x1, to.y];
      const d = `M${f(sx)} ${f(y0)} C${f(e[2])} ${f(e[3])} ${f(e[4])} ${f(e[5])} ${f(x1)} ${f(to.y)}`;
      const id = `apw${++apwSeq}`;
      const cls = `apw-${P.part}`;
      if (P.part === "model") {
        mk("path", {id, d, class: `apw-line ${cls}`}, g);
        const [mx, my] = bez(e, 0.5), r = angle(e, 0.5) * 180 / Math.PI;
        const spike = mk("g", {transform: `translate(${f(mx)} ${f(my)}) rotate(${f(r)})`}, g);
        mk("rect", {x: -9, y: -7, width: 18, height: 12, class: "apw-gap"}, spike);
        mk("path", {d: "M-9 0 H-4 L-2 -6 L1 5 L3 -2 L4.5 0 H9", class: `apw-spike ${cls}`}, spike);
        for (const begin of ["0s", "0.8s"]) ride(anim, "circle", {r: 2.3, class: `apw-dot ${cls}`}, id, "1.6s", begin);
      } else {
        mk("path", {id, d, class: "apw-track"}, g);
        for (const [o, k] of [[-2.6, " side"], [0, ""], [2.6, " side"]])
          mk("path", {d: offset(e, o), class: `apw-lane ${cls}${k}`}, g);
        for (const begin of ["0s", "0.55s", "1.1s", "1.65s"])
          ride(anim, "rect", {x: -3.5, y: -1.6, width: 7, height: 3.2, rx: 1, class: `apw-dot ${cls}`},
               id, "2.2s", begin, {rotate: "auto"});
      }
      mk("circle", {cx: f(x1), cy: f(to.y), r: 3.6, class: `apw-ring ${cls}`}, g);
    }
    // the tools' rack
    const tools = mine.filter(q => q.part === "tool");
    if (tools.length) {
      const y0 = sy("tool");
      const ys = tools.map(P => anchor(P.item).y);
      const px = Math.min(...tools.map(P => P.item.x));
      const bx = px - 34;
      const cls = "apw-tool";
      mk("path", {d: `M${f(sx)} ${f(y0)} H${f(bx)}`, class: `apw-line ${cls}`}, g);
      mk("path", {d: `M${f(bx)} ${f(Math.min(y0, ...ys))} V${f(Math.max(y0, ...ys))}`, class: `apw-line ${cls}`}, g);
      mk("circle", {cx: f(bx), cy: f(y0), r: 3, class: `apw-joint ${cls}`}, g);
      tools.forEach((P, i) => {
        const x1 = P.item.x - 6;
        mk("path", {d: `M${f(bx)} ${f(ys[i])} H${f(x1)}`, class: `apw-line ${cls}`}, g);
        mk("circle", {cx: f(bx), cy: f(ys[i]), r: 2.4, class: `apw-ring ${cls}`}, g);
        mk("circle", {cx: f(x1), cy: f(ys[i]), r: 3.6, class: `apw-ring ${cls}`}, g);
      });
      // a call: out along the rack to a tool and its answer back, each tool in turn
      tools.forEach((P, i) => {
        const id = `apw${++apwSeq}`;
        mk("path", {id, d: `M${f(sx)} ${f(y0)} H${f(bx)} V${f(ys[i])} H${f(P.item.x - 6)}`, class: "apw-track"}, anim);
        const dur = 2.6 * tools.length;
        const a0 = i / tools.length, a1 = (i + 0.4) / tools.length, a2 = (i + 0.5) / tools.length, a3 = (i + 0.9) / tools.length;
        const times = [0, a0, a1, a2, a3, 1].map(v => v.toFixed(3)).join(";");
        ride(anim, "circle", {r: 2.6, class: `apw-dot ${cls}`}, id, `${dur}s`, "0s",
             {keyPoints: "0;0;1;1;0;0", keyTimes: times, calcMode: "linear"});
      });
    }
    g.append(anim);
  }
}

/* An agent's tool: what it is, and what the policy decides. */
function toolLine(n) {
  const t = n.tool || {};
  const line = el("div", "atool");
  line.append(el("span", "atkind", TOOL_KIND_WORDS[t.kind] || "function"));
  const policy = t.policy || "allow";
  const chip = el("span", "atpolicy p-" + policy, policy.toUpperCase());
  chip.title = policy === "allow" ? "Runs when the model calls it."
    : policy === "ask" ? "Waits for a human's approval before it runs."
    : "Refused: the model is told it may not call it.";
  line.append(chip);
  const runs = state.run && state.run.ops && state.run.ops[n.name];
  if (runs) line.append(el("span", "atcount", `×${runs.runs}`));
  return line;
}

/* The pills that ARE an opened GraphOp's boundary. Clicking one selects
 * the container — they represent the GraphOp itself. */
function boundaryCard(it) {
  const n = it.node;
  const card = el("div", `node bnode b-${n.boundary}`);
  card.dataset.name = n.name;
  card.style.left = `${it.x}px`;
  card.style.top = `${it.y}px`;
  card.style.width = `${it.w}px`;
  card.style.height = `${it.h}px`;
  // ︎ forces TEXT presentation — without it Chromium may pick the
  // emoji ▶️, which paints a stray blue box inside the button
  card.append(el("span", "bglyph", n.boundary === "start" ? "▶︎" : "■︎"));
  const parentKey = it.key.split("/").slice(0, -1).join("/");
  if (n.knob) {
    // a knob on the container's border: glyph only, the word in the tip
    card.classList.add("knob");
    const owner = state.rendered.get(parentKey)?.node.name || "this graph";
    card.title = n.boundary === "start"
      ? `START of ${owner} — outside wires plug in here`
      : `END of ${owner} — results leave for the outside here`;
  } else {
    card.append(el("span", "blabel", n.name));
    card.title = n.boundary === "start"
      ? "The flow's input boundary — the session starts here."
      : "The flow's output boundary — results leave here.";
  }
  card.onclick = (ev) => {
    ev.stopPropagation();
    if (!n.knob) { toggleTerm(n.boundary); return; }   // the main flow's START / END
    select(parentKey);
  };
  return card;
}

/* START, END and the SCRATCH pad open on a click: every op their values
 * reach opens with just those plugs, the wires drawn, the rest dimmed. */
// a redraw replaces the row under the pointer, so its own leave never
// fires: the hovered variable clears once the pointer is off every row of it
document.addEventListener("pointermove", (ev) => {
  if (state.dfTermHover != null) {
    const r = ev.target.closest && ev.target.closest(".dfterm .dftermrow");
    if (!(r && r.dataset.port === state.dfTermHover)) { state.dfTermHover = null; drawDataLayer(); }
  }
});

function toggleTerm(kind) {
  state.dfTerm = state.dfTerm === kind ? null : kind;
  state.dfTermPort = state.dfTermHover = null;
  dfPort = null;
  if (state.sel) { state.sel = null; renderFlowInfo(); }
  render();
}

// the op's kind (FUNC / LLM / GRAPH…), bound (SYNC / IO / CPU) and the
// generator flash ride the name line as quiet buttons, instead of
// hiding below the fold — the kind wears its family colour so it can
// never be mistaken for part of the name
function nameChips(n) {
  const box = el("span", "nchips");
  if (n.kind) {
    // a long custom kind must not eat the op's name: strip the Op
    // suffix, then keep whole camel-case words while they fit — the
    // full kind always lives in the tooltip
    const words = String(n.kind).replace(/Op$/, "")
      .match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) || [n.kind];
    let short = words[0];
    for (const w of words.slice(1)) {
      if ((short + w).length > 9) break;
      short += w;
    }
    const c = el("span", "nchip kind", short.toUpperCase());
    c.title = n.kind;
    box.append(c);
  }
  if (n.bound) {
    const c = el("span", "nchip", String(n.bound).toUpperCase());
    c.title = `execution bound: ${n.bound}`;
    box.append(c);
  }
  if (n.is_gen) {
    const c = el("span", "nchip gen", "⚡");
    c.title = "Generator: consumers dispatch per yield, not per run.";
    box.append(c);
  }
  return box.childNodes.length ? box : null;
}

/* With a run painted, a card says ONE thing — the lens decides which.
 * path: nothing but lit / faded. time: the op's total time in the run,
 * the three slowest ranked, the border warmer with its share. errors:
 * only failures, with their error. cost: only ops that cost money.
 * values: executions and average, and the show-key values. */
/* An op's numbers in the painted run — a nested graph's are its members'
 * summed (a container never executes under its own name). */
/* A step's own numbers: the one execution the run recorded. */
function stepNumbers(n) {
  const s = n.step;
  const bad = s.status && s.status !== "ok";
  return {runs: 1, total_ms: s.dur_ms || 0, max_ms: s.dur_ms || 0, errors: bad ? 1 : 0,
          last_error: bad ? (s.error || s.status) : null};
}

function runNumbers(n) {
  const rolls = state.runRollups || new Map();
  if (n.step) return {info: stepNumbers(n), roll: null};
  if (n.agentSteps) {
    // an agent op opened onto its steps: its own record's numbers, not its
    // members' summed (they are inside its time)
    const info = state.run && state.run.ops[n.name];
    return info ? {info, roll: rolls.get(n.name) || null} : null;
  }
  if (!n.graph) {
    const info = state.run && state.run.ops[n.name];
    return info ? {info, roll: rolls.get(n.name) || null} : null;
  }
  const acc = {runs: 0, total_ms: 0, max_ms: 0, errors: 0, last_error: null};
  const roll = {count: 0, total_ms: 0, cost_usd: null, unpriced: 0, tokens_in: 0, tokens_out: 0};
  let any = false;
  (function walk(g) {
    for (const m of (g && g.nodes) || []) {
      if (m.step && !m.graph) {
        const i = stepNumbers(m);
        any = true;
        acc.runs += 1; acc.total_ms += i.total_ms; acc.max_ms = Math.max(acc.max_ms, i.max_ms);
        acc.errors += i.errors; acc.last_error = i.last_error || acc.last_error;
        continue;
      }
      if (m.graph) { walk(m.graph); continue; }
      const i = state.run.ops[m.name];
      if (!i) continue;
      any = true;
      acc.runs += i.runs; acc.total_ms += i.total_ms; acc.max_ms = Math.max(acc.max_ms, i.max_ms);
      acc.errors += i.errors; acc.last_error = i.last_error || acc.last_error;
      const r = rolls.get(m.name);
      if (r) {
        roll.count += r.count; roll.total_ms += r.total_ms; roll.unpriced += r.unpriced;
        roll.tokens_in += r.tokens_in; roll.tokens_out += r.tokens_out;
        if (r.cost_usd != null) roll.cost_usd = (roll.cost_usd || 0) + r.cost_usd;
      }
    }
  })(n.graph);
  return any ? {info: acc, roll} : null;
}

function lensBadge(card, badges, n) {
  const lens = state.lens || "path";
  const got = runNumbers(n);
  const runinfo = got && got.info;
  const roll = got && got.roll;
  if (!runinfo) {
    if (lens !== "path" && lens !== "values") card.classList.add("quiet");
    return;
  }
  // a failure is shown whatever the lens: it is what a run page is opened for
  if (runinfo.errors && lens !== "errors") {
    const last = String(runinfo.last_error || "failed").trim().split("\n").pop();
    const chip = el("span", "badge err errline", `${runinfo.errors}✗ ${last}`);
    chip.title = String(runinfo.last_error || "");
    badges.append(chip);
    card.classList.add("errorlit");
  }
  if (lens === "time") {
    const runMs = (state.run.wall_s || 0) * 1000;
    if (roll && RunView.background(roll, runMs)) {
      const chip = el("span", "badge run", "whole run");
      chip.title = `Spans the session (${fmtMs(runinfo.total_ms)}) — its time is the call's length, not work`;
      badges.append(chip);
      return;
    }
    const ranked = [...(state.runRollups || new Map()).values()]
      .filter(r => !RunView.background(r, runMs)).slice(0, 3).map(r => r.op);
    const place = ranked.indexOf(n.name);
    const chip = el("span", "badge run", fmtMs(runinfo.total_ms));
    chip.title = `${runinfo.runs} execution${runinfo.runs > 1 ? "s" : ""} · max ${fmtMs(runinfo.max_ms)}`;
    if (place >= 0) {
      const r = el("span", "badge rank", `#${place + 1}`);
      r.title = `${["Slowest", "Second slowest", "Third slowest"][place]} op in this run`;
      badges.append(r);
    }
    badges.append(chip);
    const top = Math.max(1, ...[...(state.runRollups || new Map()).values()]
      .filter(r => !RunView.background(r, runMs)).map(r => r.total_ms));
    card.style.setProperty("--heat", Math.min(1, runinfo.total_ms / top).toFixed(2));
    card.classList.add("heated");
  } else if (lens === "errors") {
    if (!runinfo.errors) { card.classList.add("quiet"); return; }
    const last = String(runinfo.last_error || "failed").trim().split("\n").pop();
    const chip = el("span", "badge err errline", `${runinfo.errors}✗ ${last}`);
    chip.title = String(runinfo.last_error || "");
    badges.append(chip);
    card.classList.add("errorlit");
  } else if (lens === "cost") {
    if (!roll || (roll.cost_usd == null && !roll.unpriced)) { card.classList.add("quiet"); return; }
    const chip = el("span", "badge run cost", RunView.money(roll.cost_usd, roll.unpriced));
    chip.title = `${roll.tokens_in} in / ${roll.tokens_out} out tokens`;
    badges.append(chip);
  } else if (lens === "values") {
    const avg = runinfo.runs ? (runinfo.total_ms / runinfo.runs) : 0;
    const chip = el("span", "badge run",
      `${runinfo.runs}× ${avg < 10 ? avg.toFixed(1) : Math.round(avg)}ms`
      + (runinfo.errors ? ` · ${runinfo.errors}✗` : ""));
    if (runinfo.errors) chip.classList.add("err");
    badges.append(chip);
  }
}

/* Each zone's brackets: under the books, one per `and` / `or`, joined at
 * its books' feet (or its inner brackets' joints), a level deeper per
 * nesting; the root's stem drops to the zone's foot, where its socket
 * sits. `and` is solid, `or` dashed; each carries its operator in a small
 * square, turned with the text. The run's light rides the stem. Reads the
 * laid-out books, then writes one svg per zone (absolute: no re-layout). */
function drawCondTrees(card) {
  const zones = [...card.querySelectorAll(".brrow")].filter(z => z._tree);
  const plans = zones.map(zone => {
    const books = zone.querySelector(".brbooks");
    const foot = Math.max(...[...books.children].map(b => b.offsetTop + b.offsetHeight));
    const lines = [], marks = [];
    const at = (n) => {
      if (!n.op) return {x: n.el.offsetLeft + n.el.offsetWidth / 2, y: foot};
      const ks = n.kids.map(at), y = foot + 9 + (CondTree.depth(n) - 1) * 14;
      const x1 = Math.min(...ks.map(k => k.x)), x2 = Math.max(...ks.map(k => k.x));
      const cls = n.op === "&" ? "cand" : "cor";
      for (const k of ks) lines.push([`M ${k.x} ${k.y} V ${y}`, cls]);
      lines.push([`M ${x1} ${y} H ${x2}`, cls]);
      const x = (x1 + x2) / 2;
      marks.push({x, y, op: n.op});
      return {x, y};
    };
    const root = at(zone._tree);
    // the stem runs on past the zone to the socket on the card's edge
    const end = card.offsetHeight - card.clientTop - zone.offsetTop - zone.clientTop;
    return {zone, root, lines, marks, h: zone.clientHeight, w: zone.clientWidth, end};
  });
  for (const {zone, root, lines, marks, h, w, end} of plans) {
    zone.querySelector("svg.ctree")?.remove();
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "ctree");
    svg.setAttribute("width", w); svg.setAttribute("height", h);
    const path = (d, cls) => { const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); p.setAttribute("class", cls); svg.append(p); };
    for (const [d, cls] of lines) path(d, cls);
    path(`M ${root.x} ${root.y} V ${end}`, "cstem");
    for (const m of marks) {
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "cmark " + (m.op === "&" ? "cand" : "cor"));
      const r = document.createElementNS(SVGNS, "rect");
      r.setAttribute("x", m.x - 5.5); r.setAttribute("y", m.y - 5.5);
      r.setAttribute("width", 11); r.setAttribute("height", 11); r.setAttribute("rx", 2.5);
      const t = document.createElementNS(SVGNS, "text");
      t.setAttribute("x", m.x); t.setAttribute("y", m.y + 0.5);
      t.setAttribute("transform", `rotate(90 ${m.x} ${m.y})`);
      t.textContent = m.op;
      const tip = document.createElementNS(SVGNS, "title");
      tip.textContent = m.op === "&" ? "and: every clause must hold" : "or: any one clause";
      g.append(r, t, tip);
      svg.append(g);
    }
    if (zone.dataset.took) {
      const led = document.createElementNS(SVGNS, "circle");
      led.setAttribute("class", "cled"); led.setAttribute("cx", root.x); led.setAttribute("cy", h - 8); led.setAttribute("r", 3);
      const tip = document.createElementNS(SVGNS, "title");
      tip.textContent = "the run took this route";
      led.append(tip);
      svg.append(led);
    }
    zone.prepend(svg);
    zone.dataset.stem = String(root.x);
    const port = zone.querySelector(".brport");
    if (port) port.style.left = `${root.x}px`;
  }
}

/* A branch reads its inputs IN its conditions: each input's plug moves
 * into the first condition that names it (the wire plugs into the name),
 * later mentions wear the same chip, hole-less; nothing is listed twice.
 * An input no condition names keeps its plug row. */
function inlineBranchPlugs(card, ports) {
  const conds = [...card.querySelectorAll(".brrow .brcond")];
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  [...ports.querySelectorAll(".dfcol.in .dfport.in")].forEach((plug, vi) => {
    const name = plug.dataset.port;
    // one colour per variable: its plug and every later mention wear it
    plug.dataset.vi = String(vi % 5);
    const copies = [];
    const re = new RegExp(`(^|[^\\w.])(${esc(name)})(?![\\w])`);
    let placed = false;
    for (const c of conds) {
      // split this condition's text nodes round the name, once per node
      for (const tn of [...c.childNodes].filter(x => x.nodeType === 3)) {
        const m = re.exec(tn.data);
        if (!m) continue;
        const at = m.index + m[1].length;
        const after = tn.splitText(at);
        after.data = after.data.slice(name.length);
        if (!placed) {
          plug.classList.add("brchip");
          c.insertBefore(plug, after);
          placed = true;
        } else {
          // the same size as the plug: a ring where its hole is, no socket
          const ghost = el("span", "brchip ghost mono");
          ghost.append(el("span", "ghosthole"), el("span", "dfname", name));
          ghost.title = `${name} — the same value as its plug`;
          ghost.dataset.vi = plug.dataset.vi;
          // a mention is the plug's: pointing at it or clicking it does
          // what the plug does (as events: the data layer adds its own
          // listeners to the plug, and replaces its handlers)
          ghost.onmouseenter = () => plug.dispatchEvent(new MouseEvent("mouseenter"));
          ghost.onmouseleave = () => plug.dispatchEvent(new MouseEvent("mouseleave"));
          ghost.onclick = (ev) => { ev.stopPropagation(); plug.click(); };
          copies.push(ghost);
          c.insertBefore(ghost, after);
        }
        break;
      }
    }
    // … and shines when the plug does: followed (its classes), or pointed
    // at (listeners, not handlers — the data layer replaces those)
    if (placed && copies.length) {
      const mirror = () => { for (const g of copies) for (const k of ["hot", "lit", "lit2", "picked"]) g.classList.toggle(k, plug.classList.contains(k)); };
      new MutationObserver(mirror).observe(plug, {attributes: true, attributeFilter: ["class"]});
      const all = [plug, ...copies];
      plug.addEventListener("mouseenter", () => { for (const c of all) c.classList.add("vhot"); });
      plug.addEventListener("mouseleave", () => { for (const c of all) c.classList.remove("vhot"); });
    }
  });
  const cin = ports.querySelector(".dfcol.in");
  if (cin && !cin.children.length) cin.remove();
  if (!ports.querySelector(".dfport")) ports.remove();
}

function opCard(it) {
  const n = it.node;
  if (n.kind === "__boundary__") return boundaryCard(it);
  const card = el("div", "node");
  card.dataset.name = n.name;
  card.style.left = `${it.x}px`;
  card.style.top = `${it.y}px`;
  card.style.setProperty("--kind", kindColor(n));
  if (it.key === state.sel) card.classList.add("selected");
  // The serve boundary is a door, not an op: ingress is where the
  // client's data enters the run, egress where answers leave. Drawn in
  // the serve family so the eye groups it with the front-door card, and
  // labelled as a boundary so nobody hunts for business logic inside.
  if (n.serve_role) {
    card.classList.add("gate", `gate-${n.serve_role}`);
    // the author's name, unadorned — the frame's INGRESS/EGRESS label
    // is the one word that explains the zone
    card.append(el("div", "nname", n.name));
    // the ingress IS the transport — one compact line, nothing more
    const t = n.serve_role === "ingress" && serveFor(state.graph);
    if (t) card.append(el("div", "nkind mono",
      t.kind + (t.path ? ` · ${t.path}` : "")));
    if (t && t.description) card.title = t.description;
  } else if (n.op_type === "agent" && n.agent) {
    agentCard(card, it);
  } else if (n.routes && n.routes.length) {
    // a router is a DECISION CARD: one zone per route, side by side in
    // route order, each with its own exit on the card's bottom edge — the
    // flow runs down, so each wire drops straight to its target. In a zone
    // each clause of the condition is a book (its text top to bottom), and
    // each `and` / `or` a bracket under the books it joins, the brackets
    // nesting as the condition does; the last one's stem runs into the
    // socket (drawCondTrees, once the card is measured). Hovering a zone
    // says the condition flat; clicking one picks it in the decision table.
    card.classList.add("branch", "cols");
    const line = el("div", "nname nline");
    line.append(el("span", "nicon", kindIcon(n)));
    line.append(el("span", "ntext", n.name));
    const chips = state.run ? null : nameChips(n);
    if (chips) line.append(chips);
    card.append(line);
    card.title = n.kind + (n.bound ? ` · ${n.bound}` : "");
    const list = el("div", "brlist");
    // which route the painted run took last: its port's light is on
    const lastOut = state.run && state.run.ops && state.run.ops[n.name] && state.run.ops[n.name].last;
    const took = lastOut && lastOut.target != null ? n.routes.findIndex(r => r.target === lastOut.target) : -1;
    const trees = n.routes.map(r => (r.condition === "else" ? {text: "else"} : CondTree.parse(r.condition)));
    // every zone keeps the same room under its books for the deepest
    // condition's brackets, so every book in the router is one height
    const room = Math.max(...trees.map(CondTree.depth)) * 14 + 16;
    n.routes.forEach((r, ri) => {
      const picked = state.route && state.route.key === it.key && state.route.ri === ri;
      const rrow = el("div", "brrow" + (r.condition === "else" ? " relse" : "") + (picked ? " picked" : ""));
      rrow.dataset.target = r.target;
      rrow.dataset.route = String(ri);
      if (ri === took) rrow.dataset.took = "1";
      const books = el("div", "brbooks");
      for (const leaf of CondTree.leaves(trees[ri])) {
        const book = el("span", "brcond book mono" + (leaf.text === "else" && r.condition === "else" ? " elsebook" : ""), leaf.text);
        leaf.el = book;
        books.append(book);
      }
      rrow.append(books);
      const under = el("div", "brroom");
      under.style.height = `${room}px`;
      rrow.append(under);
      rrow._tree = trees[ri];
      rrow.append(el("span", "brport"));
      rrow.setAttribute("aria-label", `${r.condition} → ${r.target}`);
      rrow.onpointerenter = (ev) => routeTip(ev, it.key, ri, r);
      rrow.onpointermove = (ev) => routeTipMove(ev);
      rrow.onpointerleave = () => routeTip(null);
      rrow.onclick = (ev) => { ev.stopPropagation(); routeTip(null); pickRoute(it.key, ri); };
      list.append(rrow);
    });
    card.append(list);
  } else {
    // a brain cell, with two membrane variants so a row of cells reads
    // organic instead of stamped
    card.classList.add("cell", n.name.length % 2 ? "alt" : "base");
    // the kind's icon fills the cell's left quarter — a pastel
    // half-oval slice cut along the membrane, not a badge on the line
    card.append(el("span", "iconband", kindIcon(n)));
    const line = el("div", "nname nline");
    line.append(el("span", "ntext", n.name));
    const chips = state.run ? null : nameChips(n);
    if (chips) line.append(chips);
    card.append(line);
    // an agent's tools are what it can DO: one line under its name
    const tools = agentToolsLine(n);
    if (tools) card.append(tools);
    // an agent's tool says what it is and what the policy lets it do
    if (n.part === "tool") {
      card.classList.add("agenttool");
      card.append(toolLine(n));
    }
    // an agent's memory wears the database it is
    if (n.part === "memory") card.querySelector(".iconband").replaceChildren(dbIcon());
    // the kind line was card noise at fit-zoom; it lives in the
    // tooltip and the inspector — and on the card once it is clicked
    // (the .detail block shows on the selected card only)
    card.title = n.kind + (n.bound ? ` · ${n.bound}` : "") + (n.is_gen ? " · generator" : "");
    // Clicked, the card says what the op PRODUCES, not its port
    // list: inputs are the wires, and most outputs are plumbing every
    // op passes along. show_keys (declared on the op, its kind's
    // default, or the extractor's pick from the dataflow) name the one
    // or two outputs that stand for it. With a run painted the same
    // line carries the last execution's value, cut to a card's width.
    const det = el("div", "detail");
    const keys = (state.run && (state.lens || "path") !== "values") ? [] : (n.show_keys || []).slice(0, 2);
    const turnExec = state.run && state.runTurn && state.runByOpTurn
      && state.runByOpTurn.get(n.name) && state.runByOpTurn.get(n.name).get(state.runTurn);
    const vals = n.step ? n.step.outputs : turnExec ? turnExec.outputs
      : (state.run && !state.runTurn && state.run.ops[n.name] && state.run.ops[n.name].last);
    const where = n.step ? `at ${n.step.ctx}` : turnExec ? `in ${state.runTurn}`
      : `last value of ${state.run ? state.run.run : ""}`;
    for (const k of keys) {
      const row = el("div", "dshow mono");
      row.append(el("span", "dkey", "→ " + k));
      if (vals && k in vals) {
        row.append(el("span", "dval", " = " + Values.brief(vals[k], 40)));
        row.title = `${k}: ${where}`;
      } else {
        row.title = "show key: the output that stands for this op";
      }
      det.append(row);
    }
    if (det.childNodes.length) card.append(det);
  }

  if (canvasView === "data" || (state.dfOpen && state.dfOpen.has(it.key) && !it.inner)) {
    const ports = dfPortsBlock(it, canvasView === "workflow" ? state.dfOpen.get(it.key) : null);
    if (ports) {
      card.append(ports); card.classList.add("dfcard", canvasView === "data" ? "dfdata" : "dfopen");
      // its plugs name its outputs now: the "→ key" lines would say it
      // twice (a run's painted values stay — they say something new)
      const det = card.querySelector(".detail");
      if (det && !det.querySelector(".dval")) det.remove();
      if (n.routes && n.routes.length) inlineBranchPlugs(card, ports);
    }
  }
  // At most TWO badges: one semantic marker, plus the run chip. Density
  // is respect — everything else is one click away in the inspector.
  const badges = el("div", "badges");
  // an agent card opens from its own row (agentCard): no generic badge
  if (n.graph && !card.classList.contains("agentcell")) {
    const b = el("button", "badge sub expand", `▣ ${n.subgraph_ops} ▸`);
    b.title = n.agentSteps ? "This run's turns — click to open them in place."
      : n.step ? "The steps under it — click to open them in place."
      : "A nested @graph — click to open it in place.";
    b.onclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
    badges.append(b);
  }
  // a loop's member wears no badge: the violet zone it sits in says it

  if (state.run && !ranInRun(n)) card.classList.add("dormant");
  if (state.run) lensBadge(card, badges, n);
  if (state.changedOps && state.changedOps.has(n.name)) {
    card.classList.add("changed");
    const b = el("span", "badge changedbadge", "changed");
    b.title = "Its code changed in the last edit";
    badges.append(b);
  }
  card.append(badges);
  // an agent's part is wired from its socket, never into the flow: no ports
  if (!n.part) {
    card.append(el("span", "port in"));
    // a router's exits are its condition rows — no anonymous base port
    if (!(n.routes && n.routes.length)) card.append(el("span", "port out"));
  }
  card.onclick = (ev) => { ev.stopPropagation(); select(it.key); };
  card.onmouseenter = () => dfHoverEnter(it.key);
  card.onmouseleave = () => dfHoverLeave(it.key);
  if (n.graph || n.parts) card.ondblclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
  return card;
}

/* ── view: the canvas is a scrollable document ─────────────────────
 * Pan is the stage's own scrollbars (they appear only when needed);
 * zoom scales the plane and resizes the scroll area to match. The
 * default view is 100% at the top of the flow — never a fit that
 * shrinks a big flow into confetti. */

const VIEW_PAD = 36;

const BIG_GRAPH_CELLS = 120;

function applyView() {
  const s = state.view.scale, ex = state.extent;
  if (!ex) return;
  const w = (ex.maxX - ex.minX) * s + VIEW_PAD * 2;
  const h = (ex.maxY - ex.minY) * s + VIEW_PAD * 2;
  const world = $("#world");
  world.style.width = `${w}px`;
  world.style.height = `${h}px`;
  $("#plane").style.transform =
    `translate(${-ex.minX * s + VIEW_PAD}px, ${-ex.minY * s + VIEW_PAD}px) scale(${s})`;
  $("#btn-zoom-pct").textContent = `${Math.round(s * 100)}%`;

  // no semantic zoom: a card is the same at every zoom (its detail shows
  // when it is clicked), so zooming never lays the canvas out again
}

function zoomAt(mx, my, factor) {
  const stage = $("#stage");
  const old = state.view.scale;
  const next = Math.min(2.5, Math.max(0.1, old * factor));
  // keep the point under the cursor under the cursor
  const cx = (stage.scrollLeft + mx) / old;
  const cy = (stage.scrollTop + my) / old;
  state.view.scale = next;
  applyView();
  stage.scrollLeft = cx * next - mx;
  stage.scrollTop = cy * next - my;
}

function stageCenter() {
  const r = $("#stage").getBoundingClientRect();
  return {x: r.width / 2, y: r.height / 2};
}

function fit() {
  // back to the landing view: the whole flow, or its width at a readable
  // scale — and forget the view the user had saved
  store(viewKey(), null);
  initView();
}

/* The landing view: the whole flow when it fits at a readable scale;
 * otherwise across its width (never below 70% — at 55% a name was 7px on
 * screen), from the top, centred. It used to open at 100% on the
 * top-left, so a wide flow (callbot) showed a fragment with cards cut
 * at the edge. A view the user sets — pan, zoom — is remembered per
 * project and graph, and wins on the next visit. */
const viewKey = () => `view:${PID}:${state.graph ? state.graph.name : ""}`;
function initView(fresh) {
  const ex = state.extent;
  if (!ex) return;
  const stage = $("#stage");
  const r = stage.getBoundingClientRect();
  // fresh: the landing view for this box, leaving the saved one alone
  const saved = fresh ? null : recall(viewKey(), null);
  if (saved && saved.scale > 0) {
    state.view.scale = saved.scale;
    applyView();
    stage.scrollLeft = saved.x || 0;
    stage.scrollTop = saved.y || 0;
    return;
  }
  const w = Math.max(1, ex.maxX - ex.minX), h = Math.max(1, ex.maxY - ex.minY);
  const room = (n) => n - VIEW_PAD * 2 - 24;
  const all = Math.min(room(r.width) / w, room(r.height) / h);
  state.view.scale = all >= 0.7 ? Math.min(1, all) : Math.min(1, Math.max(0.7, room(r.width) / w));
  applyView();
  const wide = w * state.view.scale + VIEW_PAD * 2;
  // a flow wider than the box lands on its START, where reading begins
  // (a phone at the readable 70% used to open on the middle, sides cut)
  const start = state.startAt;
  const x = start && wide > r.width ? (start.x - ex.minX) * state.view.scale + VIEW_PAD - r.width / 2
    : (wide - r.width) / 2;
  stage.scrollLeft = Math.max(0, Math.min(wide - r.width, x));
  stage.scrollTop = 0;
}
// the user's own view, remembered once they stop moving it
let _viewSave = 0;
$("#stage").addEventListener("scroll", () => {
  if (state.tab !== "flow" || !state.extent || state.workflowOn) return;
  clearTimeout(_viewSave);
  _viewSave = setTimeout(() => {
    // a run opened in the meantime: its pane's scroll is not the Flow view
    if (state.tab !== "flow" || state.workflowOn) return;
    const st = $("#stage");
    store(viewKey(), {scale: state.view.scale, x: Math.round(st.scrollLeft), y: Math.round(st.scrollTop)});
  }, 500);
}, {passive: true});
// however the canvas comes back (leaving the assistant's focus, say), a
// stale one is drawn as it shows — the tab switch flushes on its own
new ResizeObserver(() => flushCanvas()).observe($("#stage"));

