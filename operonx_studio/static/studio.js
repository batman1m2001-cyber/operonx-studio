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
// a $media blob in a recorded value plays or shows from the project's store
// the ref's declared type rides along: the server reads the bytes' own
// type first and takes this only for raw PCM (served as WAV so it plays)
if (window.Values) Values.mediaUrl = (sha, mime) =>
  `/api/p/${PID}/media/${sha}${mime ? `?mime=${encodeURIComponent(mime)}` : ""}`;
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
  jobSel: null,       // the job the Jobs tab is showing
  jobRun: null,       // and its run, if one is open
  jobsView: null,     // token: the latest showJobs() owns the pane
  cardEls: new Map(), // render key -> card element (selection without re-render)
  edgeEls: [],        // [{a, b, els}] every drawn edge's paths, for hot/arrow nav
  errIdx: 0,          // cycling cursor for the "error →" jump
};

// the canvas in motion (defined further down; used by render and leaveWorkflow)
let liveCanvas = null;

/* What the user is looking at, for anyone who asks — the assistant
 * sends it along with every chat message. */
function pushView() {
  const it = state.sel ? state.rendered.get(state.sel) : null;
  window.__oxview = {
    node: it ? it.node.name : null,
    kind: it ? it.node.kind : null,
    run: state.run ? state.run.run : (state._tlrun || null),
    tab: state.tab,
    lens: state.run ? (state.lens || "path") : null,
    exec: state.execSel || null,
    runs_filter: state.tab === "traces" ? (recall(`runsView:${PID}`, null) ? JSON.stringify(recall(`runsView:${PID}`, null)) : null) : null,
    monitor: state.tab === "monitor" ? JSON.stringify(recall(`monitor:${PID}`, {})) : null,
  };
  document.dispatchEvent(new CustomEvent("oxview"));
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

/* Every call to the studio. A body that is not JSON (the tunnel's own
 * "no tunnel here" page, a proxy's 502) becomes a readable error instead
 * of a JSON parse exception; a signed-out session goes to the login; a
 * GET that never reached the server is tried once more. */
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  };
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (body !== undefined) throw new Error("The studio did not answer — check the connection");
    await new Promise(r => setTimeout(r, 600));
    try { res = await fetch(path, opts); }
    catch { throw new Error("The studio did not answer — check the connection"); }
  }
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("signed out");
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch {
    throw new Error(res.ok ? "The studio sent something unreadable"
      : `The studio is unreachable (${res.status}) — the tunnel may have dropped`);
  }
  if (!res.ok) {
    if (window.Account) Account.refused(res.status, data.error);
    // the body rides along: a screen can tell "the store is away"
    // (data.store_unreachable) from any other failure
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
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
  "LLMOp":             {icon: "✧", color: "var(--k-llm)"},
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
  [/LLM|Chat|Completion/,                    {icon: "✧", color: "var(--k-llm)"}],
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

/* An LLM op's icon is its BACKEND, not just "some LLM" — detection
 * lives in providers.js (pure, node-tested); this file only wires it
 * to the canvas. */
const LLM_PROVIDERS = Providers.PROVIDERS;

function resourceOf(node) {
  const name = Array.isArray(node.resource) ? node.resource[0] : node.resource;
  return name ? ((state.ir.resources || {}).details || {})[name] || null : null;
}

function llmProvider(node) {
  if (!(node.kind || "").match(/LLM|Chat|Completion/)) return null;
  return Providers.detectProvider(
    {resource: node.resource, fields: resourceOf(node) || {}});
}

function kindIcon(node) {
  const v = visualOf(node.kind);
  if (v.color === "var(--k-llm)") {
    const p = llmProvider(node);
    if (p) return LLM_PROVIDERS[p].icon;
  }
  return v.icon;
}

/* With a run painted, an op either executed or it didn't — and the
 * ones that didn't fade back, so the picture becomes the path taken.
 * A GraphOp ran if any member did; structure (terminals) never fades. */
function ranInRun(n) {
  if (!state.run) return true;
  if (n.kind === "__boundary__") return true;
  if (n.graph) return (n.graph.nodes || []).some(ranInRun);
  if (state.runTurn && state.runByOpTurn) {
    const byTurn = state.runByOpTurn.get(n.name);
    return !!(byTurn && byTurn.has(state.runTurn));
  }
  return !!state.run.ops[n.name];
}

/* ── placement: flowlayout.js ─────────────────────────────────────── */

/* Every card of every open level is placed by ONE compound layout
 * (FlowLayout.layout, static/flowlayout.js), from the cards' real sizes:
 * an opened GraphOp is laid out with its siblings as one node of its real
 * size, its START/END knobs on its border, and each wire follows the lane
 * the placement reserved for it — no wire is routed around a card after
 * the fact. */
const B_H = 28;   // the main flow's standalone terminal pills

const portCX = (it) => it.x + it.w / 2;

// a plain curve: the serve transport's fan to the entries
function bezier(x1, y1, x2, y2) {
  const gap = Math.abs(y2 - y1);
  // dead vertical: straight, drawn as a curve like every other wire
  if (Math.abs(x2 - x1) < 3) {
    const k = (y2 - y1) / 3;
    return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
  }
  // handles must never outrun the gap — a 40px handle on a 30px hop
  // overshoots both ends and folds the wire into a kink
  const dy = gap < 80 ? gap * 0.45 : Math.max(40, gap / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

/* A wire that starts at a row's dot starts INSIDE its card — but edges
 * paint beneath the cards. Repaint exactly the over-card stretch above
 * the card, masked to its rect: identical paths, so there is no seam and
 * dashed elses stay in phase. The mask also cuts a hole under every
 * condition dot: the repaint sits ABOVE the card, so without the hole a
 * 12px glow starting at the dot's centre painted right over it. */
function overCard(A, made) {
  const top = $("#edgetop");
  const cid = "rowmask-" + A.key.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!top.querySelector(`#${cid}`)) {
    const mk = document.createElementNS(SVGNS, "mask");
    mk.setAttribute("id", cid);
    mk.setAttribute("maskUnits", "userSpaceOnUse");
    mk.setAttribute("x", A.x - 4); mk.setAttribute("y", A.y - 4);
    mk.setAttribute("width", A.w + 8); mk.setAttribute("height", A.h + 8);
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", A.x - 4); r.setAttribute("y", A.y - 4);
    r.setAttribute("width", A.w + 8); r.setAttribute("height", A.h + 8);
    r.setAttribute("fill", "#fff");
    mk.append(r);
    for (const d of (A.condDots || [])) {
      const hole = document.createElementNS(SVGNS, "circle");
      hole.setAttribute("cx", A.x + d.x); hole.setAttribute("cy", A.y + d.y);
      hole.setAttribute("r", 7.5);
      hole.setAttribute("fill", "#000");
      mk.append(hole);
    }
    top.append(mk);
  }
  const g2 = document.createElementNS(SVGNS, "g");
  g2.setAttribute("mask", `url(#${cid})`);
  const over = made.map(m => m.cloneNode(false));
  for (const m of over) g2.append(m);
  top.append(g2);
  made.push(...over);
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
  t.setAttribute("text-anchor", cls && /\b(start|end)$/.test(cls) ? cls.split(" ").pop() : "middle");
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
 * a frame of animation. Nothing here moves: a run in progress is the
 * only motion (liveCanvas, which lights the core and sends particles). */
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

/* Points along a wire without asking the browser. The router draws with
 * absolute M, L and C only, so a wire's length and points are sampled
 * here: getTotalLength/getPointAtLength cost ~0.2 ms a call, 58 of the
 * 224 ms a 302-op render took (measured, docs/ASSISTANT_NEXT_PLAN.md §8).
 * Any other command returns null, and the caller asks the DOM. */
function pathSampler(d) {
  const tok = String(d).match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  if (!tok) return null;
  const pts = [];
  let i = 0, x = 0, y = 0, cmd = null;
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M" || cmd === "L") {
      x = num(); y = num();
      pts.push(x, y);
      if (cmd === "M") cmd = "L";          // pairs after a moveto are linetos
    } else if (cmd === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
        pts.push(a * x + b * x1 + c * x2 + e * x3, a * y + b * y1 + c * y2 + e * y3);
      }
      x = x3; y = y3;
    } else return null;
  }
  if (pts.length < 4 || pts.some(Number.isNaN)) return null;
  const cum = [0];
  for (let k = 2; k < pts.length; k += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]));
  const len = cum[cum.length - 1];
  const at = (v) => {
    let k = 1;
    while (k < cum.length - 1 && cum[k] < v) k += 1;
    const seg = cum[k] - cum[k - 1] || 1, f = Math.max(0, Math.min(1, (v - cum[k - 1]) / seg));
    return {x: pts[2 * k - 2] + (pts[2 * k] - pts[2 * k - 2]) * f, y: pts[2 * k - 1] + (pts[2 * k + 1] - pts[2 * k - 1]) * f};
  };
  return {len, at};
}

/* Direction: one small light dot travelling each wire, source to target —
 * a loop's return edge carries it backwards, in its own colour. One SMIL
 * animateMotion per wire on the wire's own `d`, so it follows any route.
 * Flow view only; off for prefers-reduced-motion (CSS), paused while the tab
 * is hidden, at most FLOW_DOTS_MAX per canvas, and a toolbar switch. */
