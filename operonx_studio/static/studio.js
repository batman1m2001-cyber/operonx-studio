/* operonx studio — the canvas.
 *
 * Vanilla JS on purpose: the page must open on a machine with no internet,
 * and the graph sizes here (tens of nodes) never justify a framework.
 * Layout comes from the server so the picture is deterministic and
 * testable; this file draws it, opens GraphOp containers in place, and
 * answers clicks.
 */

"use strict";

const PID = location.pathname.split("/").pop();
const NODE_W = 260, NODE_H = 64;
const HEADER = 34;              // a container's title strip
const SVGNS = "http://www.w3.org/2000/svg";

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  ir: null,          // the whole /ir payload
  graph: null,       // current graph object
  sel: null,         // selected render key
  expanded: new Set(), // render keys of opened GraphOp containers
  rendered: new Map(), // render key -> placed item {node, x, y, w, h, depth}
  extent: null,      // {minX, minY, maxX, maxY} of the last render
  view: {scale: 1},  // pan lives in the stage's own scrollbars
  run: null,         // {run, ops: {name: {runs, errors, total_ms, max_ms}}}
  heatMax: 0,        // slowest avg ms in the painted run — the heat scale
  follow: false,     // repaint whenever a newer run appears
  stamp: 0,
  tab: "flow",
  cardEls: new Map(), // render key -> card element (selection without re-render)
  edgeEls: [],        // [{a, b, els}] every drawn edge's paths, for hot/arrow nav
  errIdx: 0,          // cycling cursor for the "error →" jump
};

/* What the user is looking at, for anyone who asks — the assistant
 * sends it along with every chat message. */
function pushView() {
  const it = state.sel ? state.rendered.get(state.sel) : null;
  window.__oxview = {
    node: it ? it.node.name : null,
    kind: it ? it.node.kind : null,
    run: state.run ? state.run.run : null,
    tab: state.tab,
  };
}

