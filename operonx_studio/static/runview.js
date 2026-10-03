/* operonx studio — one run: the answer first, then one question at a time.
 *
 * The header answers "was this run OK?" in one line (status, time, cost,
 * LLM calls, tokens, errors) and names the slowest and the most expensive
 * op. On the canvas, a lens picks the ONE thing the cards show — the path
 * taken, time, errors, cost or values — instead of all of them at once.
 * A timeline strip replaces the turn dropdown: turns are segments, and
 * clicking or dragging across them repaints the canvas for that moment.
 * Two runs can be compared op by op.
 *
 * Everything here renders from what /tree and /compare return; the
 * canvas itself stays in studio.js and reads `state.lens`.
 */

"use strict";

const RunView = (() => {
  const LENSES = [
    ["path", "Path", "Which ops ran — the rest fade"],
    ["time", "Time", "Each op's time in this run, the three slowest ranked"],
    ["errors", "Errors", "Only what failed, with its error"],
    ["cost", "Cost", "Only ops that cost money"],
    ["values", "Values", "The values each op produced"],
  ];

  function money(cost, unpriced) {
    if (cost == null) return unpriced ? "unpriced" : null;
    const txt = cost === 0 ? "$0" : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
    return unpriced ? `${txt} + ${unpriced} unpriced` : txt;
  }
  const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const ordinal = (n) => {
    const v = n % 100;
    return n + (["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th");
  };

  /* The header: title row, the verdict, the two highlights, the origin. */
  function header(run, data, mode, extras) {
    const s = data.summary || {};
    const head = el("div", "tlhead runhead");
    const top = el("div", "runhead-top");
    const back = Icons.button("back", "Runs", "small ghost", "Back to all runs");
    back.onclick = () => showTraces();
    top.append(back, el("span", "tltitle", run));
    const modes = el("span", "tlmodes");
    modes.setAttribute("role", "tablist");
    for (const [key, label, title, fn] of [["tree", "Tree", "The run as a tree: what ran for what, in order", showRunTree],
      ["workflow", "Workflow", "The flow with this run painted on it", showRunWorkflow]]) {
      const b = el("button", mode === key ? "on" : "", label);
      b.type = "button";
      b.title = title;
      b.onclick = () => fn(run);
      modes.append(b);
    }
    top.append(modes);
    for (const x of extras || []) top.append(x);
    head.append(top);

    const recs = execsOf(data.rows || []);
    const errs = s.errors != null ? s.errors : recs.filter(r => r.status === "error").length;
    const records = data.errors || [];
    // a run can fail with no failed execution: a structured LLM step that
    // returned `error`, a subgraph failing around its children
    const failed = !!errs || records.length > 0 || s.status === "error";
    const line = el("div", "verdict");
    const status = el("span", "status " + (failed ? "s-bad" : "s-ok"), failed ? "failed" : "ok");
    line.append(status);
    const bits = [fmtMs(s.duration_ms || data.total_ms || 0)];
    const cost = money(s.cost_usd, s.unpriced);
    if (cost) bits.push(cost);
    if (s.llm_calls) bits.push(`${s.llm_calls} LLM call${s.llm_calls > 1 ? "s" : ""}`);
    if (s.tokens_in || s.tokens_out) bits.push(`${compact((s.tokens_in || 0) + (s.tokens_out || 0))} tokens`);
    bits.push(`${recs.length} execution${recs.length === 1 ? "" : "s"}`);
    for (const b of bits) { line.append(el("span", "vsep", "·"), el("span", null, b)); }
    if (errs) {
      line.append(el("span", "vsep", "·"), el("span", "bad", `${errs} error${errs > 1 ? "s" : ""}`));
      const next = Icons.button("right", "Next error", "small danger", "Select the failed ops one by one");
      next.classList.add("verdict-next");
      next.onclick = () => (mode === "workflow" ? walkErrors() : nextTreeError());
      line.append(next);
    }
    head.append(line);
    if (records.length) head.append(errorList(records, mode));

    const rolls = data.rollups || [];
    const total = Math.max(1, s.duration_ms || data.total_ms || 1);
    // an op that spans the whole session (a heartbeat, the audio source)
    // is not "slow": its wall time is the call's length, not latency
    const slow = rolls.find(r => !background(r, total));
    const dear = rolls.filter(r => r.cost_usd).sort((a, b) => b.cost_usd - a.cost_usd)[0];
    if (slow || dear) {
      const hl = el("div", "highlights");
      if (slow) {
        hl.append("Slowest: ");
        hl.append(opLink(slow.op));
        hl.append(` ${fmtMs(slow.total_ms)} (${Math.round(100 * slow.total_ms / total)}%)`);
      }
      if (dear) {
        if (slow) hl.append(el("span", "vsep", "·"));
        hl.append("Most expensive: ");
        hl.append(opLink(dear.op));
        hl.append(` ${money(dear.cost_usd, 0)}`);
      }
      head.append(hl);
    }
    const origin = originLine(s);
    if (origin) head.append(origin);
    return head;
  }

  /* What failed, one line per op: its type, the op (a link to the
   * execution that failed first), how many times, the last line of the
   * error; the traceback — the user's frames only — folds under it. */
  function errorList(records, mode) {
    const box = el("div", "errlist");
    box.setAttribute("aria-label", "Errors");
    for (const e of records) {
      const item = el("details", "erritem");
      const sum = el("summary");
      sum.append(el("span", "errtype mono", e.type || "Error"));
      const go = el("button", "linkbtn mono", e.name || e.op);
      go.type = "button";
      go.title = e.op_id ? `Open the execution that failed first (${e.first_ctx})` : `Select ${e.op}`;
      go.onclick = (ev) => { ev.preventDefault(); focusExec(e, mode); };
      sum.append(go);
      if (e.count > 1) {
        const n = el("span", "errcount", `×${e.count}`);
        n.title = `${e.op} failed ${e.count} times in this run`;
        sum.append(n);
      }
      sum.append(el("span", "errlast mono", errorLine(e.message, e.type)));
      item.append(sum);
      const pre = el("pre", "errtrace mono", String(e.message || "").trim());
      item.append(pre);
      box.append(item);
    }
    return box;
  }

  /* The exception's own line, without its type (shown beside it): the
   * last line that is not indented — an exception whose message spans
   * lines (operonx's PromptError) indents the rest under it. */
  function errorLine(message, type) {
    const lines = String(message || "").trim().split("\n").filter(l => l.trim() && !/^\s/.test(l));
    const last = lines.length ? lines[lines.length - 1] : "";
    const prefix = new RegExp(`^(?:[\\w.]*\\.)?${String(type || "").replace(/\W/g, "")}: `);
    return type ? last.replace(prefix, "") : last;
  }

  /* an error's execution: its tree row by trace id, else its op */
  function focusExec(e, mode) {
    if (mode !== "workflow" && e.op_id) {
      const row = [...document.querySelectorAll("#traces .rrow.record")].find(r => r.dataset.id === e.op_id);
      if (row) { row.scrollIntoView({block: "center", behavior: "smooth"}); row.click(); return; }
    }
    focusOp(e.name || e.op);
  }

  function opLink(op) {
    const b = el("button", "linkbtn mono", op);
    b.type = "button";
    b.title = "Select it";
    b.onclick = () => focusOp(op);
    return b;
  }

  /* select an op wherever the run is showing — a tree row, or a card */
  function focusOp(op) {
    if (state.workflowOn) {
      let found = [...state.rendered.values()].find(x => x.node.name === op);
      if (!found) { expandAll(true); found = [...state.rendered.values()].find(x => x.node.name === op); }
      if (found) { select(found.key); centerOn(found); }
      return;
    }
    const rows = [...document.querySelectorAll("#traces .rrow.record")];
    const row = rows.find(r => r.dataset.op === op);
    if (row) { row.scrollIntoView({block: "center", behavior: "smooth"}); row.click(); }
  }

  let treeErr = -1;
  function nextTreeError() {
    const rows = [...document.querySelectorAll("#traces .rrow.record.err")];
    if (!rows.length) return;
    treeErr = (treeErr + 1) % rows.length;
    rows[treeErr].scrollIntoView({block: "center", behavior: "smooth"});
    rows[treeErr].click();
  }

  /* A session-long op: one or two executions spanning most of the run —
   * a heartbeat, a stream source. Its time is the session's, not work. */
  function background(roll, totalMs) {
    return !!roll && roll.count <= 2 && totalMs > 0 && roll.total_ms >= 0.8 * totalMs;
  }

  /* The lens control: which one thing the cards show. */
  function lensBar() {
    const bar = el("span", "tlmodes lensbar");
    bar.setAttribute("role", "radiogroup");
    bar.setAttribute("aria-label", "What the cards show");
    const current = state.lens || "path";
    for (const [key, label, title] of LENSES) {
      const b = el("button", key === current ? "on" : "", label);
      b.type = "button";
      b.title = title;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(key === current));
      b.onclick = () => {
        state.lens = key;
        store("lens", key);
        for (const x of bar.children) {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-checked", String(x === b));
        }
        render();
        // errors and cost point at a few ops: bring the first into view
        if (key === "errors" || key === "cost") {
          const card = document.querySelector(key === "errors" ? "#nodes .node.errorlit" : "#nodes .node .badge.cost");
          const name = card && (card.closest(".node") || card).dataset.name;
          const it = name && [...state.rendered.values()].find(x => x.node.name === name);
          if (it) centerOn(it);
        }
      };
      bar.append(b);
    }
    return bar;
  }

  /* The timeline strip: the run's turns as segments on one time axis.
   * Click or drag across it to paint that turn; the reset shows the
   * whole run. */
  function timeline(turns, totalMs, onPick) {
    const wrap = el("div", "tlstrip");
    if (!turns || !turns.length) { wrap.hidden = true; return wrap; }
    const whole = el("button", "tlwhole on", "Whole run");
    whole.type = "button";
    const track = el("div", "tltrack");
    track.setAttribute("role", "listbox");
    track.setAttribute("aria-label", "Turns");
    const total = Math.max(1, totalMs);
    const segs = [];
    const pick = (key) => {
      whole.classList.toggle("on", !key);
      for (const s of segs) s.classList.toggle("on", s.dataset.key === key);
      onPick(key || null);
    };
    turns.forEach((t, i) => {
      const seg = el("div", "tlseg");
      seg.dataset.key = t.key;
      seg.style.left = `${(100 * t.start_ms / total).toFixed(3)}%`;
      seg.style.width = `${Math.max(0.6, 100 * (t.end_ms - t.start_ms) / total).toFixed(3)}%`;
      seg.title = `${t.label} · ${fmtMs(t.end_ms - t.start_ms)} · ${t.count} executions`;
      seg.setAttribute("role", "option");
      if (i % 2) seg.classList.add("alt");
      segs.push(seg);
      track.append(seg);
    });
    // click or drag: the segment under the pointer is the turn painted
    let down = false;
    const at = (ev) => {
      const x = ev.clientX;
      const hit = segs.find(s => { const r = s.getBoundingClientRect(); return x >= r.left && x <= r.right; });
      if (hit && !hit.classList.contains("on")) pick(hit.dataset.key);
    };
    track.addEventListener("pointerdown", (ev) => { down = true; track.setPointerCapture(ev.pointerId); at(ev); });
    track.addEventListener("pointermove", (ev) => { if (down) at(ev); });
    track.addEventListener("pointerup", () => { down = false; });
    whole.onclick = () => pick(null);
    const label = el("span", "tllabel", `${turns.length} turn${turns.length > 1 ? "s" : ""}`);
    const axis = el("div", "tlaxis");
    axis.append(el("span", null, "0"), el("span", null, fmtMs(total)));
    const body = el("div", "tlbody");
    body.append(track, axis);
    wrap.append(label, whole, body);
    return wrap;
  }

  /* What stands out about one execution among its op's executions. */
  function anomalies(e, mine) {
    const flags = [];
    if (e.status === "error") flags.push(["bad", "Failed"]);
    const durs = mine.map(x => x.dur_ms || 0).sort((a, b) => a - b);
    const median = durs.length ? durs[Math.floor((durs.length - 1) / 2)] : 0;
    if (mine.length >= 3 && median > 0 && (e.dur_ms || 0) > 3 * median)
      flags.push(["warn", `${((e.dur_ms || 0) / median).toFixed(1)}× slower than this op's median`]);
    const outs = e.outputs || {};
    const textKeys = Object.keys(outs).filter(k => typeof outs[k] === "string");
    for (const k of textKeys) {
      if (outs[k] !== "") continue;
      const usually = mine.filter(x => x !== e && x.outputs && typeof x.outputs[k] === "string" && x.outputs[k] !== "").length;
      if (usually > mine.length / 2) flags.push(["warn", `Empty ${k} — usually has text`]);
    }
    if (outs.model_used && outs.model_requested && outs.model_used !== outs.model_requested)
      flags.push(["warn", `Fell back to ${outs.model_used}`]);
    return flags;
  }

  function rank(e, mine) {
    if (mine.length < 2) return null;
    const sorted = [...mine].sort((a, b) => (b.dur_ms || 0) - (a.dur_ms || 0));
    const i = sorted.indexOf(e) + 1;
    return i === 1 ? `the slowest of ${mine.length}` : `${ordinal(i)} slowest of ${mine.length}`;
  }

  /* The op's other executions as dots on one duration axis. */
  function dots(e, mine, onPick) {
    const box = el("div", "rundots");
    const max = Math.max(1, ...mine.map(x => x.dur_ms || 0));
    for (const x of mine.slice(0, 400)) {
      const d = el("button", "rundot" + (x === e ? " on" : "") + (x.status === "error" ? " bad" : ""));
      d.type = "button";
      d.style.left = `${(100 * (x.dur_ms || 0) / max).toFixed(2)}%`;
      d.title = `${fmtMs(x.dur_ms || 0)} · +${fmtMs(x.start_ms)}${x.ctx ? " · " + x.ctx : ""}`;
      d.setAttribute("aria-label", d.title);
      d.onclick = () => onPick(x);
      box.append(d);
    }
    const axis = el("div", "tlaxis");
    axis.append(el("span", null, "0"), el("span", null, fmtMs(max)));
    const wrap = el("div");
    wrap.append(box, axis);
    return wrap;
  }

  /* Two runs, op by op. */
  async function compare(a, b) {
    leaveWorkflow();
    const box = $("#traces");
    box.textContent = "";
    state.tracesView = {};
    const mine = state.tracesView;
    box.append(el("div", "note", "Comparing…"));
    let data;
    try { data = await api(`/api/p/${PID}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); }
    catch (e) { box.textContent = ""; box.append(el("div", "errbox", e.message)); return; }
    if (state.tracesView !== mine) return;
    box.textContent = "";
    const top = el("div", "runhead-top");
    const back = Icons.button("back", "Runs", "small ghost", "Back to all runs");
    back.onclick = () => showTraces();
    top.append(back, el("h2", "cmptitle", "Compare runs"));
    box.append(top);

    const cards = el("div", "cmpcards");
    for (const [label, s] of [["A", data.a], ["B", data.b]]) {
      const c = el("div", "cmpcard");
      const h = el("div", "cmpcardhead");
      h.append(el("span", "cmpbadge", label));
      const open = el("button", "linkbtn mono", s.trace_id);
      open.type = "button";
      open.onclick = () => showRunTree(s.trace_id);
      h.append(open);
      c.append(h);
      const facts = [fmtMs(s.duration_ms || 0), s.status === "error" ? "failed" : "ok"];
      const cost = money(s.cost_usd, s.unpriced);
      if (cost) facts.push(cost);
      if (s.version) facts.push(`@${String(s.version).slice(0, 7)}${s.version_dirty ? "*" : ""}`);
      if (s.started_at) facts.push(fmtWhen(s.started_at * 1000));
      c.append(el("div", "cmpfacts", facts.join(" · ")));
      cards.append(c);
    }
    box.append(cards);
    const d = data.d_ms || 0;
    box.append(el("p", "cmpsum", d === 0 ? "Same total time."
      : `B took ${fmtMs(Math.abs(d))} ${d > 0 ? "longer" : "less"} than A${data.a.duration_ms ? ` (${d > 0 ? "+" : "−"}${Math.round(100 * Math.abs(d) / data.a.duration_ms)}%)` : ""}.`));

    const wrap = el("div", "tablewrap");
    const table = el("table", "datatable cmptable");
    const hr = el("tr");
    for (const [h, cls] of [["Op"], ["A", "num"], ["B", "num"], ["Change", "num"], ["Cost A", "num hide-sm"], ["Cost B", "num hide-sm"]])
      hr.append(el("th", cls || null, h));
    const thead = el("thead"); thead.append(hr); table.append(thead);
    const tbody = el("tbody");
    for (const r of data.ops) {
      const tr = el("tr");
      tr.append(el("td", "mono", r.op));
      const side = (x) => el("td", "num" + (x ? "" : " dim"), x ? `${fmtMs(x.total_ms)}${x.count > 1 ? ` ×${x.count}` : ""}` : "did not run");
      tr.append(side(r.a), side(r.b));
      const delta = el("td", "num");
      if (r.d_ms != null) {
        const pct = r.a.total_ms ? r.d_ms / r.a.total_ms : 0;
        delta.textContent = Math.abs(r.d_ms) < 0.05 ? "—" : `${r.d_ms > 0 ? "+" : "−"}${fmtMs(Math.abs(r.d_ms))}`;
        // colour only a change that matters: 20% of the op AND 5 ms
        if (Math.abs(pct) >= 0.2 && Math.abs(r.d_ms) >= 5) delta.classList.add(r.d_ms > 0 ? "worse" : "better");
      } else {
        delta.textContent = r.a ? "only in A" : "only in B";
        delta.classList.add("dim");
      }
      tr.append(delta);
      tr.append(el("td", "num hide-sm", r.a ? money(r.a.cost_usd, r.a.unpriced) || "—" : ""));
      tr.append(el("td", "num hide-sm", r.b ? money(r.b.cost_usd, r.b.unpriced) || "—" : ""));
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    box.append(wrap);
  }

  function render() {
    if (state.workflowOn) { window.render(); }
  }

  state.lens = recall("lens", "path");
  return {header, lensBar, timeline, anomalies, rank, dots, compare, money, focusOp, background, LENSES};
})();