const FLOW_DOTS_MAX = 150;
let flowDotsOn = recall("ox:flowdots", true) !== false;

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

  // ── cards first, measured; then ONE layout places everything ──
  // Every card goes into the DOM before anything is placed: the layout
  // (flowlayout.js) works from each card's REAL size — its name line, a
  // decision card's condition rows — and reserves a clear path for every
  // wire around exactly those boxes. Nothing moves after it: an opened
  // GraphOp is laid out with its siblings, not shifted into them.
  const leaves = [];
  (function walk(gr, prefix, depth) {
    for (const n of gr.nodes || []) {
      const key = prefix + n.id;
      if (n.graph && state.expanded.has(key)) walk(n.graph, key + "/", depth + 1);
      else leaves.push({key, node: n, depth, inner: null, x: 0, y: 0, w: NODE_W, h: NODE_H});
    }
  })(g, "", 0);
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
    let els = [...card.querySelectorAll(".ntext, .brcond")];
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
    const need = Math.max(...m.els.map((_, j) => natural[i][j] - laidOut[i].widths[j]));
    const want = Math.ceil(m.it.w + need + 8);
    const w = Math.max(180, Math.min(310, want));
    if (want > 310) {
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
    if (it.node.routes && it.node.routes.length) {
      it.rows = [...card.querySelectorAll(".brrow")].map(rrow => ({
        el: rrow, target: rrow.dataset.target,
        route: rrow.dataset.route != null ? Number(rrow.dataset.route) : null,
        left: rrow.offsetLeft, top: rrow.offsetTop, w: rrow.offsetWidth, h: rrow.offsetHeight,
      }));
    }
  }
  const sized = new Map(leaves.map(it => [it.key, it]));
  const L = FlowLayout.layout(g, {
    expanded: state.expanded,
    textWidth: zoneTextWidth,
    sizeOf: (key) => { const it = sized.get(key); return it ? {w: it.w, h: it.h, rows: it.rows || []} : null; },
  });
  // in paint order: a container before its members, so they sit on its box
  // — and a loop's zone between the two: over the box, under its cards
  nodesBox.textContent = "";
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
  }
  // each condition row's port DOT on the side its wire leaves by — the
  // side the layout chose (where its target lies; END left, a loop's
  // return right) — and where that dot is, card-relative
  for (const [key, sides] of L.rowSides) {
    const it = state.rendered.get(key);
    if (!it) continue;
    it.condPorts = {};
    it.condDots = [];
    for (const {row, side} of sides) {
      row.el.classList.toggle("left", side < 0);
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
    state.edgeEls.push({a: a.key, b: b.key, id: e.id, els: made});
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

/* With a run painted, a card says ONE thing — the lens decides which.
 * path: nothing but lit / faded. time: the op's total time in the run,
 * the three slowest ranked, the border warmer with its share. errors:
 * only failures, with their error. cost: only ops that cost money.
 * values: executions and average, and the show-key values. */
/* An op's numbers in the painted run — a nested graph's are its members'
 * summed (a container never executes under its own name). */
function runNumbers(n) {
  const rolls = state.runRollups || new Map();
  if (!n.graph) {
    const info = state.run && state.run.ops[n.name];
    return info ? {info, roll: rolls.get(n.name) || null} : null;
  }
  const acc = {runs: 0, total_ms: 0, max_ms: 0, errors: 0, last_error: null};
  const roll = {count: 0, total_ms: 0, cost_usd: null, unpriced: 0, tokens_in: 0, tokens_out: 0};
  let any = false;
  (function walk(g) {
    for (const m of (g && g.nodes) || []) {
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
    const chips = state.run ? null : nameChips(n);
    if (chips) line.append(chips);
    card.append(line);
    card.title = n.kind + (n.bound ? ` · ${n.bound}` : "");
    const list = el("div", "brlist");
    n.routes.forEach((r, ri) => {
      const rrow = el("div", "brrow" + (r.condition === "else" ? " relse" : ""));
      rrow.dataset.target = r.target;
      rrow.dataset.route = String(ri);
      rrow.append(el("span", "brcond mono", r.condition));
      rrow.append(el("span", "brport"));
      rrow.title = `${r.condition} → ${r.target}`;
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
    // the kind line was card noise at fit-zoom; it lives in the
    // tooltip and the inspector — and, zoomed in close, on the card
    // itself (the .detail block shows only at [data-zoom="hi"])
    card.title = n.kind + (n.bound ? ` · ${n.bound}` : "") + (n.is_gen ? " · generator" : "");
    // Zoomed in, the card says what the op PRODUCES, not its port
    // list: inputs are the wires, and most outputs are plumbing every
    // op passes along. show_keys (declared on the op, its kind's
    // default, or the extractor's pick from the dataflow) name the one
    // or two outputs that stand for it. With a run painted the same
    // line carries the last execution's value, cut to a card's width.
    const det = el("div", "detail");
    const keys = (state.run && (state.lens || "path") !== "values") ? [] : (n.show_keys || []).slice(0, 2);
    const turnExec = state.run && state.runTurn && state.runByOpTurn
      && state.runByOpTurn.get(n.name) && state.runByOpTurn.get(n.name).get(state.runTurn);
    const vals = turnExec ? turnExec.outputs
      : (state.run && !state.runTurn && state.run.ops[n.name] && state.run.ops[n.name].last);
    const where = turnExec ? `in ${state.runTurn}` : `last value of ${state.run ? state.run.run : ""}`;
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

  // At most TWO badges: one semantic marker, plus the run chip. Density
  // is respect — everything else is one click away in the inspector.
  const badges = el("div", "badges");
  if (n.graph) {
    const b = el("button", "badge sub expand", `▣ ${n.subgraph_ops} ▸`);
    b.title = "A nested @graph — click to open it in place.";
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
  // an op was picked on the canvas: its detail is the point, bring the tab forward
  // (on a phone the panel is a sheet that only a selection opens)
  if (MOBILE.matches || (panelWanted() && recall("sideTab", "assistant") !== "inspect")) showSide("inspect");
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
  const titleRow = el("div", "ptitle-row");
  titleRow.append(el("h3", null, n.name));
  if (window.oxAssistant) {
    const ask = Icons.button("spark", "Ask", "askbtn", `Ask the assistant about ${n.name}`);
    ask.onclick = () => window.oxAssistant.focus();
    titleRow.append(ask);
  }
  head.append(titleRow);
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
  if (n.loop) chips.append(el("span", "chip cloop", "↺ in a loop"));
  head.append(chips);
  panel.append(head);
  if (n.loop) panel.append(loopNote(n, it.zone));

  if (state.run && !ranInRun(n)) {
    panel.append(el("div", "rolenote dormnote",
      `— did not execute in ${state.run.run}. The values below are its wiring, not a recording.`));
  }
  // with a run painted, the op's verdict in that run comes first
  const inRun = state.run && state.run.ops[n.name];
  if (inRun) {
    const roll = state.runRollups ? state.runRollups.get(n.name) : null;
    const total = Math.max(1, (state.run.wall_s || 0) * 1000);
    const v = el("div", "execverdict");
    v.append(el("span", "status " + (inRun.errors ? "s-bad" : "s-ok"), inRun.errors ? `${inRun.errors} failed` : "ok"));
    v.append(el("span", "vsep", "·"), el("span", "strong", fmtMs(inRun.total_ms)));
    v.append(el("span", "vsep", "·"), el("span", null, `${inRun.runs} run${inRun.runs > 1 ? "s" : ""}`));
    if (state.run.wall_s) v.append(el("span", "vsep", "·"), el("span", null, `${Math.round(100 * inRun.total_ms / total)}% of the run`));
    const cost = roll ? RunView.money(roll.cost_usd, roll.unpriced) : null;
    if (cost) v.append(el("span", "vsep", "·"), el("span", null, cost));
    panel.append(v);
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

  // A painted run leads with THE RUNS: click an execution, see its
  // inputs and outputs — that is what a trace is for. Everything else
  // (wiring, resource, code) queues behind. Containers keep the
  // member-scan latest-values view before their grouped passes.
  if (execP && !n.graph) panel.append(executionsSection(n, execP));
  if (execP && n.graph) panel.append(valuesSection(n, execP));
  // With a run painted the panel is a TRACE reader: ports would only
  // repeat what every execution already shows, and code lives in the
  // flow view — both stand down until the run is cleared.
  if (n.description) panel.append(el("div", "rolenote", n.description));
  if (!state.run) panel.append(portsSection(it));
  const res = resourceSection(n);
  if (res) panel.append(res);
  const llm = llmSection(n, execP);
  if (llm) panel.append(llm);
  if (n.routes) panel.append(routeSection(it, execP));
  if (execP && n.graph) panel.append(executionsSection(n, execP));
  if (n.code && !state.run) panel.append(codeSection(n));
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
/* A field value with its ${VAR} knobs rendered as env pills: the var
 * NAME shows (that is safe and useful), the value never travels here.
 * A `${VAR:default}` pill carries its default right after it. */
function envValue(v) {
  const out = el("span", "resval mono");
  const s = String(v);
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.append(s.slice(last, m.index));
    const tok = el("span", "envtok", "${" + m[1] + "}");
    tok.title = m[2] !== undefined && m[2] !== ""
      ? `env variable — default: ${m[2]}` : "env variable — required";
    out.append(tok);
    if (m[2]) out.append(el("span", "envdefault", m[2]));
    last = re.lastIndex;
  }
  if (last < s.length) out.append(s.slice(last));
  return out;
}

/* The resource an op leans on is part of what the op IS — an LLM op
 * without its model and endpoint is half a description. Hardcoded
 * secrets never reach the IR (masked at extraction); env-bound ones
 * appear as their ${VAR} pill. */
function resourceSection(n) {
  if (!n.resource) return null;
  const names = Array.isArray(n.resource) ? n.resource : [n.resource];
  const all = (state.ir.resources || {}).details || {};
  const sec = el("section");
  sec.append(el("div", "stitle", "Resource"));
  const provider = llmProvider(n);
  for (const name of names) {
    const det = all[name];
    const head = el("div", "resname mono");
    head.append(`⛁ ${name}` + (det && det.category ? `  ·  ${det.category}` : ""));
    sec.append(head);
    if (provider) {
      const row = el("div", "resrow");
      row.append(el("span", "reskey", "backend"));
      row.append(el("span", "resval resbackend",
        `${LLM_PROVIDERS[provider].icon} ${LLM_PROVIDERS[provider].label}`));
      sec.append(row);
    }
    if (det) {
      for (const [k, v] of Object.entries(det)) {
        if (k === "category") continue;
        const row = el("div", "resrow");
        row.append(el("span", "reskey", k));
        row.append(envValue(v));
        sec.append(row);
      }
    } else {
      sec.append(el("div", "note",
        "named here, but no matching entry in the project's resource files"));
    }
  }
  return sec;
}

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
    c.title = tip || text;   // a chip may ellipsise; the title always has it whole
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
  const btn = el("button", "needs-edit", "Preview change");
  const status = el("span", "srcline");
  bar.append(btn, status);
  if (window.Account) Account.readonly(field);
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
function fmtCtx(c) { return Array.isArray(c) ? c.join(".") : (c || ""); }

/* ── trace values ───────────────────────────────────────────────────
 * One renderer for an execution's values (io.js): an LLM call as its
 * conversation and reply, everything else as readable fields, and a
 * Formatted / JSON switch the panel remembers. */
function traceValue(v) { return IO.valueView(v); }

/* an execution's input and output cards; inputs that read a SCRATCH
 * cell wear the cell's name */
function valueZones(box, inputs, outputs, scratchKeyOf = {}, opts = {}) {
  const badges = {};
  for (const [k, cell] of Object.entries(scratchKeyOf))
    badges[k] = [`⌂ ${cell}`, "read from a SCRATCH cell — the cell's observed value at this step"];
  box.append(IO.panel(inputs, outputs, {
    ...opts, badges, mode: recall("ioMode", "pretty"), onMode: (m) => store("ioMode", m),
  }));
}

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

    // which inputs are SCRATCH reads — the IR's bindings say so
    const scratchKeyOf = {};
    for (const inp of n.inputs || []) {
      if (inp.binding && inp.binding.kind === "scratch")
        scratchKeyOf[inp.name] = inp.binding.key || inp.name;
    }
    const show = (ex, row) => {
      if (active) active.classList.remove("active");
      active = row; row.classList.add("active");
      detail.textContent = "";
      if (ex.error) detail.append(el("div", "srcline bad", String(ex.error)));
      valueZones(detail, ex.inputs, ex.outputs, scratchKeyOf);
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
      // every run wears its dispatch ctx — WHICH pass this was is half
      // of understanding a generator's fan
      row.append(el("span", "exop mono",
        ex.members ? `${ex.members.length} ops` : fmtCtx(ex.ctx)));
      row.title = ex.ctx ? `ctx ${fmtCtx(ex.ctx)}` : "";
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
  // (on a phone the panel is a sheet that only a selection opens)
  if (MOBILE.matches || (panelWanted() && recall("sideTab", "assistant") !== "inspect")) showSide("inspect");
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

/* ── the resource hub: every declared backing service, who uses it,
   and whether the env contract is satisfied. Read-only by design —
   the server checks variables by NAME and never returns a value. */
async function showResources() {
  const box = $("#resources");
  box.textContent = "";
  const res = state.ir.resources || {};
  const details = res.details || {};
  const head = el("div", "panehead");
  head.append(el("h2", null, "Resources"));
  box.append(head);
  box.append(el("p", "panesub",
    "The backing services this project declares, which ops use them, and whether the "
    + "environment they need is set. Secret fields never leave the server."));

  // reverse index: resource name → the ops that lean on it — including
  // ops nested inside GraphOps, which carry their graph inline
  const uses = {};
  const walk = (nodes, graph) => {
    for (const n of nodes || []) {
      const names = Array.isArray(n.resource) ? n.resource
        : n.resource ? [n.resource] : [];
      for (const r of names) (uses[r] = uses[r] || []).push({graph, node: n});
      if (n.graph) walk(n.graph.nodes, graph);
    }
  };
  for (const g of state.ir.graphs || []) walk(g.nodes, g);

  const cats = {};
  for (const [name, det] of Object.entries(details)) {
    const c = det.category || "other";
    (cats[c] = cats[c] || []).push([name, det]);
  }
  if (!Object.keys(cats).length && !(res.keys || []).length) {
    box.append(paneNote("No resources declared",
      "Resources are the LLMs, stores and services ops call by name. Declare them in a resources file next to operonx.toml."));
  }
  for (const cat of Object.keys(cats).sort()) {
    box.append(el("h3", "rescat", cat));
    const grid = el("div", "resgrid");
    box.append(grid);
    for (const [name, det] of cats[cat].sort((a, b) => a[0].localeCompare(b[0]))) {
      const card = el("div", "rescard");
      card.append(el("div", "resname", name));
      const provider = det.category === "llm"
        ? llmProvider({kind: "LLMOp", resource: name}) : null;
      if (provider) {
        const row = el("div", "resrow");
        row.append(el("span", "reskey", "backend"));
        row.append(el("span", "resval resbackend",
          `${LLM_PROVIDERS[provider].icon} ${LLM_PROVIDERS[provider].label}`));
        card.append(row);
      }
      if (det.category === "llm") card.append(priceRow(name, det));
      for (const [k, v] of Object.entries(det)) {
        if (k === "category" || k === "cost_per_input_token" || k === "cost_per_output_token") continue;
        const row = el("div", "resrow");
        row.append(el("span", "reskey", k));
        row.append(envValue(v));
        card.append(row);
      }
      const urow = el("div", "resrow");
      urow.append(el("span", "reskey", "used by"));
      const val = el("span", "usedby");
      const u = uses[name] || [];
      if (!u.length) val.append(el("span", "note", "No op uses it"));
      for (const use of u) {
        const c = el("button", "pchip pref", use.node.name);
        c.title = `${use.graph.name} · ${use.node.kind} — jump to it`;
        c.onclick = () => jumpToOp(use.graph, use.node);
        val.append(c);
      }
      urow.append(val);
      card.append(urow);
      grid.append(card);
    }
  }
  const covered = new Set([...Object.keys(details),
    ...Object.values(details).map(d => d.category)]);
  const loose = (res.keys || []).filter(k => !covered.has(k));
  if (loose.length) {
    box.append(el("h3", "rescat", "declared, details not parsed"));
    const card = el("div", "rescard usedby");
    for (const k of loose) card.append(el("span", "chip", k));
    box.append(card);
  }

  // the env contract, with a health light per variable
  box.append(el("h3", "rescat", "Environment"));
  const envBox = el("div", "envlist");
  box.append(envBox);
  try {
    const h = await api(`/api/p/${PID}/env-health`);
    const env = res.env || {};
    const rows = [];
    for (const name of env.required || [])
      rows.push([name, h.env[name] || "missing", null]);
    for (const [name, dflt] of Object.entries(env.optional || {}))
      rows.push([name, h.env[name] || "default", dflt]);
    if (!rows.length) envBox.append(el("div", "envrow note", "The project asks for no environment variables."));
    for (const [name, stat, dflt] of rows) {
      const row = el("div", "envrow");
      row.append(el("span", `envdot ${stat}`));
      row.append(el("span", "envname mono", name));
      row.append(el("span", `envstat ${stat}`,
        stat === "set" ? "Set" : stat === "missing"
          ? "Missing — required, and nothing sets it" : "Not set — the default applies"));
      if (dflt != null && stat === "default")
        row.append(el("span", "envdflt mono", String(dflt)));
      envBox.append(row);
    }
    if (!h.dotenv) envBox.append(el("div", "envrow note",
      "No .env file in the project root — variables can only come from the process environment."));
  } catch {
    envBox.append(el("div", "envrow note", "Environment status is unavailable."));
  }
}

/* An LLM resource's prices, and an editor that writes them to the
 * resources file — shown as a diff first, applied on confirm. A price of
 * 0 is a declared zero (an in-house model); no price is "unpriced". */
function priceRow(name, det) {
  const wrap = el("div", "pricerow");
  const perM = (v) => (v == null || v === "" ? null : Number(v) * 1e6);
  const fmt = (v) => (v === 0 ? "$0" : `$${Number(v.toPrecision(6))}`);
  const pin = perM(det.cost_per_input_token), pout = perM(det.cost_per_output_token);
  const line = el("div", "resrow");
  line.append(el("span", "reskey", "price"));
  const val = el("span", "resval priceval");
  if (pin == null && pout == null) {
    val.append(el("span", "unpriced", "Not priced"), " — calls show as unpriced in Runs and Monitor");
  } else {
    val.textContent = `${fmt(pin || 0)} in · ${fmt(pout || 0)} out per 1M tokens`;
  }
  const edit = el("button", "linkbtn needs-edit", pin == null && pout == null ? "Set prices" : "Edit");
  edit.type = "button";
  line.append(val, edit);
  wrap.append(line);

  const form = el("div", "priceform");
  form.hidden = true;
  const field = (label, value) => {
    const f = el("label", "pricefield");
    f.append(el("span", null, label));
    const i = el("input");
    i.type = "number"; i.min = "0"; i.step = "0.01"; i.inputMode = "decimal";
    i.value = value == null ? "" : String(Number(value.toPrecision(6)));
    i.placeholder = "0";
    f.append(i, el("span", "priceunit", "USD / 1M tokens"));
    return [f, i];
  };
  const [fIn, iIn] = field("Input", pin);
  const [fOut, iOut] = field("Output", pout);
  const diff = el("pre", "diffbox");
  diff.hidden = true;
  const err = el("div", "err");
  const acts = el("div", "priceacts");
  const cancel = el("button", "small", "Cancel");
  cancel.type = "button";
  const preview = el("button", "small", "Preview change");
  preview.type = "button";
  const apply = el("button", "small primary", "Save to resources file");
  apply.type = "button";
  apply.hidden = true;
  acts.append(cancel, preview, apply);
  form.append(fIn, fOut, el("p", "note pricehint", "For an in-house model, 0 declares it free — different from leaving it unpriced."), diff, err, acts);
  wrap.append(form);

  const body = () => ({resource: name, input_per_1m: iIn.value || 0, output_per_1m: iOut.value || 0});
  edit.onclick = () => { form.hidden = !form.hidden; };
  cancel.onclick = () => { form.hidden = true; diff.hidden = true; apply.hidden = true; err.textContent = ""; };
  preview.onclick = async () => {
    err.textContent = "";
    try {
      const r = await api(`/api/p/${PID}/resources/price`, body());
      diff.textContent = "";
      for (const ln of (r.diff || "No change.").split("\n")) {
        diff.append(el("div", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : null, ln));
      }
      diff.hidden = false;
      apply.hidden = !r.changed;
    } catch (e) { err.textContent = e.message; }
  };
  apply.onclick = async () => {
    try {
      await api(`/api/p/${PID}/resources/price`, {...body(), apply: true});
      toast("Prices saved — new calls are priced from now on");
      form.hidden = true;
    } catch (e) { err.textContent = e.message; }
  };
  return wrap;
}

function jumpToOp(graph, node) {
  switchTab("flow");
  if (state.graph !== graph
      && (state.ir.graphs || []).includes(graph)) {
    state.graph = graph;
    $("#graph-pick").value = graph.name;
    state.sel = null;
    state.expanded.clear();
    render();
    fit();
  }
  const find = () => [...state.rendered.values()]
    .find(x => !x.inner && x.node.name === node.name);
  let it = find();
  if (!it) {
    // nested inside a collapsed GraphOp — open everything and retry
    expandAll(true);
    it = find();
  }
  if (it) { select(it.key); centerOn(it); }
}

/* A pane's "nothing here yet" — what is missing and the exact lines
 * that fix it, instead of a grey sentence. */
/* A screen that could not load: what went wrong in one line, and a way
 * to try again — a dropped tunnel is the usual reason, and it passes. */
function loadError(err, retry) {
  const box = el("div", "errbox loaderr");
  box.append(el("div", "errhead", "This could not load"),
    el("div", "note", err && err.message ? err.message : String(err)));
  if (retry) {
    const b = Icons.button("refresh", "Try again", "small");
    b.onclick = retry;
    box.append(b);
  }
  return box;
}

/* An empty or stuck screen: what is (not) here, and the ONE action that
 * fixes it — usually the assistant doing it — before any manual recipe.
 * opts.ask = {label, prompt}: a button that hands the assistant the task.
 * opts.actions = [{label, icon, run}]: plain buttons beside it. A code
 * recipe, when given, folds under "Or do it by hand". */
function paneNote(title, text, code, opts) {
  opts = opts || {};
  const box = el("div", "panenote");
  box.append(el("h3", null, title));
  box.append(el("div", null, text));
  const acts = el("div", "noteacts");
  if (opts.ask && window.oxAsk) {
    const b = Icons.button("spark", opts.ask.label, "primary noteask");
    b.title = "The assistant does it, and shows you what it changed";
    b.onclick = () => window.oxAsk(opts.ask.prompt);
    acts.append(b);
  }
  for (const a of opts.actions || []) {
    const b = Icons.button(a.icon || "right", a.label, opts.ask ? "" : "primary");
    b.onclick = a.run;
    acts.append(b);
  }
  if (acts.childNodes.length) box.append(acts);
  if (code) {
    if (acts.childNodes.length) {
      const fold = el("details", "notehand");
      fold.append(el("summary", null, "Or do it by hand"), el("pre", null, code));
      box.append(fold);
    } else box.append(el("pre", null, code));
  }
  return box;
}

/* The runs list is the Runs screen (runs.js): origin tree, filters,
 * the runs in the chosen folder. Everything that used to "go back to the
 * list" still calls this. */
function showTraces() {
  return RunsView.show();
}

/* Time, the way a person reads it: "3h ago" first, the exact local
 * time beside it. Anything that does not parse is shown as given. */
function fmtWhen(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return String(t || "");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString([], {month: "short", day: "numeric"})}, ${time}`;
}
function fmtAgo(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return "";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function fmtSpan(a, b) {
  const s = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  if (!isFinite(s) || s < 0) return "";
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/* ── the run, two ways (Traces tab) ─────────────────────────────────
 * TREE: the run as operonx's ctx tree — the same parents Langfuse gets
 * (a yield record contains everything dispatched for that item), one
 * row per execution wearing the op's flow icon and chips, its show-key
 * values and a duration bar on one scale.
 * WORKFLOW: the flow canvas moved into this pane and painted — the same
 * layout, every card carrying the run's real values, a turn picker so
 * the cards show one turn's values and the ops that did not run in
 * that turn fade. Both read /tree. */

// the time math lives in timeline.js — pure, node-tested
const TL = Timeline.TL;
const timePlace = Timeline.timePlace;
const fmtMs = Timeline.fmtMs;

// the IR node behind an op name, nested graphs included — the flow's
// icon, kind colour, chips and show keys all hang off it
function irNodeByName(name) {
  if (!state._irByName || state._irByName.graph !== state.graph) {
    const m = new Map();
    (function walk(g) {
      for (const n of (g && g.nodes) || []) {
        if (!m.has(n.name)) m.set(n.name, n);
        if (n.graph) walk(n.graph);
      }
    })(state.graph);
    state._irByName = {graph: state.graph, map: m};
  }
  return state._irByName.map.get(name) || null;
}

// "key = value" per show key present in this execution's outputs; an
// op with no show keys (a door, an op the extractor could not see)
// falls back to its first two recorded outputs
function execValues(node, outputs, max) {
  if (!outputs) return [];
  let keys = ((node && node.show_keys) || []).filter(k => k in outputs);
  if (!keys.length) keys = Object.keys(outputs).filter(k => !k.startsWith("_"));
  return keys.slice(0, 2).map(k => [k, Values.brief(outputs[k], max)]);
}

const execsOf = (rows) => rows.filter(r => r.kind === "record");

function runHeader(run, data, mode, extras) {
  return RunView.header(run, data, mode, extras);
}

/* Where a run came from, as links back: the job run and item it was, the
 * service that answered, the runbook run that grouped it — the other
 * direction of the Jobs pane's Trace links. */
function originLine(s) {
  if (!s || !s.origin || s.origin === "adhoc") return null;
  const line = el("div", "tlorigin");
  const link = (text, title, onclick) => {
    const b = el("button", "linkbtn", text);
    b.type = "button";
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  if (s.origin === "job" || s.origin === "eval") {
    line.append(`${s.origin === "eval" ? "Eval" : "Job"} `);
    line.append(link(s.job, `All traces of ${s.job}`, () => RunsView.openFolder({kind: s.origin, name: s.job})));
    if (s.key) line.append(` · item ${s.key}`);
    if (s.job_run) {
      line.append(" of run ");
      line.append(link(s.job_run, "Open this job run in Jobs", () => {
        state.jobSel = s.job; state.jobRun = s.job_run; switchTab("jobs"); showJobs(s.job, s.job_run);
      }));
    }
    if (s.runbook) {
      line.append(" · runbook ");
      line.append(link(s.runbook, "Every trace of this runbook run",
        () => RunsView.openFolder({kind: "runbook", name: s.runbook, runbook_run: s.runbook_run})));
    }
  } else if (s.origin === "service" || s.origin === "playground") {
    line.append(s.origin === "playground" ? "Playground · " : "Service ");
    line.append(link(s.service || s.name, "Every run of this service",
      () => RunsView.openFolder({kind: s.origin, name: s.service || s.name})));
    if (s.transport) line.append(` · ${s.transport}`);
    if (s.session_id) line.append(` · session ${s.session_id}`);
    // a real session its service recorded, or a playground one: send it again
    const md = s.metadata || {};
    const sent = (md.replay_script || md.playground_script || []).filter(m => m.kind === "text" || m.kind === "json");
    if (sent.length && typeof PlayView !== "undefined" && md.toy !== "rerun" && !(window.Account && Account.viewOnly)) {
      line.append(" · ");
      line.append(link("Replay in the Playground", `Send its ${sent.length} message${sent.length === 1 ? "" : "s"} again, to the current code`,
        () => PlayView.replayFrom(s.trace_id, {...md, service: s.service || s.name})));
    }
  }
  if (s.version) line.append(` · code @${String(s.version).slice(0, 7)}${s.version_dirty ? " (uncommitted changes)" : ""}`);
  return line;
}

async function loadRunTree(run) {
  return api(`/api/p/${PID}/trace/${encodeURIComponent(run)}/tree`);
}

async function showRunTree(run) {
  leaveWorkflow();
  const box = $("#traces");
  box.textContent = "";
  const mine = (state.tracesView = {});
  let data;
  state.execPanelRun = null;
  state.execSel = null;
  try { data = await loadRunTree(run); } catch (e) { box.append(el("div", "note", e.message)); return; }
  if (state.tracesView !== mine) return;
  state.runSummary = data.summary || null;
  box.append(runHeader(run, data, "tree"));
  const rows = data.rows, total = Math.max(1, data.total_ms), execs = execsOf(rows);
  const tree = el("div", "rtree");
  const hdr = el("div", "rhdr");
  for (const h of ["Observation", "Value", "When · how long"]) hdr.append(el("span", null, h));
  tree.append(hdr);
  const els = [];
  rows.forEach((r, i) => {
    const row = el("div", "rrow" + (r.kids ? " has" : "") + (r.kind !== "record" ? " " + r.kind : "")
      + (r.status === "error" ? " err" : ""));
    const name = el("div", "rname");
    const guides = el("span", "rind");
    for (let d = 0; d < r.depth; d++) guides.append(el("i"));
    const tog = el("span", "rtog", r.kids ? "▾" : "");
    const node = r.op ? irNodeByName(r.op) : null;
    const ico = el("span", "rico", node ? kindIcon(node) : (r.kind === "container" ? "▣" : "≋"));
    if (node) ico.style.setProperty("--kind", kindColor(node));
    name.append(guides, tog, ico, el("span", "rn", r.name));
    if (node) { const chips = nameChips(node); if (chips) name.append(chips); }
    row.append(name);
    const val = el("div", "rval mono");
    if (r.kind === "record") {
      if (r.error) { val.textContent = r.error.trim().split("\n").pop().slice(0, 90); val.classList.add("bad"); }
      else {
        for (const [k, v] of execValues(node, r.outputs, 36)) {
          if (val.childNodes.length) val.append(" · ");
          val.append(el("span", "rk", k + " = "), el("span", "rv", v));
        }
      }
    } else {
      val.textContent = r.kind === "container" ? "graph" : "stream item — not recorded (transient)";
    }
    row.append(val);
    const bar = el("div", "rbar");
    const b = el("b");
    b.style.left = `${(r.start_ms / total * 100).toFixed(2)}%`;
    b.style.width = `${Math.max(0.4, r.dur_ms / total * 100).toFixed(2)}%`;
    bar.append(b, el("s", "mono", fmtMs(r.dur_ms)));
    row.append(bar);
    row.title = r.ctx + (r.wall_start
      ? " · " + new Date(r.wall_start * 1000).toLocaleTimeString([], {hour12: false}) : "");
    tree.append(row);
    els.push(row);
    // fold: hide every deeper row that follows, until a row no deeper
    tog.onclick = (ev) => {
      ev.stopPropagation();
      if (!r.kids) return;
      const open = row.dataset.open !== "0";
      row.dataset.open = open ? "0" : "1";
      tog.textContent = open ? "▸" : "▾";
      for (let j = i + 1; j < rows.length && rows[j].depth > r.depth; j++) {
        els[j].hidden = open;
        if (!open) { els[j].dataset.open = "1"; if (rows[j].kids) els[j].querySelector(".rtog").textContent = "▾"; }
      }
    };
    if (r.kind === "record") {
      r.el = row;
      row.classList.add("record");
      row.dataset.op = r.op || "";
      row.dataset.id = r.id || "";
      row.onclick = () => {
        for (const o of els) o.classList.remove("sel");
        row.classList.add("sel");
        renderExecPanel(run, r, execs);
      };
    }
  });
  box.append(tree);
  state._tlrun = run;
  renderFlowInfo();
}

/* One execution, in the order it is read: the verdict (how it went, how
 * it ranks among this op's runs, what stands out), what it produced,
 * what it received, what it cost, its other runs, and what fed it. */
async function renderExecPanel(run, e, execs) {
  state.execSel = `${e.op} @ ${e.ctx || "main"} (+${fmtMs(e.start_ms)})`;
  state.execPanelRun = run;
  pushView();
  const panel = $("#inspector");
  // picking an execution is asking to read it: bring the panel forward
  const ps = panelState();
  if (!ps.on || ps.tab !== "inspect") showSide("inspect");
  panel.classList.remove("off");
  panel.textContent = "";
  panel.scrollTop = 0;
  const mine = execs.filter(x => x.op === e.op);

  // ── verdict ──
  const head = el("div", "phead");
  const title = el("div", "pheadrow");
  title.append(el("h3", null, e.op));
  // reading a long prompt wants width: the panel widens in place
  const wide = Icons.button($("#sidebar").classList.contains("wide") ? "collapse" : "expand", undefined,
    "small ghost widebtn", "Widen the panel to read values");
  wide.onclick = () => {
    const on = $("#sidebar").classList.toggle("wide");
    store("panelWide", on);
    renderExecPanel(run, e, execs);
  };
  title.append(wide);
  head.append(title);
  const verdict = el("div", "execverdict");
  verdict.append(el("span", "status " + (e.status === "error" ? "s-bad" : "s-ok"), e.status === "error" ? "failed" : "ok"));
  verdict.append(el("span", "vsep", "·"), el("span", "strong", fmtMs(e.dur_ms)));
  const rank = RunView.rank(e, mine);
  if (rank) verdict.append(el("span", "vsep", "·"), el("span", null, rank));
  head.append(verdict);
  const when = el("div", "execwhen");
  when.append(`at +${fmtMs(e.start_ms)}`);
  if (e.wall_start) {
    // the recorder's wall clock, so a card can be matched to a log line
    const at = new Date(e.wall_start * 1000);
    const t = el("span", "mono", " · " + at.toLocaleTimeString([], {hour12: false}) + "." + String(at.getMilliseconds()).padStart(3, "0"));
    t.title = at.toISOString();
    when.append(t);
  }
  if (e.ctx && e.ctx !== "main") when.append(el("span", "mono", ` · ${e.ctx}`));
  head.append(when);
  panel.append(head);

  const flags = RunView.anomalies(e, mine);
  if (e.error) {
    const err = el("div", "errcard");
    const lines = String(e.error).trim().split("\n");
    err.append(el("div", "errcard-head", lines[lines.length - 1]));
    if (lines.length > 1) {
      const fold = el("details");
      fold.append(el("summary", null, "Traceback"), el("pre", "mono", String(e.error)));
      err.append(fold);
    }
    panel.append(err);
  }
  const notes = flags.filter(([k]) => k !== "bad");
  if (notes.length) {
    const box = el("div", "flags");
    for (const [kind, text] of notes) box.append(el("div", `flag ${kind}`, text));
    panel.append(box);
  }

  // ── output, input, cost ── fetched per op, matched to this execution
  const vsec = el("section");
  const vbox = el("div", null, "Loading values…");
  vsec.append(vbox);
  panel.append(vsec);
  const costSec = el("section");
  panel.append(costSec);

  // ── its other runs ──
  if (mine.length > 1) {
    const sec = el("section");
    sec.append(el("div", "stitle", `This op's ${mine.length} runs`));
    sec.append(RunView.dots(e, mine, (x) => {
      x.el?.scrollIntoView({block: "center", behavior: "smooth"});
      x.el?.click();
    }));
    panel.append(sec);
  }

  // ── what fed it ──
  if ((e.upstreams || []).length) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Fed by"));
    const byId = new Map(execs.map(x => [x.id, x]));
    for (const u of e.upstreams) {
      const src = byId.get(u.from);
      const row = el("div", "resrow");
      row.append(el("span", "reskey mono", u.to_key || ""));
      const chip = el("button", "pchip pref",
        `${src ? src.op : u.from}.${u.from_key || ""}`);
      if (src) chip.onclick = () => {
        src.el?.scrollIntoView({block: "center", behavior: "smooth"});
        src.el?.click();
      };
      row.append(chip);
      sec.append(row);
    }
    panel.append(sec);
  }

  try {
    const got = await api(`/api/p/${PID}/trace/${encodeURIComponent(run)}`
      + `/op/${encodeURIComponent(e.op)}?limit=200`);
    const match = (got.executions || []).find(x =>
      Math.abs((x.duration_ms ?? -1) - e.dur_ms) < 0.001
      && (x.ctx == null || e.ctx == null
          || String(Array.isArray(x.ctx) ? x.ctx.join(".") : x.ctx) === String(e.ctx)))
      || (got.executions || [])[0];
    vbox.textContent = "";
    if (!match) { vbox.append(el("div", "note", "Values were not kept for this execution.")); return; }
    // which inputs came out of SCRATCH cells — the IR knows the binding
    const scratchKeyOf = {};
    (function walk(g) {
      for (const nn of (g && g.nodes) || []) {
        if (nn.name === e.op) {
          for (const inp of nn.inputs || []) {
            if (inp.binding && inp.binding.kind === "scratch")
              scratchKeyOf[inp.name] = inp.binding.key || inp.name;
          }
        }
        if (nn.graph) walk(nn.graph);
      }
    })(state.graph);
    const outs = match.outputs && typeof match.outputs === "object" ? match.outputs : {};
    const priced = "cost_usd" in outs || "usage" in outs;
    valueZones(vbox, match.inputs, match.outputs, scratchKeyOf,
               {outputsFirst: true, hide: priced ? ["usage", "cost_usd", "model_used"] : []});
    // the op again, with these inputs, in the current code
    const sm = state.runSummary;
    if (typeof PlayView !== "undefined" && sm && (sm.service || sm.job) && state._tlrun === run) {
      panel.insertBefore(PlayView.rerunSection(run, e, match), costSec.nextSibling);
    }
    // an LLM reply carries its own facts line (io.js); only a priced op
    // that is not a chat reply keeps the separate block
    if (priced && !IO.replyOf(outs)) {
      costSec.append(el("div", "stitle", "Cost and usage"));
      const u = outs.usage || {};
      const facts = el("div", "facts compact");
      const fact = (k, v) => { const r = el("div", "factrow"); r.append(el("div", "factkey", k), el("div", "factval", v)); facts.append(r); };
      if (outs.model_used) fact("Model", String(outs.model_used));
      fact("Tokens in", String(u.prompt_tokens ?? "—") + (u.cached_tokens ? ` (${u.cached_tokens} cached)` : ""));
      fact("Tokens out", String(u.completion_tokens ?? "—"));
      fact("Cost", RunView.money(outs.cost_usd, outs.cost_usd == null ? 1 : 0) || "—");
      costSec.append(facts);
    }
  } catch (err) {
    vbox.textContent = "";
    vbox.append(el("div", "note", err.message));
  }
}

/* WORKFLOW view: the flow canvas itself, moved into the Traces pane and
 * painted with this run — the same layout, every card carrying real
 * values, a turn picker to read one exchange. The paint lives only
 * here: leaving the view moves the canvas home and clears it, so the
 * Flow tab is always the clean flow. */
/* The graph a run ran. A run records its engine's name ("engine",
 * "params"), not the graph's, so it is matched on evidence: the project
 * graph whose ops (nested ones included) cover the ops the run executed.
 * Ties go to the graph with fewer ops the run never touched, then to the
 * one on screen. Null when no graph covers half of them. */
function graphForRun(data) {
  const ran = Object.keys((data && data.ops) || {});
  if (!ran.length) return state.graph;
  const opsOf = (g, out = new Set()) => {
    for (const n of (g && g.nodes) || []) { out.add(n.name); if (n.graph) opsOf(n.graph, out); }
    return out;
  };
  let best = null;
  for (const g of state.ir.graphs || []) {
    const names = opsOf(g);
    const hits = ran.filter(o => names.has(o)).length;
    const cand = {g, score: hits / ran.length, extra: names.size - hits, here: g === state.graph ? 0 : 1};
    if (!best || cand.score > best.score
        || (cand.score === best.score && (cand.extra < best.extra || (cand.extra === best.extra && cand.here < best.here)))) best = cand;
  }
  return best && best.score >= 0.5 ? best.g : null;
}

async function showRunWorkflow(run) {
  if (state.tab !== "traces") switchTab("traces", {quiet: true});
  leaveWorkflow();
  const box = $("#traces");
  box.textContent = "";
  const mine = (state.tracesView = {});
  let data, tree;
  try {
    [data, tree] = await Promise.all([
      api(`/api/p/${PID}/trace/${encodeURIComponent(run)}`), loadRunTree(run)]);
  } catch (e) { box.append(el("div", "note", e.message)); return; }
  if (state.tracesView !== mine) return;
  state.run = data;
  state.errIdx = 0;
  // every execution with its values, by op and by turn — the cards
  // read one turn's values when a turn is picked, the last otherwise
  state.runTurn = null;
  state.runTurns = tree.turns || [];
  state.runByOpTurn = new Map();
  for (const e of execsOf(tree.rows)) {
    const key = (e.ctx || "").split(".").slice(0, 2).join(".");
    if (!state.runByOpTurn.has(e.op)) state.runByOpTurn.set(e.op, new Map());
    state.runByOpTurn.get(e.op).set(key, e);   // rows are in time order: last wins
  }
  // heat scale: the run's slowest average paints the hottest border
  state.heatMax = Math.max(0, ...Object.values(data.ops || {})
    .map(o => o.runs ? o.total_ms / o.runs : 0));

  state.runRollups = new Map((tree.rollups || []).map(r => [r.op, r]));

  // the canvas shows the graph this run ran: another of the project's
  // graphs is switched to (and said so); one the studio does not draw
  // gets a note and the tree, never a canvas of unrelated faded cards
  const ranGraph = graphForRun(data);
  const workflowName = ((data.summary || tree.summary || {}).workflow) || "?";
  if (!ranGraph) {
    box.append(runHeader(run, tree, "workflow", []));
    const note = el("div", "wfnote wfmissing");
    const said = el("span");
    said.append("This run's graph (", el("code", null, workflowName), ") isn't drawn here.");
    const ops = Object.keys(data.ops || {});
    if (ops.length) said.append(el("span", "wfops", ` It ran ${ops.slice(0, 6).join(", ")}${ops.length > 6 ? "…" : ""}.`));
    note.append(said);
    const tb = el("button", "small", "Open as tree");
    tb.type = "button";
    tb.onclick = () => showRunTree(run);
    note.append(tb);
    box.append(note);
    state.run = null;
    pushView();
    return;
  }
  let switched = null;
  if (ranGraph !== state.graph) {
    switched = state.graph ? state.graph.name : null;
    state.graph = ranGraph;
    $("#graph-pick").value = ranGraph.name;
    state.sel = null;
    state.expanded.clear();
    state.flowView = null;      // the Flow tab's remembered view was another graph's
  }
  const extras = [RunView.lensBar(), replayControl(run)];
  box.append(runHeader(run, tree, "workflow", extras));
  if (switched) {
    const note = el("div", "wfnote");
    const said = el("span");
    said.append("Showing ", el("code", null, ranGraph.name), ", the graph this run ran",
      el("span", "wfops", switched ? ` (the canvas had ${switched})` : ""));
    note.append(said);
    box.append(note);
  }
  box.append(RunView.timeline(state.runTurns, tree.total_ms, (key) => {
    state.runTurn = key; render(); renderFlowInfo();
  }));
  box.classList.add("workflow");
  const stage = $("#stage");
  if (!state._stageHome) state._stageHome = {parent: stage.parentNode, next: stage.nextSibling};
  stage.style.display = "";
  box.append(stage);
  state.workflowOn = true;
  syncChrome();
  render();
  // moving the canvas into the run's pane reset its scroll to the top-left
  // corner (a phone showed 3 of 27 cards, at the edge): the run opens
  // fitted to its own, smaller box — the Flow tab's saved view untouched
  initView(true);
  pushView();
  renderFlowInfo();
}

/* "error →": center + select the errored ops one by one, opening
 * containers if the culprit is folded away inside one. */
function walkErrors() {
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
}

// the canvas goes home and the paint comes off — the Flow tab never
// shows a run
function leaveWorkflow() {
  // not quiet: a quiet stop left the "Replaying … done" pill riding back
  // to the Flow tab with the canvas
  if (liveCanvas) liveCanvas.stop();
  if (!state.workflowOn) return;
  state.workflowOn = false;
  syncChrome();
  const stage = $("#stage");
  $("#traces").classList.remove("workflow");
  const home = state._stageHome;
  home.parent.insertBefore(stage, home.next && home.next.parentNode === home.parent ? home.next : null);
  stage.style.display = state.tab === "flow" ? "" : "none";
  state.run = null;
  state.runTurn = null;
  state.runByOpTurn = null;
  state.runRollups = null;
  state.heatMax = 0;
  render();
  // ... and coming home it lost the Flow tab's view: it comes back once
  // the canvas shows at its full size (flushCanvas)
  state.viewPending = true;
  renderFlowInfo();
}

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
  const opened = !anyOpen && !!count;
  Icons.set($("#btn-expand"), opened ? "fold" : "unfold");
  $("#btn-expand").classList.toggle("active", opened);
  $("#btn-expand").setAttribute("aria-label", opened ? "Close every nested graph" : "Open every nested graph");
};

$("#btn-find").onclick = () => openFind();

/* ── tabs, graph switch, pan/zoom, live reload ────────────────────── */

/* Screens other files add (settings.js, runs.js, …): each registers
 * {el, show} here and switchTab shows and hides it like the built-ins. */
const PANES = {};
function registerPane(name, pane) { PANES[name] = pane; }

/* A revisited screen shows its last picture at once, and refreshes under
 * it. Through the tunnel a screen's data is a request away (~0.75 s), and
 * Runs, Monitor, Settings and the Playground used to go blank or say
 * "Loading…" for that long on every revisit (measured). The picture is a
 * copy laid over the screen, inert, while the screen rebuilds beneath it
 * at its real size; once what is underneath has settled (nothing still
 * loading) the copy lifts, and rows the copy did not have are marked. */
const LOADING = /Loading|Starting the|Connecting/;
const covers = new Set();            // the lift of every cover up: leaving a screen lifts its cover
function coverWhileFresh(elm) {
  if (!elm || elm.hidden || !(elm.textContent || "").trim() || elm._cover) return;
  const parent = elm.offsetParent;
  if (!parent) return;
  const cover = elm.cloneNode(true);
  cover.removeAttribute("id");
  for (const n of cover.querySelectorAll("[id]")) n.removeAttribute("id");
  cover.classList.add("revisit-cover");
  cover.inert = true;
  cover.setAttribute("aria-hidden", "true");
  Object.assign(cover.style, {position: "absolute", left: `${elm.offsetLeft}px`, top: `${elm.offsetTop}px`,
    width: `${elm.offsetWidth}px`, height: `${elm.offsetHeight}px`, margin: "0"});
  const seen = new Set([...elm.querySelectorAll("[data-key]")].map(n => n.dataset.key));
  const scroll = elm.scrollTop;
  elm.after(cover);
  cover.scrollTop = scroll;
  elm._cover = cover;
  let frame = 0;
  const settled = () => (elm.textContent || "").trim().length > 40 && !LOADING.test(elm.textContent);
  const lift = () => {
    covers.delete(lift);
    if (elm._cover !== cover) return;
    observer.disconnect();
    clearTimeout(cap);
    elm._cover = null;
    elm.scrollTop = scroll;
    cover.remove();
    // what the last picture did not have: marked, quietly, for a moment
    if (seen.size) for (const n of elm.querySelectorAll("[data-key]")) if (!seen.has(n.dataset.key)) n.classList.add("fresh");
  };
  const check = () => { frame = 0; if (settled()) lift(); };
  const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
  observer.observe(elm, {childList: true, subtree: true, characterData: true});
  const cap = setTimeout(lift, 6000);
  covers.add(lift);
  requestAnimationFrame(() => requestAnimationFrame(check));
}

function switchTab(name, opts) {
  // the playground runs a service's code: not a viewer's (D11); every way in stops here
  if (name === "playground" && window.Account && Account.viewOnly) { Account.toast(Account.VIEW_ONLY, true); return; }
  // where the Flow tab was: a run's pane borrows the canvas, and moving
  // it resets its scroll (hiding it does not)
  if (state.tab === "flow" && !state.workflowOn && canvasShown()) {
    const st = $("#stage");
    state.flowView = {scale: state.view.scale, x: st.scrollLeft, y: st.scrollTop};
  }
  leaveWorkflow();
  for (const lift of [...covers]) lift();
  state.tab = name;
  if (name !== "traces") { state.execPanelRun = null; state.execSel = null; }
  if (window.oxRailLabel) window.oxRailLabel(name);
  for (const b of document.querySelectorAll(".tabs button[data-tab], [data-tabbtn]")) {
    const on = (b.dataset.tab || b.dataset.tabbtn) === name;
    b.classList.toggle("active", on);
    b.setAttribute(b.dataset.tab ? "aria-selected" : "aria-pressed", String(on));
  }
  $("#stage").style.display = name === "flow" ? "" : "none";
  $("#traces").hidden = name !== "traces";
  $("#jobs").hidden = name !== "jobs";
  $("#resources").hidden = name !== "resources";
  for (const [n, p] of Object.entries(PANES)) p.el.hidden = n !== name;
  // a revisit: the last picture while the screen refreshes (not for a run
  // the caller is about to open, nor the canvas)
  if (!(opts && opts.quiet)) coverWhileFresh(PANES[name] ? PANES[name].el : name === "traces" ? $("#traces") : null);
  if (PANES[name]) PANES[name].show(opts);
  // quiet: the caller is about to fill the Traces pane itself
  if (name === "traces" && !(opts && opts.quiet)) showTraces();
  if (name === "jobs") showJobs(state.jobSel);
  if (name === "resources") showResources();
  // on a phone the sheet belongs to the screen it was opened on
  if (MOBILE.matches && recall("sideTab", "assistant") === "inspect") store(panelKey(), false);
  syncChrome();
  applyPanels();
  // a canvas left stale while hidden is drawn now, at its final size —
  // callers read it right after this
  if (name === "flow") flushCanvas();
  // the inspector speaks about what is on screen: a canvas selection
  // does not follow the user into the Traces list
  if (name !== "flow" && state.sel) { state.sel = null; refreshSelection(); }
  renderFlowInfo();
  pushView();
}

/* The chrome follows what is on screen: the body carries the tab, and
 * `data-stage` while the canvas shows (the Flow tab, or a run's workflow
 * view) — the canvas toolbar appears only then. */
function syncChrome() {
  document.body.dataset.tab = state.tab;
  const stageOn = state.tab === "flow" || !!state.workflowOn;
  if (stageOn) document.body.dataset.stage = "";
  else delete document.body.dataset.stage;
  if (!stageOn) { $("#find").hidden = true; $("#legend").hidden = true; }
}

/* ── the side panel: one panel on the right, two tabs ──────────────
   Inspect is the project summary or the selected op; Assistant is the
   chat. The panel is optional; the tab is remembered. Selecting an op
   brings the Inspect tab forward, the chat bubble brings Assistant.
   On a phone the panel is a bottom sheet over the canvas: closed by
   default, opened by a selection, remembered on its own key so a
   desktop preference never covers a phone screen. Where there is
   nothing to inspect (Jobs, Resources) the panel is the assistant's or
   nobody's — an inspector with nothing in it only costs width. */

const MOBILE = window.matchMedia("(max-width: 760px)");
const panelKey = () => (MOBILE.matches ? "panelRightM" : "panelRight");
// open by default only where it fits beside the content (a tablet gets
// it as an overlay, opened from the Ask bar)
const WIDE = window.matchMedia("(min-width: 1100px)");
const panelWanted = () => recall(panelKey(), WIDE.matches);
const inspectable = () => state.tab === "flow" || state.tab === "traces";

function panelState() {
  const tab = recall("sideTab", "assistant");
  const on = panelWanted() && !(tab === "inspect" && !inspectable());
  return {on, tab};
}

function applyPanels() {
  const {on, tab} = panelState();
  $("#sidebar").classList.toggle("off", !on);
  $("#btn-right").classList.toggle("active", on);
  $("#btn-right").setAttribute("aria-pressed", String(on));
  for (const b of document.querySelectorAll("#sidetabs button[data-side]")) {
    b.classList.toggle("active", b.dataset.side === tab);
    b.setAttribute("aria-selected", String(b.dataset.side === tab));
  }
  $("#inspector").hidden = tab !== "inspect";
  // `on`: the chat is showing; `panel`: the sidebar is open at all — the
  // floating bubble stays away whenever the panel is open, since the
  // Assistant tab is one click away inside it
  document.dispatchEvent(new CustomEvent("oxdock", {detail: {on: on && tab === "assistant", panel: on}}));
}
function showSide(tab) {
  store(panelKey(), true);
  store("sideTab", tab);
  applyPanels();
}
function hideSide() {
  store(panelKey(), false);
  applyPanels();
}
window.oxSide = {
  show: showSide,
  hide: (tab) => { if (tab) store("sideTab", tab); hideSide(); },
  state: panelState,
  toggle: () => {
    const {on, tab} = panelState();
    if (on) hideSide();
    else showSide(tab === "inspect" && !inspectable() ? "assistant" : tab);
  },
};
$("#btn-right").onclick = window.oxSide.toggle;
$("#side-close").onclick = () => { hideSide(); if (state.sel) deselect(); };
for (const b of document.querySelectorAll("#sidetabs button[data-side]"))
  b.onclick = () => showSide(b.dataset.side);
MOBILE.addEventListener("change", applyPanels);

/* ── the legend: the visual language, written down on screen ──────── */

function legendSample(cls, dash) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 64 12");
  svg.setAttribute("class", "wires lsample");
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
  const close = Icons.button("x", undefined, "chat-close", "Close");
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
  row(el("span", "lglyph lzone", "↺"), "a violet zone is a loop: the steps inside run again every turn; its header says where the loop exits and on what condition");
  row(el("span", "lglyph", "next turn"), "the violet return wire goes back to the start of the loop for another turn; \"exit loop\" marks the route that leaves it");
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
  if (!menu.hidden) { menu.hidden = true; $("#pname").setAttribute("aria-expanded", "false"); return; }
  $("#pmenu").hidden = true;
  menu.textContent = "";
  try {
    const {projects} = await api("/api/projects");
    for (const p of projects.filter(x => x.exists)) {
      const item = el("button", "switchrow" + (p.id === PID ? " here" : ""));
      item.setAttribute("role", "menuitem");
      item.append(el("span", "name", p.name));
      item.append(el("span", "path mono", p.root));
      item.onclick = () => { if (p.id !== PID) location.href = `/p/${p.id}`; };
      menu.append(item);
    }
    const all = el("button", "switchrow switchall", "All projects");
    all.onclick = () => { location.href = "/"; };
    menu.append(all);
  } catch (e) { menu.append(el("div", "note", e.message)); }
  menu.hidden = false;
  $("#pname").setAttribute("aria-expanded", "true");
};
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#switcher") && !ev.target.closest("#pname")) {
    $("#switcher").hidden = true;
    $("#pname").setAttribute("aria-expanded", "false");
  }
});
for (const b of document.querySelectorAll(".tabs button[data-tab]"))
  b.onclick = () => switchTab(b.dataset.tab);

/* The rail: the screens grouped by what they are for. Slim (icons) below
 * 1200px unless the user chose; on a phone a drawer the header's screen
 * button opens, which closes again once a screen is picked. */
(function rail() {
  const r = $("#rail"), shade = $("#railshade"), btn = $("#btn-screen");
  const SLIM = window.matchMedia("(max-width: 1199px)");
  const apply = () => {
    const pref = recall("railSlim", null);
    document.body.classList.toggle("railslim", !MOBILE.matches && (pref ?? SLIM.matches));
    const slim = document.body.classList.contains("railslim");
    $("#rail-slim").title = slim ? "Expand the menu" : "Collapse the menu";
    $("#rail-slim").setAttribute("aria-label", $("#rail-slim").title);
  };
  $("#rail-slim").onclick = () => { store("railSlim", !document.body.classList.contains("railslim")); apply(); };
  SLIM.addEventListener("change", apply);
  MOBILE.addEventListener("change", apply);
  apply();
  const close = () => { document.body.classList.remove("railopen"); shade.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.onclick = () => {
    const open = !document.body.classList.contains("railopen");
    document.body.classList.toggle("railopen", open);
    shade.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  shade.onclick = close;
  for (const b of r.querySelectorAll(".tabs button[data-tab]")) b.addEventListener("click", close);
  window.oxRailLabel = (name) => {
    const b = r.querySelector(`.tabs button[data-tab="${name}"] span`);
    $("#screen-label").textContent = b ? b.textContent : name === "settings" ? "Settings" : name;
  };
})();

$("#graph-pick").onchange = (ev) => {
  state.graph = state.ir.graphs.find(g => g.name === ev.target.value);
  state.sel = null;
  state.expanded.clear();
  $("#inspector").classList.remove("open");
  // the side panel speaks about the graph on screen, not the last one
  render(); fit(); renderFlowInfo(); pushView();
};

$("#btn-fit").onclick = fit;
{
  const b = $("#btn-flowdots");
  const show = () => { b.setAttribute("aria-pressed", String(flowDotsOn)); b.classList.toggle("on", flowDotsOn); };
  show();
  b.onclick = () => {
    flowDotsOn = !flowDotsOn;
    store("ox:flowdots", flowDotsOn);
    show();
    for (const dot of document.querySelectorAll(".eflow")) dot.style.display = flowDotsOn ? "" : "none";
    if (flowDotsOn && !document.querySelector(".eflow")) render();
  };
}
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
    // an opened GraphOp's body is canvas — it pans like the background;
    // only its title strip (select, collapse) is a control
    const hit = ev.target.closest(".node");
    const overNode = hit && hit.classList.contains("container") && !ev.target.closest(".chead") ? null : hit;
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
    // the exact name first, then a name that starts with it, then any
    // that contains it ("out" found "router" before "out"); among equals
    // the shallowest wins — the top-level op, not a container's twin
    const rank = (item) => {
      const name = item.node.name.toLowerCase();
      return (name === q ? 0 : name.startsWith(q) ? 1 : 2) * 100 + item.depth;
    };
    let best = null;
    for (const [, item] of state.rendered) {
      if (!item.node.name.toLowerCase().includes(q)) continue;
      if (!best || rank(item) < rank(best)) best = item;
    }
    if (best) { closeFind(); select(best.key); centerOn(state.rendered.get(best.key)); }
  });
})();

