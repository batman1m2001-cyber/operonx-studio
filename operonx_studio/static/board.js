/* operonx studio — Board: an operonx-project milestone as columns, and the card it opens.
 *
 * The engine keeps the board in the project's store (.operonx/project/project.db);
 * the studio reads it (projectboard.py). It lives inside Project mode
 * (projectmode.js): a milestone on its Plans page opens here, mounted in the
 * page; `/board` and the assistant's "open_board" land there too. It follows
 * the milestone by its event cursor.
 */

"use strict";

const BoardView = (() => {
  const box = $("#board");
  const tabBtn = document.querySelector('.tabs button[data-tab="board"]');
  const K = `board:${PID}`;
  const v = Object.assign({mid: "", card: ""}, recall(K, {}));
  delete v.view; delete v.filter;
  let token = 0;
  let timer = null;
  let last = null;     // the milestone as last drawn: {cursor, turns}
  let host = null;     // Project mode's slot, while the board is mounted there
  const home = box.parentElement;
  const live = () => state.tab === "board" || (!!host && state.tab === "project" && box.parentElement === host);

  const save = () => store(K, v);
  const go = (patch) => { Object.assign(v, patch); save(); show(); };
  const enc = encodeURIComponent;
  const base = () => `/api/p/${PID}/board`;

  const STATE = {
    created: ["created", "s-idle"], discovering: ["discovering", "s-run"], requirements: ["requirements", "s-run"],
    planning: ["planning", "s-run"], awaiting_approval: ["waits for your approval", "s-wait"],
    running: ["running", "s-run"], waiting_human: ["waiting on you", "s-wait"], paused: ["paused", "s-idle"],
    verifying: ["verifying", "s-run"], done: ["done", "s-ok"], failed: ["failed", "s-bad"],
    cancelled: ["cancelled", "s-idle"], budget_exhausted: ["budget spent", "s-bad"],
    waiting_dependency: ["waits for another board", "s-wait"],
  };
  const CARD = {pending: "waits for its dependencies", ready: "ready", running: "running", waiting_human: "asks you",
                verified: "verified, merging", done: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled"};

  function hours(s) {
    if (s == null) return "—";
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const money = (x) => x == null ? "—" : `$${Number(x).toFixed(2)}`;

  /* ── the tab is there only for a project the engine drives ───────── */
  /* ── the tab is there only for a project the engine drives ───────── */
  async function probe() {
    try {
      const got = await api(base());
      if (tabBtn) tabBtn.hidden = !got.available;
      return got;
    } catch { if (tabBtn) tabBtn.hidden = true; return {available: false}; }
  }

  async function show() {
    const mine = ++token;
    let list;
    try { list = await probe(); }
    catch (err) { box.textContent = ""; box.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    if (!list.available) {
      box.textContent = "";
      box.append(paneNote("No board here", "This project has no operonx-project store (.operonx/project/project.db)."));
      return;
    }
    if (list.error) { box.textContent = ""; box.append(el("div", "errbox", list.error)); return; }
    const ms = list.milestones || [];
    if (!ms.length) {
      clearTimeout(timer);
      last = null;
      box.textContent = "";
      box.append(paneNote("No milestone yet", "A plan's milestone shows here once it is on the board."));
      return;
    }
    if (!ms.some((m) => m.id === v.mid)) v.mid = ms[ms.length - 1].id;
    let data;
    try { data = await api(`${base()}/${enc(v.mid)}`); }
    catch (err) { box.textContent = ""; box.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    let card = null;
    if (v.card && data.cards.some((c) => c.id === v.card)) {
      try { card = await api(`${base()}/${enc(v.mid)}/card/${enc(v.card)}`); } catch { card = null; }
      if (mine !== token) return;
    }
    draw(ms, data, card);
    last = {cursor: data.cursor, turns: data.turns_key || ""};
    schedule();
  }

  /* the board follows its milestone: a cheap read every few seconds, a
   * redraw only when the event cursor moved */
  function schedule() {
    clearTimeout(timer);
    if (!live() || document.hidden) return;
    timer = setTimeout(() => refresh(false), 3000);
  }
  async function refresh(force) {
    if (!live()) return;
    if (force || !last) { show(); return; }
    try {
      const d = await api(`${base()}/${enc(v.mid)}`);
      if (d.cursor !== last.cursor || (d.turns_key || "") !== last.turns) { show(); return; }
    } catch { /* the next tick tries again */ }
    schedule();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && live()) refresh(false); });

  /* ── the page ─────────────────────────────────────────────────────── */
  function draw(list, data, card) {
    const m = data.milestone;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Board"));
    if (list.length > 1) {
      const pick = el("select", "bdpick");
      for (const x of list) {
        const o = el("option", null, `${x.id} · ${x.title}`);
        o.value = x.id;
        o.selected = x.id === v.mid;
        pick.append(o);
      }
      pick.onchange = () => go({mid: pick.value, card: ""});
      head.append(pick);
    } else {
      head.append(el("span", "count", `${m.id} · ${m.title}`));
    }
    box.append(head, summary(m), columnsView(data));
    if (card) box.append(cardPanel(card));
  }

  function summary(m) {
    const s = el("div", "bdsum");
    const [label, cls] = STATE[m.state] || [m.state, "s-idle"];
    s.append(el("span", `status ${cls}`, label));
    const bits = [m.mode.toUpperCase(), `${m.done}/${m.cards} cards done`,
                  `${money(m.cost_usd)} of ${money(m.budget_usd)}`,
                  `${hours(m.running_s)} of ${m.max_hours == null ? "—" : `${m.max_hours} h`}`];
    for (const b of bits) s.append(el("span", "bdbit", b));
    const wrap = el("div", "bdhead");
    wrap.append(s);
    if (m.reason) wrap.append(el("div", "bdreason", m.reason));
    return wrap;
  }

  /* ── Board: the columns ───────────────────────────────────────────── */
  /* ── Board: the columns ───────────────────────────────────────────── */
  function columnsView(data) {
    const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
    const grid = el("div", "bdcols");
    const shown = data.columns.filter((col) => col.key !== "blocked" || col.cards.length);
    // an empty column keeps its place, narrow: the work is in the others
    grid.style.gridTemplateColumns = shown.map((col) => col.cards.length ? "minmax(170px, 1fr)" : "minmax(96px, .5fr)").join(" ");
    for (const col of shown) {
      const c = el("div", `bdcol bd-${col.key}${col.cards.length ? "" : " empty"}`);
      const h = el("div", "bdcolhead");
      h.append(el("span", null, col.title));
      h.append(el("span", "count", col.limit ? `${col.cards.length}/${col.limit}` : String(col.cards.length)));
      c.append(h);
      for (const id of col.cards) c.append(tile(byId[id]));
      if (!col.cards.length) c.append(el("div", "bdempty", "—"));
      grid.append(c);
    }
    return grid;
  }

  function tile(c) {
    const t = el("button", `bdcard st-${c.state}${c.id === v.card ? " sel" : ""}${c.asks ? " asks" : ""}${c.working ? " lit" : ""}`);
    t.type = "button";
    t.dataset.oxTarget = `card:${c.id}`;
    const top = el("div", "bdcardtop");
    top.append(el("b", "mono", c.id));
    if (c.kind === "init") top.append(el("span", "chip", "init"));
    if (c.risk === "high") top.append(el("span", "chip cwarn", "risky"));
    if (c.asks) {
      const ask = el("span", "chip cwarn", "asks you");
      if (c.question) ask.title = `The assistant's last turn on it asks: ${c.question}`;
      top.append(ask);
    }
    // WORKSPACE_PLAN W1.3–W1.4: the assistant's turn on it, and what stands behind its state
    if (c.working) top.append(el("span", "chip crun", "assistant on it"));
    else if (c.evidence) {
      const ev = {tests: ["chip cok", "tests ✓", "Its last test run was green"],
                  red: ["chip cbad", "last run red", "Its last test run had failures"],
                  none: ["chip cwarn", "no evidence", "Marked done, with no test run behind it on the board"]}[c.evidence];
      if (ev) { const chip = el("span", ev[0], ev[1]); chip.title = ev[2]; top.append(chip); }
    }
    t.append(top, el("div", "bdcardtitle", c.title));
    if (c.activity && c.activity.text) {
      const live = el("div", "bdlive", c.activity.text);
      live.title = `${fmtAgo(c.activity.at * 1000)}`;
      t.append(live);
    }
    const meta = [];
    if (c.rows.length) meta.push(c.rows.length > 2 ? `${c.rows.length} rows` : c.rows.join(", "));
    if (c.state === "pending" && c.deps.length) meta.push(`needs ${c.deps.join(", ")}`);
    if (c.round) meta.push(`round ${c.round}`);
    if (c.reopens) meta.push(`re-opened ${c.reopens}×`);
    if (c.turns) meta.push(`${c.turns} turn${c.turns > 1 ? "s" : ""}`);
    if (c.cost_usd) meta.push(money(c.cost_usd));
    if (meta.length) t.append(el("div", "bdcardmeta", meta.join(" · ")));
    if (["failed", "blocked", "cancelled"].includes(c.state) && c.reason) t.append(el("div", "bdcardwhy", c.reason.slice(0, 140)));
    t.onclick = () => go({card: c.id === v.card ? "" : c.id});
    return t;
  }

  function cardPanel(got) {
    const c = got.card;
    const p = el("section", "bdpanel");
    const top = el("div", "bdpaneltop");
    top.append(el("b", "mono", c.id), el("span", null, ` ${c.title}`));
    top.append(el("span", "chip", CARD[c.state] || c.state));
    if (c.stage) top.append(el("span", "chip crun", c.stage));
    top.append(el("div", "spacer"));
    if (c.run_id) {
      // each attempt is a traced run (the engine writes the project's run store)
      const run = Icons.button("list", "Open the run", "linkbtn", `Open ${c.run_id} in Runs: every round, step by step`);
      run.onclick = () => performUi("open_run", {run: c.run_id, quiet: true});
      top.append(run);
    }
    const close = Icons.button("x", "", "iconbtn", "Close the card");
    close.onclick = () => go({card: ""});
    top.append(close);
    p.append(top);
    if (c.intent) p.append(el("p", "bdintent", c.intent));
    const dl = el("dl", "bdfacts");
    const fact = (k, val) => { if (val == null || val === "" || (Array.isArray(val) && !val.length)) return; dl.append(el("dt", null, k), el("dd", null, Array.isArray(val) ? val.join(", ") : String(val))); };
    fact("Rows", c.rows);
    fact("Needs", c.deps);
    fact("Paths", c.paths);
    fact("Acceptance tests", c.acceptance);
    fact("Last checks", c.checks.map((x) => `${x.name} ${x.ok ? "✓" : "✗"}`));
    fact("Cost", c.cost_usd ? money(c.cost_usd) : "");
    fact("Why", c.reason);
    p.append(dl);
    if (c.criteria.length) {
      p.append(el("div", "stitle", "Criteria"));
      const ul = el("ul", "bdcrit");
      for (const k of c.criteria) ul.append(el("li", null, typeof k === "string" ? k : (k.text || JSON.stringify(k))));
      p.append(ul);
    }
    if (got.turns && got.turns.length) p.append(turnsView(got.turns));
    if (got.terminals && got.terminals.length) {
      p.append(el("div", "stitle", "Terminals on this card"));
      const ul = el("ul", "bdturns");
      for (const t of got.terminals) {
        const li = el("li");
        const open = el("button", "linkbtn", t.title);
        open.type = "button";
        open.title = `Open it on the Terminal page (${t.cwd})`;
        open.onclick = () => { if (typeof TerminalPage !== "undefined") TerminalPage.show(t.id); ProjectMode.go("terminal"); };
        li.append(el("span", `chip${t.state === "working" ? " crun" : ""}`, t.state === "working" ? `working · ${t.running}` : t.state), open,
                  el("span", "note", ` by ${t.by === "assistant" ? "the assistant" : "you"}`));
        ul.append(li);
      }
      p.append(ul);
    }
    if (got.deploys && got.deploys.length) {
      p.append(el("div", "stitle", "Deploys on this card"));
      const ul = el("ul", "bdturns");
      const cls = {ok: " cok", failed: " cbad", running: " crun", queued: " crun", waiting: " cwarn", interrupted: " cbad"};
      for (const r of got.deploys.slice().reverse()) {
        const li = el("li");
        const open = el("button", "linkbtn", `${r.kind} ${r.ref.length > 20 ? r.ref.slice(0, 7) : r.ref} → ${r.env}`);
        open.type = "button";
        open.title = "Open it on the Environments page";
        open.onclick = () => { store(`envs:${PID}`, {...recall(`envs:${PID}`, {}), sel: r.env}); ProjectMode.go("environments"); };
        li.append(el("span", `chip${cls[r.state] || ""}`, r.state), open,
                  el("span", "note", ` ${r.sha ? r.sha.slice(0, 7) + " · " : ""}by ${r.by === "assistant" ? "the assistant" : "you"}`));
        ul.append(li);
      }
      p.append(ul);
    }
    if (got.events.length) {
      p.append(el("div", "stitle", "What happened"));
      const ol = el("ol", "bdevents");
      for (const e of got.events.slice(-25)) {
        const li = el("li");
        li.append(el("span", "note", fmtWhen(e.at * 1000)), el("span", "mono", ` ${e.kind} `),
                  el("span", null, eventText(e)));
        ol.append(li);
      }
      p.append(ol);
    }
    return p;
  }

  /* the assistant's turns on a card, each with its evidence: test runs, base checks, commits (W1.3–W1.4) */
  function turnsView(turns) {
    const box = el("div");
    box.append(el("div", "stitle", "Turns on this card"));
    const ol = el("ol", "bdturns");
    for (const t of turns.slice(0, 12)) {
      const li = el("li");
      const open = el("button", "linkbtn", (t.message || "a turn").slice(0, 90));
      open.type = "button";
      open.title = "Open this conversation";
      open.onclick = () => window.oxAssistant && window.oxAssistant.open(t.session, true);
      li.append(el("span", "note", fmtWhen(t.started * 1000)), el("span", `chip${t.state === "running" ? " crun" : ""}`, t.state), open);
      if (t.asks) li.append(el("div", "bdqtext", `Asks you: ${t.asks}`));
      const ul = el("ul", "bdevidence");
      for (const e of t.evidence || []) {
        const failed = e.kind === "tests" && e.failed;
        ul.append(el("li", failed ? "bad" : e.kind === "tests" ? "good" : null,
          e.kind === "tests" ? `tests: ${e.passed} passed${e.failed ? `, ${e.failed} failed` : ""}${e.skipped ? `, ${e.skipped} skipped` : ""}`
          : e.kind === "base" ? `on base: ${e.text}` : `commit ${e.sha} ${e.subject}`));
      }
      if (!(t.evidence || []).length) ul.append(el("li", "note", "no test run, base check or commit"));
      li.append(ul);
      ol.append(li);
    }
    box.append(ol);
    return box;
  }

  function eventText(e) {
    const d = e.data || {};
    if (e.kind === "card.state") return `${d.from} → ${d.to}${d.reason ? ` — ${String(d.reason).slice(0, 160)}` : ""}`;
    if (d.reason) return String(d.reason).slice(0, 160);
    const s = JSON.stringify(d);
    return s === "{}" ? "" : s.slice(0, 160);
  }

  /* the assistant points at a milestone or a card (performUi "open_board") */
  function open(patch) {
    const keep = Object.fromEntries(Object.entries(patch || {}).filter(([k, x]) => ["mid", "card"].includes(k) && x));
    if (keep.mid && keep.mid !== v.mid && !keep.card) keep.card = "";
    Object.assign(v, keep); save();
    switchTab("project", {page: "plans", mid: v.mid || ""});
  }

  /* Project mode shows a milestone's board inside its Plans page */
  function mount(slot, patch) {
    if (patch && patch.mid && patch.mid !== v.mid) { v.mid = patch.mid; v.card = ""; save(); }
    host = slot;
    slot.append(box);
    box.hidden = false;
    show();
  }
  function unmount() {
    if (!host) return;
    host = null;
    clearTimeout(timer);
    box.hidden = true;
    if (home) home.append(box);
  }

  probe();
  registerPane("board", {el: box, show});
  return {show, probe, open, mount, unmount};
})();
