/* operonx studio — the canvas.
 *
 * Vanilla JS on purpose: the page must open on a machine with no internet,
 * and the graph sizes here (tens of nodes) never justify a framework.
 * Layout comes from the server so the picture is deterministic and
 * testable; this file draws it, opens GraphOp containers in place, and
 * answers clicks.
 */

"use strict";

// `/p/<pid>` or `/p/<pid>/<screen>/…` (router.js): the id is the second segment
const PID = location.pathname.split("/")[2];
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
  route: null,        // {key, ri}: a router's route picked on the canvas
  routePeek: null,    // {key, ri}: the route under the pointer
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
    exec_id: state.execSel ? (state.execId || null) : null,
    mode: state.run ? "workflow" : "tree",
    file: state.tab === "yaml" ? (state.yamlFile || null) : null,
    runs_filter: state.tab === "traces" ? (recall(`runsView:${PID}`, null) ? JSON.stringify(recall(`runsView:${PID}`, null)) : null) : null,
    monitor: state.tab === "monitor" ? JSON.stringify(recall(`monitor:${PID}`, {})) : null,
  };
  document.dispatchEvent(new CustomEvent("oxview"));
  if (typeof Router !== "undefined") Router.follow(window.__oxview);
}

/* One shared voice for action feedback: applied, painted, copied. */
let _toastTimer = null;
function toast(text, bad, action) {
  let t = $("#toast");
  if (!t) {
    t = el("div", null, "");
    t.id = "toast";
    document.body.append(t);
  }
  t.textContent = text;
  // one action a toast can offer: Undo, after a write
  if (action) {
    const b = el("button", "toastact", action.label);
    b.type = "button";
    b.onclick = () => { t.classList.remove("show"); action.run(); };
    t.append(b);
  }
  t.classList.toggle("bad", !!bad);
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), action ? 7000 : 2400);
}

/* A write to the project landed (operonx_studio/safewrite.py): say so, and
 * offer to put it back. */
function wrote(got, text) {
  toast(text, false, got && got.write ? {label: "Undo", run: () => undoWrite(got.write)} : null);
}

async function undoWrite(id) {
  try {
    const r = await api(`/api/p/${PID}/writes/${encodeURIComponent(id)}/undo`, {});
    toast(`Undone — ${r.file} is as it was`);
  } catch (e) { toast(e.message, true); }
}

/* A write the studio refused, said in place: the file moved since the
 * preview (with the change against it now), the change reached past what
 * it was for, or the project would not build. Returns the new base for a
 * stale file, so the same change can be applied against it. */
function refusal(err, box) {
  const d = (err && err.data) || {};
  box.textContent = "";
  const head = {stale: "The file changed since the preview.", scope: "Not written: the change reaches past what it was for.",
                build: "Not written: the project would not build with it."}[d.code] || "Not written.";
  box.append(el("div", "refuse-head", head), el("div", "note", err.message));
  if (d.diff) {
    const diff = el("div", "diffbox");
    for (const ln of d.diff.split("\n")) diff.append(el("div", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : null, ln));
    box.append(diff);
  }
  box.hidden = false;
  return d.code === "stale" ? d.base : null;
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
  // an agent's parts (extract.py `_agent_parts`): an MCP server's tool, its memory
  "MCPTool":           {icon: "⇄", color: "var(--k-io)"},
  "Session":           {icon: "⛁", color: "var(--ap-mem)"},
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

/* An agent op, and the steps a run recorded under one (turn, model call,
 * tool call), look like their TYPE (agentsteps.js) — never like an IR
 * node that happens to share the step's name. */
function stepVisual(node) {
  return (node.step || node.op_type === "agent") ? AgentSteps.visual(node.op_type) : null;
}

function kindColor(node) { return (stepVisual(node) || visualOf(node.kind)).color; }

/* An LLM op's icon is its BACKEND, not just "some LLM" — detection
 * lives in providers.js (pure, node-tested); this file only wires it
 * to the canvas. */
const LLM_PROVIDERS = Providers.PROVIDERS;

/* An op names a resource without its category (`LLMOp(resource="assistant")`,
 * `Model("assistant")`); the project's files key it with one (`llm:assistant`). */
function resourceDetail(all, name) {
  if (all[name]) return all[name];
  const key = Object.keys(all).find(k => k.slice(k.indexOf(":") + 1) === name && k.includes(":"));
  return key ? all[key] : null;
}

function resourceOf(node) {
  const name = Array.isArray(node.resource) ? node.resource[0] : node.resource;
  return name ? resourceDetail((state.ir.resources || {}).details || {}, name) : null;
}

function llmProvider(node) {
  if (!(node.kind || "").match(/LLM|Chat|Completion/)) return null;
  return Providers.detectProvider(
    {resource: node.resource, fields: resourceOf(node) || {}});
}

function kindIcon(node) {
  const sv = stepVisual(node);
  if (sv) return sv.icon;
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
  if (n.step) return true;            // a step the run recorded: it ran
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

