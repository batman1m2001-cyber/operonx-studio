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
const NODE_W = 210, NODE_H = 76;
const HEADER = 34;              // a container's title strip

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
  stamp: 0,
};

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
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("text-anchor", "middle");
  if (cls) t.setAttribute("class", cls);
  t.textContent = text;
  svg.append(t);
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

  for (const s of serves) {
    for (const t of entryItems) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", bezier(s.x + 190, s.y + NODE_H / 2, t.x, portY(t)));
      p.setAttribute("class", "serve");
      svg.append(p);
    }
  }

  // graph edges (every open level draws its own)
  for (const {e, a, b} of flat.edges) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let cls = e.soft ? "soft" : "";
    if (e.back) {
      p.setAttribute("d", returnPath(a, b));
      cls += " back";
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
    }
    if (state.sel && (state.rendered.get(state.sel)?.node.id === e.src
                   || state.rendered.get(state.sel)?.node.id === e.dst)) cls += " hot";
    p.setAttribute("class", cls.trim());
    svg.append(p);
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
  card.style.left = `${it.x}px`;
  card.style.top = `${it.y}px`;
  card.style.width = `${it.w}px`;
  card.style.height = `${it.h}px`;
  card.style.setProperty("--kind", kindColor(n));
  if (it.key === state.sel) card.classList.add("selected");

  const head = el("div", "chead");
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
  card.style.left = `${it.x}px`;
  card.style.top = `${it.y}px`;
  card.style.setProperty("--kind", kindColor(n));
  if (it.key === state.sel) card.classList.add("selected");
  card.append(el("div", "nname", n.name));
  card.append(el("div", "nkind", n.kind + (n.bound ? ` · ${n.bound}` : "")));
  const badges = el("div", "badges");
  if (n.start) badges.append(el("span", "badge", "entry"));
  if (n.end) badges.append(el("span", "badge", "exit"));
  if (n.is_gen) {
    const b = el("span", "badge gen", "⚡ stream");
    b.title = "Generator: invoked once, yields many — every consumer dispatches per yield, not per run.";
    badges.append(b);
  }
  if (n.transient) {
    const b = el("span", "badge", "transient");
    b.title = "Outputs are delivered and then evicted; a long stream retains nothing.";
    badges.append(b);
  }
  if (n.loop) {
    const cap = n.loop.max_iterations;
    const b = el("span", "badge loop", `↺ while${cap ? " ≤" + cap : ""}`);
    b.title = "Member of a rewritten cycle: the compiler runs this as a synthetic loop; the return edge below is what the author wrote.";
    badges.append(b);
  }
  if (n.graph) {
    const b = el("button", "badge sub expand", `▣ ${n.subgraph_ops} ops ▸`);
    b.title = "A nested @graph — click to open it in place.";
    b.onclick = (ev) => { ev.stopPropagation(); toggleExpand(it.key); };
    badges.append(b);
  } else if (n.subgraph_ops) {
    const b = el("span", "badge sub", `▣ ${n.subgraph_ops} ops`);
    b.title = "A nested @graph. Collapsed here; its ops run inside this node.";
    badges.append(b);
  }

  const runinfo = state.run && state.run.ops[n.name];
  if (runinfo) {
    const avg = runinfo.runs ? (runinfo.total_ms / runinfo.runs) : 0;
    badges.append(el("span", "badge run",
      `${runinfo.runs}× · ${avg < 10 ? avg.toFixed(1) : Math.round(avg)} ms`));
    if (runinfo.errors) {
      badges.append(el("span", "badge err", `${runinfo.errors} err`));
      card.classList.add("errorlit");
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
  panel.append(el("h3", null, n.name));
  panel.append(el("div", "kind",
    n.kind + (n.bound ? ` · bound=${n.bound}` : "") + (n.is_gen ? " · generator" : "")));
  if (n.is_gen) {
    const note = el("div", "srcline",
      "Yields a stream: downstream ops dispatch once per yield. Edge counts in a run are per item, not per invocation.");
    panel.append(note);
  }
  if (n.loop) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Loop"));
    sec.append(el("div", "srcline",
      `Synthetic while-loop (${n.loop.group}) — the authored cycle, rewritten by the compiler. ` +
      `Ceiling: ${n.loop.max_iterations ?? "none"} iterations.`));
    panel.append(sec);
  }
  if (n.graph) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Nested graph"));
    sec.append(el("div", "srcline",
      `${n.subgraph_ops} ops inside. ` +
      (state.expanded.has(it.key) ? "Open on the canvas." : "Double-click the node (or its ▣ badge) to open it in place.")));
    panel.append(sec);
  }

  const src = n.source || {};
  const srcSec = el("section");
  srcSec.append(el("div", "stitle", "Source"));
  for (const [label, loc] of [["defined", src.defined_at], ["wired", src.wired_at]]) {
    if (loc && loc.file) {
      srcSec.append(el("div", "srcline mono", `${label}  ${loc.file}:${loc.line}`));
    }
  }
  panel.append(srcSec);

  // Value slots: when a run is painted, the latest recorded value of
  // every input and output lands inline under its name. The wiring says
  // where a value comes from; the run says what it actually was — the
  // inspector owes the user both.
  const slots = {in: {}, out: {}};

  const inSec = el("section");
  inSec.append(el("div", "stitle", "Inputs"));
  for (const inp of n.inputs || []) inSec.append(inputRow(it, inp, slots));
  if (!(n.inputs || []).length) inSec.append(el("div", "note", "none"));
  panel.append(inSec);

  const outSec = el("section");
  outSec.append(el("div", "stitle", "Outputs"));
  for (const o of n.outputs || []) {
    const row = el("div", "inrow");
    row.append(el("div", "iname mono", o));
    slots.out[o] = el("div");
    row.append(slots.out[o]);
    outSec.append(row);
  }
  if (!(n.outputs || []).length) outSec.append(el("div", "note", "none"));
  panel.append(outSec);

  const runinfo = state.run && state.run.ops[n.name];
  if (runinfo) {
    const runSec = el("section");
    runSec.append(el("div", "stitle", `Run · ${state.run.run}`));
    const avg = runinfo.runs ? runinfo.total_ms / runinfo.runs : 0;
    runSec.append(el("div", "srcline",
      `${runinfo.runs} execution(s) · avg ${avg.toFixed(1)} ms · max ${runinfo.max_ms.toFixed(1)} ms`));
    if (runinfo.last_error) {
      runSec.append(el("div", "srcline", `last error: ${runinfo.last_error}`));
    }
    panel.append(runSec);
  }
  // The drill-down renders for EVERY node while a run is painted — a
  // GraphOp has no aggregate under its own name (only its members ran),
  // and the answer to "what happened here" must never be silence.
  if (state.run) panel.append(executionsSection(n, slots));
  else {
    const hint = el("div", "note",
      "Pick a run in the Traces tab to see the recorded values of these inputs and outputs.");
    panel.append(hint);
  }
}

