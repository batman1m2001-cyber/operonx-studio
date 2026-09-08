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
const NODE_W = 210, NODE_H = 64;
const HEADER = 34;              // a container's title strip
const MOTION_OK = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  view: {x: 60, y: 60, scale: 1},
  run: null,         // {run, ops: {name: {runs, errors, total_ms, max_ms}}}
  heatMax: 0,        // slowest avg ms in the painted run — the heat scale
  follow: false,     // repaint whenever a newer run appears
  stamp: 0,
};

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

function kindColor(node) {
  const k = node.kind || "";
  if (k.includes("LLM")) return "var(--k-llm)";
  if (k.includes("Graph")) return "var(--k-graph)";
  if (k.includes("Branch")) return "var(--k-branch)";
  if (node.bound === "io") return "var(--k-io)";
  return "var(--k-func)";
}

function kindIcon(node) {
  const k = node.kind || "";
  if (k.includes("LLM")) return "✦";
  if (k.includes("Branch")) return "⑃";
  if (k.includes("Graph")) return "▣";
  if (k.includes("Embedding") || k.includes("Rerank") || k.includes("Search") || k.includes("Fetch")) return "⛁";
  if (k.includes("Emit")) return "📣";
  if (k.includes("Interrupt")) return "✋";
  if (node.is_gen) return "⚡";
  return "ƒ";
}

/* ── placement: expansion opens a GraphOp in place ────────────────── */

/* The server lays every graph on a grid, nested graphs included. A
 * GraphOp the user opens becomes a container sized to its inner layout;
 * every column to its right and row below shifts by the growth, so the
 * grid stays a grid and nothing overlaps. Recursion makes a container
 * inside a container work for free. */