/* One shared voice for action feedback: applied, painted, copied. */
let _toastTimer = null;
function toast(text, bad) {
  let t = $("#toast");
  if (!t) {
    t = el("div", null, "");
    t.id = "toast";
    document.body.append(t);
  }
  t.textContent = text;
  t.classList.toggle("bad", !!bad);
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
function recall(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ── kind → color family ──────────────────────────────────────────── */

/* ── the op visual registry ───────────────────────────────────────────
 * ONE place that says how a kind looks. The kind — and only the kind —
 * decides the visual: two FuncOps must never wear different colors
 * because of an orthogonal property (bound, gen, …); those live in
 * badges and chips. Resolution: exact kind name, then family pattern,
 * then the default — so an op the studio has never seen still renders
 * coherently instead of guessing per-property. Extend by adding a row.
 */
const OP_VISUALS = {
  "FuncOp":            {icon: "ƒ", color: "var(--k-func)"},
  "GraphOp":           {icon: "▣", color: "var(--k-graph)"},
  "BranchOp":          {icon: "⑃", color: "var(--k-branch)"},
  "LLMOp":             {icon: "✦", color: "var(--k-llm)"},
  "EmbeddingOp":       {icon: "⛁", color: "var(--k-res)"},
  "RerankOp":          {icon: "⛁", color: "var(--k-res)"},
  "VectorSearchOp":    {icon: "⛁", color: "var(--k-res)"},
  "DocFetchOp":        {icon: "⛁", color: "var(--k-res)"},
  "EmitOp":            {icon: "⌁", color: "var(--k-io)"},
  "InterruptOp":       {icon: "✋", color: "var(--k-branch)"},
  "STTOp":             {icon: "◉", color: "var(--k-audio)"},
  "TTSOp":             {icon: "♪", color: "var(--k-audio)"},
  "DenoiseClassifier": {icon: "≈", color: "var(--k-audio)"},
};
const OP_FAMILIES = [
  [/LLM|Chat|Completion/,                    {icon: "✦", color: "var(--k-llm)"}],
  [/Graph/,                                  {icon: "▣", color: "var(--k-graph)"}],
  [/Branch|Rout|Switch/,                     {icon: "⑃", color: "var(--k-branch)"}],
  [/Embed|Rerank|Search|Fetch|Retriev|Store/, {icon: "⛁", color: "var(--k-res)"}],
  [/STT|TTS|Audio|Denoise|VAD|Speech|Voice/, {icon: "◉", color: "var(--k-audio)"}],
];
const OP_DEFAULT = {icon: "◈", color: "var(--k-default)"};

function visualOf(kind) {
  kind = kind || "";
  if (OP_VISUALS[kind]) return OP_VISUALS[kind];
  for (const [pattern, visual] of OP_FAMILIES) {
    if (pattern.test(kind)) return visual;
  }
  return OP_DEFAULT;
}

function kindColor(node) { return visualOf(node.kind).color; }
function kindIcon(node) { return visualOf(node.kind).icon; }

/* With a run painted, an op either executed or it didn't — and the
 * ones that didn't fade back, so the picture becomes the path taken.
 * A GraphOp ran if any member did; structure (terminals) never fades. */
function ranInRun(n) {
  if (!state.run) return true;
  if (n.kind === "__boundary__") return true;
  if (state.run.ops[n.name]) return true;
  if (n.graph) return (n.graph.nodes || []).some(ranInRun);
  return false;
}

/* ── placement: expansion opens a GraphOp in place ────────────────── */

/* The server lays every graph on a grid, nested graphs included. A
 * GraphOp the user opens becomes a container sized to its inner layout;
 * every column to its right and row below shifts by the growth, so the
 * grid stays a grid and nothing overlaps. Recursion makes a container
 * inside a container work for free. */
/* An opened GraphOp shows its own ports as nodes: a START pill where
 * the outside's edges arrive, an END pill they leave from. The pills
 * ARE the GraphOp's boundary — inner entries hang off START, inner
 * exits feed END, and external edges plug into the pills instead of
 * the container's rim. */
const B_W = 66, B_H = 28, B_GAP = 40;

function withBoundaries(model, key, depth) {
  // top-down: START above the first row, END below the last — current
  // enters at the top terminal and leaves at the bottom one
  for (const it of model.items) it.y += B_H + B_GAP;
  const contentBottom = (model.h - 48) + B_H + B_GAP;
  const midX = Math.max(6, (model.w - 48) / 2 - B_W / 2);
  const pill = (which, x, y) => ({
    key: `${key}/__${which}`,
    node: {id: `__${which}__`, name: which.toUpperCase(),
           kind: "__boundary__", boundary: which},
    depth, inner: null, x, y, w: B_W, h: B_H,
  });
  const start = pill("start", midX, 10);
  const end = pill("end", midX, contentBottom + B_GAP);
  const edges = [...model.edges];
  for (const it of model.items) {
    if (it.node.start) edges.push({src: "__start__", dst: it.node.id, boundary: true});
    if (it.node.end) edges.push({src: it.node.id, dst: "__end__", boundary: true});
  }
  model.items.push(start, end);
  return {items: model.items, edges, w: model.w, h: end.y + B_H + 26};
}

function placeGraph(g, prefix, depth) {
  const size = new Map();
  for (const n of g.nodes) {
    const key = prefix + n.id;
    let inner = null, w = NODE_W, h = NODE_H;
    if (n.graph && state.expanded.has(key)) {
      inner = withBoundaries(placeGraph(n.graph, key + "/", depth + 1), key, depth + 1);
      w = Math.max(NODE_W + 40, inner.w);
      h = inner.h + HEADER;
    }
    size.set(n.id, {key, w, h, inner});
  }

  const xs = [...new Set(g.nodes.map(n => n.x))].sort((a, b) => a - b);
  const ys = [...new Set(g.nodes.map(n => n.y))].sort((a, b) => a - b);
  const extraX = new Map(xs.map(x => [x, 0]));
  const extraY = new Map(ys.map(y => [y, 0]));
  for (const n of g.nodes) {
    const s = size.get(n.id);
    extraX.set(n.x, Math.max(extraX.get(n.x), s.w - NODE_W));
    extraY.set(n.y, Math.max(extraY.get(n.y), s.h - NODE_H));
  }
  const shiftX = new Map(); let acc = 0;
  for (const x of xs) { shiftX.set(x, acc); acc += extraX.get(x); }
  const shiftY = new Map(); acc = 0;
  for (const y of ys) { shiftY.set(y, acc); acc += extraY.get(y); }

  const items = [];
  let maxX = NODE_W, maxY = NODE_H;
  for (const n of g.nodes) {
    const s = size.get(n.id);
    const it = {key: s.key, node: n, depth, inner: s.inner,
                x: n.x + shiftX.get(n.x), y: n.y + shiftY.get(n.y),
                w: s.w, h: s.h};
    items.push(it);
    maxX = Math.max(maxX, it.x + it.w);
    maxY = Math.max(maxY, it.y + it.h);
  }
  return {items, edges: g.edges || [], w: maxX + 48, h: maxY + 48};
}

function flattenModel(model, ox, oy, out) {
  const abs = new Map();
  for (const it of model.items) {
    const a = {...it, x: it.x + ox, y: it.y + oy};
    abs.set(it.node.id, a);
    out.nodes.push(a);
    state.rendered.set(a.key, a);
    if (it.inner) {
      flattenModel(it.inner, a.x, a.y + HEADER, out);
      // the pills stand for the container: outside edges plug into them
      a.bIn = state.rendered.get(it.key + "/__start") || null;
      a.bOut = state.rendered.get(it.key + "/__end") || null;
    }
  }
  for (const e of model.edges) {
    const a = abs.get(e.src), b = abs.get(e.dst);
    if (a && b) out.edges.push({e, a, b});
  }
  return out;
}

/* ── edge geometry (top-down: out of the bottom, into the top) ───── */

const portCX = (it) => it.x + it.w / 2;

function bezier(x1, y1, x2, y2) {
  const dy = Math.max(40, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

/* ── obstacle avoidance ───────────────────────────────────────────────
 * An edge through the middle of an unrelated node is a lie about the
 * graph. Every forward edge is collision-tested against the node boxes;
 * a dirty one reroutes through the clear horizontal channel between
 * rows, or failing that, bows around the obstacle. */

function _cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

function _hits(points, rects) {
  for (const [x, y] of points) {
    for (const r of rects) {
      if (x > r.l && x < r.r && y > r.t && y < r.b) return true;
    }
  }
  return false;
}

function _sampleCubic(x1, y1, cx1, cy1, cx2, cy2, x2, y2) {
  // sample by LENGTH, not by a fixed count — fifteen points on a
  // 900px edge leaves 60px blind spots, wide enough to miss a node
  const span = Math.abs(x2 - x1) + Math.abs(y2 - y1);
  const steps = Math.min(140, Math.max(14, Math.round(span / 20)));
  const pts = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    pts.push(_cubic([x1, y1], [cx1, cy1], [cx2, cy2], [x2, y2], t));
  }
  return pts;
}

function _rects(obstacles, a, b) {
  // An opened container is solid ground to every edge that has no
  // business inside it — through-traffic must route around the box.
  // Only an edge whose endpoint lives INSIDE (a member, or the START/
  // END pill an external edge was rerouted to) may cross the membrane.
  const inside = (o, it) => it && it.x >= o.x - 1 && it.y >= o.y - 1
    && it.x + it.w <= o.x + o.w + 1 && it.y + it.h <= o.y + o.h + 1;
  const out = [];
  for (const o of obstacles) {
    if (o === a || o === b) continue;
    if (o.inner && (inside(o, a) || inside(o, b))) continue;
    out.push({l: o.x - 6, r: o.x + o.w + 6, t: o.y - 6, b: o.y + o.h + 6});
  }
  return out;
}

/* Lane bookkeeping, reset per render: crossing edges are legible,
 * COINCIDENT edges are mud. Every claimed vertical lane is recorded,
 * and the next edge that wants the same corridor gets the nearest free
 * offset instead of stacking on top. */
let _lanes = {v: []};

function _vFree(x, t, b) {
  return !_lanes.v.some(o => Math.abs(o.x - x) < 11 && o.b > t && o.t < b);
}

/* A clear vertical lane through the y-band, nearest the preferred x.
 * Candidates come from the actual obstacle silhouette (their left and
 * right flanks), because centred rows have no global column grid. */
function _clearLaneX(rects, top, bottom, prefer) {
  const band = rects.filter(o => o.b > top && o.t < bottom);
  const cands = [prefer];
  for (const o of band) cands.push(o.l - 16, o.r + 16);
  cands.sort((m, n) => Math.abs(m - prefer) - Math.abs(n - prefer));
  for (const cand of cands) {
    for (let step = 0; step <= 6; step++) {
      for (const off of step ? [step * 13, -step * 13] : [0]) {
        const x = cand + off;
        const blocked = band.some(o => o.l < x + 8 && o.r > x - 8);
        if (!blocked && _vFree(x, top, bottom)) {
          _lanes.v.push({x, t: top, b: bottom});
          return x;
        }
      }
    }
  }
  return null;
}

function routeAvoiding(a, b, obstacles) {
  const x1 = portCX(a), y1 = a.y + a.h, x2 = portCX(b), y2 = b.y;
  const dy = Math.max(40, Math.abs(y2 - y1) / 2);
  const rects = _rects(obstacles, a, b);
  const long = y2 - y1 > 200;
  const vertical = Math.abs(x1 - x2) < 18;

  // A straight shot is only kept when it hits nothing AND, for a long
  // near-vertical run, when no other edge already owns that corridor —
  // two skips accepted "straight" used to lie exactly on each other.
  const straight = _sampleCubic(x1, y1, x1, y1 + dy, x2, y2 - dy, x2, y2);
  if (!_hits(straight, rects)) {
    if (!(long && vertical) || _vFree(x1, y1 + 20, y2 - 20)) {
      if (long && vertical) _lanes.v.push({x: x1, t: y1 + 20, b: y2 - 20});
      return bezier(x1, y1, x2, y2);
    }
  }

  // Two escapes: a smooth bow, or a jogged vertical side-lane. A short
  // hop looks best bowed; a long haul looks best in a straight lane —
  // try in that order, fall back to the other.
  const bow = () => {
    const stepX = NODE_W / 2 + 64;
    for (const off of [-stepX, stepX, -2 * stepX, 2 * stepX]) {
      const pts = _sampleCubic(x1, y1, x1 + off, y1 + dy, x2 + off, y2 - dy, x2, y2);
      if (!_hits(pts, rects)) {
        return `M ${x1} ${y1} C ${x1 + off} ${y1 + dy}, ${x2 + off} ${y2 - dy}, ${x2} ${y2}`;
      }
    }
    return null;
  };
  const laneRoute = () => {
    if (!long) return null;
    const lane = _clearLaneX(rects, y1 + 50, y2 - 50, (x1 + x2) / 2);
    if (lane === null) return null;
    return `M ${x1} ${y1} C ${x1} ${y1 + 46}, ${lane} ${y1 + 46}, ${lane} ${y1 + 100}`
      + ` L ${lane} ${y2 - 100}`
      + ` C ${lane} ${y2 - 46}, ${x2} ${y2 - 46}, ${x2} ${y2}`;
  };
  const shortHop = y2 - y1 < 480;
  return (shortHop ? (bow() ?? laneRoute()) : (laneRoute() ?? bow()))
    ?? bezier(x1, y1, x2, y2);   // accept the overlap rather than spiral
}

function returnPath(a, b) {
  // A loop's return edge: out of the source's right flank, bowing up
  // the right margin, back into the target's right flank. Drawn
  // differently from a forward edge on purpose — this is the arrow that
  // makes an agent while-loop look like what the author wrote instead of
  // one opaque compiler box.
  const x1 = a.x + a.w, y1 = a.y + a.h / 2;
  const x2 = b.x + b.w, y2 = b.y + b.h / 2;
  const bulge = Math.max(x1, x2) + 56 + Math.abs(y1 - y2) * 0.08;
  return `M ${x1} ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, ${x2} ${y2}`;
}

function consumeOf(edge, a, b) {
  // `.parallel()` / `.collect()` live on the CONSUMER's binding: find the
  // dst node's input that a ref from src feeds, and read its mode.
  for (const inp of b.node.inputs || []) {
    const bind = inp.binding || {};
    if (bind.kind === "ref" && (bind.from || "").split(".").pop() === a.node.name && bind.consume)
      return bind.consume;
  }
  return null;
}

function edgeGlyph(svg, x, y, text, cls, tip) {
  const t = document.createElementNS(SVGNS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("text-anchor", "middle");
  if (cls) t.setAttribute("class", cls);
  t.textContent = text;
  if (tip) {
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = tip;
    t.append(title);
  }
  svg.append(t);
}

/* An axon ends in a synaptic bouton at its target — which also gives
 * every edge the direction the old plain strokes never showed. */
function bouton(svg, x, y, cls) {
  const c = document.createElementNS(SVGNS, "circle");
  c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", 3.5);
  c.setAttribute("class", "bouton" + (cls ? ` ${cls}` : ""));
  svg.append(c);
}

/* An edge is a beam of energy: a wide soft glow, a bright core, and
 * spark particles frozen mid-flight — each with a smaller trailing dot
 * behind it, so the comet shape says which way the energy flows without
 * a frame of animation. */
function energyEdge(svg, d, cls, made) {
  const glow = document.createElementNS(SVGNS, "path");
  glow.setAttribute("d", d);
  glow.setAttribute("class", ("eglow " + cls).trim());
  svg.append(glow);
  const core = document.createElementNS(SVGNS, "path");
  core.setAttribute("d", d);
  core.setAttribute("class", ("ecore " + cls).trim());
  svg.append(core);
  // the laser filament: a white-hot hairline down the beam's center
  const ray = document.createElementNS(SVGNS, "path");
  ray.setAttribute("d", d);
  ray.setAttribute("class", ("eray " + cls).trim());
  svg.append(ray);
  if (made) made.push(glow, core, ray);
  return core;
}

function energySparks(svg, path, cls) {
  let len;
  try { len = path.getTotalLength(); } catch { return; }
  if (!len || len < 130) return;
  const count = Math.max(1, Math.min(3, Math.round(len / 240)));
  for (let i = 0; i < count; i++) {
    const at = ((i + 0.5) / count) * len;
    const pt = path.getPointAtLength(at);
    const tail = path.getPointAtLength(Math.max(0, at - 7));
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

function render() {
  const g = state.graph;
  const nodesBox = $("#nodes");
  const svg = $("#edges");
  nodesBox.textContent = "";
  svg.textContent = "";
  $("#edgetop").textContent = "";
  state.rendered.clear();
  state.cardEls.clear();
  state.edgeEls = [];
  _lanes = {v: []};

  const model = placeGraph(g, "", 0);
  const flat = flattenModel(model, 0, 0, {nodes: [], edges: []});

  // The serve boundary stands apart from the flow: ingress pulled left,
  // egress pushed right, each in its own tinted band — the picture reads
  // client → ingress → flow → egress → client.
  const gatesIn = flat.nodes.filter(x => x.depth === 0 && x.node.serve_role === "ingress");
  const gatesOut = flat.nodes.filter(x => x.depth === 0 && x.node.serve_role === "egress");
  for (const x of gatesIn) x.y -= 70;
  for (const x of gatesOut) {
    // the egress is not always on the last row — only step down out of
    // the flow when the lane below is actually clear
    const clash = flat.nodes.some(o => o !== x && !o.inner
      && o.x < x.x + x.w && o.x + o.w > x.x
      && o.y > x.y && o.y < x.y + x.h + 100);
    if (!clash) x.y += 70;
  }

  // Cards go into the DOM FIRST, so every edge, frame and stub below
  // works from each card's REAL height — the layout's 64px is only a
  // guess, and a door wearing a transport line runs ~90px tall. The
  // old order anchored edges into the middle of tall cards.
  for (const it of flat.nodes) {
    const card = it.inner ? containerCard(it) : opCard(it);
    state.cardEls.set(it.key, card);
    nodesBox.append(card);
  }
  // WIDTH pass first — the root fix for every truncation whack-a-mole:
  // a card is exactly as wide as its name line (and, on a decision
  // card, its longest condition) needs, no wider. scrollWidth minus
  // clientWidth on the one-line elements says how much is missing
  // (positive) or spare (negative); the card resizes by that amount,
  // clamped, and KEEPS ITS SLOT CENTER so the layout's spacing holds —
  // slack between 316px slots absorbs growth up to the cap.
  for (const it of flat.nodes) {
    if (it.inner || it.node.kind === "__boundary__") continue;
    const card = state.cardEls.get(it.key);
    if (!card || !card.offsetHeight) continue;
    const els = [...card.querySelectorAll(".ntext, .brcond")];
    if (!els.length) {
      // gates: plain name line, plus the transport line below it
      for (const sel of [".nname", ".nkind"]) {
        const e = card.querySelector(sel);
        if (e) els.push(e);
      }
    }
    if (els.length) {
      // scrollWidth never reads below clientWidth, so a stretched flex
      // span hides how little it truly needs — pin it to max-content
      // for one frame to get the intrinsic width
      const intrinsic = (e) => {
        const saved = e.style.cssText;
        e.style.flex = "none"; e.style.width = "max-content";
        const w = e.offsetWidth;
        e.style.cssText = saved;
        return w;
      };
      const need = Math.max(...els.map(e => intrinsic(e) - e.clientWidth));
      const newW = Math.max(180, Math.min(310, Math.ceil(it.w + need + 8)));
      if (newW !== it.w) {
        it.x += (it.w - newW) / 2;
        it.w = newW;
        card.style.width = `${newW}px`;
        card.style.left = `${it.x}px`;
      }
    }
  }
  for (const it of flat.nodes) {
    if (it.inner || it.node.kind === "__boundary__") continue;
    const card = state.cardEls.get(it.key);
    if (card && card.offsetHeight) it.h = Math.max(it.h, card.offsetHeight);
    if (card && it.node.routes && it.node.routes.length) {
      // each condition row is a wired exit: record where the wire
      // leaves (first row per target decides), and put the row's port
      // DOT on the side its target actually lies — the wire departs
      // exactly at the dot, never from the blind side of the card
      it.condPorts = {};
      for (const rrow of card.querySelectorAll(".brrow")) {
        const t = rrow.dataset.target;
        const tgt = flat.nodes.find(o => o.depth === it.depth
          && o.node.name === t && o !== it);
        const side = tgt && portCX(tgt) < it.x + it.w / 2 ? -1 : 1;
        rrow.classList.toggle("left", side < 0);
        if (!(t in it.condPorts)) {
          // x/y of the row's own DOT (card-relative): the wire must
          // emerge from the condition box itself, not the card border
          it.condPorts[t] = {
            x: side < 0 ? rrow.offsetLeft - 1
                        : rrow.offsetLeft + rrow.offsetWidth + 1,
            y: rrow.offsetTop + rrow.offsetHeight / 2, side};
        }
      }
    }
  }

  // Rows part for real heights: semantic zoom grows cards, and a
  // fixed pitch would let them collide. Runs INSIDE every opened
  // container first (deepest first — a grown inner box must be known
  // before its parent's rows part), stretching the container around
  // its members and END terminal, then across the top level.
  {
    const shiftTree = (it, delta) => {
      for (const sub of flat.nodes) {
        if (sub === it || sub.key.startsWith(it.key + "/")) {
          sub.y += delta;
          const c = state.cardEls.get(sub.key);
          if (c) c.style.top = `${sub.y}px`;
        }
      }
    };
    const partRows = (items) => {
      const rows = new Map();
      for (const it of items) {
        const k = Math.round(it.y);
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k).push(it);
      }
      const placedBoxes = [];
      let maxBottom = -Infinity;
      for (const y of [...rows.keys()].sort((a, b) => a - b)) {
        const row = rows.get(y);
        let minTop = y;
        for (const it of row) {
          for (const b of placedBoxes) {
            if (b.x < it.x + it.w && b.x + b.w > it.x) {
              minTop = Math.max(minTop, b.bottom + 46);
            }
          }
        }
        const delta = minTop - y;
        if (delta > 0) for (const it of row) shiftTree(it, delta);
        for (const it of row) {
          placedBoxes.push({x: it.x, w: it.w, bottom: it.y + it.h});
          maxBottom = Math.max(maxBottom, it.y + it.h);
        }
      }
      return maxBottom;
    };

    const containers = flat.nodes.filter(it => it.inner)
      .sort((a, b) => b.depth - a.depth);
    for (const c of containers) {
      const kids = flat.nodes.filter(sub =>
        sub.key.startsWith(c.key + "/")
        && !sub.key.slice(c.key.length + 1).includes("/"));
      if (!kids.length) continue;
      const bottom = partRows(kids);
      const newH = Math.max(c.h, bottom + 18 - c.y);
      if (newH !== c.h) {
        c.h = newH;
        const cc = state.cardEls.get(c.key);
        if (cc) cc.style.height = `${c.h}px`;
      }
    }
    partRows(flat.nodes.filter(it => it.depth === 0));
  }

  const maxX = Math.max(model.w, ...flat.nodes.map(n => n.x + n.w));
  const maxY = Math.max(model.h, ...flat.nodes.map(n => n.y + n.h));
  // headroom above: the transport card, or the door frame's label;
  // width includes the right margin where loop returns bulge
  const minY = gatesIn.length
    ? Math.min(...gatesIn.map(x => x.y)) - 70
    : -NODE_H - 140;
  state.extent = {minX: -40, minY, maxX: maxX + 150, maxY: maxY + 175};

  for (const layer of [svg, $("#edgetop")]) {
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
    rect.setAttribute("width", it.w + 24); rect.setAttribute("height", it.h + 38);
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
  // GraphOp, begins at a START contact and ends at an END one. Quiet
  // ties reach every entry (this is what dispatches beat/lag-style
  // monitors: the session starting, not the client) and gather the
  // exits. With the client stubs gone, ties land dead-centre on every
  // card, doors included.
  if (flat.nodes.length) {
    const at = (name) => flat.nodes.find(it => it.depth === 0 && it.node.name === name);
    const entryTies = (g.entries || []).map(at).filter(Boolean);
    const exitTies = (g.exits || []).map(at).filter(Boolean);
    const over = (items) => items.reduce((s, it) => s + portCX(it), 0)
      / items.length - B_W / 2;
    const tie = (x1, y1, x2, y2) => {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", bezier(x1, y1, x2, y2));
      p.setAttribute("class", "bedge");
      svg.append(p);
    };
    if (entryTies.length) {
      const topY = Math.min(...entryTies.map(it => it.y)) - 96;
      const startIt = {key: "__main/__start", depth: 0, inner: null,
                       x: over(entryTies), y: topY, w: B_W, h: B_H,
                       node: {id: "__start__", name: "START",
                              kind: "__boundary__", boundary: "start"}};
      nodesBox.append(boundaryCard(startIt));
      for (const t of entryTies) {
        tie(startIt.x + B_W / 2, startIt.y + B_H, t.x + t.w / 2, t.y);
      }
    }
    if (exitTies.length) {
      const endY = Math.max(...exitTies.map(it => it.y + it.h)) + 96;
      const endIt = {key: "__main/__end", depth: 0, inner: null,
                     x: over(exitTies), y: endY, w: B_W, h: B_H,
                     node: {id: "__end__", name: "END",
                            kind: "__boundary__", boundary: "end"}};
      nodesBox.append(boundaryCard(endIt));
      for (const t of exitTies) {
        tie(t.x + t.w / 2, t.y + t.h, endIt.x + B_W / 2, endIt.y);
      }
    }
  }

  // One beam per pair: the IR often carries a data edge AND an order
  // edge between the same two nodes, and drawing both stacked parallel
  // strands was half the visual noise. Keep the most meaningful one.
  const meaning = (fe) => (fe.e.soft ? 0 : 2) + (fe.e.type === "condition" ? 1 : 0)
    + (fe.e.back ? 1 : 0);
  const byPair = new Map();
  for (const fe of flat.edges) {
    const key = `${fe.a.key}→${fe.b.key}`;
    const prev = byPair.get(key);
    if (!prev || meaning(fe) > meaning(prev)) byPair.set(key, fe);
  }

  // Glyphs and labels buffer here and draw AFTER every path, so no
  // later beam ever paints over a word.
  const glyphJobs = [];
  const addGlyph = (x, y, text, cls, tip) => glyphJobs.push([x, y, text, cls, tip]);
  const along = (path, fraction, dy) => {
    // labels sit BESIDE a mostly-vertical wire, not on it
    try {
      const len = path.getTotalLength();
      const pt = path.getPointAtLength(len * fraction);
      return [pt.x + 12, pt.y + dy + 3];
    } catch { return null; }
  };
  const obstacles = flat.nodes;   // containers included — _rects decides per edge

  // graph edges (every open level draws its own)
  for (const {e, a, b} of byPair.values()) {
    // a boundary tie inside an opened container: START → entries,
    // exits → END. Structural, quiet — not an energy beam.
    if (e.boundary) {
      const bp = document.createElementNS(SVGNS, "path");
      bp.setAttribute("d", bezier(portCX(a), a.y + a.h, portCX(b), b.y));
      bp.setAttribute("class", "bedge");
      svg.append(bp);
      state.edgeEls.push({a: a.key, b: b.key, els: [bp]});
      continue;
    }
    // an expanded container's pills stand in for its rim: edges from
    // outside land on START, leave from END
    const A = a.bOut || a, B = b.bIn || b;
    const p = document.createElementNS(SVGNS, "path");
    let cls = e.soft ? "soft" : "";
    let sheath = null;
    // an if/else route gets its own beam: branch amber, the ELSE
    // fallback dashed and laserless — the condition text stays OFF the
    // wire (hover the edge, or open the router's route table). This
    // holds whatever ROUTE the edge takes: a condition edge that wraps
    // to the next band is still a condition edge.
    let condLabels = [], isElse = false;
    if (a.node.routes && e.type === "condition") {
      condLabels = a.node.routes
        .filter(r => r.target === b.node.name).map(r => r.condition);
      isElse = condLabels.length > 0 && condLabels.every(c => c === "else");
    }
    if (e.back) {
      p.setAttribute("d", returnPath(A, B));
      cls += " back";
      if (!e.soft) sheath = "back";
      const bulge = Math.max(A.x + A.w, B.x + B.w) + 56
        + Math.abs((A.y + A.h / 2) - (B.y + B.h / 2)) * 0.08;
      addGlyph(bulge + 4, (A.y + A.h / 2 + B.y + B.h / 2) / 2, "↺ loop", "back-label");
    } else {
      // a condition edge leaves ITS OWN ROW on the decision card — the
      // wire starts beside the condition that fires it
      const rowPort = condLabels.length && A.condPorts
        ? A.condPorts[b.node.name] : null;
      if (rowPort != null) {
        // departs AT the row's dot, horizontal tangent out, vertical
        // tangent in — control distances scale with the actual gap so
        // a near neighbour gets a tight elbow, not a balloon
        const side = rowPort.side;
        const x1 = A.x + (rowPort.x != null ? rowPort.x
                                            : (side > 0 ? A.w : 0));
        const y1 = A.y + rowPort.y;
        const x2 = portCX(B), y2 = B.y;
        const c1 = Math.max(22, Math.min(64, Math.abs(x2 - x1) * 0.5));
        const c2 = Math.max(26, Math.min(72, Math.max(1, y2 - y1) * 0.5));
        // tangent tilts slightly toward the target, so the wire reads
        // "leaving this row, heading there" instead of bowing sideways
        const dip = Math.max(4, Math.min(22, (y2 - y1) * 0.15));
        p.setAttribute("d",
          `M ${x1} ${y1} C ${x1 + side * c1} ${y1 + dip}, ${x2} ${y2 - c2}, ${x2} ${y2}`);
        p.dataset.fromRow = "1";
      } else {
        p.setAttribute("d", routeAvoiding(A, B, obstacles));
      }
      if (!e.soft) sheath = condLabels.length ? (isElse ? "cond relse" : "cond") : "";
    }
    let drawn = p;
    const made = [];
    const faded = state.run && (!ranInRun(a.node) || !ranInRun(b.node));
    if (sheath !== null) {
      drawn = energyEdge(svg, p.getAttribute("d"), sheath.trim(), made);
      // no sparks on an else-fallback, nor into an op that never ran
      if (!sheath.includes("relse") && !faded) energySparks(svg, drawn, sheath.trim());
    } else {
      p.setAttribute("class", cls.trim());
      svg.append(p);
      made.push(p);
    }
    // a decision wire starts INSIDE the card, at its condition row's
    // dot — but edges paint beneath the cards. Repaint exactly the
    // over-card stretch above the card, clipped to its rect: identical
    // paths, so there is no seam and dashed elses stay in phase.
    if (p.dataset.fromRow === "1") {
      const top = $("#edgetop");
      const cid = "rowclip-" + A.key.replace(/[^A-Za-z0-9_-]/g, "_");
      if (!top.querySelector(`#${cid}`)) {
        const cp = document.createElementNS(SVGNS, "clipPath");
        cp.setAttribute("id", cid);
        const r = document.createElementNS(SVGNS, "rect");
        r.setAttribute("x", A.x - 4); r.setAttribute("y", A.y - 4);
        r.setAttribute("width", A.w + 8); r.setAttribute("height", A.h + 8);
        cp.append(r); top.append(cp);
      }
      const g2 = document.createElementNS(SVGNS, "g");
      g2.setAttribute("clip-path", `url(#${cid})`);
      const over = made.map(m => m.cloneNode(false));
      for (const m of over) g2.append(m);
      top.append(g2);
      made.push(...over);
    }
    if (faded) for (const el2 of made) el2.classList.add("dorm");
    // selection highlights and ←/→ walking work off this ledger, so a
    // click never needs to redraw the whole canvas
    state.edgeEls.push({a: a.key, b: b.key, els: made});
    // the node's own port bead is the terminal; an extra circle on top of
    // it was clutter. Only a loop's flank, which has no port, gets one.
    if (e.back) bouton(svg, B.x + B.w, B.y + B.h / 2, "b-back");

    if (!e.back) {
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

  refreshSelection();
  applyView();
}

/* Selection is a class toggle, not a redraw — clicking around a big
 * flow must not blink the whole canvas. */
function refreshSelection() {
  for (const [k, c] of state.cardEls) c.classList.toggle("selected", k === state.sel);
  for (const g of state.edgeEls) {
    const hot = !!state.sel && (g.a === state.sel || g.b === state.sel);
    for (const e of g.els) e.classList.toggle("hot", hot);
  }
}

function deselect() {
  state.sel = null;
  refreshSelection();
  pushView();
  renderFlowInfo();
}

/* Nothing selected: the panel belongs to the flow itself — what this
 * graph is, its doors, and the painted run if any. */
function renderFlowInfo() {
  if (state.sel) return;
  const panel = $("#inspector");
  panel.textContent = "";
  panel.scrollTop = 0;
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
    const bits = [`${Object.keys(state.run.ops || {}).length} ops ran`,
                  `${state.run.records ?? "?"} records`];
    if (state.run.wall_s != null) bits.push(`${state.run.wall_s.toFixed(1)}s`);
    if (state.run.errors) bits.push(`${state.run.errors} errors`);
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
  const promoter = el("span", "promoter", "↱");
  promoter.title = "An operon: one promoter, the genes inside transcribed together.";
  head.append(promoter);
  head.append(el("span", "nname", n.name));
  head.append(el("span", "nkind", `${n.kind} · ${n.subgraph_ops} ops`));
  const close = el("button", "collapse", "▾ collapse");
  close.title = "Collapse this graph back into a single node";
  close.onclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
  head.append(close);
  head.onclick = (ev) => { ev.stopPropagation(); select(it.key); };
  card.append(head);

  // no rim ports: the START/END pills inside are the container's ports now
  return card;
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
  card.append(el("span", "blabel", n.name));
  card.title = n.boundary === "start"
    ? "The GraphOp's own input boundary — edges from outside arrive here."
    : "The GraphOp's own output boundary — results leave for the outside here.";
  const parentKey = it.key.split("/").slice(0, -1).join("/");
  card.onclick = (ev) => { ev.stopPropagation(); select(parentKey); };
  return card;
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
  } else if (n.routes && n.routes.length) {
    // a router is a DECISION CARD: one row per condition, each row
    // owning its own exit — the wire leaves the row that fires it,
    // n8n-style, so the choice is readable on the canvas itself
    card.classList.add("branch");
    const line = el("div", "nname nline");
    line.append(el("span", "nicon", kindIcon(n)));
    line.append(el("span", "ntext", n.name));
    const chips = nameChips(n);
    if (chips) line.append(chips);
    card.append(line);
    card.title = n.kind + (n.bound ? ` · ${n.bound}` : "");
    const list = el("div", "brlist");
    for (const r of n.routes) {
      const rrow = el("div", "brrow" + (r.condition === "else" ? " relse" : ""));
      rrow.dataset.target = r.target;
      rrow.append(el("span", "brcond mono", r.condition));
      rrow.append(el("span", "brport"));
      rrow.title = `${r.condition} → ${r.target}`;
      list.append(rrow);
    }
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
    const chips = nameChips(n);
    if (chips) line.append(chips);
    card.append(line);
    // the kind line was card noise at fit-zoom; it lives in the
    // tooltip and the inspector — and, zoomed in close, on the card
    // itself (the .detail block shows only at [data-zoom="hi"])
    card.title = n.kind + (n.bound ? ` · ${n.bound}` : "") + (n.is_gen ? " · generator" : "");
    const det = el("div", "detail");
    const brief = (names) => names.length > 3
      ? names.slice(0, 3).join(", ") + ` +${names.length - 3}`
      : names.join(", ");
    const ins = (n.inputs || []).map(i => i.name);
    if (ins.length) det.append(el("div", "dports mono", "← " + brief(ins)));
    if ((n.outputs || []).length)
      det.append(el("div", "dports mono dout", "→ " + brief(n.outputs)));
    if (det.childNodes.length) card.append(det);
  }

  // At most TWO badges: one semantic marker, plus the run chip. Density
  // is respect — everything else is one click away in the inspector.
  const badges = el("div", "badges");
  if (n.graph) {
    const b = el("button", "badge sub expand", `▣ ${n.subgraph_ops} ▸`);
    b.title = "A nested @graph — click to open it in place.";
    b.onclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
    badges.append(b);
  } else if (n.loop) {
    const b = el("span", "badge loop", "↺ loop");
    b.title = "Member of a rewritten cycle; the return edge below is what the author wrote.";
    badges.append(b);
  }

  if (state.run && !ranInRun(n)) card.classList.add("dormant");
  const runinfo = state.run && state.run.ops[n.name];
  if (runinfo) {
    const avg = runinfo.runs ? (runinfo.total_ms / runinfo.runs) : 0;
    const chip = el("span", "badge run",
      `${runinfo.runs}× ${avg < 10 ? avg.toFixed(1) : Math.round(avg)}ms`
      + (runinfo.errors ? ` · ${runinfo.errors}✗` : ""));
    if (runinfo.errors) { chip.classList.add("err"); card.classList.add("errorlit"); }
    badges.append(chip);
    // heat: the slow op should be findable without reading a number
    if (!runinfo.errors && state.heatMax > 0) {
      card.style.setProperty("--heat", Math.min(1, avg / state.heatMax).toFixed(2));
      card.classList.add("heated");
    }
  }
  card.append(badges);
  card.append(el("span", "port in"));
  // a router's exits are its condition rows — no anonymous base port
  if (!(n.routes && n.routes.length)) card.append(el("span", "port out"));
  card.onclick = (ev) => { ev.stopPropagation(); select(it.key); };
  if (n.graph) card.ondblclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
  return card;
}

/* ── view: the canvas is a scrollable document ─────────────────────
 * Pan is the stage's own scrollbars (they appear only when needed);
 * zoom scales the plane and resizes the scroll area to match. The
 * default view is 100% at the top of the flow — never a fit that
 * shrinks a big flow into confetti. */

const VIEW_PAD = 36;

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

  // semantic zoom: close up, cards carry more (kind, ports); far out
  // they slim down. A level change reflows card heights, so the canvas
  // re-renders once to re-anchor every wire to the new bottoms.
  const level = s >= 0.85 ? "hi" : s <= 0.45 ? "lo" : "mid";
  if (world.dataset.zoom !== level) {
    world.dataset.zoom = level;
    if (state.graph && !state._rezoom) {
      state._rezoom = true;
      requestAnimationFrame(() => { state._rezoom = false; render(); });
    }
  }
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
  // fit the WIDTH: the whole flow across, reading down by scroll — a
  // both-axes fit shrank every tall flow into confetti
  const ex = state.extent;
  if (!ex) return;
  const stage = $("#stage");
  const r = stage.getBoundingClientRect();
  state.view.scale = Math.min(1.2,
    (r.width - 70) / Math.max(1, ex.maxX - ex.minX));
  applyView();
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
}

/* the landing view: real size, top of the flow, spine centred */
function initView() {
  const ex = state.extent;
  if (!ex) return;
  const stage = $("#stage");
  state.view.scale = 1;
  applyView();
  const r = stage.getBoundingClientRect();
  stage.scrollTop = 0;
  stage.scrollLeft = Math.max(0, (ex.maxX - ex.minX) / 2 + VIEW_PAD - r.width / 2);
}

/* ── inspector ────────────────────────────────────────────────────── */

/* The inspector's contract: the most important thing first.
 *
 * With a run painted, that is what the op actually DID — its recorded
 * output and input values, then its execution history. Without one, it
 * is what the op IS — its wiring and params. Identity chips always lead;
 * code, prompts and source live in collapsed sections underneath, so
 * they are one click away but never in the way. */
function select(key) {
  state.sel = (state.sel === key) ? null : key;
  refreshSelection();
  pushView();
  const panel = $("#inspector");
  if (!state.sel) { renderFlowInfo(); return; }
  const it = state.rendered.get(state.sel);
  if (!it) { state.sel = null; renderFlowInfo(); return; }
  const n = it.node;
  panel.textContent = "";
  panel.scrollTop = 0;

  // ── identity: sticky while the body scrolls ───────────────────────
  const head = el("div", "phead");
  const close = el("button", "pclose", "✕");
  close.title = "close (Esc)";
  close.onclick = deselect;
  head.append(close);
  // a nested member keeps its address visible: container › … › me
  const parts = state.sel.split("/");
  if (parts.length > 1) {
    const trail = parts.slice(0, -1)
      .map((_, i) => state.rendered.get(parts.slice(0, i + 1).join("/"))?.node.name || "?")
      .join(" › ");
    head.append(el("div", "crumbpath mono", trail + " ›"));
  }
  head.append(el("h3", null, n.name));
  const chips = el("div", "chips");
  const kindChip = el("span", "chip kindchip", n.kind);
  kindChip.style.setProperty("--kind", kindColor(n));
  chips.append(kindChip);
  if (n.bound) chips.append(el("span", "chip", n.bound));
  if (n.is_gen) {
    const c = el("span", "chip cgen", "⚡ generator");
    c.title = "Invoked once, yields many — every consumer dispatches per yield.";
    chips.append(c);
  }
  if (n.transient) {
    const c = el("span", "chip", "transient");
    c.title = "Outputs are delivered and then evicted; a long stream retains nothing.";
    chips.append(c);
  }
  if (n.resource) {
    chips.append(el("span", "chip cres",
      "⛁ " + (Array.isArray(n.resource) ? n.resource.join(" · ") : n.resource)));
  }
  if (n.loop) {
    const c = el("span", "chip cloop", `↺ while ≤${n.loop.max_iterations ?? "∞"}`);
    c.title = `Member of the authored cycle '${n.loop.group}', rewritten by the compiler into a synthetic loop.`;
    chips.append(c);
  }
  head.append(chips);
  panel.append(head);

  if (state.run && !ranInRun(n)) {
    panel.append(el("div", "rolenote dormnote",
      `— did not execute in ${state.run.run}. The values below are its wiring, not a recording.`));
  }
  if (n.serve_role) {
    panel.append(el("div", "rolenote",
      n.serve_role === "ingress"
        ? "⇥ Serve boundary — the client's data enters the run here. No business logic inside."
        : "⇥ Serve boundary — the run's answers leave for the client here. No business logic inside."));
    const t = n.serve_role === "ingress" && serveFor(state.graph);
    if (t) {
      const line = el("div", "srcline mono",
        `⟶ transport: ${t.kind}${t.path ? " " + t.path : ""}`);
      if (t.description) line.title = t.description;
      panel.append(line);
    }
  }

  // One fetch per selection; every section that cares about the painted
  // run shares it.
  const execP = state.run
    ? api(`/api/p/${PID}/trace/${encodeURIComponent(state.run.run)}/op/${encodeURIComponent(n.name)}`)
    : null;

  if (execP) panel.append(valuesSection(n, execP));
  // What flows in, what flows out, and WHO it links to — the essential
  // card, always visible, links as chips you can click, not dotted text.
  panel.append(portsSection(it));
  const llm = llmSection(n, execP);
  if (llm) panel.append(llm);
  if (n.routes) panel.append(routeSection(it, execP));
  if (execP) panel.append(executionsSection(n, execP));
  if (n.code) panel.append(codeSection(n));
  if (n.graph) panel.append(membersSection(it));
}

function valuesSection(n, execP) {
  const sec = el("section");
  sec.append(el("div", "stitle", `Latest values · ${state.run.run}`));
  const box = el("div", null, "…");
  sec.append(box);

  const addRow = (dir, key, val) => {
    const row = el("div", `valrow ${dir === "in" ? "vin" : ""}`);
    row.append(el("div", "vname mono", dir === "out" ? `${key} →` : `→ ${key}`));
    row.append(Values.render(val, {open: dir === "out"}));
    box.append(row);
  };

  execP.then(data => {
    box.textContent = "";
    if (!data.executions.length) {
      box.append(el("div", "note", "no records for this op in this run"));
      return;
    }

    if (n.graph) {
      // A GraphOp never executes under its own name — its ports' values
      // live in its MEMBERS' records. The last member record that
      // carried each declared port name is the value that crossed the
      // container's boundary.
      const boundary = (names, dir) => {
        const found = {};
        for (const ex of data.executions) {
          const src = dir === "out" ? ex.outputs : ex.inputs;
          if (!src || typeof src !== "object") continue;
          for (const k of names) if (k in src) found[k] = src[k];
        }
        return found;
      };
      const outs = boundary(n.outputs || [], "out");
      const ins = boundary((n.inputs || []).map(i => i.name), "in");
      for (const k of n.outputs || []) {
        if (k in outs) addRow("out", k, outs[k]);
        else addRow("out", k, "(not recorded in this run)");
      }
      for (const inp of n.inputs || []) {
        if (inp.name in ins) addRow("in", inp.name, ins[inp.name]);
      }
      if (!box.childNodes.length) box.append(el("div", "note", "no declared ports"));
      return;
    }

    // a plain op: the latest record's values, outputs first — "what did
    // this op produce" is why the node was clicked
    const last = data.executions[data.executions.length - 1];
    const groups = [["out", last.outputs, n.outputs || []],
                    ["in", last.inputs, null]];
    for (const [dir, values, priority] of groups) {
      const entries = Object.entries(values || {});
      if (priority) entries.sort((a, b) =>
        (priority.indexOf(a[0]) + 1 || 99) - (priority.indexOf(b[0]) + 1 || 99));
      for (const [key, val] of entries) addRow(dir, key, val);
    }
    if (!box.childNodes.length) box.append(el("div", "note", "record carried no values"));
  }).catch(e => { box.textContent = e.message; });
  return sec;
}

/* The decision table: every condition, its target, and — with a run
 * painted — how often each fired and which fired last. Rows that never
 * fired dim; the latest choice is marked. */
function routeSection(it, execP) {
  const n = it.node;
  const sec = el("section");
  sec.append(el("div", "stitle", "Decision table"));
  const byTarget = new Map();
  for (const r of n.routes) {
    const row = el("div", "drow" + (r.condition === "else" ? " relse" : ""));
    const cond = el("div", "dcond mono", r.condition);
    cond.title = r.condition;
    row.append(cond);
    row.append(el("span", "parr out", "→"));
    const tgt = el("button", "pchip pref", r.target);
    tgt.onclick = () => jumpTo(r.target, it.depth);
    row.append(tgt);
    const meta = el("span", "dmeta");
    row.append(meta);
    if (!byTarget.has(r.target)) byTarget.set(r.target, []);
    byTarget.get(r.target).push({row, meta});
    sec.append(row);
  }
  if (execP) execP.then(data => {
    if (!data.executions.length) return;
    const fired = {};
    for (const ex of data.executions) {
      const t = (ex.outputs || {}).target;
      if (t) fired[t] = (fired[t] || 0) + 1;
    }
    const last = data.executions[data.executions.length - 1];
    const latest = (last.outputs || {}).target;
    for (const [target, entries] of byTarget) {
      const count = fired[target] || 0;
      for (const {row, meta} of entries) {
        if (count) meta.append(el("span", "chip cfired", `${count}×`));
        else row.classList.add("dnever");
        if (target === latest) {
          row.classList.add("dlatest");
          meta.append(el("span", "chip clatest", "latest"));
        }
      }
    }
  }).catch(() => {});
  return sec;
}

/* LLMOp: the traced conversation when there is one — role-labelled
 * bubbles with the response emphasized — else the authored templates. */
function llmSection(n, execP) {
  if (!(n.kind || "").includes("LLM")) return null;
  const byName = {};
  for (const inp of n.inputs || []) byName[inp.name] = inp.binding || {};
  const sec = el("section");
  sec.append(el("div", "stitle", "Conversation"));
  const box = el("div");
  sec.append(box);

  const templates = () => {
    const prompt = byName.prompt;
    if (prompt && prompt.kind === "literal" && prompt.value && typeof prompt.value === "object") {
      for (const part of ["system", "user"]) {
        if (prompt.value[part] === undefined) continue;
        box.append(el("div", "plabel", part + " (template)"));
        box.append(el("pre", "promptblock mono", String(prompt.value[part])));
      }
    } else if (byName.messages) {
      const b = byName.messages;
      box.append(el("div", "srcline",
        b.kind === "ref" ? `messages ← ${(b.from || "").split(".").pop()}.${b.output} (conversation is data, never templated)`
                         : "messages: bound at run time"));
    } else {
      box.append(el("div", "note", "no prompt literal — see wiring below"));
    }
  };

  const bubbles = (msgs, response) => {
    for (const m of msgs.slice(-8)) {
      const b = el("div", `bubble b-${m.role || "user"}`);
      b.append(el("div", "plabel", m.role || "?"));
      b.append(el("div", "btext", typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      box.append(b);
    }
    if (msgs.length > 8) box.append(el("div", "srcline", `…${msgs.length - 8} earlier messages`));
    if (response !== undefined && response !== null) {
      const b = el("div", "bubble b-assistant b-resp");
      b.append(el("div", "plabel", "response"));
      b.append(el("div", "btext", String(response)));
      box.append(b);
    }
  };

  if (execP) {
    execP.then(data => {
      const last = data.executions[data.executions.length - 1];
      const msgs = last && last.inputs && last.inputs.messages;
      const content = last && last.outputs && last.outputs.content;
      if (Array.isArray(msgs) && msgs.length) bubbles(msgs, content);
      else if (content !== undefined && content !== null) { templates(); bubbles([], content); }
      else templates();
    }).catch(templates);
  } else {
    templates();
  }

  const params = el("div", "chips");
  for (const [name, b] of Object.entries(byName)) {
    if (b.kind !== "literal") continue;
    if (name === "prompt" || name === "messages") continue;
    const v = b.value;
    if (v === null || ["string", "number", "boolean"].includes(typeof v))
      params.append(el("span", "chip", `${name}=${JSON.stringify(v)}`));
  }
  if (params.childNodes.length) sec.append(params);
  return sec;
}

/* GraphOp: the members, right here — click one to open the container
 * and select it. With a run painted, each member's cost. */
function membersSection(it) {
  const n = it.node;
  const sec = el("section");
  sec.append(el("div", "stitle", `Inside · ${n.subgraph_ops} ops`));
  for (const m of (n.graph.nodes || [])) {
    const row = el("button", "memberrow");
    row.append(el("span", "memicon", kindIcon(m)));
    row.append(el("span", "mono", m.name));
    row.append(el("span", "memkind", m.kind));
    const runinfo = state.run && state.run.ops[m.name];
    if (runinfo) {
      const avg = runinfo.runs ? runinfo.total_ms / runinfo.runs : 0;
      const chip = el("span", "chip", `${runinfo.runs}× ${avg < 10 ? avg.toFixed(1) : Math.round(avg)}ms`);
      if (runinfo.errors) chip.classList.add("cbad");
      row.append(chip);
    }
    row.onclick = () => {
      if (!state.expanded.has(it.key)) { state.expanded.add(it.key); render(); }
      select(it.key + "/" + m.id);
    };
    sec.append(row);
  }
  return sec;
}

/* ── code, tinted offline ─────────────────────────────────────────── */

const PY_KW = new Set(("def return if else elif for while in not and or async await yield "
  + "import from as class try except finally with pass raise lambda None True False "
  + "is global del assert break continue match case").split(" "));
const PY_TOKEN = /("""|'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#.*$|@\w+|\b[A-Za-z_]\w*\b)/g;

function tintLine(line, st) {
  const frag = document.createDocumentFragment();
  if (st.instr) {   // inside a triple-quoted string
    const end = line.indexOf(st.instr);
    if (end === -1) { frag.append(span("cs", line)); return frag; }
    frag.append(span("cs", line.slice(0, end + 3)));
    st.instr = null;
    frag.append(...tintLine(line.slice(end + 3), st).childNodes);
    return frag;
  }
  let idx = 0, m;
  PY_TOKEN.lastIndex = 0;
  while ((m = PY_TOKEN.exec(line)) !== null) {
    if (m.index > idx) frag.append(line.slice(idx, m.index));
    const t = m[0];
    if (t === '"""' || t === "'''") {
      const rest = line.slice(m.index + 3);
      const end = rest.indexOf(t);
      if (end === -1) { st.instr = t; frag.append(span("cs", line.slice(m.index))); return frag; }
      frag.append(span("cs", t + rest.slice(0, end + 3)));
      idx = m.index + 3 + end + 3;
      PY_TOKEN.lastIndex = idx;
      continue;
    }
    if (t.startsWith("#")) frag.append(span("cc", t));
    else if (t.startsWith("@")) frag.append(span("cd", t));
    else if (t.startsWith('"') || t.startsWith("'")) frag.append(span("cs", t));
    else if (PY_KW.has(t)) frag.append(span("ck", t));
    else frag.append(t);
    idx = PY_TOKEN.lastIndex;
  }
  if (idx < line.length) frag.append(line.slice(idx));
  return frag;
}

function span(cls, text) { const s = el("span", cls, text); return s; }

function codeSection(n) {
  const sec = el("details", "foldbox");
  const sum = el("summary");
  sum.append(el("span", "stitle", "Code"));
  const loc = (n.source || {}).defined_at;
  if (loc && loc.file) sum.append(el("span", "srcline mono", ` ${loc.file}:${loc.line}`));
  sec.append(sum);
  const pre = el("pre", "codeblock mono");
  const st = {instr: null};
  n.code.replace(/\s+$/, "").split("\n").forEach((line, i) => {
    const row = el("div", "cline");
    row.append(el("span", "lno", String((loc && loc.line || 1) + i)));
    // the tinted tokens live inside ONE pre-whitespace span — as bare
    // flex children, whitespace-only text nodes (indentation, the gap
    // in `async def`) are silently discarded by flex layout
    const text = el("span", "ctext");
    text.append(tintLine(line, st));
    row.append(text);
    pre.append(row);
  });
  sec.append(pre);
  return sec;
}

/* The graph a node lives in — the top-level graph, or its container's. */
function graphOf(it) {
  const parts = it.key.split("/");
  if (parts.length > 1) {
    const parent = state.rendered.get(parts.slice(0, -1).join("/"));
    if (parent && parent.node.graph) return parent.node.graph;
  }
  return state.graph;
}

function jumpTo(name, depth) {
  let best = null;
  for (const [, item] of state.rendered) {
    if (item.node.name !== name) continue;
    if (item.depth === depth) { best = item; break; }
    if (!best || item.depth < best.depth) best = item;
  }
  if (best) { select(best.key); centerOn(best); }
}

/* PORTS — the card that answers the only three questions that matter
 * cold: what comes in, what goes out, and who it links to. Links are
 * chips you click, not `a ← b.x` text; everything secondary (dotted
 * paths, transforms, file lines) hides in tooltips and the Code fold. */
function portsSection(it) {
  const n = it.node;
  const holder = graphOf(it) || {};
  const sec = el("section");
  sec.append(el("div", "stitle", "Ports"));

  const chip = (cls, text, tip, onclick) => {
    const c = el(onclick ? "button" : "span", `pchip ${cls}`, text);
    if (tip) c.title = tip;
    if (onclick) c.onclick = onclick;
    return c;
  };

  // one visual carries the whole meaning: `name ← source` for inputs,
  // `name → consumer` for outputs — the arrow says which way the value
  // flows, and each direction lives in its own tinted zone with its
  // own name colour. No headers, no bullets.
  const inZone = el("div", "pzone pzin");
  const outZone = el("div", "pzone pzout");
  const row = (dir, name, links) => {
    const r = el("div", "portrow");
    r.append(el("span", "pname mono", name));
    r.append(el("span", `parr ${dir}`, dir === "in" ? "←" : "→"));
    const box = el("span", "plinks");
    for (const l of links) box.append(l);
    r.append(box);
    (dir === "in" ? inZone : outZone).append(r);
    return r;
  };

  for (const inp of n.inputs || []) {
    const b = inp.binding || {};
    const name = inp.name + (inp.required ? " *" : "");
    if (b.kind === "ref") {
      const src = (b.from || "").split(".").pop();
      const isCell = !(holder.nodes || []).some(m => m.name === src);
      let label = src + (b.output && b.output !== src ? `.${b.output}` : "");
      if (b.consume) label += b.consume.mode === "collect" ? " ⧉" : " ∥";
      const tip = `${b.from}.${b.output}`
        + (b.transforms ? ` · ${b.transforms} transform` : "")
        + (b.consume ? (b.consume.mode === "collect"
            ? " · collect: buffers every yield, delivers a list"
            : ` · parallel${b.consume.max ? " ≤" + b.consume.max : ""}: yields fan out concurrently`) : "");
      row("in", name, [isCell
        ? chip("pcell", `◌ ${b.output || src}`, `graph cell — ${tip}`)
        : chip("pref", label, tip, () => jumpTo(src, it.depth))]);
    } else if (b.kind === "scratch") {
      row("in", name, [chip("pscratch", `⌂ ${b.key ?? b.value ?? "?"}`,
        "session scratch — set by the serve layer")]);
    } else if (b.kind === "literal") {
      const preview = JSON.stringify(b.value);
      const c = chip("plit", preview.length > 22 ? preview.slice(0, 20) + "…" : preview,
        it.depth > 0 ? "literal — edit in the nested graph's own source"
                     : "literal — click to edit", null);
      const r = row("in", name, [c]);
      if (it.depth === 0) {
        c.onclick = () => {
          if (r._editor) { r._editor.hidden = !r._editor.hidden; return; }
          r._editor = literalEditor(n, inp);
          r.after(r._editor);
        };
        c.classList.add("peditable");
      }
    } else {
      row("in", name, [chip("pmuted", b.kind || "unbound")]);
    }
  }

  // outputs: a LINK appears only for a real WRITE — the author's
  // `member["x"] >> PARENT["y"]`, where this output overrides another
  // op's variable. A downstream pull is the CONSUMER's own wiring and
  // shows on the consumer's input side; here it is only a tooltip.
  const consumers = {};
  for (const m of holder.nodes || []) {
    for (const i2 of m.inputs || []) {
      const b2 = i2.binding || {};
      if (b2.kind === "ref" && (b2.from || "").split(".").pop() === n.name) {
        (consumers[b2.output] = consumers[b2.output] || []).push(m.name);
      }
    }
  }
  const exports = {};
  for (const e2 of holder.exports || []) {
    if (e2.from === n.name) (exports[e2.output] = exports[e2.output] || []).push(e2.as);
  }
  for (const o of n.outputs || []) {
    const links = (exports[o] || []).map(dest =>
      chip("ppar", `PARENT.${dest}`,
        `${n.name}["${o}"] >> PARENT["${dest}"] — overrides the container's '${dest}'`));
    const r = row("out", o, links);
    const who = [...new Set(consumers[o] || [])];
    if (who.length) r.title = `pulled downstream by: ${who.join(", ")}`;
  }
  if (inZone.childNodes.length) sec.append(inZone);
  if (outZone.childNodes.length) sec.append(outZone);
  if (!(n.inputs || []).length && !(n.outputs || []).length) {
    sec.append(el("div", "note", "no declared ports"));
  }
  return sec;
}

/* the one edit the studio allows, folded away until the value is clicked */
function literalEditor(node, inp) {
  const b = inp.binding || {};
  const wrap = el("div", "inrow");
  const field = el("input");
  field.type = "text";
  field.value = JSON.stringify(b.value);
  const bar = el("div", "apply");
  const btn = el("button", null, "Preview change");
  const status = el("span", "srcline");
  bar.append(btn, status);
  const diffBox = el("div", "diffbox");
  diffBox.style.display = "none";
  wrap.append(field, bar, diffBox);

  btn.onclick = async () => {
    let value;
    try { value = JSON.parse(field.value); }
    catch { status.textContent = "not valid JSON"; return; }
    status.textContent = "…";
    try {
      const plan = await api(`/api/p/${PID}/edit`, {
        graph: state.graph.name, action: "set_param",
        op_name: node.name, param: inp.name, value, dry_run: true,
      });
      if (!plan.changed) { status.textContent = "no change"; diffBox.style.display = "none"; return; }
      diffBox.textContent = "";
      for (const line of (plan.diff || "").split("\n")) {
        const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
        diffBox.append(el("div", cls, line));
      }
      diffBox.style.display = "block";
      status.textContent = "";
      const confirm = el("button", "primary", "Apply");
      confirm.onclick = async () => {
        try {
          await api(`/api/p/${PID}/edit`, {
            graph: state.graph.name, action: "set_param",
            op_name: node.name, param: inp.name, value, dry_run: false,
          });
          status.textContent = "applied ✓ — reloading";
          toast(`${node.name}.${inp.name} rewritten in source`);
        } catch (e) { status.textContent = e.message; }
      };
      bar.append(confirm);
    } catch (e) { status.textContent = e.message; }
  };
  return wrap;
}

/* The drill-down under the aggregate: one dense line per recorded
 * execution — rank, member, duration with an inline bar, status — and
 * ONE detail area below the table (not fifty accordions). The latest
 * record is pre-selected. */
function executionsSection(n, execP) {
  const sec = el("section");
  sec.append(el("div", "stitle", "Executions"));
  const runinfo = state.run.ops[n.name];
  if (runinfo) {
    const avg = runinfo.runs ? runinfo.total_ms / runinfo.runs : 0;
    const stats = el("div", "srcline",
      `${runinfo.runs}× · avg ${avg.toFixed(1)} ms · max ${runinfo.max_ms.toFixed(1)} ms`
      + (runinfo.errors ? ` · ${runinfo.errors} err` : ""));
    if (runinfo.errors) stats.classList.add("bad");
    sec.append(stats);
  }
  const box = el("div", "execbox", "…");
  sec.append(box);
  execP.then(data => {
    box.textContent = "";
    if (!data.executions.length) {
      box.append(el("div", "note", "no records for this op in this run"));
      return;
    }
    if (data.total > data.showing) {
      box.append(el("div", "srcline", `${data.total} recorded · last ${data.showing} below`));
    }

    // A GraphOp's records belong to its members, but one PASS through
    // the container is one execution of the container — and members of
    // the same pass share their dispatch ctx. Group by it, so the list
    // reads as invocations of THIS node, with the member breakdown and
    // the boundary values inside each.
    let rows;
    if (n.graph) {
      const groups = new Map();
      data.executions.forEach((ex, i) => {
        const key = ex.ctx ? JSON.stringify(ex.ctx) : `solo-${i}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ex);
      });
      const inNames = (n.inputs || []).map(i => i.name);
      rows = [...groups.values()].map(members => {
        const bad = members.find(m => m.status !== "ok");
        const boundary = (names, dir) => {
          const found = {};
          for (const m of members) {
            const src = dir === "out" ? m.outputs : m.inputs;
            if (!src || typeof src !== "object") continue;
            for (const k of names) if (k in src) found[k] = src[k];
          }
          return found;
        };
        return {
          op: n.name,
          start_time: members[0] && members[0].start_time,
          duration_ms: members.reduce((s, m) => s + (m.duration_ms || 0), 0),
          status: bad ? bad.status : "ok",
          error: bad ? bad.error : null,
          outputs: boundary(n.outputs || [], "out"),
          inputs: boundary(inNames, "in"),
          members,
        };
      });
    } else {
      rows = data.executions;
    }

    const maxMs = Math.max(1, ...rows.map(ex => ex.duration_ms || 0));
    const table = el("div", "exectable");
    const detail = el("div", "execdetail");
    let active = null;

    // when anything failed, one checkbox cuts the list to the failures
    if (rows.some(ex => ex.status !== "ok")) {
      const bar = el("label", "followpin");
      const cb = el("input");
      cb.type = "checkbox";
      cb.onchange = () => table.classList.toggle("erronly", cb.checked);
      bar.append(cb, " errors only");
      box.append(bar);
    }

    const clock = (t) => {
      if (t == null) return "";
      const d = new Date(t * 1000);
      return d.toLocaleTimeString([], {hour12: false})
        + "." + String(d.getMilliseconds()).padStart(3, "0").slice(0, 1);
    };

    const show = (ex, row) => {
      if (active) active.classList.remove("active");
      active = row; row.classList.add("active");
      detail.textContent = "";
      if (ex.error) detail.append(el("div", "srcline bad", String(ex.error)));
      detail.append(el("div", "plabel", "outputs"));
      detail.append(Values.render(ex.outputs ?? null, {open: true, priority: n.outputs || []}));
      detail.append(el("div", "plabel", "inputs"));
      detail.append(Values.render(ex.inputs ?? null, {}));
      if (ex.members) {
        detail.append(el("div", "plabel", "members"));
        for (const m of ex.members) {
          const line = el("div", "srcline mono" + (m.status === "ok" ? "" : " bad"),
            `${m.op}  ${(m.duration_ms ?? 0).toFixed(1)}ms  ${m.status ?? "?"}`);
          detail.append(line);
        }
      }
    };

    rows.forEach((ex, i) => {
      const idx = n.graph ? i + 1 : data.total - data.showing + i + 1;
      const row = el("button", "exline" + (ex.status === "ok" ? "" : " bad"));
      row.append(el("span", "exn mono", `#${idx}`));
      row.append(el("span", "extime mono", clock(ex.start_time)));
      row.append(el("span", "exop mono",
        ex.members ? `${ex.members.length} ops`
                   : (ex.op && ex.op !== n.name ? ex.op : "")));
      const bar = el("span", "exbar");
      bar.style.setProperty("--w", `${Math.max(2, 100 * (ex.duration_ms || 0) / maxMs)}%`);
      row.append(bar);
      row.append(el("span", "exms mono", `${(ex.duration_ms ?? 0).toFixed(1)}ms`));
      row.append(el("span", "exst", ex.status === "ok" ? "✓" : (ex.status ?? "?")));
      row.onclick = () => show(ex, row);
      table.append(row);
    });
    box.append(table, detail);
    show(rows[rows.length - 1], table.lastChild);
  }).catch(e => { box.textContent = e.message; });
  return sec;
}

function inspectServe(serve) {
  const panel = $("#inspector");
  panel.classList.add("open");
  panel.textContent = "";
  panel.append(el("h3", null, `serve · ${serve.kind}`));
  panel.append(el("div", "kind mono", serve.path || ""));
  if (serve.description) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Description"));
    sec.append(el("div", "srcline", serve.description));
    panel.append(sec);
  }
  const sec = el("section");
  sec.append(el("div", "stitle", "Feeds"));
  for (const name of state.graph.entries || []) sec.append(el("span", "outchip mono", name));
  panel.append(sec);
}

/* ── traces ───────────────────────────────────────────────────────── */

async function showTraces() {
  const box = $("#traces");
  box.textContent = "";
  let data;
  try { data = await api(`/api/p/${PID}/traces`); }
  catch (e) { box.append(el("div", "errbox", e.message)); return; }
  if (!data.configured) {
    box.append(el("div", "note",
      'No trace directory declared. Add to operonx.toml:\n\n[studio]\ntraces = "/path/your/consumer/writes"'));
    box.querySelector(".note").style.whiteSpace = "pre-wrap";
    return;
  }
  if (data.missing) {
    box.append(el("div", "note", `Declared traces dir does not exist yet: ${data.missing}`));
    return;
  }
  if (data.langfuse_error) {
    box.append(el("div", "note", `Langfuse (${data.langfuse}) unreachable: ${data.langfuse_error}`));
  }
  // follow-latest: repaint whenever a newer local run lands
  const topbar = el("div", "tracebar");
  const followBar = el("label", "followpin");
  const pin = el("input");
  pin.type = "checkbox";
  pin.checked = state.follow;
  pin.onchange = () => { state.follow = pin.checked; store("follow", state.follow); };
  followBar.append(pin, " auto-paint the newest run as it arrives");
  topbar.append(followBar);
  const refresh = el("button", null, "⟳ refresh");
  refresh.onclick = showTraces;
  topbar.append(refresh);
  box.append(topbar);

  if (!data.runs.length) {
    box.append(el("div", "note", `No runs recorded yet${data.root ? " in " + data.root : ""}`));
    return;
  }
  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["run", "recorded", "activity", "source", ""]) hr.append(el("th", null, h));
  thead.append(hr); table.append(thead);
  const tbody = el("tbody");
  for (const r of data.runs) {
    const tr = el("tr", "run-row");
    tr.append(el("td", "mono", r.name || r.run));
    tr.append(el("td", null, r.mtime ? new Date(r.mtime * 1000).toLocaleString() : ""));
    const act = el("td");
    if (r.records !== undefined) {
      act.append(el("span", "chip", `${r.ops} ops`));
      act.append(el("span", "chip", `${r.records} rec`));
      if (r.wall_s != null) act.append(el("span", "chip", `${r.wall_s.toFixed(1)}s`));
      if (r.errors) act.append(el("span", "chip cbad", `${r.errors} err`));
    }
    tr.append(act);
    tr.append(el("td", null,
      r.source === "langfuse" ? "langfuse" : `local · ${(r.size / 1024).toFixed(1)} KB`));
    const actions = el("td", "runacts");
    const paint = el("button", null, "paint");
    paint.title = "color the canvas with this run's durations and errors";
    paint.onclick = (ev) => { ev.stopPropagation(); paintRun(r.run); };
    const tl = el("button", null, "timeline");
    tl.title = "when did every op run — the run as a waterfall";
    tl.onclick = (ev) => { ev.stopPropagation(); showTimeline(r.run); };
    actions.append(paint, tl);
    if (r.source !== "langfuse") {
      const rm = el("button", "danger", "✕");
      rm.title = "delete this recorded run from disk";
      rm.onclick = async (ev) => {
        ev.stopPropagation();
        if (!window.confirm(`Delete run ${r.run} from disk?`)) return;
        try {
          await api(`/api/p/${PID}/trace/${encodeURIComponent(r.run)}/delete`, {});
          toast(`deleted ${r.run}`);
          if (state.run && state.run.run === r.run) $("#run-clear").onclick();
          showTraces();
        } catch (e) { toast(e.message, true); }
      };
      actions.append(rm);
    }
    tr.append(actions);
    tr.onclick = () => paintRun(r.run);
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
}

/* The run as a waterfall: one lane per op, every recorded execution a
 * bar at its true offset. WHEN is the half of debugging the aggregate
 * view cannot answer. */
async function showTimeline(run) {
  const box = $("#traces");
  box.textContent = "";
  const bar = el("div", "tracebar");
  const back = el("button", null, "← runs");
  back.onclick = showTraces;
  bar.append(back);
  box.append(bar);

  let data;
  try { data = await api(`/api/p/${PID}/trace/${encodeURIComponent(run)}/timeline`); }
  catch (e) { box.append(el("div", "errbox", e.message)); return; }
  const spans = data.spans || [];
  if (!spans.length) { box.append(el("div", "note", "no timed records in this run")); return; }

  const total = Math.max(0.001, ...spans.map(s => s.start + s.dur_ms / 1000));
  bar.append(el("span", "srcline",
    `${run} · ${data.total} executions · ${total.toFixed(2)}s`
    + (data.total > spans.length ? ` · first ${spans.length} shown` : "")));

  const lanes = new Map();          // op -> its bar container, first-seen order
  const chart = el("div", "tl");
  for (const s of spans) {
    let lane = lanes.get(s.op);
    if (!lane) {
      const row = el("div", "tlrow");
      const label = el("button", "tlname mono", s.op);
      label.title = "select this op on the canvas";
      label.onclick = () => {
        const found = [...state.rendered.values()].find(x => x.node.name === s.op)
          || (expandAll(true), [...state.rendered.values()].find(x => x.node.name === s.op));
        switchTab("flow");
        if (found) { select(found.key); centerOn(found); }
      };
      lane = el("div", "tltrack");
      row.append(label, lane);
      chart.append(row);
      lanes.set(s.op, lane);
    }
    const b = el("div", "tlbar" + (s.status === "ok" ? "" : " bad"));
    b.style.left = `${(s.start / total) * 100}%`;
    b.style.width = `${Math.max(0.35, (s.dur_ms / 1000 / total) * 100)}%`;
    b.title = `${s.op} · +${s.start.toFixed(3)}s · ${s.dur_ms.toFixed(1)}ms · ${s.status}`
      + (s.error ? `\n${s.error}` : "");
    lane.append(b);
  }
  box.append(chart);

  const axis = el("div", "tlaxis");
  for (let i = 0; i <= 4; i++)
    axis.append(el("span", "mono", `${(total * i / 4).toFixed(2)}s`));
  box.append(axis);
}

async function paintRun(run) {
  const data = await api(`/api/p/${PID}/trace/${encodeURIComponent(run)}`);
  state.run = data;
  state.errIdx = 0;
  // heat scale: the run's slowest average paints the hottest border
  state.heatMax = Math.max(0, ...Object.values(data.ops || {})
    .map(o => o.runs ? o.total_ms / o.runs : 0));
  $("#run-name").textContent = data.run + (data.truncated ? " (truncated)" : "");
  // the banner answers "how did it go" before any clicking
  const bits = [`${Object.keys(data.ops || {}).length} ops`,
                `${data.records ?? "?"} rec`];
  if (data.wall_s != null) bits.push(`${data.wall_s.toFixed(1)}s`);
  if (data.errors) bits.push(`${data.errors} err`);
  $("#run-stats").textContent = bits.join(" · ");
  $("#run-stats").classList.toggle("bad", !!data.errors);
  $("#run-err").hidden = !data.errors;
  $("#runbanner").classList.add("show");
  switchTab("flow");
  render();
  pushView();
  renderFlowInfo();
}

/* "error →": center + select the errored ops one by one, opening
 * containers if the culprit is folded away inside one. */
$("#run-err").onclick = () => {
  if (!state.run) return;
  const names = Object.entries(state.run.ops || {})
    .filter(([, o]) => o.errors).map(([name]) => name);
  if (!names.length) return;
  const name = names[state.errIdx % names.length];
  state.errIdx += 1;
  let found = [...state.rendered.values()].find(x => x.node.name === name);
  if (!found) {          // hidden inside a collapsed GraphOp — open everything
    expandAll(true);
    found = [...state.rendered.values()].find(x => x.node.name === name);
  }
  if (found) { select(found.key); centerOn(found); }
  else toast(`'${name}' errored but is not on this canvas`, true);
};

$("#run-clear").onclick = () => {
  state.run = null;
  state.heatMax = 0;
  $("#runbanner").classList.remove("show");
  render();
  pushView();
  renderFlowInfo();
};

/* every nested graph at once — opening five GraphOps one by one to see
 * a pipeline is ritual, not choice */
function expandAll(open) {
  const all = [];
  (function walk(g, prefix) {
    for (const n of g.nodes || []) {
      if (n.graph) { all.push(prefix + n.id); walk(n.graph, prefix + n.id + "/"); }
    }
  })(state.graph, "");
  state.expanded = open ? new Set(all) : new Set();
  render();
  return all.length;
}

$("#btn-expand").onclick = () => {
  const anyOpen = state.expanded.size > 0;
  const count = expandAll(!anyOpen);
  if (!count) toast("no nested graphs here");
  $("#btn-expand").textContent = anyOpen || !count ? "⊞" : "⊟";
};

$("#btn-find").onclick = () => openFind();

/* ── tabs, graph switch, pan/zoom, live reload ────────────────────── */

function switchTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll(".tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  $("#stage").style.display = name === "flow" ? "" : "none";
  $("#traces").hidden = name !== "traces";
  if (name === "traces") showTraces();
  pushView();
}

/* ── side panels: info left, assistant right, both optional ──────── */

function applyPanels() {
  const leftOn = recall("panelLeft", true);
  const rightOn = recall("panelRight", true);
  $("#inspector").classList.toggle("off", !leftOn);
  $("#btn-left").classList.toggle("active", leftOn);
  $("#btn-right").classList.toggle("active", rightOn);
  document.dispatchEvent(new CustomEvent("oxdock", {detail: {on: rightOn}}));
}
$("#btn-left").onclick = () => { store("panelLeft", !recall("panelLeft", true)); applyPanels(); };
$("#btn-right").onclick = () => { store("panelRight", !recall("panelRight", true)); applyPanels(); };

/* ── the legend: the visual language, written down on screen ──────── */

function legendSample(cls, dash) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 64 12");
  svg.setAttribute("class", "lsample");
  const d = "M 2 6 L 62 6";
  if (dash) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    p.setAttribute("class", cls);
    svg.append(p);
  } else {
    energyEdge(svg, d, cls);
  }
  return svg;
}

function buildLegend() {
  const box = $("#legend");
  box.textContent = "";
  const title = el("div", "ltitle", "Reading the canvas");
  const close = el("button", "chat-close", "✕");
  close.onclick = () => { box.hidden = true; };
  title.append(close);
  box.append(title);

  const row = (sample, text) => {
    const r = el("div", "lrow");
    r.append(sample, el("span", null, text));
    box.append(r);
  };
  row(legendSample(""), "data flows this way — the output feeds the next op");
  row(legendSample("cond"), "if/else route — the condition sits in its own row on the router card, and the wire leaves that row");
  row(legendSample("ecore cond relse", true), "else — fires only when no condition matched");
  row(legendSample("soft", true), "soft merge — may not fire at all");
  row(el("span", "lglyph", "↺"), "a loop returns underneath, back to where the author's cycle begins");
  row(el("span", "lglyph", "⚡"), "generator: one call, many yields — consumers run per yield");
  row(el("span", "lglyph", "≋ ∥ ⧉"), "streaming edge · parallel fan-out · collect-into-list");
  row(el("span", "lglyph", "▣"), "a nested graph — click its badge (or double-click) to open it in place");
  row(el("span", "lglyph", "▶"), "START / END terminals are a graph's own ports — the main flow and every opened GraphOp have them; the dotted ties from START are session-start dispatch");
  row(el("span", "lglyph", "⇥"), "framed doors are the serve boundary: the ingress wears the transport's name, the reply leaves egress toward the client");
  row(el("span", "lheat"), "with a run painted: warmer border = slower average, red = errored, faded = did not run");

  box.append(el("div", "ltitle lkeys", "Keys"));
  box.append(el("div", "lrow lkeysrow",
    "/ or Ctrl+K find · space+drag or middle-drag pan · ctrl+scroll zoom · "
    + "0 fit · 1 = 100% · ↑ ↓ walk the wires · Esc close"));
}

$("#btn-legend").onclick = () => {
  const box = $("#legend");
  if (box.hidden) buildLegend();
  box.hidden = !box.hidden;
};

/* ── quick switcher: change project without the round trip home ───── */

$("#pname").onclick = async () => {
  const menu = $("#switcher");
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.textContent = "";
  try {
    const {projects} = await api("/api/projects");
    for (const p of projects.filter(x => x.exists)) {
      const item = el("button", "switchrow" + (p.id === PID ? " here" : ""));
      item.append(el("span", "name", p.name));
      item.append(el("span", "path mono", p.root));
      item.onclick = () => { if (p.id !== PID) location.href = `/p/${p.id}`; };
      menu.append(item);
    }
  } catch (e) { menu.append(el("div", "note", e.message)); }
  menu.hidden = false;
};
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#switcher") && !ev.target.closest("#pname"))
    $("#switcher").hidden = true;
});
for (const b of document.querySelectorAll(".tabs button"))
  b.onclick = () => switchTab(b.dataset.tab);

$("#graph-pick").onchange = (ev) => {
  state.graph = state.ir.graphs.find(g => g.name === ev.target.value);
  state.sel = null;
  state.expanded.clear();
  $("#inspector").classList.remove("open");
  render(); fit();
};

$("#btn-fit").onclick = fit;
$("#btn-zoom-in").onclick = () => { const c = stageCenter(); zoomAt(c.x, c.y, 1.25); };
$("#btn-zoom-out").onclick = () => { const c = stageCenter(); zoomAt(c.x, c.y, 0.8); };
$("#btn-zoom-pct").onclick = () => {
  const c = stageCenter();
  zoomAt(c.x, c.y, 1 / state.view.scale);   // back to exactly 100%
};

(() => {
  const stage = $("#stage");
  let drag = null;
  let spaceHeld = false;

  // The stage scrolls natively (wheel, trackpad, scrollbars); only
  // ctrl+wheel — and a trackpad pinch, which the browser reports as
  // exactly that — is intercepted, to zoom about the cursor.
  stage.addEventListener("wheel", (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top,
             Math.exp(-ev.deltaY * 0.0022));
    }
  }, {passive: false});

  stage.addEventListener("mousedown", (ev) => {
    const overNode = ev.target.closest(".node");
    const panButton = ev.button === 1 || (ev.button === 0 && spaceHeld);
    if (overNode && !panButton && ev.button === 0) return;  // node click
    if (ev.button !== 0 && ev.button !== 1) return;
    ev.preventDefault();
    drag = {x: ev.clientX, y: ev.clientY,
            sl: stage.scrollLeft, st: stage.scrollTop, moved: false};
    stage.classList.add("panning");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    drag.moved = drag.moved || Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3;
    stage.scrollLeft = drag.sl - (ev.clientX - drag.x);
    stage.scrollTop = drag.st - (ev.clientY - drag.y);
  });
  window.addEventListener("mouseup", () => { drag = null; stage.classList.remove("panning"); });

  window.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault(); openFind(); return;
    }
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
    if (ev.key === "Escape") {
      if (!$("#find").hidden) closeFind();
      else if (!$("#legend").hidden) $("#legend").hidden = true;
      else if (state.sel) deselect();
      return;
    }
    if (ev.key === "/") { ev.preventDefault(); openFind(); return; }
    if (ev.key === " ") { spaceHeld = true; stage.classList.add("panmode"); ev.preventDefault(); return; }
    // walk the wires: ↓/→ follows an outgoing edge, ↑/← an incoming one
    if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft"
         || ev.key === "ArrowDown" || ev.key === "ArrowUp") && state.sel) {
      const fwd = ev.key === "ArrowRight" || ev.key === "ArrowDown";
      const hop = state.edgeEls.find(g => (fwd ? g.a : g.b) === state.sel);
      if (hop) {
        const next = fwd ? hop.b : hop.a;
        select(next);
        const item = state.rendered.get(next);
        if (item) centerOn(item);
      }
      ev.preventDefault();
      return;
    }
    const c = stageCenter();
    if (ev.key === "+" || ev.key === "=") zoomAt(c.x, c.y, 1.25);
    else if (ev.key === "-" || ev.key === "_") zoomAt(c.x, c.y, 0.8);
    else if (ev.key === "0") fit();
    else if (ev.key === "1") zoomAt(c.x, c.y, 1 / state.view.scale);
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === " ") { spaceHeld = false; stage.classList.remove("panmode"); }
  });

  stage.addEventListener("click", (ev) => {
    if (ev.target.closest(".node") || ev.target.closest("#find")
        || ev.target.closest("#legend")) return;
    deselect();
  });
})();