/* ── resizable inspector ──────────────────────────────────────────── */

(() => {
  // the side panel sits on the RIGHT; its handle drags leftward
  const bar = $("#dragbar"), panel = $("#sidebar");
  const saved = recall("panelW", null);
  if (saved) panel.style.width = `${saved}px`;
  if (recall("panelWide", false)) panel.classList.add("wide");
  let dragging = false;
  bar.addEventListener("pointerdown", (ev) => {
    dragging = true;
    bar.setPointerCapture(ev.pointerId);
    document.body.classList.add("resizing");
  });
  bar.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const right = $(".main").getBoundingClientRect().right;
    const width = Math.min(720, Math.max(300, right - ev.clientX));
    panel.style.width = `${width}px`;
  });
  bar.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    // a click without a drag leaves no width behind (it used to store 340px)
    if (panel.style.width) store("panelW", parseInt(panel.style.width, 10));
  });
  // back to the default: 380px, 420px on a large screen (studio.css)
  bar.addEventListener("dblclick", () => {
    panel.style.width = "";
    store("panelW", null);
  });
})();

syncChrome();
applyPanels();

async function load(first) {
  // the first picture rides in the page itself (app.py project_page)
  const boot = first ? document.getElementById("ir-boot") : null;
  let data = null;
  if (boot) {
    try { data = JSON.parse(boot.textContent); } catch { data = null; }
    boot.remove();
  }
  if (!data) data = await api(`/api/p/${PID}/ir`);
  $("#pname").textContent = "";
  $("#pname").append(el("span", null, data.name || "project"));
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
    $("#live-text").textContent = "Extraction failed";
    state.stamp = data.stamp;
    return;
  }
  for (const b of document.querySelectorAll("#stage .errbox")) b.remove();
  $("#live").classList.remove("stale");
  $("#live-text").textContent = "Live";
  // which ops' code changed since the last extraction — the canvas
  // outlines them for a while, so an edit (the assistant's or anyone's)
  // shows where it landed
  if (state.ir && !first) {
    const codeOf = (ir) => {
      const m = new Map();
      for (const g of ir.graphs || []) (function walk(gr) {
        for (const n of (gr && gr.nodes) || []) { m.set(n.name, n.code || ""); if (n.graph) walk(n.graph); }
      })(g);
      return m;
    };
    const before = codeOf(state.ir), after = codeOf(data);
    const changed = [...after].filter(([k, c]) => before.has(k) ? before.get(k) !== c : true).map(([k]) => k);
    if (changed.length) document.dispatchEvent(new CustomEvent("oxflowchanged", {detail: {ops: changed}}));
    if (changed.length && changed.length < 40) {
      state.changedOps = new Set(changed);
      clearTimeout(state._changedTimer);
      state._changedTimer = setTimeout(() => { state.changedOps = null; render(); }, 60000);
      toast(`${changed.length} op${changed.length > 1 ? "s" : ""} changed: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? "…" : ""}`);
    }
  }
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
  // one graph: on a phone the header gives its room to the project's name
  document.body.classList.toggle("onegraph", data.graphs.length <= 1);
  state.graph = data.graphs.find(g => g.name === current) || data.graphs[0];
  if (state.graph) pick.value = state.graph.name;
  $("#btn-project").title = `${data.graphs.length} operons · ${(data.services || []).length} services · ${(data.jobs || []).length} jobs`;
  render();
  // opened on a hidden canvas (the assistant in focus): fit it when it shows
  if (first) { if (state.renderPending) state.viewPending = true; else initView(); }
  pushView();
  renderFlowInfo();
}