function valueBlock(v) {
  const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return el("pre", "execjson mono", text === undefined ? "null" : text);
}

/* The drill-down under the aggregate: each recorded execution of this op
 * in the painted run, with the inputs and outputs the trace consumer
 * wrote. Fetched lazily — the section renders first, records arrive into
 * it — so selecting a node stays instant on runs with thousands of
 * records. */
function executionsSection(n, slots) {
  const sec = el("section");
  sec.append(el("div", "stitle", "Executions"));
  const box = el("div", "execbox", "loading…");
  sec.append(box);
  api(`/api/p/${PID}/trace/${encodeURIComponent(state.run.run)}/op/${encodeURIComponent(n.name)}`)
    .then(data => {
      box.textContent = "";
      if (!data.executions.length) {
        box.append(el("div", "note", "no records for this op in this run"));
        return;
      }

      // The latest execution's values land inline under each input and
      // output name above — the wiring says where a value comes from,
      // this says what it actually was.
      const last = data.executions[data.executions.length - 1];
      for (const [dir, values] of [["in", last.inputs], ["out", last.outputs]]) {
        for (const [key, val] of Object.entries(values || {})) {
          const slot = slots && slots[dir][key];
          if (slot) { slot.textContent = ""; slot.append(valueBlock(val)); }
        }
      }

      if (data.total > data.showing) {
        box.append(el("div", "srcline",
          `${data.total} recorded — showing the last ${data.showing}`));
      }
      data.executions.forEach((ex, i) => {
        const d = el("details", "execrow");
        const sum = el("summary");
        const idx = data.total - data.showing + i + 1;
        sum.append(el("span", "mono", `#${idx}`));
        // a container's records belong to its members — say which one ran
        if (ex.op && ex.op !== n.name) sum.append(el("span", "mono dim", ` ${ex.op}`));
        sum.append(el("span", null,
          ` ${(ex.duration_ms ?? 0).toFixed(1)} ms`));
        sum.append(el("span", ex.status === "ok" ? "ok" : "bad", ` ${ex.status ?? "?"}`));
        d.append(sum);
        if (i === data.executions.length - 1) d.open = true;
        if (ex.error) d.append(el("div", "srcline bad", String(ex.error)));
        for (const [label, val] of [["inputs", ex.inputs], ["outputs", ex.outputs]]) {
          d.append(el("div", "stitle", label));
          d.append(el("pre", "execjson mono", JSON.stringify(val ?? null, null, 2)));
        }
        box.append(d);
      });
    })
    .catch(e => { box.textContent = e.message; });
  return sec;
}

function inputRow(it, inp, slots) {
  const node = it.node;
  const row = el("div", "inrow");
  row.append(el("div", "iname mono", inp.name + (inp.required ? " *" : "")));
  if (slots) { slots.in[inp.name] = el("div"); row.append(slots.in[inp.name]); }
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
  if (!data.runs.length) {
    box.append(el("div", "note", `No runs recorded yet in ${data.root}`));
    return;
  }
  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["run", "recorded", "size", ""]) hr.append(el("th", null, h));
  thead.append(hr); table.append(thead);
  const tbody = el("tbody");
  for (const r of data.runs) {
    const tr = el("tr", "run-row");
    tr.append(el("td", "mono", r.run));
    tr.append(el("td", null, new Date(r.mtime * 1000).toLocaleString()));
    tr.append(el("td", null, `${(r.size / 1024).toFixed(1)} KB`));
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
  $("#run-name").textContent = data.run + (data.truncated ? " (truncated)" : "");
  $("#runbanner").classList.add("show");
  switchTab("flow");
  render();
}

$("#run-clear").onclick = () => {
  state.run = null;
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
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
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
    if (ev.target.closest(".node")) return;
    state.sel = null;
    $("#inspector").classList.remove("open");
    render();
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
  state.graph = data.graphs.find(g => g.name === current) || data.graphs[0];
  if (state.graph) pick.value = state.graph.name;
  render();
  if (first) fit();
}

async function poll() {
  try {
    const {stamp} = await api(`/api/p/${PID}/stamp`);
    if (stamp !== state.stamp) await load(false);
  } catch { /* daemon briefly away; the next poll answers */ }
  setTimeout(poll, 1500);
}

load(true).then(() => setTimeout(poll, 1500));