/* ── find a node by name ──────────────────────────────────────────── */

function openFind() {
  const box = $("#find"), input = $("#find-input");
  box.hidden = false;
  input.value = "";
  input.focus();
}

function closeFind() {
  $("#find").hidden = true;
  for (const c of document.querySelectorAll("#nodes .node.dimmed")) c.classList.remove("dimmed");
}

function centerOn(item) {
  const stage = $("#stage");
  const r = stage.getBoundingClientRect();
  const s = state.view.scale, ex = state.extent;
  stage.scrollLeft = (item.x + item.w / 2 - ex.minX) * s + VIEW_PAD - r.width / 2;
  stage.scrollTop = (item.y + item.h / 2 - ex.minY) * s + VIEW_PAD - r.height / 2;
}

(() => {
  const input = $("#find-input");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    for (const c of document.querySelectorAll("#nodes .node")) {
      const name = (c.dataset.name || "").toLowerCase();
      c.classList.toggle("dimmed", !!q && !name.includes(q));
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { closeFind(); return; }
    if (ev.key !== "Enter") return;
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    // shallowest match wins — the top-level op, not a container's twin
    let best = null;
    for (const [, item] of state.rendered) {
      if (!item.node.name.toLowerCase().includes(q)) continue;
      if (!best || item.depth < best.depth) best = item;
    }
    if (best) { closeFind(); select(best.key); centerOn(state.rendered.get(best.key)); }
  });
})();