/* The pulse (app.py): one held request that answers the moment the
 * code changes, the assistant opens something, or — when following —
 * a newer run lands. It replaced two polls every 1.5 s. */
state.uiSeq = -1;
state.chatSeq = -1;
let pulseMiss = 0;
async function pulse() {
  for (;;) {
    try {
      const q = new URLSearchParams({stamp: String(state.stamp || 0), ui: String(state.uiSeq),
                                     chat: String(state.chatSeq)});
      if (state.follow) q.set("follow", (state.run && state.run.run) || "-");
      else if (state.tab === "flow" && flowLive.on) q.set("follow", flowLive.newest || "-");
      const got = await api(`/api/p/${PID}/pulse?${q}`);
      pulseMiss = 0;
      setLinkState(true);
      // a role changed while this page was open: it redraws for the new one (§2.5)
      if (got.role && window.Account && Account.me() && got.role !== Account.me().user.role) { location.reload(); return; }
      if (got.stamp !== state.stamp) await load(!state.ir);
      if (state.uiSeq < 0) state.uiSeq = got.ui_last;   // only what happens from now on
      if (state.chatSeq >= 0 && (got.chat_ended || []).length) {
        document.dispatchEvent(new CustomEvent("oxturnended", {detail: {ended: got.chat_ended}}));
      }
      state.chatSeq = got.chat_last ?? state.chatSeq;
      // the plan's limits, as last heard by any conversation
      if (got.assistant_rate) document.dispatchEvent(new CustomEvent("oxrate", {detail: got.assistant_rate}));
      for (const a of got.actions || []) {
        state.uiSeq = a.seq;
        try { await performUi(a.kind, a.args || {}); } catch { /* a stale action is not an error */ }
      }
      if (state.follow && got.newest && (!state.run || state.run.run !== got.newest)) {
        await showRunWorkflow(got.newest);
      } else if (!state.follow && state.tab === "flow" && got.newest) {
        flowLive.landed(got.newest, got.newest_info);
      }
    } catch {
      // the studio or the tunnel is briefly away: back off, then say so
      pulseMiss += 1;
      if (pulseMiss > 2) setLinkState(false);
      await new Promise(r => setTimeout(r, Math.min(8000, 800 * pulseMiss)));
    }
  }
}