function placeGraph(g, prefix, depth) {
  const size = new Map();
  for (const n of g.nodes) {
    const key = prefix + n.id;
    let inner = null, w = NODE_W, h = NODE_H;
    if (n.graph && state.expanded.has(key)) {
      inner = placeGraph(n.graph, key + "/", depth + 1);
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
    if (it.inner) flattenModel(it.inner, a.x, a.y + HEADER, out);
  }
  for (const e of model.edges) {
    const a = abs.get(e.src), b = abs.get(e.dst);
    if (a && b) out.edges.push({e, a, b});
  }
  return out;
}

/* ── edge geometry ────────────────────────────────────────────────── */

const portY = (it) => it.y + Math.min(it.h, NODE_H) / 2;

function bezier(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function returnPath(a, b) {
  // A loop's return edge: out of the source's underside, bowing beneath
  // everything it passes over, back into the target's underside. Drawn
  // differently from a forward edge on purpose — this is the arrow that
  // makes an agent while-loop look like what the author wrote instead of
  // one opaque compiler box.
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y + b.h;
  const dip = Math.max(y1, y2) + 60 + Math.abs(x1 - x2) * 0.08;
  return `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`;
}

function wrapPath(a, b) {
  // The seam where a long chain wraps to the next band: out of the
  // source's right side, down through the band gap, left along the
  // channel, into the target from its left — a carriage return, not a
  // backwards sweep across the whole picture.
  const x1 = a.x + a.w, y1 = portY(a);
  const x2 = b.x, y2 = portY(b);
  const ch = b.y - 44;            // the channel above the target's band
  return `M ${x1} ${y1}`
    + ` C ${x1 + 70} ${y1}, ${x1 + 70} ${ch}, ${x1 - 10} ${ch}`
    + ` L ${x2 - 30} ${ch}`
    + ` C ${x2 - 70} ${ch}, ${x2 - 60} ${y2}, ${x2} ${y2}`;
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

function edgeGlyph(svg, x, y, text, cls) {
  const t = document.createElementNS(SVGNS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("text-anchor", "middle");
  if (cls) t.setAttribute("class", cls);
  t.textContent = text;
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

/* The action potential: one glowing dot travelling the axon. Skipped
 * when the user asks for reduced motion, or on very dense graphs. */
function impulse(svg, path, animate) {
  if (!animate) return;
  const c = document.createElementNS(SVGNS, "circle");
  c.setAttribute("r", 2.4);
  c.setAttribute("class", "impulse");
  const move = document.createElementNS(SVGNS, "animateMotion");
  const dur = 2.8 + Math.random() * 1.8;
  move.setAttribute("dur", `${dur.toFixed(2)}s`);
  move.setAttribute("begin", `${(-Math.random() * dur).toFixed(2)}s`);
  move.setAttribute("repeatCount", "indefinite");
  const ref = document.createElementNS(SVGNS, "mpath");
  ref.setAttribute("href", `#${path.id}`);
  move.append(ref);
  c.append(move);
  svg.append(c);
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
      x: -NODE_W - 110,
      y: 40 + i * (NODE_H + 30),
    }));
}

/* ── rendering ────────────────────────────────────────────────────── */

function render() {
  const g = state.graph;
  const nodesBox = $("#nodes");
  const svg = $("#edges");
  nodesBox.textContent = "";
  svg.textContent = "";
  state.rendered.clear();

  const model = placeGraph(g, "", 0);
  const flat = flattenModel(model, 0, 0, {nodes: [], edges: []});

  const maxX = Math.max(model.w, ...flat.nodes.map(n => n.x + n.w));
  const maxY = Math.max(model.h, ...flat.nodes.map(n => n.y + n.h));
  state.extent = {minX: -NODE_W - 110, minY: 0, maxX, maxY: maxY + 120};

  const span = 400 + maxX, tall = 300 + maxY;
  svg.setAttribute("width", span + 400);
  svg.setAttribute("height", tall);
  svg.style.left = "-400px";
  svg.setAttribute("viewBox", `-400 0 ${span + 400} ${tall}`);

  // serve entry nodes
  const serves = serveNodesFor(g);
  const entryItems = (g.entries || [])
    .map(name => flat.nodes.find(it => it.depth === 0 && it.node.name === name))
    .filter(Boolean);

  // Impulses are joy on a working graph and sludge on a huge one.
  const animate = MOTION_OK && flat.edges.length <= 120;
  let axonN = 0;

  for (const s of serves) {
    for (const t of entryItems) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", bezier(s.x + 190, s.y + NODE_H / 2, t.x, portY(t)));
      p.setAttribute("class", "serve");
      svg.append(p);
      bouton(svg, t.x, portY(t), "b-serve");
    }
  }

  // graph edges (every open level draws its own)
  for (const {e, a, b} of flat.edges) {
    const p = document.createElementNS(SVGNS, "path");
    p.id = `ax${axonN++}`;
    let cls = e.soft ? "soft" : "";
    let end = [b.x, portY(b)], endCls = "";
    if (e.back) {
      p.setAttribute("d", returnPath(a, b));
      cls += " back";
      end = [b.x + b.w / 2, b.y + b.h]; endCls = "b-back";
      const dip = Math.max(a.y + a.h, b.y + b.h) + 58 + Math.abs(a.x - b.x) * 0.06;
      edgeGlyph(svg, (a.x + b.x + b.w) / 2, dip, "↺ loop", "back-label");
    } else if (b.x < a.x - 1) {
      p.setAttribute("d", wrapPath(a, b));
      cls += " wrap";
    } else {
      p.setAttribute("d", bezier(a.x + a.w, portY(a), b.x, portY(b)));
      const mx = (a.x + a.w + b.x) / 2, my = (portY(a) + portY(b)) / 2 - 6;
      // A generator's edge is not one item; a consumer's mode is not
      // sequential. Both change what the run does, so both are on the wire.
      if (a.node.is_gen) { cls += " stream"; edgeGlyph(svg, mx, my, "≋"); }
      const consume = consumeOf(e, a, b);
      if (consume) {
        edgeGlyph(svg, mx, my + (a.node.is_gen ? 14 : 0),
                  consume.mode === "collect" ? "⧉ collect"
                  : `∥ parallel${consume.max ? "≤" + consume.max : ""}`);
      }
      // a branch edge is meaningless without its condition — label lane
      // sits below the glyph lane so the two never collide
      if (a.node.routes && e.type === "condition") {
        const labels = a.node.routes
          .filter(r => r.target === b.node.name).map(r => r.condition);
        if (labels.length) edgeGlyph(svg, mx, my + 26, labels.join(" | "), "routelabel");
      }
    }
    if (state.sel && (state.rendered.get(state.sel)?.node.id === e.src
                   || state.rendered.get(state.sel)?.node.id === e.dst)) cls += " hot";
    p.setAttribute("class", cls.trim());
    svg.append(p);
    bouton(svg, end[0], end[1], endCls);
    impulse(svg, p, animate);
  }

  // serve cards
  for (const s of serves) {
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

  // op cards — flatten order draws a container before its members, so
  // members paint on top of their box without any z-index bookkeeping
  for (const it of flat.nodes) {
    nodesBox.append(it.inner ? containerCard(it) : opCard(it));
  }

  applyView();
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

  card.append(el("span", "port in"));
  card.append(el("span", "port out"));
  return card;
}

function opCard(it) {
  const n = it.node;
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
    card.append(el("div", "nname",
      n.serve_role === "ingress" ? `⇥ ${n.name}` : `${n.name} ⇥`));
    card.append(el("div", "nkind",
      n.serve_role === "ingress" ? "ingress · client → run" : "egress · run → client"));
  } else {
    const line = el("div", "nname");
    line.append(el("span", "nicon", kindIcon(n)));
    line.append(n.name);
    card.append(line);
    // the kind/bound line was card noise at fit-zoom; it lives in the
    // tooltip and the inspector now
    card.title = n.kind + (n.bound ? ` · ${n.bound}` : "") + (n.is_gen ? " · generator" : "");
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
  } else if (n.is_gen) {
    const b = el("span", "badge gen", "⚡");
    b.title = "Generator: consumers dispatch per yield, not per run.";
    badges.append(b);
  }

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
  card.append(el("span", "port out"));
  card.onclick = (ev) => { ev.stopPropagation(); select(it.key); };
  if (n.graph) card.ondblclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
  return card;
}

/* ── view: pan, zoom, fit ─────────────────────────────────────────── */

function applyView() {
  const v = state.view;
  $("#world").style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  $("#btn-zoom-pct").textContent = `${Math.round(v.scale * 100)}%`;
}

function zoomAt(mx, my, factor) {
  const old = state.view.scale;
  const next = Math.min(2.5, Math.max(0.1, old * factor));
  state.view.x = mx - (mx - state.view.x) * (next / old);
  state.view.y = my - (my - state.view.y) * (next / old);
  state.view.scale = next;
  applyView();
}

function stageCenter() {
  const r = $("#stage").getBoundingClientRect();
  return {x: r.width / 2, y: r.height / 2};
}

function fit() {
  const ex = state.extent;
  if (!ex) return;
  const stage = $("#stage").getBoundingClientRect();
  const scale = Math.min(1.2,
    (stage.width - 80) / Math.max(1, ex.maxX - ex.minX),
    (stage.height - 80) / Math.max(1, ex.maxY - ex.minY));
  state.view = {
    x: 40 - ex.minX * scale + (stage.width - 80 - (ex.maxX - ex.minX) * scale) / 2,
    y: 40 - ex.minY * scale + (stage.height - 80 - (ex.maxY - ex.minY) * scale) / 2,
    scale,
  };
  applyView();
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
  render();
  const panel = $("#inspector");
  if (!state.sel) { panel.classList.remove("open"); return; }
  const it = state.rendered.get(state.sel);
  if (!it) return;
  const n = it.node;
  panel.classList.add("open");
  panel.textContent = "";
  panel.scrollTop = 0;

  // ── identity: sticky while the body scrolls ───────────────────────
  const head = el("div", "phead");
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

  if (n.kind === "FuncOp" || n.code) panel.append(signatureLine(n));
  if (n.serve_role) {
    panel.append(el("div", "rolenote",
      n.serve_role === "ingress"
        ? "⇥ Serve boundary — the client's data enters the run here. No business logic inside."
        : "⇥ Serve boundary — the run's answers leave for the client here. No business logic inside."));
  }

  // One fetch per selection; every section that cares about the painted
  // run shares it.
  const execP = state.run
    ? api(`/api/p/${PID}/trace/${encodeURIComponent(state.run.run)}/op/${encodeURIComponent(n.name)}`)
    : null;

  if (execP) panel.append(valuesSection(n, execP));
  const llm = llmSection(n, execP);
  if (llm) panel.append(llm);
  if (n.routes) panel.append(routeSection(it, execP));
  if (execP) panel.append(executionsSection(n, execP));
  if (n.code) panel.append(codeSection(n));
  if (n.graph) panel.append(membersSection(it));
  // Wiring, params and source: the main event without a run, one click
  // away with one — the values above already answer the first question.
  panel.append(wiringSection(it, !state.run));
}

function signatureLine(n) {
  const params = (n.inputs || []).map(inp => {
    const b = inp.binding || {};
    if (b.kind === "literal" && ["string", "number", "boolean"].includes(typeof b.value)) {
      const lit = JSON.stringify(b.value);
      return inp.name + "=" + (lit.length > 14 ? lit.slice(0, 12) + "…" : lit);
    }
    return inp.name;
  });
  const outs = (n.outputs || []).join(", ");
  return el("div", "sigline mono", `(${params.join(", ")}) → ${outs || "∅"}`);
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

/* A branch's whole meaning: which condition routes where. With a run
 * painted, the routes that actually fired get their counts. */
function routeSection(it, execP) {
  const n = it.node;
  const sec = el("section");
  sec.append(el("div", "stitle", "Routes"));
  const rows = new Map();
  for (const r of n.routes) {
    const row = el("div", "routerow");
    row.append(el("span", `routecond mono${r.condition === "else" ? " relse" : ""}`, r.condition));
    row.append(el("span", "routearrow", "→"));
    const tgt = el("button", "routetarget mono", r.target);
    tgt.onclick = () => {
      for (const [k, item] of state.rendered) {
        if (item.node.name === r.target && item.depth === it.depth) { select(k); return; }
      }
    };
    row.append(tgt);
    rows.set(r.target, row);
    sec.append(row);
  }
  if (execP) execP.then(data => {
    const fired = {};
    for (const ex of data.executions) {
      const t = (ex.outputs || {}).target;
      if (t) fired[t] = (fired[t] || 0) + 1;
    }
    for (const [target, count] of Object.entries(fired)) {
      const row = rows.get(target);
      if (row) {
        row.classList.add("fired");
        row.append(el("span", "chip cfired", `${count}×`));
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
    row.append(tintLine(line, st));
    pre.append(row);
  });
  sec.append(pre);
  return sec;
}

function wiringSection(it, open) {
  const n = it.node;
  const box = el("details", "foldbox");
  box.open = open;
  const sum = el("summary");
  sum.append(el("span", "stitle", "Wiring & params"));
  box.append(sum);

  for (const inp of n.inputs || []) box.append(inputRow(it, inp));
  if (!(n.inputs || []).length) box.append(el("div", "note", "no inputs"));

  const outs = el("div", "outrow");
  for (const o of n.outputs || []) outs.append(el("span", "outchip mono", o));
  if (outs.childNodes.length) box.append(outs);

  const src = n.source || {};
  for (const [label, loc] of [["defined", src.defined_at], ["wired", src.wired_at]]) {
    if (loc && loc.file) box.append(el("div", "srcline mono", `${label}  ${loc.file}:${loc.line}`));
  }
  return box;
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

function inputRow(it, inp) {
  const node = it.node;
  const row = el("div", "inrow");
  row.append(el("div", "iname mono", inp.name + (inp.required ? " *" : "")));
  const b = inp.binding || {};
  const from = el("div", "ifrom");
  if (b.kind === "ref") {
    from.append("← ");
    const src = el("span", "src mono", `${(b.from || "").split(".").pop()}.${b.output}`);
    from.append(src);
    if (b.transforms) from.append(` (+${b.transforms} transform)`);
    if (b.consume) {
      from.append(b.consume.mode === "collect"
        ? " · collect (buffers every yield until EOF, delivers a list)"
        : ` · parallel${b.consume.max ? " ≤" + b.consume.max : ""} (yields fan out concurrently)`);
    }
    row.append(from);
  } else if (b.kind === "scratch") {
    from.append(`← SCRATCH[${JSON.stringify(b.key ?? b.value ?? "?")}]`);
    row.append(from);
  } else if (b.kind === "literal" && it.depth > 0) {
    // An op inside an opened container belongs to the nested graph, which
    // the manifest may not declare — the set_param edit path addresses
    // graphs by manifest name. Show the value; edit it where it lives.
    from.textContent = `literal ${JSON.stringify(b.value)} — edit in the nested graph's own source`;
    row.append(from);
  } else if (b.kind === "literal") {
    from.textContent = "literal — editable";
    row.append(from);
    // The one edit the studio allows: a literal param, rewritten in the
    // source through a typed edit that previews its own diff. Wiring is
    // never editable here — that is code, and code is edited as code.
    const field = el("input");
    field.type = "text";
    field.value = JSON.stringify(b.value);
    const bar = el("div", "apply");
    const btn = el("button", null, "Preview change");
    const status = el("span", "srcline");
    bar.append(btn, status);
    const diffBox = el("div", "diffbox");
    diffBox.style.display = "none";
    row.append(field, bar, diffBox);

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
          const ln = el("div", cls, line);
          diffBox.append(ln);
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
            // the watcher sees the mtime; the poll below re-renders
          } catch (e) { status.textContent = e.message; }
        };
        bar.append(confirm);
      } catch (e) { status.textContent = e.message; }
    };
  } else {
    from.textContent = b.kind || "unbound";
    row.append(from);
  }
  return row;
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
  const followBar = el("label", "followpin");
  const pin = el("input");
  pin.type = "checkbox";
  pin.checked = state.follow;
  pin.onchange = () => { state.follow = pin.checked; store("follow", state.follow); };
  followBar.append(pin, " auto-paint the newest run as it arrives");
  box.append(followBar);

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
    tr.append(el("td", null, "view on canvas →"));
    tr.onclick = () => paintRun(r.run);
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
}

async function paintRun(run) {
  const data = await api(`/api/p/${PID}/trace/${encodeURIComponent(run)}`);
  state.run = data;
  // heat scale: the run's slowest average paints the hottest border
  state.heatMax = Math.max(0, ...Object.values(data.ops || {})
    .map(o => o.runs ? o.total_ms / o.runs : 0));
  $("#run-name").textContent = data.run + (data.truncated ? " (truncated)" : "");
  $("#runbanner").classList.add("show");
  switchTab("flow");
  render();
}

$("#run-clear").onclick = () => {
  state.run = null;
  state.heatMax = 0;
  $("#runbanner").classList.remove("show");
  render();
};

/* ── tabs, graph switch, pan/zoom, live reload ────────────────────── */

function switchTab(name) {
  for (const b of document.querySelectorAll(".tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  $("#stage").style.display = name === "flow" ? "" : "none";
  $("#inspector").classList.toggle("open", name === "flow" && !!state.sel);
  $("#traces").hidden = name !== "traces";
  if (name === "traces") showTraces();
}
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

  // Wheel scrolls the canvas; ctrl+wheel (and a trackpad pinch, which the
  // browser reports as exactly that) zooms about the cursor. This is the
  // n8n/Figma convention — a two-finger scroll must never fling the zoom.
  stage.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      const rect = stage.getBoundingClientRect();
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top,
             Math.exp(-ev.deltaY * 0.0022));
    } else {
      state.view.x -= ev.deltaX;
      state.view.y -= ev.deltaY;
      applyView();
    }
  }, {passive: false});

  stage.addEventListener("mousedown", (ev) => {
    const overNode = ev.target.closest(".node");
    const panButton = ev.button === 1 || (ev.button === 0 && spaceHeld);
    if (overNode && !panButton && ev.button === 0) return;  // node click
    if (ev.button !== 0 && ev.button !== 1) return;
    ev.preventDefault();
    drag = {x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y, moved: false};
    stage.classList.add("panning");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    drag.moved = drag.moved || Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3;
    state.view.x = drag.vx + ev.clientX - drag.x;
    state.view.y = drag.vy + ev.clientY - drag.y;
    applyView();
  });
  window.addEventListener("mouseup", () => { drag = null; stage.classList.remove("panning"); });

  window.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault(); openFind(); return;
    }
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
    if (ev.key === "/") { ev.preventDefault(); openFind(); return; }
    if (ev.key === " ") { spaceHeld = true; stage.classList.add("panmode"); ev.preventDefault(); return; }
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
    if (ev.target.closest(".node") || ev.target.closest("#find")) return;
    state.sel = null;
    $("#inspector").classList.remove("open");
    render();
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
  const stage = $("#stage").getBoundingClientRect();
  const s = state.view.scale;
  state.view.x = stage.width / 2 - (item.x + item.w / 2) * s;
  state.view.y = stage.height / 2 - (item.y + item.h / 2) * s;
  applyView();
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
    const width = Math.min(720, Math.max(280, window.innerWidth - ev.clientX));
    panel.style.width = `${width}px`;
  });
  bar.addEventListener("pointerup", () => {
    dragging = false;
    document.body.classList.remove("resizing");
    store("panelW", parseInt(panel.style.width, 10) || 360);
  });
  bar.addEventListener("dblclick", () => {
    panel.style.width = "360px";
    store("panelW", 360);
  });
})();

async function load(first) {
  const data = await api(`/api/p/${PID}/ir`);
  $("#pname").textContent = data.name || "project";
  document.title = `${data.name} — operonx studio`;
  if (data.error) {
    $("#nodes").textContent = "";
    $("#edges").textContent = "";
    const box = el("div", "errbox", data.error);
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
  if (first) fit();
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