/* ── resizable inspector ──────────────────────────────────────────── */

(() => {
  // the info panel sits on the LEFT now; its handle drags rightward
  const bar = $("#dragbar"), panel = $("#inspector");
  const saved = recall("panelW", null);
  if (saved) panel.style.width = `${saved}px`;
  let dragging = false;
  bar.addEventListener("pointerdown", (ev) => {
    dragging = true;
    bar.setPointerCapture(ev.pointerId);
    document.body.classList.add("resizing");
  });
  bar.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const left = $(".main").getBoundingClientRect().left;
    const width = Math.min(720, Math.max(280, ev.clientX - left));
    panel.style.width = `${width}px`;
  });
  bar.addEventListener("pointerup", () => {
    dragging = false;
    document.body.classList.remove("resizing");
    store("panelW", parseInt(panel.style.width, 10) || 340);
  });
  bar.addEventListener("dblclick", () => {
    panel.style.width = "340px";
    store("panelW", 340);
  });
})();

applyPanels();

async function load(first) {
  const data = await api(`/api/p/${PID}/ir`);
  $("#pname").textContent = data.name || "project";
  document.title = `${data.name} — operonx studio`;
  if (data.error) {
    $("#nodes").textContent = "";
    $("#edges").textContent = "";
    // the error, not the wall: last line big, traceback folded away
    const box = el("div", "errbox");
    const lines = String(data.error).trim().split("\n");
    box.append(el("div", "errhead", lines[lines.length - 1]));
    if (lines.length > 1) {
      const fold = el("details");
      fold.append(el("summary", null, "full traceback"));
      fold.append(el("pre", "mono", data.error));
      box.append(fold);
    }
    box.append(el("div", "note",
      "Fix the file and save — the studio re-extracts and redraws on its own."));
    box.style.position = "absolute";
    box.style.maxWidth = "700px";
    $("#stage").append(box);
    $("#live").classList.add("stale");
    $("#live-text").textContent = "extraction failed";
    state.stamp = data.stamp;
    return;
  }
  for (const b of document.querySelectorAll("#stage .errbox")) b.remove();
  $("#live").classList.remove("stale");
  $("#live-text").textContent = "live";
  state.ir = data;
  state.stamp = data.stamp;

  const pick = $("#graph-pick");
  const current = state.graph && state.graph.name;
  pick.textContent = "";
  for (const g of data.graphs) {
    const opt = el("option", null, `${g.name} (${g.nodes.length})`);
    opt.value = g.name;
    pick.append(opt);
  }
  // The convention is ONE main served graph per project, so with one
  // graph there is nothing to pick — the chrome would only suggest a
  // choice that does not exist. The picker returns if a project ever
  // declares extra unserved [[graph]] entries.
  pick.hidden = data.graphs.length <= 1;
  state.graph = data.graphs.find(g => g.name === current) || data.graphs[0];
  if (state.graph) pick.value = state.graph.name;
  render();
  if (first) initView();
  pushView();
  renderFlowInfo();
}

let pollN = 0;
async function poll() {
  pollN += 1;
  try {
    const {stamp} = await api(`/api/p/${PID}/stamp`);
    if (stamp !== state.stamp) await load(false);
    // follow-latest, throttled — a directory scan every 6s, never the
    // remote Langfuse API
    if (state.follow && pollN % 4 === 0) {
      const t = await api(`/api/p/${PID}/traces?local_only=1`);
      const newest = (t.runs || []).find(r => r.source === "local");
      if (newest && (!state.run || state.run.run !== newest.run)) await paintRun(newest.run);
    }
  } catch { /* daemon briefly away; the next poll answers */ }
  setTimeout(poll, 1500);
}

state.follow = recall("follow", false);
load(true).then(() => setTimeout(poll, 1500));
