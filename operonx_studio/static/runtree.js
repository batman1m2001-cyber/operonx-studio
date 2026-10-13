/* operonx studio — one run, read like a document (docs/STUDIO_EXPERIENCE_PLAN.md §3).
 *
 *   the header     was it OK, how long, what it cost; what it was asked
 *                  and what it answered (the run's input and output)
 *   the turns      a conversation's exchanges, one chip each
 *   the steps      every execution, as the ctx tree or as a timeline, on
 *                  one time axis; search, errors only, key ops only
 *   the step       the selected execution beside the steps: its output,
 *                  its input, what fed it and what it fed
 *   conversation   a run that reads as one (a user's side and the bot's,
 *                  by review.py's rule: any product with doors, a
 *                  transcript, a playground script) is offered as lines
 *                  too; a line opens the step that produced it
 *
 * The steps are drawn as a window over the rows that are open (a long call
 * is thousands of rows), so a row is found by its id, never by the DOM.
 * The address names the step (router.js), so a link opens it selected.
 */

const RunTree = (() => {
  const ROW_H = 30;                 // a step row's height, in px (studio.css .rt-row)
  let cur = null;                   // the run on screen: {run, data, rows, ...}

  // ── the rows: tree order, what is open, what the filters keep ──

  function index(data) {
    const rows = data.rows || [];
    const byId = new Map();
    rows.forEach((r, i) => { r._i = i; if (r.id) byId.set(r.id, r); });
    // the steps each step fed, from the other side of their upstreams
    const feeds = new Map();
    for (const r of rows) {
      for (const u of r.upstreams || []) {
        if (!feeds.has(u.from)) feeds.set(u.from, []);
        feeds.get(u.from).push({to: r, from_key: u.from_key, to_key: u.to_key});
      }
    }
    return {rows, byId, feeds};
  }

  /* The rows to draw: in tree order with the folded ones hidden, or every
   * execution in start order (the timeline); a filter keeps its matches and
   * the rows above them, so a match is never out of context. */
  function visible() {
    const {rows} = cur;
    const f = cur.filter;
    const q = f.q.trim().toLowerCase();
    const keyOps = cur.keyOps;
    const active = q || f.errors || f.key;
    let keep = null;
    if (active) {
      keep = new Set();
      const byIdx = cur.parentIdx;
      for (const r of rows) {
        let hit = true;
        if (q) hit = (`${r.name} ${r.op || ""} ${r._preview || ""} ${r.error || ""}`).toLowerCase().includes(q);
        if (hit && f.errors) hit = r.status === "error";
        if (hit && f.key) hit = !!r.op && keyOps.has(r.op);
        if (!hit) continue;
        for (let i = r._i; i != null && !keep.has(i); i = byIdx[i]) keep.add(i);
      }
    }
    if (cur.mode === "timeline") {
      return rows.filter(r => r.kind === "record" && (!keep || keep.has(r._i)))
        .slice().sort((a, b) => a.start_ms - b.start_ms);
    }
    const out = [];
    let skipBelow = Infinity;
    for (const r of rows) {
      if (r.depth > skipBelow) continue;
      skipBelow = Infinity;
      if (keep && !keep.has(r._i)) continue;
      out.push(r);
      // a filter shows its matches open; otherwise a folded row hides its subtree
      if (!active && r.kids && cur.folded.has(r._i)) skipBelow = r.depth;
    }
    return out;
  }

  // ── a row ──

  function preview(r) {
    if (r._preview !== undefined) return r._preview;
    let text = "";
    if (r.kind === "record") {
      if (r.error) text = String(r.error).trim().split("\n").pop();
      else {
        const node = r.op && !r.child ? irNodeByName(r.op) : null;
        // words first: a value that is a record's shape ({…}, […]) only
        // when the step produced nothing else
        const vals = execValues(node, r.outputs, 60);
        const words = vals.filter(([, v]) => !/^[{[]/.test(v));
        text = (words.length ? words : vals).map(([k, v]) => `${k} ${v}`).join(" · ");
      }
    } else if (r.kind === "stand-in") {
      text = "an item of a stream that records none of its own";
    }
    r._preview = text;
    return text;
  }

  function iconOf(r) {
    const node = r.op && !r.child ? irNodeByName(r.op) : null;
    const sv = r.child ? AgentSteps.visual(r.op_type) : null;
    const ico = el("span", "rt-ico", node ? kindIcon(node) : sv ? sv.icon : (r.kind === "container" ? "▣" : "≋"));
    if (node || sv) ico.style.setProperty("--kind", node ? kindColor(node) : sv.color);
    if (sv) ico.title = sv.label;
    return ico;
  }

  function drawRow(r) {
    const timeline = cur.mode === "timeline";
    const row = el("div", "rt-row" + (r.kind !== "record" ? " rt-" + r.kind : "")
      + (r.status === "error" ? " err" : "") + (cur.sel === r ? " sel" : ""));
    row.setAttribute("role", "treeitem");
    row.dataset.i = String(r._i);
    if (!timeline && r.kids) row.setAttribute("aria-expanded", String(!cur.folded.has(r._i)));
    // one guide line per level above it, so what ran for what reads down the page
    if (!timeline && r.depth > 0) row.style.setProperty("--d", String(r.depth));
    const name = el("div", "rt-name");
    name.style.paddingLeft = `${(timeline ? 0 : r.depth) * 14 + 6}px`;
    let tog;
    if (!timeline && r.kids) {
      tog = el("button", "rt-tog", cur.folded.has(r._i) ? "▸" : "▾");
      tog.type = "button";
      tog.tabIndex = -1;
      tog.setAttribute("aria-label", cur.folded.has(r._i) ? `Open ${r.name}` : `Fold ${r.name}`);
      tog.onclick = (ev) => { ev.stopPropagation(); fold(r); };
    } else {
      tog = el("span", "rt-tog");   // keeps the column; nothing to fold
    }
    const ico = iconOf(r);
    name.append(tog, ico, el("span", "rt-n", r.name));
    if (r.op && cur.keyOps.has(r.op)) {
      const k = el("span", "rt-key", "key");
      k.title = "A key op of this service: a latency the caller feels";
      name.append(k);
    }
    if (r.status === "error") name.append(el("span", "rt-errtag", "failed"));
    const pv = preview(r);
    if (pv) name.append(el("span", "rt-pv" + (r.error ? " bad" : ""), pv));
    row.append(name);
    row.append(el("div", "rt-dur", r.kind === "stand-in" && !r.dur_ms ? "" : fmtMs(r.dur_ms || 0)));
    const track = el("div", "rt-track");
    const bar = el("b");
    // the bar wears its op's kind colour: a speech step and an LLM step tell apart on the axis
    const kind = ico.style.getPropertyValue("--kind");
    if (kind) bar.style.setProperty("--kind", kind);
    bar.style.left = `${(r.start_ms / cur.total * 100).toFixed(3)}%`;
    bar.style.width = `${Math.max(0.3, (r.dur_ms || 0) / cur.total * 100).toFixed(3)}%`;
    track.append(bar);
    row.append(track);
    row.title = `${r.ctx || ""}${r.wall_start ? " · " + new Date(r.wall_start * 1000).toLocaleTimeString([], {hour12: false}) : ""}`;
    row.onclick = () => select(r);
    return row;
  }

  // ── the window over the rows ──

  function paint() {
    if (!cur || cur.mode === "conversation") return;
    const list = cur.listEl;
    const vis = cur.vis;
    cur.spacer.style.height = `${vis.length * ROW_H}px`;
    const top = list.scrollTop, h = list.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 8);
    const last = Math.min(vis.length, Math.ceil((top + h) / ROW_H) + 8);
    const frag = document.createDocumentFragment();
    for (let k = first; k < last; k++) {
      const row = drawRow(vis[k]);
      row.style.transform = `translateY(${k * ROW_H}px)`;
      frag.append(row);
    }
    cur.rowsEl.textContent = "";
    cur.rowsEl.append(frag);
  }

  function relist() {
    cur.root.classList.toggle("rt-conv-on", cur.mode === "conversation");
    if (cur.mode === "conversation") return drawConversation();
    if (cur.convEl) { cur.convEl.remove(); cur.convEl = null; }
    cur.spacer.hidden = false;
    cur.vis = visible();
    const shown = cur.vis.reduce((n, r) => n + (r.kind === "record" ? 1 : 0), 0);
    cur.count.textContent = shown === cur.records ? `${cur.records} steps` : `${shown} of ${cur.records} steps`;
    paint();
  }

  function fold(r, open) {
    const isFolded = cur.folded.has(r._i);
    if (open === undefined) open = isFolded;
    if (open) cur.folded.delete(r._i); else cur.folded.add(r._i);
    relist();
  }

  function scrollTo(r) {
    const k = cur.vis.indexOf(r);
    if (k < 0) return;
    const list = cur.listEl, y = k * ROW_H;
    if (y < list.scrollTop || y + ROW_H > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, y - list.clientHeight / 2);
    }
  }

  /* Make *r* reachable: open the rows above it and clear a filter that hides it. */
  function reveal(r) {
    for (let i = cur.parentIdx[r._i]; i != null; i = cur.parentIdx[i]) cur.folded.delete(i);
    cur.vis = visible();
    if (!cur.vis.includes(r)) {
      cur.filter = {q: "", errors: false, key: false};
      syncToolbar();
      cur.vis = visible();
    }
  }

  // ── selection: the step panel ──

  function select(r, opts) {
    if (!cur || !r) return;
    cur.sel = r;
    markLine();
    reveal(r);
    paint();
    scrollTo(r);
    cur.root.classList.add("rt-has-step");
    if (r.kind === "record" || r.step) {
      // a subgraph with its own record opens like a step: its inputs and outputs
      renderExecPanel(cur.run, r, cur.execs, cur.stepEl);
    } else {
      cur.stepEl.textContent = "";
      cur.stepEl.append(el("h3", "rt-step-title", r.name),
        el("div", "note", r.kind === "container"
          ? "A subgraph: the steps under it are its ops. Runs recorded before operonx 1.22.3 kept no values for the subgraph itself."
          : "An item of a stream that records nothing per item (a transient op): the steps under it ran for it."));
    }
    if (!(opts && opts.quiet) && cur.mode !== "conversation") cur.listEl.focus({preventScroll: true});
  }

  /* Select by execution id (a link, an eval's blamed op, the address). */
  function selectId(id) {
    if (!cur) return false;
    const r = cur.byId.get(id);
    if (r) select(r, {quiet: true});
    return !!r;
  }

  /* Select an op's slowest execution (a header's key-op or slowest link). */
  function selectOp(op) {
    if (!cur) return false;
    let best = null;
    for (const r of cur.rows) if (r.kind === "record" && r.op === op && (!best || r.dur_ms > best.dur_ms)) best = r;
    if (best) select(best);
    return !!best;
  }

  function nextError() {
    if (!cur) return;
    const errs = cur.rows.filter(r => r.kind === "record" && r.status === "error");
    if (!errs.length) return;
    const at = cur.sel ? errs.findIndex(r => r._i > cur.sel._i) : 0;
    select(errs[at < 0 ? 0 : at]);
  }

  function onKey(ev) {
    if (!cur || ev.target.closest("input, textarea")) return;
    if (cur.mode === "conversation") {
      if (ev.key === "/") { cur.search.focus(); ev.preventDefault(); }
      return;
    }
    const vis = cur.vis;
    const k = cur.sel ? vis.indexOf(cur.sel) : -1;
    if (ev.key === "ArrowDown" || ev.key === "j") { select(vis[Math.min(vis.length - 1, k + 1)]); }
    else if (ev.key === "ArrowUp" || ev.key === "k") { select(vis[Math.max(0, k - 1)]); }
    else if (ev.key === "ArrowRight" && cur.sel && cur.sel.kids) { fold(cur.sel, true); }
    else if (ev.key === "ArrowLeft" && cur.sel) {
      if (cur.sel.kids && !cur.folded.has(cur.sel._i)) fold(cur.sel, false);
      else if (cur.parentIdx[cur.sel._i] != null) select(cur.rows[cur.parentIdx[cur.sel._i]]);
    }
    else if (ev.key === "e") { nextError(); }
    else if (ev.key === "/") { cur.search.focus(); }
    else return;
    ev.preventDefault();
  }

  // ── the header: the run's input and output ──

  function valueCard(label, text) {
    const card = el("section", "rt-io");
    card.append(el("div", "rt-io-h", label));
    const body = el("div", "rt-io-b");
    let value = text;
    try { value = JSON.parse(text); } catch { /* a cut preview: shown as text */ }
    body.append(traceValue(value));
    card.append(body);
    // a long value folds; one click opens it
    requestAnimationFrame(() => {
      if (body.scrollHeight > body.clientHeight + 4) {
        const more = el("button", "linkbtn rt-io-more", "Show all");
        more.type = "button";
        more.onclick = () => { card.classList.toggle("open"); more.textContent = card.classList.contains("open") ? "Show less" : "Show all"; };
        card.append(more);
      }
    });
    return card;
  }

  function ioCards(s) {
    if (!s || (!s.input && !s.output)) return null;
    const box = el("div", "rt-iorow");
    if (s.input) box.append(valueCard("Input", s.input));
    if (s.output) box.append(valueCard("Output", s.output));
    return box;
  }

  // ── the turns: a conversation's exchanges ──

  function turnStrip() {
    const turns = cur.data.turns || [];
    // a conversation has tens of turns; thousands of items are a batch
    if (turns.length < 2 || turns.length > 60) return null;
    // each turn's steps, in one pass over the rows
    const byTurn = new Map(turns.map(t => [t.key, []]));
    // (by prefix: a segment can hold a dot, a loop's `g.loop#3`)
    for (const r of cur.rows) {
      if (r.kind !== "record" || !r.ctx) continue;
      const c = String(r.ctx);
      const t = turns.find(x => c === x.key || c.startsWith(x.key + "."));
      if (t) byTurn.get(t.key).push(r);
    }
    const strip = el("div", "rt-turns");
    strip.setAttribute("aria-label", "Turns");
    for (const t of turns) {
      const under = byTurn.get(t.key) || [];
      // what the turn was about: the first show-key values its steps produced
      const said = [];
      for (const r of under) {
        const node = r.op && !r.child ? irNodeByName(r.op) : null;
        if (!node || !(node.show_keys || []).length || r.error) continue;
        for (const [, v] of execValues(node, r.outputs, 70)) {
          // words, not a record's shape: a dict or a list says nothing here
          if (!v || v === '""' || v === "null" || /^[{[]/.test(v) || said.includes(v)) continue;
          said.push(v);
        }
        if (said.length >= 2) break;
      }
      const chip = el("button", "rt-turn" + (under.some(r => r.status === "error") ? " err" : ""));
      chip.type = "button";
      chip.append(el("span", "rt-turn-n", t.label), el("span", "rt-turn-t", fmtMs(t.end_ms - t.start_ms)));
      if (said.length) chip.append(el("span", "rt-turn-s", said.join(" → ")));
      chip.onclick = () => {
        const first = cur.rows.find(r => r.ctx === t.key || String(r.ctx || "").startsWith(t.key + "."));
        if (first) select(first);
      };
      strip.append(chip);
    }
    return strip;
  }

  // ── the conversation: the run as what was said ──

  /* Both sides present: a user line and a bot line (a batch job has
   * neither; an op's lone text answer is not a conversation). */
  const isConversation = (turns) => turns.some(t => t.who === "user") && turns.some(t => t.who === "bot");

  async function loadConversation(mine) {
    let got;
    try { got = await api(`/api/p/${PID}/review/run/${encodeURIComponent(cur.run)}`); } catch { return; }
    if (cur !== mine || !isConversation(got.turns || [])) return;
    cur.turns = got.turns;
    const b = el("button", null, "Conversation");
    b.type = "button"; b.dataset.mode = "conversation";
    b.title = "What was said, in order — a line opens the step that produced it";
    b.onclick = () => { cur.mode = "conversation"; store("runTreeMode", "conversation"); syncToolbar(); relist(); };
    cur.modeBtns.unshift(b);
    cur.modesEl.prepend(b);
    if (cur.wantConversation) { cur.mode = "conversation"; syncToolbar(); relist(); }
  }

  // a conversation's times read in seconds past one
  const fmtSpan = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
  const sinceStart = (at) => {
    const t0 = (cur.data.summary || {}).started_at;
    return at && t0 ? `+${fmtSpan(Math.max(0, (at - t0) * 1000))}` : "";
  };

  function drawConversation() {
    cur.spacer.hidden = true;
    if (!cur.convEl) {
      cur.convEl = el("div", "rt-conv");
      cur.convEl.setAttribute("role", "list");
      cur.listEl.append(cur.convEl);
    }
    const box = cur.convEl;
    box.textContent = "";
    const q = cur.filter.q.trim().toLowerCase();
    let shown = 0, heardAt = null;
    for (const t of cur.turns) {
      const ops = t.ops || [t.op];
      if (t.who === "user") heardAt = t.at;
      if (q && !(`${t.text} ${ops.join(" ")}`).toLowerCase().includes(q)) continue;
      shown++;
      const line = el("div", `rt-line ${t.who === "user" ? "me" : "bot"}`);
      line.setAttribute("role", "listitem");
      const bubble = el("button", `chat-msg ${t.who === "user" ? "from-me" : "from-bot"}`);
      bubble.type = "button";
      bubble.title = "Open the step that produced it";
      bubble.append(el("span", "rt-line-t", t.text));
      const meta = el("span", "rt-line-m");
      const bits = [ops.join(" · ")];
      const at = sinceStart(t.at);
      if (at) bits.push(at);
      // a bot line after the user's: the time since they were heard
      if (t.who === "bot" && heardAt != null && t.at != null) {
        bits.push(`${fmtSpan(Math.max(0, (t.at - heardAt) * 1000))} after the user`);
        heardAt = null;
      }
      meta.textContent = bits.join("  ·  ");
      bubble.append(meta);
      bubble.onclick = () => {
        const ok = t.step && selectId(t.step);
        if (!ok) selectOp(t.op);
        cur.lineSel = t;
        markLine();
      };
      t._el = bubble;
      line.append(bubble);
      box.append(line);
    }
    if (!shown) box.append(el("div", "note", "No line matches."));
    cur.count.textContent = shown === cur.turns.length ? `${cur.turns.length} lines` : `${shown} of ${cur.turns.length} lines`;
    markLine();
  }

  /* The line of the selected step, marked (from a click on either side). */
  function markLine() {
    if (!cur || !cur.turns) return;
    const sel = cur.sel;
    for (const t of cur.turns) {
      if (!t._el) continue;
      const on = (cur.lineSel === t) || (!!sel && !!t.step && t.step === sel.id && cur.lineSel == null);
      t._el.classList.toggle("on", on);
    }
    cur.lineSel = null;
  }

  // ── the toolbar ──

  function syncToolbar() {
    cur.search.value = cur.filter.q;
    cur.search.placeholder = cur.mode === "conversation" ? "Find a line  ( / )" : "Find a step, a value, an error  ( / )";
    cur.errBtn.classList.toggle("on", cur.filter.errors);
    cur.keyBtn.classList.toggle("on", cur.filter.key);
    for (const b of cur.modeBtns) b.classList.toggle("on", b.dataset.mode === cur.mode);
  }

  function toolbar() {
    const bar = el("div", "rt-tools");
    const modes = el("span", "seg");
    cur.modesEl = modes;
    cur.modeBtns = [];
    for (const [m, label, title] of [["tree", "Tree", "What ran for what, in order"], ["timeline", "Timeline", "Every step by when it started"]]) {
      const b = el("button", null, label);
      b.type = "button"; b.dataset.mode = m; b.title = title;
      b.onclick = () => { cur.mode = m; store("runTreeMode", m); syncToolbar(); relist(); };
      cur.modeBtns.push(b);
      modes.append(b);
    }
    const search = el("input", "rt-search");
    search.type = "search";
    search.placeholder = "Find a step, a value, an error  ( / )";
    search.setAttribute("aria-label", "Find a step");
    let t = 0;
    search.oninput = () => { clearTimeout(t); t = setTimeout(() => { cur.filter.q = search.value; relist(); }, 120); };
    // (in the conversation, the search finds lines; the other filters are the steps')
    cur.search = search;
    const errs = cur.rows.filter(r => r.status === "error").length;
    const errBtn = el("button", "chipbtn", `Errors${errs ? ` ${errs}` : ""}`);
    errBtn.type = "button";
    errBtn.disabled = !errs;
    errBtn.title = errs ? "Only the steps that failed (e: the next one)" : "Nothing failed";
    errBtn.onclick = () => { cur.filter.errors = !cur.filter.errors; syncToolbar(); relist(); };
    cur.errBtn = errBtn;
    const keyBtn = el("button", "chipbtn", "Key ops");
    keyBtn.type = "button";
    keyBtn.hidden = !cur.keyOps.size;
    keyBtn.title = `Only this service's key ops: ${[...cur.keyOps].join(", ")}`;
    keyBtn.onclick = () => { cur.filter.key = !cur.filter.key; syncToolbar(); relist(); };
    cur.keyBtn = keyBtn;
    const foldAll = Icons.button("collapse", undefined, "small ghost", "Fold every step");
    foldAll.onclick = () => { for (const r of cur.rows) if (r.kids && r.depth >= 0) cur.folded.add(r._i); relist(); };
    const openAll = Icons.button("expand", undefined, "small ghost", "Open every step");
    openAll.onclick = () => { cur.folded.clear(); relist(); };
    const count = el("span", "rt-count");
    cur.count = count;
    bar.append(modes, search, errBtn, keyBtn, el("span", "spacer"), count, foldAll, openAll);
    return bar;
  }

  // ── the page ──

  async function show(run) {
    leaveWorkflow();
    const box = $("#traces");
    box.textContent = "";
    const mine = (state.tracesView = {});
    state.execPanelRun = null;
    state.execSel = null;
    let data;
    try { data = await loadRunTree(run); } catch (e) { box.append(el("div", "note", e.message)); return; }
    if (state.tracesView !== mine) return;
    state.runSummary = data.summary || null;
    followRun(run, mine, data, () => show(run));
    const {rows, byId, feeds} = index(data);
    const parentIdx = rows.map(r => (r.parent && byId.has(r.parent) ? byId.get(r.parent)._i : null));
    const svc = (state.ir && (state.ir.services || []).find(s => s.name === (data.summary || {}).service)) || null;
    const prev = cur && cur.run === run ? cur : null;
    cur = {
      run, data, rows, byId, feeds, parentIdx, total: Math.max(1, data.total_ms || 1),
      execs: execsOf(rows), records: rows.filter(r => r.kind === "record").length,
      keyOps: new Set((svc && svc.key_ops) || []),
      // the conversation is offered once its lines arrive (loadConversation)
      mode: recall("runTreeMode", "tree") === "conversation" ? "tree" : recall("runTreeMode", "tree"),
      wantConversation: recall("runTreeMode", "tree") === "conversation",
      turns: null, convEl: null, lineSel: null,
      filter: prev ? prev.filter : {q: "", errors: false, key: false},
      folded: prev ? prev.folded : new Set(), sel: null,
    };
    // a short run is drawn whole; a long one through the window (paint)
    const root = el("div", "rt" + (cur.rows.length <= 40 ? " rt-short" : ""));
    cur.root = root;
    root.append(runHeader(run, data, "tree"));
    const io = ioCards(data.summary);
    if (io) root.append(io);
    const turns = turnStrip();
    if (turns) root.append(turns);

    const split = el("div", "rt-split");
    const left = el("div", "rt-left");
    left.append(toolbar());
    const axis = el("div", "rt-axis");
    axis.append(el("span", null, "Step"), el("span", "rt-dur", "Took"), el("span", "rt-axisend", `0 — ${fmtMs(cur.total)}`));
    left.append(axis);
    const list = el("div", "rt-list");
    list.tabIndex = 0;
    list.setAttribute("role", "tree");
    list.setAttribute("aria-label", "Steps of this run");
    const spacer = el("div", "rt-spacer");
    const rowsEl = el("div", "rt-rows");
    spacer.append(rowsEl);
    list.append(spacer);
    left.append(list);
    Object.assign(cur, {listEl: list, spacer, rowsEl});
    let raf = 0;
    list.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); });
    list.addEventListener("keydown", onKey);

    const grip = el("div", "rt-grip");
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-label", "Resize the step panel");
    const step = el("aside", "rt-step");
    step.setAttribute("aria-label", "The selected step");
    step.append(el("div", "rt-step-empty", "Pick a step to read its output, its input and what fed it.  ↑ ↓ to move, / to find, e for the next error."));
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
        const width = Math.min(r.width - 360, Math.max(320, r.right - e2.clientX));
        split.style.setProperty("--rt-step-w", `${width}px`);
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        store("runStepW", parseInt(getComputedStyle(split).getPropertyValue("--rt-step-w"), 10) || null);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, {once: true});
    });
    syncToolbar();
    relist();
    loadConversation(cur);
    if (prev && prev.sel && byId.has(prev.sel.id)) select(byId.get(prev.sel.id), {quiet: true});
    state._tlrun = run;
    renderFlowInfo();
    pushView();
  }

  /* On a phone the step replaces the steps; this goes back. */
  function backToSteps() {
    if (cur) cur.root.classList.remove("rt-has-step");
  }

  return {show, selectId, selectOp, nextError, backToSteps, current: () => cur};
})();
