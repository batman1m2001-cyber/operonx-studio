/* operonx studio — Board: the project's docs/brd/board.md as four columns, and the card it opens.
 *
 * One card per task (LEAN_PROJECT_PLAN §5): todo, doing, needs you, done. A card's lane comes from its files,
 * its kind from its requirement, and "after C2" marks a card whose earlier card is not done. A card the
 * assistant works shows the step it is on. The studio reads the file (projectboard.py); it lives inside
 * Project mode's Board page (projectmode.js), where `/board` and the assistant's "open_board" land too.
 */

"use strict";

const BoardView = (() => {
  const box = $("#board");
  const K = `board:${PID}`;
  const v = Object.assign({card: ""}, recall(K, {}));
  delete v.mid; delete v.view; delete v.filter;
  let token = 0;
  let timer = null;
  let last = "";       // the board as last drawn, to redraw only when it changed
  let host = null;     // Project mode's slot, while the board is mounted there
  const home = box.parentElement;
  const live = () => !!host && state.tab === "project" && box.parentElement === host;

  const save = () => store(K, v);
  const go = (patch) => { Object.assign(v, patch); save(); show(); };
  const enc = encodeURIComponent;
  const base = () => `/api/p/${PID}/board`;
  const COLUMNS = [["todo", "Todo"], ["doing", "Doing"], ["needs you", "Needs you"], ["done", "Done"]];
  const slug = (s) => s.replace(" ", "-");

  function button(cls, text, onclick, title) {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    b.onclick = onclick;
    return b;
  }

  async function show() {
    const mine = ++token;
    let data, card = null;
    try {
      data = await api(base());
      if (data.file && v.card && data.cards.some((c) => c.id === v.card)) card = await api(`${base()}/card/${enc(v.card)}`);
    } catch (err) { if (mine === token) { box.textContent = ""; box.append(loadError(err, () => show())); } return; }
    if (mine !== token) return;
    last = JSON.stringify(data);
    draw(data, card);
    schedule();
  }

  /* the board follows the file and the assistant's turns: a cheap read every few seconds, a redraw on a change */
  function schedule() {
    clearTimeout(timer);
    if (!live() || document.hidden) return;
    timer = setTimeout(async () => {
      if (!live()) return;
      try { if (JSON.stringify(await api(base())) !== last) { show(); return; } } catch { /* the next tick */ }
      schedule();
    }, 3000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && live()) show(); });

  function draw(data, card) {
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Board"));
    const cards = data.cards || [];
    if (cards.length) head.append(el("span", "count", `${data.columns.done.length} of ${cards.length} done`));
    box.append(head);
    if (data.error) box.append(el("div", "errbox", data.error));
    if (!cards.length) {
      box.append(paneNote("No cards yet", "Ask the assistant for a task: it writes one card per step in "
        + "docs/brd/board.md and moves each as it works."));
      return;
    }
    box.append(columnsView(data));
    if (card) box.append(cardPanel(card));
  }

  function columnsView(data) {
    const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
    const grid = el("div", "bdcols");
    // an empty column keeps its place, narrow: the work is in the others
    grid.style.gridTemplateColumns = COLUMNS.map(([k]) => data.columns[k].length ? "minmax(170px, 1fr)" : "minmax(96px, .5fr)").join(" ");
    for (const [key, title] of COLUMNS) {
      const ids = data.columns[key];
      const col = el("div", `bdcol bd-${slug(key)}${ids.length ? "" : " empty"}`);
      const h = el("div", "bdcolhead");
      h.append(el("span", null, title), el("span", "count", String(ids.length)));
      col.append(h);
      for (const id of ids) col.append(tile(byId[id]));
      if (!ids.length) col.append(el("div", "bdempty", "—"));
      grid.append(col);
    }
    return grid;
  }

  function laneChip(lane) {
    const chip = el("span", `bdlane lane-${lane}`, lane);
    chip.title = "The lane, read from the card's files";
    return chip;
  }

  const EVIDENCE = {tests: ["chip cok", "tests ✓", "Its last test run was green"],
                    red: ["chip cbad", "last run red", "Its last test run had failures"],
                    none: ["chip cwarn", "no evidence", "Done, with no test run on any of its turns"]};

  function tile(c) {
    const t = el("button", `bdcard st-${slug(c.state)}${c.id === v.card ? " sel" : ""}${c.asks ? " asks" : ""}${c.working ? " lit" : ""}`);
    t.type = "button";
    t.dataset.oxTarget = `card:${c.id}`;
    const top = el("div", "bdcardtop");
    top.append(el("b", "mono", c.id), laneChip(c.lane));
    if (c.kind === "fix") top.append(el("span", "chip", "fix"));
    if (c.waits.length) {
      const w = el("span", "chip cwarn", `after ${c.waits.join(", ")}`);
      w.title = `Waits until ${c.waits.join(", ")} is done`;
      top.append(w);
    }
    const ev = EVIDENCE[c.evidence];
    if (c.working) top.append(el("span", "chip crun", "assistant on it"));
    else if (ev) { const chip = el("span", ev[0], ev[1]); chip.title = ev[2]; top.append(chip); }
    t.append(top, el("div", "bdcardtitle", c.title));
    if (c.working) t.append(el("div", "bdlive", c.now || "working"));
    const ask = c.state === "needs you" ? c.note : c.asks ? c.question : "";
    if (ask) t.append(el("div", "bdcardask", ask.slice(0, 160)));
    const meta = [];
    if (c.req.length) meta.push(c.req.length > 2 ? `${c.req.length} rows` : c.req.join(", "));
    if (c.turns) meta.push(`${c.turns} turn${c.turns > 1 ? "s" : ""}`);
    if (meta.length) t.append(el("div", "bdcardmeta", meta.join(" · ")));
    t.onclick = () => go({card: c.id === v.card ? "" : c.id});
    return t;
  }

  async function move(c, to) {
    try { await api(`${base()}/card`, {method: "POST", body: JSON.stringify({card: c.id, to, note: ""})}); }
    catch (err) { toast(err.message); }
    show();
  }

  function cardPanel(got) {
    const c = got.card;
    const p = el("section", "bdpanel");
    const top = el("div", "bdpaneltop");
    top.append(el("b", "mono", c.id), el("span", null, ` ${c.title}`), laneChip(c.lane), el("span", "chip", c.state));
    top.append(el("div", "spacer"));
    const close = Icons.button("x", "", "iconbtn", "Close the card");
    close.onclick = () => go({card: ""});
    top.append(close);
    p.append(top);
    if (c.note) p.append(el("p", "bdqtext", c.note));
    const dl = el("dl", "bdfacts");
    const fact = (k, val) => { if (val && val.length) dl.append(el("dt", null, k), el("dd", "mono", val.join(", "))); };
    fact("Requirements", c.req);
    fact("After", c.after);
    fact("Files", c.files);
    fact("Done when", c.done);
    p.append(dl);
    const acts = el("div", "pm-acts");
    if (c.state === "needs you") acts.append(button("primary", "Go", () => move(c, "doing"), "Agree: the card goes back to doing"));
    acts.append(button(null, "Ask about it", () => window.oxAsk && window.oxAsk(`Card ${c.id} (${c.title}) on docs/brd/board.md: `)));
    p.append(acts);
    if (got.turns && got.turns.length) p.append(turnsView(got.turns));
    if (got.terminals && got.terminals.length) {
      p.append(el("div", "stitle", "Terminals on this card"));
      const ul = el("ul", "bdturns");
      for (const t of got.terminals) {
        const li = el("li");
        const open = button("linkbtn", t.title, () => { if (typeof TerminalPage !== "undefined") TerminalPage.show(t.id); ProjectMode.go("terminal"); },
                            `Open it on the Terminal page (${t.cwd})`);
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
        const open = button("linkbtn", `${r.kind} ${r.ref.length > 20 ? r.ref.slice(0, 7) : r.ref} → ${r.env}`,
                            () => { store(`envs:${PID}`, {...recall(`envs:${PID}`, {}), sel: r.env}); ProjectMode.go("environments"); },
                            "Open it on the Environments page");
        li.append(el("span", `chip${cls[r.state] || ""}`, r.state), open,
                  el("span", "note", ` ${r.sha ? r.sha.slice(0, 7) + " · " : ""}by ${r.by === "assistant" ? "the assistant" : "you"}`));
        ul.append(li);
      }
      p.append(ul);
    }
    return p;
  }

  /* the assistant's turns on a card, each with its evidence: test runs, base checks, commits */
  function turnsView(turns) {
    const wrap = el("div");
    wrap.append(el("div", "stitle", "Turns on this card"));
    const ol = el("ol", "bdturns");
    for (const t of turns.slice(0, 12)) {
      const li = el("li");
      const open = button("linkbtn", (t.message || "a turn").slice(0, 90),
                          () => window.oxAssistant && window.oxAssistant.open(t.session, true), "Open this conversation");
      li.append(el("span", "note", fmtWhen(t.started * 1000)), el("span", `chip${t.state === "running" ? " crun" : ""}`, t.state), open);
      if (t.now) li.append(el("div", "bdlive", t.now));
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
    wrap.append(ol);
    return wrap;
  }

  /* the assistant points at a card (performUi "open_board") */
  function open(patch) {
    if (patch && patch.card) { v.card = patch.card; save(); }
    switchTab("project", {page: "board"});
  }

  /* Project mode shows the board on its Board page */
  function mount(slot) {
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

  registerPane("board", {el: box, show});
  return {show, open, mount, unmount};
})();