/* The header's Live dot: it says "Reconnecting" when the pulse keeps
 * failing, instead of a page that silently stopped updating. */
function setLinkState(up) {
  const live = $("#live");
  if (!live || live.classList.contains("stale")) return;
  live.classList.toggle("down", !up);
  $("#live-text").textContent = up ? "Live" : "Reconnecting…";
}

async function performUi(kind, args) {
  if (kind === "open_run") {
    if (state.tab !== "traces") switchTab("traces", {quiet: true});
    if (args.lens) { state.lens = args.lens; store("lens", args.lens); }
    await (args.mode === "workflow" ? showRunWorkflow(args.run) : showRunTree(args.run));
    // an execution to select: an eval's blamed op, a deep link's `op`
    if (args.op) RunView.focusExec({op_id: args.op, op: args.op.split("#")[0].split(".").pop()},
                                   args.mode === "workflow" ? "workflow" : "tree");
    if (!args.quiet) toast(`Assistant opened run ${args.run}`);
  } else if (kind === "open_monitor") {
    store(`monitor:${PID}`, {target: args.target || "", range: args.days >= 30 ? "30d" : args.days <= 1 ? "24h" : "7d"});
    switchTab("monitor");
  } else if (kind === "compare") {
    if (state.tab !== "traces") switchTab("traces", {quiet: true});
    await RunView.compare(args.a, args.b);
  } else if (kind === "select_op") {
    if (state.tab !== "flow") switchTab("flow");
    // an op is named by its node, or by the function behind it
    const def = new RegExp(`\\bdef ${String(args.op).replace(/[^\w]/g, "")}\\(`);
    const find = () => {
      const all = [...state.rendered.values()];
      return all.find(x => x.node.name === args.op) || all.find(x => def.test(x.node.code || ""));
    };
    let it = find();
    if (!it) { expandAll(true); it = find(); }
    if (it) { if (state.sel !== it.key) select(it.key); centerOn(it); }
    else toast(`No op named ${args.op} in this graph`);
  } else if (kind === "open_jobs") {
    state.jobSel = args.job; switchTab("jobs");
  } else if (kind === "open_tab") {
    switchTab(args.tab);
  } else if (kind === "open_eval") {
    switchTab("evals", {name: args.name, run: args.run, exp: args.exp});
  }
}

