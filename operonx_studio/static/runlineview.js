/* operonx studio — the run page's Workflow view: the flow as a line, beside
 * the step (docs/RUN_LINE_PLAN.md W2).
 *
 *   the line    one row per op of the flow, in the order the run reached it
 *               (runline.js): lanes for forks and joins, a faded lane for a
 *               route not taken, an open GraphOp's ops indented under it;
 *               what happened (routes, waits, races, retries, ×n, failed),
 *               how long, and when on the run's time axis
 *   the step    the picked op: why it did not run, the route it took, what
 *               it waited for — then its execution as the Tree reads one
 *               (renderExecPanel): output, input, what fed it
 *
 * In a big flow what is not around the picked op dims, so the line reads
 * as the part that matters; the list scrolls. ↑ ↓ move, e the next error.
 */

const RunLineView = (() => {
  const RH = 30, LX = 14, LG = 14;     // a row's height; the first lane's x; a lane's pitch (px)
  const BIG = 16;                      // more rows than this: dim what is not around the picked op
  let cur = null;

  const KIND_TAG = {llm: "LLM", agent: "agent", emit: "emit", data: "vector"};
  const KIND_NAME = {func: "op", llm: "LLMOp", agent: "AgentOp", graph: "GraphOp", branch: "branch", emit: "EmitOp", data: "vector op"};

  /* a station's colour: the studio's kind colour, the branch the routes' lavender */
  function tint(s) {
    if (s.kind === "branch") return "var(--rt-wire)";
    if (s.kind === "func" || s.kind === "graph") return "var(--k-graph)";
    return kindColor(s.node);
  }

  // ── the line: lanes in SVG, a row per station ──

  function draw() {
    const {L, sel} = cur;
    const near = sel ? RunLine.around(L, sel) : new Set();
    const big = L.rows.length > BIG && !!sel;
    const lw = LX + L.width * LG - 4;
    cur.rowsEl.style.setProperty("--lw", `${lw}px`);
    cur.rowsEl.textContent = "";
    const T = cur.total;
    const x = (l) => LX + l * LG, yc = (i) => i * RH + RH / 2;
    const paths = [], marks = [];
    const seg = (d, e) => {
      const hot = !!sel && (e.from === sel || e.to === sel);
      const faint = big && !hot && !(near.has(e.from) && near.has(e.to));
      const col = e.type === "error" ? "var(--err)" : e.route != null
        ? (hot ? "var(--rt-wire-lit)" : "var(--rt-wire)") : (hot ? "var(--k-graph)" : "var(--k-graph-line)");
      let op = e.ran ? (faint ? .35 : 1) : (faint ? .18 : .45);
      if (e.late) op = faint ? .2 : .55;
      const dash = e.late ? "1 4" : e.ran ? (e.type === "error" ? "5 3" : "") : "3 4";
      paths.push(`<path d="${d}" style="stroke:${col}" stroke-width="${hot ? 2.6 : 1.6}" stroke-opacity="${op}"`
        + `${dash ? ` stroke-dasharray="${dash}"` : ""} fill="none" stroke-linecap="round"/>`);
    };
    const curve = (x1, y1, x2, y2) => (x1 === x2 ? `M${x1} ${y1}V${y2}`
      : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);

    L.rows.forEach((r, i) => {
      const s = L.stations.get(r.key), top = i * RH, bot = top + RH, y = yc(i), sx = x(r.lane);
      for (const t of r.through) seg(`M${x(t.lane)} ${top}V${bot}`, t.edge);
      for (const m of r.merges) seg(curve(x(m.lane), top, sx, y), m.edge);
      for (const f of r.forks) seg(curve(sx, y, x(f.lane), bot), f.edge);
      const on = r.key === sel, dim = big && !near.has(r.key);
      marks.push(marker(s, sx, y, dim ? .4 : 1, on ? 5.5 : 4.2));
      if (on) marks.push(`<circle cx="${sx}" cy="${y}" r="9" fill="none" style="stroke:var(--accent)" stroke-width="1.5" opacity=".75"/>`);
      cur.rowsEl.append(rowEl(s, r, i, on, dim, T));
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "rl-svg");
    svg.setAttribute("width", lw);
    svg.setAttribute("height", L.rows.length * RH);
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = paths.join("") + marks.join("");
    cur.rowsEl.append(svg);
    cur.rowsEl.style.height = `${L.rows.length * RH}px`;
  }

  function marker(s, sx, y, o, rr) {
    const base = tint(s);
    const stroke = s.failed || s.stopped ? "var(--err)" : base;
    const fill = s.ran ? (s.failed ? "var(--err)" : base) : "var(--surface)";
    const st = (f, k, w) => `style="fill:${f};stroke:${k}" stroke-width="${w}" opacity="${o}"`;
    if (s.kind === "branch") {
      return `<rect x="${sx - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${sx} ${y})" ${st(fill, stroke, 1.5)}/>`;
    }
    if (s.group) {
      let m = `<rect x="${sx - rr}" y="${y - rr}" width="${rr * 2}" height="${rr * 2}" rx="2.5" ${st(s.open ? "var(--surface)" : fill, stroke, 1.8)}/>`;
      if (s.open && s.ran) m += `<rect x="${sx - 1.8}" y="${y - 1.8}" width="3.6" height="3.6" rx="1" style="fill:${fill}" opacity="${o}"/>`;
      return m;
    }
    if (s.kind === "emit") {
      return `<path d="M${sx - rr} ${y + rr * .8}L${sx} ${y - rr}L${sx + rr} ${y + rr * .8}Z" stroke-linejoin="round" ${st(fill, stroke, 1.5)}/>`;
    }
    if (s.kind === "data") {
      return `<rect x="${sx - rr}" y="${y - rr * .75}" width="${rr * 2}" height="${rr * 1.5}" rx="${rr * .75}" ${st(fill, stroke, 1.5)}/>`;
    }
    let m = `<circle cx="${sx}" cy="${y}" r="${rr}" ${st(fill, stroke, 1.6)}/>`;
    if (s.kind === "agent") m += `<circle cx="${sx}" cy="${y}" r="${rr + 2.6}" fill="none" style="stroke:${stroke}" stroke-width="1" opacity="${o * .8}"/>`;
    if (s.failed) m += `<path d="M${sx - 2} ${y - 2}L${sx + 2} ${y + 2}M${sx + 2} ${y - 2}L${sx - 2} ${y + 2}" style="stroke:var(--surface)" stroke-width="1.5" opacity="${o}"/>`;
    return m;
  }

  /* what happened at a station, in a few words */
  function metaOf(s) {
    const out = [];
    const m = (cls, text) => out.push(el("span", cls, text));
    if (KIND_TAG[s.kind]) {
      const t = el("span", "rl-kd", KIND_TAG[s.kind]);
      t.style.setProperty("--kind", tint(s));
      out.push(t);
    }
    if (!s.ran) m("rl-m rl-no", "did not run");
    else if (s.kind === "branch") {
      const took = s.routes.find(q => q.ran);
      if (took) m("rl-rt", `→ ${took.to}`);
      else if (s.matched === false) m("rl-er", "no route matched");
    } else {
      const bits = [];
      if (s.execs.length > 1) bits.push(s.gen ? (s.kind === "llm" ? `streamed ${s.execs.length} chunks` : `yielded ${s.execs.length}`) : `×${s.execs.length}`);
      if (s.llm && s.kind !== "llm") bits.push(`${s.llm} LLM`);
      if (s.tools.size) bits.push(`${s.tools.size} tool${s.tools.size > 1 ? "s" : ""}`);
      if (s.invoked) bits.push(`runs ${[...s.invoked.keys()].join(", ")}`);
      if (bits.length) m("rl-m", bits.join(" · "));
    }
    if (s.retries) m("rl-m", `↻ ${s.retries} retr${s.retries > 1 ? "ies" : "y"}`);
    if (s.failed) {
      const ex = s.execs.find(e => e.status === "error");
      const er = (cur.tree.errors || []).find(e => e.op_id === (ex && ex.id));
      m("rl-er", `failed${er && er.type ? ` · ${er.type}` : ""}`);
    }
    if (s.stopped) m("rl-er", `stopped · ${s.stopped.type}`);
    if (s.waited) m("rl-wt", `waited ${fmtMs(s.waited.ms)} for ${s.waited.for}`);
    if (s.raced) m("rl-wt", `${s.raced.won} came first`);
    if (s.loops) m("rl-m", `↺ back to ${s.loops.join(", ")}`);
    return out;
  }

  function rowEl(s, r, i, on, dim, T) {
    const row = el("div", "rl-row" + (s.ran ? "" : " no") + (on ? " sel" : "") + (dim ? " dim" : "")
      + (s.failed || s.stopped ? " err" : ""));
    row.style.top = `${i * RH}px`;
    row.dataset.key = r.key;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", on ? "true" : "false");
    const name = el("div", "rl-name");
    name.style.paddingLeft = `${s.depth * 16}px`;
    if (s.group) {
      const tog = el("button", "rl-tog", s.open ? "▾" : "▸");
      tog.type = "button";
      tog.title = s.open ? "Close this GraphOp" : "Open this GraphOp: its ops on the line";
      tog.onclick = (ev) => { ev.stopPropagation(); toggle(r.key); };
      name.append(tog);
    } else name.append(el("span", "rl-tog"));
    name.append(el("span", "rl-n", s.name), ...metaOf(s));
    name.title = s.key.split(".").filter(p => !p.startsWith("__loop")).join(" › ");
    const took = el("div", "rl-dur", s.ran && s.kind !== "branch" ? fmtMs(s.took) : "");
    const track = el("div", "rt-track rl-track");
    if (s.ran) {
      const segs = s.execs.length ? s.execs : [{start_ms: s.start, dur_ms: s.end - s.start}];
      for (const e of segs.slice(0, 200)) {
        const b = el("b", e.status === "error" ? "bad" : "");
        b.style.left = `${(100 * e.start_ms / T).toFixed(3)}%`;
        b.style.width = `${Math.max(0.6, 100 * (e.dur_ms || 0) / T).toFixed(3)}%`;
        if (s.kind !== "func" && s.kind !== "graph" && s.kind !== "branch") b.style.setProperty("--kind", tint(s));
        track.append(b);
      }
    }
    row.append(el("span", "rl-lanes"), name, took, track);
    row.onclick = () => select(r.key);
    return row;
  }

  function legend() {
    const {L} = cur;
    const box = el("div", "rl-legend");
    const all = [...L.stations.values()];
    const kinds = new Set(all.map(s => s.kind));
    const edges = L.rows.flatMap(r => r.forks.map(f => f.edge));
    const item = (svg, text) => {
      const s = el("span");
      s.innerHTML = svg;
      s.append(text);
      box.append(s);
    };
    item(`<svg width="14" height="10"><circle cx="7" cy="5" r="4" style="fill:var(--k-graph)"/></svg>`, "ran");
    if (all.some(s => !s.ran)) item(`<svg width="14" height="10"><circle cx="7" cy="5" r="3.6" style="fill:var(--surface);stroke:var(--k-graph)" stroke-width="1.4"/></svg>`, "did not run");
    if (all.some(s => s.group)) item(`<svg width="14" height="10"><rect x="2" y="1" width="8" height="8" rx="2" style="fill:var(--k-graph)"/></svg>`, "GraphOp");
    if (kinds.has("branch")) item(`<svg width="14" height="10"><rect x="3" y="1" width="7" height="7" transform="rotate(45 6.5 4.5)" style="fill:var(--rt-wire)"/></svg>`, "branch");
    for (const k of ["agent", "llm", "emit", "data"]) {
      const s = all.find(x => x.kind === k);
      if (!s) continue;
      const c = tint(s);
      const svg = k === "agent" ? `<svg width="16" height="12"><circle cx="8" cy="6" r="3.6" style="fill:${c}"/><circle cx="8" cy="6" r="5.6" fill="none" style="stroke:${c}"/></svg>`
        : k === "emit" ? `<svg width="14" height="10"><path d="M3 9L7 1L11 9Z" style="fill:${c}"/></svg>`
        : k === "data" ? `<svg width="14" height="10"><rect x="2" y="2" width="10" height="6" rx="3" style="fill:${c}"/></svg>`
        : `<svg width="14" height="10"><circle cx="7" cy="5" r="4" style="fill:${c}"/></svg>`;
      item(svg, KIND_TAG[k]);
    }
    if (edges.some(e => e.type === "error")) item(`<svg width="26" height="10"><path d="M1 5H25" style="stroke:var(--err)" stroke-width="1.6" stroke-dasharray="5 3"/></svg>`, "on error");
    if (edges.some(e => !e.ran && !e.late)) item(`<svg width="26" height="10"><path d="M1 5H25" style="stroke:var(--k-graph-line)" stroke-width="1.6" stroke-dasharray="3 4" opacity=".6"/></svg>`, "not taken");
    if (edges.some(e => e.late)) item(`<svg width="26" height="10"><path d="M1 5H25" style="stroke:var(--k-graph-line)" stroke-width="1.6" stroke-dasharray="1 4" stroke-linecap="round" opacity=".7"/></svg>`, "came too late");
    return box;
  }

  // ── the step: the station's story, then its execution ──

  function chip(parts) {
    const s = el("span");
    for (const p of parts) s.append(Array.isArray(p) ? el("b", null, p[0]) : p);
    return s;
  }

  function summary(s) {
    const {L} = cur;
    const box = el("div", "rl-sum");
    const pre = L.preds.get(s.key) || [], nxt = L.succs.get(s.key) || [];
    const nm = (k) => L.stations.get(k).name;
    const chips = [];
    if (s.ran) {
      if (s.execs.length > 1) chips.push(chip([[String(s.execs.length)], ` ${s.gen ? (s.kind === "llm" ? "chunks" : "items") : "runs"}`]));
      if (s.retries) chips.push(chip([[String(s.retries)], ` failed attempt${s.retries > 1 ? "s" : ""} before it went through`]));
      if (s.llm) chips.push(chip([[String(s.llm)], ` LLM call${s.llm > 1 ? "s" : ""}`]));
      if (s.waited) chips.push(chip(["waited ", [fmtMs(s.waited.ms)], " for ", [s.waited.for], ` (${s.waited.n} in)`]));
      if (s.raced) chips.push(chip([[s.raced.won], ` came first · ${s.raced.late.join(", ")} too late`]));
      if (s.idle) chips.push(chip(["done ", [fmtMs(s.idle)], " before the join needed it"]));
      if (s.loops) chips.push(chip(["↺ back to ", [s.loops.join(", ")]]));
    }
    if (chips.length) {
      const kv = el("div", "rl-kv");
      kv.append(...chips);
      box.append(kv);
    }
    const sec = (title) => { box.append(el("div", "stitle", title)); };
    if (!s.ran) {
      const why = pre.map((e) => {
        const p = L.stations.get(e.from);
        if (p.kind === "branch" && p.ran) {
          const took = p.routes.find(q => q.ran);
          const cond = e.label && e.label !== "else" ? ` — ${e.label} was false` : "";
          return `${p.name} took ${took ? `the route to ${took.to}` : "no route"}${cond}`;
        }
        if (p.failed) return `${p.name} failed, so nothing came`;
        if (!p.ran) return `${p.name} did not run`;
        if (e.type === "error") return `${p.name} did not fail, so its error path stayed idle`;
        return null;
      }).filter(Boolean);
      sec("Why it did not run");
      const b = el("div", "rl-box");
      (why.length ? why : [cur.turn ? "it did not run in this turn" : "nothing reached it"]).forEach(w => b.append(el("div", null, w)));
      box.append(b);
    }
    if (s.kind === "branch" && s.ran && (s.routes.length || s.matched === false)) {
      sec("Routes");
      const b = el("div", "rl-box");
      for (const q of s.routes) {
        const line = el("div", "rl-route" + (q.ran ? " on" : ""));
        line.append(el("span", "rl-dot", q.ran ? "●" : "○"), el("span", "mono", q.label || "else"), el("span", null, `→ ${q.to}`));
        b.append(line);
      }
      if (s.matched === false) b.append(el("div", "rl-er", "No route matched: the flow stopped here."));
      box.append(b);
    }
    if (s.stopped) {
      sec("Stopped");
      const lines = String(s.stopped.message || "").trim().split("\n").filter(Boolean);
      const last = (lines[lines.length - 1] || "").replace(new RegExp(`^(?:[\\w.]*\\.)?${String(s.stopped.type || "").replace(/\W/g, "")}: `), "");
      box.append(el("div", "errcard", `${s.stopped.type} — ${last}`));
    }
    if (s.failed) {
      const caught = nxt.filter(e => e.type === "error" && L.stations.get(e.to).ran).map(e => nm(e.to));
      box.append(el("div", caught.length ? "rl-handled" : "rl-er",
        caught.length ? `Handled: on_error → ${caught.join(", ")} got the error.` : "Not handled: the run failed here."));
    }
    if (s.tools.size || s.invoked) {
      const b = el("div", "rl-chips");
      for (const [t, n] of s.tools) b.append(el("span", "pill mono", `${t}${n > 1 ? ` ×${n}` : ""}`));
      for (const [t, n] of s.invoked || []) b.append(el("span", "pill mono", `runs ${t}${n > 1 ? ` ×${n}` : ""}`));
      sec(s.tools.size ? "Tools it called" : "Graphs it ran");
      box.append(b);
    }
    return box;
  }

  function renderStep() {
    const {stepEl, L, sel} = cur;
    stepEl.textContent = "";
    stepEl.scrollTop = 0;
    const s = sel && L.stations.get(sel);
    if (!s) {
      stepEl.append(el("div", "rt-step-empty", "Pick an op to read what it did in this run: its output, its input, what fed it.  ↑ ↓ to move, e for the next error."));
      return;
    }
    const pick = s.execs.length
      ? (cur.exec && s.execs.find(e => e.id === cur.exec)) || s.execs[s.execs.length - 1] : null;
    if (pick) {
      cur.exec = pick.id;
      const body = el("div");
      stepEl.append(body);
      // the Tree's panel for the execution: its head is drawn at once, the
      // values after a fetch; the station's story goes under the head
      renderExecPanel(cur.run, pick, cur.execs, body);
      const head = body.querySelector(".phead");
      const after = [];
      if (s.execs.length > 1) after.push(execChips(s, pick));
      after.push(summary(s));
      if (head) head.after(...after); else body.prepend(...after);
      return;
    }
    // no execution of its own: what the line knows
    state.execSel = null;
    state.execId = null;
    pushView();
    const head = el("div", "phead");
    const title = el("div", "pheadrow");
    const back = Icons.button("back", "Steps", "small ghost rt-back", "Back to the line");
    back.onclick = () => backToSteps();
    const ico = kindIconEl("rt-ico", s.node);
    ico.style.setProperty("--kind", kindColor(s.node));
    title.append(back, ico, el("h3", null, s.name));
    head.append(title);
    const verdict = el("div", "execverdict pills");
    verdict.append(el("span", "pill status " + (s.ran ? "s-ok" : "s-none"), s.ran ? "ran" : "did not run"));
    verdict.append(el("span", "pill", KIND_NAME[s.kind] || s.node.kind || "op"));
    if (s.ran && s.span) verdict.append(RunView.pill(fmtMs(s.span[1] - s.span[0]), "Took", "p-strong"));
    head.append(verdict);
    stepEl.append(head, summary(s));
    if (s.group && s.ran) {
      stepEl.append(el("p", "note", s.open
        ? "Its ops are under it on the line: pick one to read its values."
        : "Recorded before operonx 1.22.3, so its own inputs and outputs were not kept. Open it (▸) to read its ops."));
    }
  }

  function execChips(s, pick) {
    const box = el("div", "wfexecs");
    box.append(el("span", "note", `${s.execs.length} ${s.gen ? "items" : "executions"}`));
    s.execs.slice(-40).forEach((r) => {
      const i = s.execs.indexOf(r);
      const c = el("button", "pill" + (r === pick ? " on" : "") + (r.status === "error" ? " err" : ""), `#${i + 1} +${fmtMs(r.start_ms)}`);
      c.type = "button";
      c.title = `${r.ctx} · ${fmtMs(r.dur_ms)}`;
      c.onclick = () => { cur.exec = r.id; renderStep(); };
      box.append(c);
    });
    return box;
  }

  // ── picking ──

  function select(key, opts) {
    if (!cur || !cur.L.stations.has(key)) return false;
    if (cur.sel !== key) cur.exec = (opts && opts.exec) || null;
    else if (opts && opts.exec) cur.exec = opts.exec;
    cur.sel = key;
    const y = cur.listEl.scrollTop;
    draw();
    cur.listEl.scrollTop = y;
    const row = cur.rowsEl.querySelector(".rl-row.sel");
    if (row && !(opts && opts.quiet)) row.scrollIntoView({block: "nearest"});
    else if (row && opts && opts.center) row.scrollIntoView({block: "center"});
    renderStep();
    if (matchMedia("(max-width: 760px)").matches && !(opts && opts.quiet)) cur.root.classList.add("rt-has-step");
    return true;
  }

  /* an execution by its trace id: the station it ran at */
  function selectId(id) {
    if (!cur) return false;
    for (const s of cur.L.stations.values()) {
      if (s.execs.some(e => e.id === id)) return select(s.key, {exec: id, center: true});
    }
    // a step under a station (an agent's tool call, an LLM call): the station
    const row = cur.byId.get(id);
    if (row) {
      const p = RunLine.rowPath(row);
      const at = [...cur.L.stations.keys()].filter(k => p === k || p.startsWith(k + ".")).pop();
      if (at) return select(at, {center: true});
    }
    return false;
  }

  function selectOp(op) {
    if (!cur) return false;
    const all = [...cur.L.stations.values()].filter(s => s.name === op || s.key === op);
    const s = all.find(x => x.ran) || all[0];
    return s ? select(s.key, {center: true}) : false;
  }

  function nextError() {
    if (!cur) return;
    const bad = cur.L.rows.map(r => r.key).filter(k => { const s = cur.L.stations.get(k); return s.failed || s.stopped; });
    if (!bad.length) { toast("No op failed in this run"); return; }
    const i = bad.indexOf(cur.sel);
    select(bad[(i + 1) % bad.length], {center: true});
  }

  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const keys = cur.L.rows.map(r => r.key);
    const i = keys.indexOf(cur.sel);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const j = i < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)));
      select(keys[j]);
    } else if (ev.key === "e") {
      ev.preventDefault();
      nextError();
    }
  }

  /* open or close a GraphOp on the line */
  function toggle(key) {
    const open = new Set(cur.L.open);
    if (open.has(key)) { for (const k of [...open]) if (k === key || k.startsWith(key + ".")) open.delete(k); }
    else open.add(key);
    cur.open = open;
    relayout();
  }

  function relayout() {
    cur.L = RunLine.layout(cur.graph, cur.tree.rows || [], {turn: cur.turn, errors: cur.tree.errors || [], open: cur.open || undefined});
    if (cur.sel && !cur.L.stations.has(cur.sel)) {
      // a closed GraphOp: its op's place is the GraphOp
      const up = [...cur.L.stations.keys()].filter(k => cur.sel.startsWith(k + ".")).pop();
      cur.sel = up || null;
    }
    const lg = cur.left.querySelector(".rl-legend");
    if (lg) lg.replaceWith(legend());
    draw();
    renderStep();
  }

  function backToSteps() {
    if (cur) cur.root.classList.remove("rt-has-step");
  }

  // ── the page ──

  async function show(run) {
    if (state.tab !== "traces") switchTab("traces", {quiet: true});
    const box = $("#traces");
    box.textContent = "";
    const mine = (state.tracesView = {});
    state.execPanelRun = null;
    state.execSel = null;
    let data, tree;
    try {
      [data, tree] = await Promise.all([
        api(`/api/p/${PID}/trace/${encodeURIComponent(run)}`), loadRunTree(run)]);
    } catch (e) { box.append(el("div", "note", e.message)); return; }
    if (state.tracesView !== mine) return;
    followRun(run, mine, tree, () => show(run));
    const prev = cur && cur.run === run ? cur : null;
    const graph = graphForRun(data);
    if (!graph) {
      cur = null;
      box.append(runHeader(run, tree, "workflow"));
      const workflowName = ((data.summary || tree.summary || {}).workflow) || "?";
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
      pushView();
      return;
    }
    const byId = new Map();
    const feeds = new Map();
    for (const r of tree.rows || []) {
      if (r.id) byId.set(r.id, r);
      for (const u of r.upstreams || []) {
        if (!feeds.has(u.from)) feeds.set(u.from, []);
        feeds.get(u.from).push({to: r, from_key: u.from_key, to_key: u.to_key});
      }
    }
    cur = {
      run, data, tree, graph, byId, feeds, execs: execsOf(tree.rows || []),
      total: Math.max(5, tree.total_ms || 0, ...(tree.rows || []).map(r => r.start_ms + (r.dur_ms || 0))),
      turn: prev ? prev.turn : null, open: prev ? prev.open : null,
      sel: prev ? prev.sel : null, exec: prev ? prev.exec : null,
    };
    cur.L = RunLine.layout(graph, tree.rows || [], {turn: cur.turn, errors: tree.errors || [], open: cur.open || undefined});

    const root = el("div", "rt rl");
    cur.root = root;
    root.append(runHeader(run, tree, "workflow"));
    if ((tree.turns || []).length) {
      root.append(RunView.timeline(tree.turns, tree.total_ms, (key) => { cur.turn = key; relayout(); }));
    }
    const split = el("div", "rt-split");
    const left = el("div", "rt-left");
    cur.left = left;
    const axis = el("div", "rl-axis");
    axis.append(el("span", null, `The flow, as this run went · ${graph.name}`), el("span", "rt-dur", "Took"),
      el("span", "rt-axisend", `0 — ${fmtMs(cur.total)}`));
    const list = el("div", "rt-list rl-list");
    list.tabIndex = 0;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "The flow's ops, in the order this run reached them");
    const rowsEl = el("div", "rl-rows");
    list.append(rowsEl);
    list.addEventListener("keydown", onKey);
    left.append(axis, list, legend());
    Object.assign(cur, {listEl: list, rowsEl});
    const grip = el("div", "rt-grip");
    grip.setAttribute("role", "separator");
    const step = el("aside", "rt-step");
    step.setAttribute("aria-label", "The selected op");
    cur.stepEl = step;
    split.append(left, grip, step);
    root.append(split);
    box.append(root);
    const w = recall("runStepW", null);
    if (w) split.style.setProperty("--rt-step-w", `${w}px`);
    grip.addEventListener("pointerdown", (ev) => {
      grip.setPointerCapture(ev.pointerId);
      const move = (e2) => {
        const r = split.getBoundingClientRect();
        split.style.setProperty("--rt-step-w", `${Math.min(r.width - 360, Math.max(320, r.right - e2.clientX))}px`);
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        store("runStepW", parseInt(getComputedStyle(split).getPropertyValue("--rt-step-w"), 10) || null);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, {once: true});
    });
    state._tlrun = run;
    // a desk opens on the first op that failed, else the first op; a phone on the line
    const first = cur.sel && cur.L.stations.has(cur.sel) ? cur.sel
      : (cur.L.rows.find(r => { const s = cur.L.stations.get(r.key); return s.failed || s.stopped; }) || cur.L.rows[0] || {}).key;
    if (first && !matchMedia("(max-width: 760px)").matches) select(first, {quiet: true, center: true, exec: cur.exec});
    else { cur.sel = null; draw(); renderStep(); }
    renderFlowInfo();
    pushView();
  }

  /* the view on screen, or null */
  const current = () => (cur && cur.root && cur.root.isConnected ? cur : null);

  return {show, select, selectId, selectOp, nextError, backToSteps, current};
})();
