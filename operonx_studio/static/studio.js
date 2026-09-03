/* operonx studio — the canvas.
 *
 * Vanilla JS on purpose: the page must open on a machine with no internet,
 * and the graph sizes here (tens of nodes) never justify a framework.
 * Layout comes from the server so the picture is deterministic and
 * testable; this file only draws it and answers clicks.
 */

"use strict";

const PID = location.pathname.split("/").pop();
const NODE_W = 210, NODE_H = 76;

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
  sel: null,         // selected node id
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

/* ── rendering ────────────────────────────────────────────────────── */

function bezier(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
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

function render() {
  const g = state.graph;
  const nodesBox = $("#nodes");
  const svg = $("#edges");
  nodesBox.textContent = "";
  svg.textContent = "";

  const span = 400 + (g.width || 800), tall = 200 + (g.height || 400);
  svg.setAttribute("width", span + 400);
  svg.setAttribute("height", tall);
  svg.style.left = "-400px";
  svg.setAttribute("viewBox", `-400 0 ${span + 400} ${tall}`);

  const pos = {};
  for (const n of g.nodes) pos[n.id] = n;

  // serve entry nodes
  const serves = serveNodesFor(g);
  const entryIds = new Set((g.entries || []).map(name =>
    (g.nodes.find(n => n.name === name) || {}).id).filter(Boolean));

  for (const s of serves) {
    for (const eid of entryIds) {
      const t = pos[eid];
      if (!t) continue;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", bezier(s.x + 190, s.y + NODE_H / 2, t.x, t.y + NODE_H / 2));
      p.setAttribute("class", "serve");
      svg.append(p);
    }
  }

  // graph edges
  for (const e of g.edges) {
    const a = pos[e.src], b = pos[e.dst];
    if (!a || !b) continue;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", bezier(a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2));
    let cls = e.soft ? "soft" : "";
    if (state.sel && (e.src === state.sel || e.dst === state.sel)) cls += " hot";
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

  // op cards
  for (const n of g.nodes) {
    const card = el("div", "node");
    card.style.left = `${n.x}px`;
    card.style.top = `${n.y}px`;
    card.style.setProperty("--kind", kindColor(n));
    if (n.id === state.sel) card.classList.add("selected");
    card.append(el("div", "nname", n.name));
    card.append(el("div", "nkind", n.kind + (n.bound ? ` · ${n.bound}` : "")));
    const badges = el("div", "badges");
    if (n.start) badges.append(el("span", "badge", "entry"));
    if (n.end) badges.append(el("span", "badge", "exit"));
    if (n.loop) badges.append(el("span", "badge", "loop"));

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
    card.onclick = (ev) => { ev.stopPropagation(); select(n.id); };
    nodesBox.append(card);
  }

  applyView();
}

function applyView() {
  const v = state.view;
  $("#world").style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
}

function fit() {
  const g = state.graph;
  if (!g || !g.nodes.length) return;
  const stage = $("#stage").getBoundingClientRect();
  const minX = Math.min(-NODE_W - 110, ...g.nodes.map(n => n.x));
  const maxX = Math.max(...g.nodes.map(n => n.x)) + NODE_W;
  const minY = Math.min(0, ...g.nodes.map(n => n.y));
  const maxY = Math.max(...g.nodes.map(n => n.y)) + NODE_H;
  const scale = Math.min(1.2,
    (stage.width - 80) / Math.max(1, maxX - minX),
    (stage.height - 80) / Math.max(1, maxY - minY));
  state.view = {
    x: 40 - minX * scale + (stage.width - 80 - (maxX - minX) * scale) / 2,
    y: 40 - minY * scale + (stage.height - 80 - (maxY - minY) * scale) / 2,
    scale,
  };
  applyView();
}

/* ── inspector ────────────────────────────────────────────────────── */

function select(id) {
  state.sel = (state.sel === id) ? null : id;
  render();
  const panel = $("#inspector");
  if (!state.sel) { panel.classList.remove("open"); return; }
  const n = state.graph.nodes.find(x => x.id === state.sel);
  if (!n) return;
  panel.classList.add("open");
  panel.textContent = "";
  panel.append(el("h3", null, n.name));
  panel.append(el("div", "kind", n.kind + (n.bound ? ` · bound=${n.bound}` : "")));

  const src = n.source || {};
  const srcSec = el("section");
  srcSec.append(el("div", "stitle", "Source"));
  for (const [label, loc] of [["defined", src.defined_at], ["wired", src.wired_at]]) {
    if (loc && loc.file) {
      srcSec.append(el("div", "srcline mono", `${label}  ${loc.file}:${loc.line}`));
    }
  }
  panel.append(srcSec);

  const inSec = el("section");
  inSec.append(el("div", "stitle", "Inputs"));
  for (const inp of n.inputs || []) inSec.append(inputRow(n, inp));
  if (!(n.inputs || []).length) inSec.append(el("div", "note", "none"));
  panel.append(inSec);

  const outSec = el("section");
  outSec.append(el("div", "stitle", "Outputs"));
  for (const o of n.outputs || []) outSec.append(el("span", "outchip mono", o));
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
}

function inputRow(node, inp) {
  const row = el("div", "inrow");
  row.append(el("div", "iname mono", inp.name + (inp.required ? " *" : "")));
  const b = inp.binding || {};
  const from = el("div", "ifrom");
  if (b.kind === "ref") {
    from.append("← ");
    const src = el("span", "src mono", `${(b.from || "").split(".").pop()}.${b.output}`);
    from.append(src);
    if (b.transforms) from.append(` (+${b.transforms} transform)`);
    row.append(from);
  } else if (b.kind === "scratch") {
    from.append(`← SCRATCH[${JSON.stringify(b.key ?? b.value ?? "?")}]`);
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
  $("#inspector").classList.remove("open");
  render(); fit();
};

$("#btn-fit").onclick = fit;

(() => {
  const stage = $("#stage");
  let drag = null;
  stage.addEventListener("mousedown", (ev) => {
    if (ev.target.closest(".node")) return;
    drag = {x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y};
    stage.classList.add("panning");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    state.view.x = drag.vx + ev.clientX - drag.x;
    state.view.y = drag.vy + ev.clientY - drag.y;
    applyView();
  });
  window.addEventListener("mouseup", () => { drag = null; stage.classList.remove("panning"); });
  stage.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const old = state.view.scale;
    const next = Math.min(2.5, Math.max(0.15, old * (ev.deltaY < 0 ? 1.12 : 0.89)));
    // zoom about the cursor, not the origin
    state.view.x = mx - (mx - state.view.x) * (next / old);
    state.view.y = my - (my - state.view.y) * (next / old);
    state.view.scale = next;
    applyView();
  }, {passive: false});
  stage.addEventListener("click", () => {
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