/* `studio:` links in the assistant's replies (chat.js turns them into
 * buttons): studio:run/<id>, studio:op/<name>, studio:tab/<name>,
 * studio:monitor/<origin>/<name>. */
window.oxStudioLink = (href) => {
  const path = String(href).replace(/^studio:/, "");
  const [kind, ...rest] = path.split("/");
  const arg = decodeURIComponent(rest.join("/"));
  if (kind === "run") return performUi("open_run", {run: arg});
  if (kind === "op") return performUi("select_op", {op: arg});
  if (kind === "tab") return performUi("open_tab", {tab: arg === "runs" ? "traces" : arg});
  if (kind === "eval") return performUi("open_eval", {name: rest[0], run: rest[1] || ""});
  if (kind === "monitor") return performUi("open_monitor", {target: rest.length > 1 ? `${rest[0]}:${decodeURIComponent(rest.slice(1).join("/"))}` : ""});
  return null;
};

state.follow = recall("follow", false);
// `/p/<pid>?run=<trace id>` opens that run: a served reply's
// `x-operonx-trace-id` header is all a client needs to link to its run;
// `&op=<execution id>` selects one execution in it (an eval's blamed op)
const linkedRun = new URLSearchParams(location.search).get("run");
const linkedOp = new URLSearchParams(location.search).get("op");
load(true).then(() => {
  if (linkedRun) performUi("open_run", {run: linkedRun, op: linkedOp || undefined, quiet: true});
}).catch((err) => {
  // the first paint failed (a dropped tunnel, a dead studio): say so where
  // the canvas would be; the pulse retries and draws when it can
  const box = el("div", "errbox");
  box.append(el("div", "errhead", "Could not load this project"), el("div", "note", err.message));
  box.style.position = "absolute";
  $("#stage").append(box);
}).finally(pulse);

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
    for (const [, card] of cardsOf(op)) {
      card.classList.remove("live-done", "live-failed");
      card.classList.add("live-active");
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

/* ── the project menu: Operons · Services · Jobs ───────────────────────
 * The three lists the application layer declares (operonx.app), from
 * the /ir payload. An Operon opens in the Flow tab; a Service opens the
 * graph it serves; a Job opens the Jobs tab on that job. */

function renderProjectMenu() {
  const box = $("#pmenu");
  box.textContent = "";
  const ir = state.ir || {};
  const col = (title, rows) => {
    const c = el("div", "pcol");
    c.append(el("div", "ptitle", title));
    if (!rows.length) c.append(el("div", "pnone", "none"));
    for (const r of rows) c.append(r);
    return c;
  };
  const row = (name, sub, onclick, cls) => {
    const r = el("div", "prow" + (cls ? " " + cls : ""));
    r.append(el("span", "pn", name));
    if (sub) r.append(el("span", "ps", sub));
    r.onclick = () => { $("#pmenu").hidden = true; onclick(); };
    return r;
  };
  const operons = (ir.graphs || []).map(g => row(g.name, `${g.nodes.length} ops`, () => {
    state.graph = g; $("#graph-pick").value = g.name; switchTab("flow"); render(); renderFlowInfo();
  }, state.graph && state.graph.name === g.name ? "sel" : ""));
  const services = (ir.services || ir.serves || []).map(sv => {
    const variants = sv.variants || [];
    const base = sv.graph ? sv.graph.split(":").pop() : "";
    const meta = `${sv.kind} ${sv.path || ""}${sv.port ? " :" + sv.port : ""}${sv.session ? " · " + sv.session : ""}` +
      (variants.length ? ` · ${variants.length} variants` : "");
    return row(sv.name || sv.path, meta, () => {
      // one door, one compiled graph per variant: open the first, the
      // Operons column lists them all as <graph>[<variant>]
      const names = variants.length ? variants.map(v => `${base}[${v}]`) : [base];
      const target = sv.graph ? (ir.graphs || []).find(g => names.includes(g.name)) : null;
      if (target) { state.graph = target; $("#graph-pick").value = target.name; switchTab("flow"); render(); renderFlowInfo(); }
      else toast(sv.app ? `${sv.name}: an ASGI app, not a graph` : `${sv.name}: graph ${sv.graph} is not listed under [[graph]]`);
    });
  });
  const jobs = (ir.jobs || []).map(j => row(j.name,
    `${j.kind === "runbook" ? "runbook" : j.session}${j.schedule ? " · " + j.schedule : ""}`,
    () => { state.jobSel = j.name; switchTab("jobs"); }));
  box.append(col("Operons", operons), col("Services", services), col("Jobs", jobs));
}
$("#btn-project").onclick = (ev) => {
  ev.stopPropagation();
  const box = $("#pmenu");
  if (box.hidden) { renderProjectMenu(); $("#switcher").hidden = true; }
  box.hidden = !box.hidden;
  $("#btn-project").setAttribute("aria-expanded", String(!box.hidden));
};
document.addEventListener("click", (ev) => {
  const box = $("#pmenu");
  if (!box.hidden && !box.contains(ev.target)) {
    box.hidden = true;
    $("#btn-project").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  for (const [menu, btn] of [["#pmenu", "#btn-project"], ["#switcher", "#pname"]]) {
    if (!$(menu).hidden) { $(menu).hidden = true; $(btn).setAttribute("aria-expanded", "false"); $(btn).focus(); }
  }
});

/* ── the Jobs tab: the records the jobs write, and Run / Resume ────────
 * A job is never a span; its truth is run.json + items.jsonl. The pane
 * shows exactly those: the jobs with their last run, one job's runs, one
 * run's items (or a runbook's tree). Run and Resume start `operonx-run`
 * under the project's interpreter; the pane polls while a run is open. */

let _jobsPoll = null;

/* A status is a dot and a word — colour for the eye, the word for
 * everyone else. */
function statusChip(status) {
  const cls = status === "ok" ? "s-ok" : status === "running" ? "s-run"
    : (status === "failed" || status === "stopped" || status === "timeout") ? "s-bad"
    : status === "skipped" ? "s-skip" : "";
  return el("span", "status " + cls, status || "unknown");
}

function countsChips(counts) {
  const wrap = el("span", "counts");
  for (const [k, v] of Object.entries(counts || {})) {
    if (!v && k !== "ok") continue;
    wrap.append(el("span", k === "failed" || k === "timeout" ? "bad" : k === "empty" ? "warn" : "", `${v} ${k}`));
  }
  return wrap;
}

async function showJobs(sel, runId) {
  const box = $("#jobs");
  const mine = (state.jobsView = {});
  if (!box.childNodes.length) box.append(el("div", "note", "Loading jobs…"));
  let data;
  // one round trip: the list carries the opened job's runs and run
  const q = new URLSearchParams({open: sel || "", run: runId || ""});
  try { data = await api(`/api/p/${PID}/jobs?${q}`); }
  catch (e) { box.textContent = ""; box.append(loadError(e, () => showJobs(sel, runId))); return; }
  if (state.jobsView !== mine) return;
  box.textContent = "";
  if (!data.jobs.length) {
    box.append(paneNote("No jobs declared",
      "A job runs a graph over a batch of items — one run per item, a record per run.",
      '[[job]]\nname   = "score_calls"\ngraph  = "pipeline:score_call"\nsource = "data/calls.jsonl"\nsink   = "out/scores.jsonl"\nkey    = "call_id"',
      {ask: {label: "Add a job", prompt: "Add a job to this project that runs its main graph over a batch of items "
        + "(a small JSONL of realistic examples if there is none) and records each result. Declare it, run it once, "
        + "and tell me how it went."}}));
    return;
  }
  const cols = el("div", "jcols");
  const list = el("div", "jlist");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Jobs");
  const detail = el("div", "jdetail");
  cols.append(list, detail);
  box.append(cols);

  const picked = data.jobs.find(j => j.name === sel) || data.jobs[0];
  state.jobSel = picked.name;
  for (const j of data.jobs) {
    const r = el("div", "jrow" + (j.name === picked.name ? " sel" : ""));
    r.tabIndex = 0;
    r.setAttribute("role", "option");
    r.setAttribute("aria-selected", String(j.name === picked.name));
    const head = el("div", "jhead");
    head.append(el("span", "jn", j.name));
    head.append(el("span", "jkind", (j.kind === "runbook" ? "runbook" : j.session) + (j.schedule ? ` · ${j.schedule}` : "")));
    r.append(head);
    if (j.description) r.append(el("div", "jdesc", j.description));
    const last = el("div", "jlast");
    if (j.last) {
      last.append(statusChip(j.last.status));
      if (j.last.started) {
        const w = el("span", "jwhen", fmtAgo(j.last.started));
        w.title = fmtWhen(j.last.started);
        last.append(w);
      }
    } else last.append(el("span", "jwhen", "Never run"));
    r.append(last);
    r.onclick = () => showJobs(j.name);
    r.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showJobs(j.name); } };
    list.append(r);
  }
  await renderJobDetail(detail, picked, runId, mine, data.detail && data.detail.name === picked.name ? data.detail : null);
  // keep the picked job in view on the phone's horizontal strip
  const on = list.querySelector(".jrow.sel");
  if (on && MOBILE.matches) on.scrollIntoView({block: "nearest", inline: "nearest"});
}

async function renderJobDetail(detail, job, runId, mine, pre) {
  detail.textContent = "";
  const bar = el("div", "jbar");
  bar.append(el("h2", "jtitle", job.name));
  const refresh = Icons.button("refresh", undefined, "", "Refresh");
  refresh.onclick = () => showJobs(job.name, state.jobRun);
  bar.append(refresh);
  if (job.kind !== "runbook" && job.session !== "stream") {
    const resume = Icons.button("resume", "Resume", "needs-edit");
    resume.title = "Run only the keys the last run did not finish";
    resume.onclick = () => startJob(job.name, true);
    bar.append(resume);
  }
  const run = Icons.button("play", "Run", "primary needs-edit");
  run.title = `operonx-run ${job.name} — under the project's interpreter`;
  run.onclick = () => startJob(job.name, false);
  bar.append(run);
  detail.append(bar);
  if (job.description) detail.append(el("p", "jmeta", job.description));
  const facts = [job.kind === "runbook" ? "Runbook" : `${job.session} job`];
  if (job.schedule) facts.push(`schedule ${job.schedule}`);
  if (job.kind !== "runbook") facts.push(`${job.source || "—"} → ${job.sink || "—"}`);
  detail.append(el("p", "jpath", facts.join("  ·  ") + (job.record_dir ? `\nrecords in ${job.record_dir}` : "")));
  detail.querySelector(".jpath").style.whiteSpace = "pre-line";

  let data = pre ? {runs: pre.runs} : null;
  if (!data) {
    try { data = await api(`/api/p/${PID}/jobs/${encodeURIComponent(job.name)}/runs`); }
    catch (e) { detail.append(el("div", "errbox", e.message)); return; }
  }
  if (state.jobsView !== mine) return;
  if (!data.runs.length) {
    detail.append(paneNote("Not run yet", `Press Run to start ${job.name}; its runs and their items appear here.`));
    return;
  }

  detail.append(el("h3", "jsection", "Runs"));
  const wrap = el("div", "tablewrap");
  const table = el("table", "datatable jruns");
  const hr = el("tr");
  for (const [h, cls] of [["Started"], ["Status"], ["Items"], ["Took", "num"]]) hr.append(el("th", cls || null, h));
  const thead = el("thead"); thead.append(hr); table.append(thead);
  const tbody = el("tbody");
  const open = data.runs.find(r => r.run_id === runId) || data.runs[0];
  state.jobRun = open.run_id;
  for (const r of data.runs) {
    const tr = el("tr", "clickable" + (r.run_id === open.run_id ? " sel" : ""));
    const when = el("td");
    when.append(el("div", "cellmain", r.started ? fmtWhen(r.started) : "—"));
    when.append(el("div", "cellsub mono", r.run_id));
    tr.append(when);
    const st = el("td"); st.append(statusChip(r.status)); tr.append(st);
    const ct = el("td");
    if (r.tree) { const c = countsOfTree(r.tree); ct.append(countsChips(c)); }
    else ct.append(countsChips(r.counts));
    tr.append(ct);
    tr.append(el("td", "num dim", r.ended ? fmtSpan(r.started, r.ended) : (r.status === "running" ? "running…" : "")));
    tr.onclick = () => showJobs(job.name, r.run_id);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  detail.append(wrap);

  let one = pre && pre.one && pre.run_id === open.run_id ? pre.one : null;
  if (!one) {
    try { one = await api(`/api/p/${PID}/jobs/${encodeURIComponent(job.name)}/runs/${open.run_id}`); }
    catch (e) { detail.append(el("div", "errbox", e.message)); return; }
  }
  if (state.jobsView !== mine) return;
  if (one.run.error) detail.append(el("div", "errbox", one.run.error));
  if (one.run.tree) {
    detail.append(el("h3", "jsection", "Jobs in this run"));
    if ((one.run.wires || []).length) detail.append(renderWires(one.run.wires));
    detail.append(renderRunbookTree(one.run.tree));
  } else {
    const n = (one.items || []).length;
    const h = el("h3", "jsection", "Items");
    if (n) h.append(el("span", "count", `  ${n}`));
    detail.append(h);
    detail.append(renderItems(one.items, one.run));
  }

  // a running run: poll until it settles
  clearTimeout(_jobsPoll);
  if (open.status === "running" && state.tab === "jobs") {
    _jobsPoll = setTimeout(() => { if (state.tab === "jobs") showJobs(job.name, open.run_id); }, 2500);
  }
}

function countsOfTree(tree) {
  const c = {ok: 0, failed: 0, skipped: 0};
  const walk = (n) => { if (n.kind === "job") c[n.status] = (c[n.status] || 0) + 1; for (const k of n.children || []) walk(k); };
  walk(tree);
  return c;
}

function renderRunbookTree(tree) {
  const box = el("div", "rtree");
  const walk = (n, depth) => {
    const row = el("div", "rrow jobrow" + (n.status === "failed" ? " err" : ""));
    row.style.paddingLeft = `${12 + depth * 18}px`;
    row.append(el("span", "rico", n.kind === "job" ? "⚙" : n.kind === "parallel" ? "⇉" : "→"));
    // a job and a runbook (operonx >= 1.8) by name; an old tree's
    // sequential / parallel nodes by kind
    row.append(el("span", "rn", n.kind === "job" || n.kind === "runbook" ? n.name : n.kind));
    row.append(statusChip(n.status));
    if (n.ms) row.append(el("span", "rval", `${(n.ms / 1000).toFixed(2)}s`));
    if (n.error) row.append(el("span", "rval bad", n.error));
    if (n.run_id) row.append(el("span", "rval mono", n.run_id));
    box.append(row);
    for (const c of n.children || []) walk(c, depth + 1);
  };
  walk(tree, 0);
  return box;
}

/* A runbook's wires as it was written: one `>>` line per source, sources
 * feeding the same jobs on one line — `[a, b] >> c` — as `operonx-run
 * --show` prints them. */
function wireLines(wires) {
  const order = [];
  const into = new Map();
  for (const [a, b] of wires) {
    for (const n of [a, b]) if (!order.includes(n)) order.push(n);
    if (!into.has(a)) into.set(a, []);
    into.get(a).push(b);
  }
  const side = (xs) => (xs.length === 1 ? xs[0] : `[${xs.join(", ")}]`);
  const groups = new Map();
  for (const [src, dsts] of into) {
    const key = side(dsts);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(src);
  }
  return [...groups].map(([dst, srcs]) => `${side(srcs)} >> ${dst}`);
}

function renderWires(wires) {
  const box = el("div", "rwires mono");
  for (const line of wireLines(wires)) box.append(el("div", null, line));
  return box;
}

function renderItems(items, run) {
  if (!items.length) {
    const c = run.counts || {};
    return el("div", "note", "fed" in c ? `One run: fed ${c.fed} · sent ${c.sent}${run.trace_id ? " · trace " + run.trace_id : ""}` : "No items recorded.");
  }
  const wrap = el("div", "tablewrap");
  const table = el("table", "datatable jitems");
  const hr = el("tr");
  for (const [h, cls] of [["Key"], ["Status"], ["Took", "num"], ["Sent", "num hide-sm"], ["Attempts", "num hide-sm"], ["Error"], [""]])
    hr.append(el("th", cls || null, h));
  const thead = el("thead"); thead.append(hr); table.append(thead);
  const tbody = el("tbody");
  for (const it of items) {
    const tr = el("tr", it.status === "failed" || it.status === "timeout" ? "err" : "");
    tr.append(el("td", "mono", it.key));
    const st = el("td"); st.append(statusChip(it.status)); tr.append(st);
    tr.append(el("td", "num", it.ms ? fmtMs(it.ms) : ""), el("td", "num hide-sm", String(it.sent ?? "")),
              el("td", "num hide-sm", String(it.attempts ?? "")));
    const err = el("td", "jerr", it.error || "");
    if (it.error) err.title = it.error;
    tr.append(err);
    const tc = el("td", "num");
    if (it.trace_id) {
      const b = el("button", "linkbtn", "Trace");
      b.append(Icons.svg("right"));
      b.title = `Open trace ${it.trace_id}`;
      b.onclick = async () => {
        switchTab("traces", {quiet: true});
        try { await showRunTree(it.trace_id); } catch (e) { toast(`Trace ${it.trace_id} is not in the traces directory`, true); }
      };
      tc.append(b);
    }
    tr.append(tc);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

async function startJob(name, resume) {
  try {
    const r = await api(`/api/p/${PID}/jobs/${encodeURIComponent(name)}/run`, {resume});
    toast(`${resume ? "Resuming" : "Running"} ${name} (pid ${r.pid})`);
    setTimeout(() => showJobs(name), 1200);
  } catch (e) { toast(e.message, true); }
}
