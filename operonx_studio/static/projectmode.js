/* operonx studio — Project mode: the studio as the place a project is built
 * from (docs/PROJECT_MODE_PLAN.md D3).
 *
 * A mode of the studio, chat first: the main menu gives way to the
 * project's own icon bar, the assistant (Claude Code, working by the
 * project's conventions) takes the centre, and beside it the project's
 * state, read from the engine's one status document (`operonx-project api
 * {"op": "status"}`, D2) — what needs the owner, what is in progress, the
 * checklist, the plans, the last commits. The screen and the assistant
 * read the same document, so they never disagree. The column refreshes
 * after every assistant turn, every 15 s while it shows, and when the tab
 * comes back.
 *
 *   Now        the conversation, and beside it where the project stands
 *   Plans      every plan doc and milestone, phase by phase; a milestone opens its board
 *   Checklist  the requirements: done, open, and their tests
 *   Questions  what waits for the owner, answered in place
 *   Changes    the commits, newest first
 *   Settings   how it is built, the models, the engine's daemon
 *
 * On a page other than Now the page takes the centre and the conversation
 * moves to the right, so it is always one glance away.
 *
 *   /p/<pid>/project[/<page>]
 */

"use strict";

const ProjectMode = (() => {
  const box = $("#project");
  const bar = $("#prail");
  const K = `pmode:${PID}`;
  const v = Object.assign({page: "now", open: {}, mid: "", filter: "open", search: ""}, recall(K, {}));
  const PAGES = {now: "Now", plans: "Plans", checklist: "Checklist", questions: "Questions", changes: "Changes",
                 settings: "Settings"};
  let doc = null;      // the last status document
  let failed = null;   // why there is none: {message, unavailable}
  let token = 0;
  let pageToken = 0;
  let timer = null;
  let busy = false;    // the assistant's turn, as last heard
  let on = false;      // the mode is showing
  const drafts = {};   // words being typed on the Questions page, kept across redraws

  // board.js's view (a top-level const: not on window)
  const HAS_BOARD = () => typeof BoardView !== "undefined";
  const save = () => store(K, v);
  const enc = encodeURIComponent;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
  // a name the assistant's hand can reach (hand.js, docs/ALIVE_ASSISTANT_PLAN.md D2)
  const tgt = (n, name) => { n.dataset.oxTarget = name; return n; };
  const ask = (text) => { if (window.oxAsk) window.oxAsk(text); if (MOBILE.matches) go("now"); };

  function ago(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  function button(cls, text, onclick, title) {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    b.onclick = onclick;
    return b;
  }

  /* ── the frame ──────────────────────────────────────────────────── */
  const main = el("div", "pm-main");
  const page = el("div", "pm-page");
  const chat = el("div", "pm-chat");
  chat.id = "pmchat";
  const side = el("aside", "pm-status");
  side.setAttribute("aria-label", "Where the project stands");
  main.append(page, chat, side);
  box.append(main);

  /* ── the status column ─────────────────────────────────────────── */
  function section(key, title, count, body, opts) {
    const s = tgt(el("section", "pm-sec"), `status:${key}`);
    s.dataset.key = key;
    const h = el("h3", "pm-h");
    const name = opts && opts.page ? button("pm-hlink", title, () => go(opts.page), `Open ${PAGES[opts.page]}`) : el("span", null, title);
    h.append(name);
    if (count != null) h.append(el("span", `pm-count${opts && opts.hot ? " hot" : ""}`, String(count)));
    s.append(h);
    if (body) s.append(body);
    return s;
  }

  function fold(key, summary, build) {
    const d = el("details", "pm-fold");
    d.open = !!v.open[key];
    d.ontoggle = () => { v.open[key] = d.open; save(); };
    d.append(el("summary", null, summary));
    d.append(build());
    return d;
  }

  /* a long list: the first few on screen, the rest one click away */
  function capped(key, items, n, draw) {
    const list = el("div", "pm-list");
    for (const x of items.slice(0, n)) list.append(draw(x));
    if (items.length > n) {
      list.append(fold(key, `${items.length - n} more`, () => {
        const more = el("div", "pm-list");
        for (const x of items.slice(n)) more.append(draw(x));
        return more;
      }));
    }
    return list;
  }

  function needsYou(items) {
    if (!items.length) return el("p", "pm-quiet", "Nothing waits for you.");
    return capped("more-needs", items, 3, (q) => {
      const row = button("pm-item pm-q pm-one", null, () => go("questions"), `${q.id} · ${q.text}\nAnswer it on the Questions page`);
      row.dataset.key = `q:${q.source}:${q.milestone || ""}:${q.id}`;
      tgt(row, `q:${q.id}`);
      row.append(el("span", "pm-id", q.id), el("span", "pm-text", q.text || q.kind));
      return row;
    });
  }

  function workingOn(items) {
    const list = el("div", "pm-list");
    if (!items.length) { list.append(el("p", "pm-quiet", "Nothing is in progress.")); return list; }
    for (const w of items) {
      const row = button("pm-item pm-w", null, () => { if (w.milestone) v.mid = w.milestone; go("plans"); }, w.path || `milestone ${w.milestone}`);
      row.dataset.key = `w:${w.path || w.milestone}`;
      tgt(row, w.path ? `plan:${w.path}` : `ms:${w.milestone}`);
      row.append(el("span", "pm-title", w.title), el("span", "pm-sentence", w.sentence));
      list.append(row);
    }
    return list;
  }

  function meter(done, total) {
    const pct = total ? Math.round((100 * done) / total) : 0;
    const m = el("div", "pm-meter");
    m.setAttribute("role", "progressbar");
    m.setAttribute("aria-valuenow", String(pct));
    m.setAttribute("aria-valuemin", "0");
    m.setAttribute("aria-valuemax", "100");
    const fill = el("span");
    fill.style.width = `${pct}%`;
    m.append(fill);
    return m;
  }

  function checklistBox(c) {
    const wrap = el("div", "pm-check");
    if (!c.total) { wrap.append(el("p", "pm-quiet", "No checklist yet (docs/brd).")); return wrap; }
    wrap.append(el("p", "pm-line", `${c.verified} of ${c.total} verified`), meter(c.verified, c.total));
    if (c.open.length) {
      wrap.append(fold("open-rows", `${plural(c.open.length, "row")} still open`, () => {
        const l = el("div", "pm-list");
        for (const r of c.open) {
          const row = el("div", "pm-item pm-row pm-one");
          row.dataset.key = `r:${r.id}`;
          tgt(row, `row:${r.id}`);
          row.title = `${r.id} · ${r.status.replace(/_/g, " ")}\n${r.what || r.note || ""}`;
          row.append(el("span", "pm-id", r.id), el("span", "pm-text", r.what || r.note || ""));
          l.append(row);
        }
        return l;
      }));
    }
    return wrap;
  }

  const PLAN_WORDS = {in_progress: "in progress", plan: "planned", parked: "parked", done: "done"};
  function addBlocksNote(d) {
    const note = el("div", "pm-note");
    note.title = "A plan doc says where it stands in a block at its top (title, status, phases)";
    note.append(el("span", null, `${plural(d.unmarked.length, "plan")} without a status`));
    note.append(button("linkbtn", "Add them", () => ask("Add the status block (docs/PROJECT_MODE_PLAN D1: "
      + "title, status, phases with their status, rows, updated) to every plan doc that has none: "
      + `${d.unmarked.join(", ")}. Read each plan and the git log to set each phase's real status; `
      + "then run operonx-project brd check and fix what it says.")));
    return note;
  }
  function plansBox(d) {
    const wrap = el("div", "pm-plans");
    const counts = {};
    for (const p of d.plans) counts[p.status] = (counts[p.status] || 0) + 1;
    const parts = ["in_progress", "plan", "parked", "done"].filter((s) => counts[s]).map((s) => `${counts[s]} ${PLAN_WORDS[s]}`);
    wrap.append(el("p", "pm-line", parts.length ? parts.join(" · ") : "No plan says where it stands yet."));
    for (const e of d.plan_errors) wrap.append(el("p", "pm-bad", e));
    if (d.unmarked.length) wrap.append(addBlocksNote(d));
    return wrap;
  }

  function changesBox(list) {
    const l = el("div", "pm-list");
    if (!list.length) { l.append(el("p", "pm-quiet", "No commits yet.")); return l; }
    for (const ch of list.slice(0, 3)) {
      const row = el("div", "pm-item pm-commit pm-one");
      row.dataset.key = `c:${ch.sha}`;
      tgt(row, `commit:${ch.sha}`);
      row.title = `${ch.sha} · ${ch.author} · ${ch.at}`;
      row.append(el("span", "pm-text", ch.subject), el("span", "pm-where", ago(ch.at)));
      l.append(row);
    }
    return l;
  }

  function missing() {
    return failed.unavailable
      ? paneNote("The builder is not installed", `${failed.message}. Install it beside the studio: `
        + "./install.sh in the operonx-studio checkout installs operonx-project with it.")
      : el("div", "errbox", failed.message);
  }

  function drawSide() {
    side.textContent = "";
    if (failed) { side.append(section("engine", "Project status", null, missing())); return; }
    if (!doc) { side.append(el("p", "pm-quiet", "Reading where the project stands…")); return; }
    const d = doc;
    const head = el("div", "pm-summary");
    const needs = d.needs_you.length;
    head.append(el("span", needs ? "hot" : null, needs ? `${plural(needs, "thing")} need${needs === 1 ? "s" : ""} you` : "Nothing needs you"),
      el("span", null, `${plural(d.working_on.length, "plan")} in progress`),
      el("span", null, d.checklist.total ? `${d.checklist.verified}/${d.checklist.total} verified` : "no checklist"));
    // on a phone the column folds above the conversation: the summary is its handle
    const wrap = el("details", "pm-wrap");
    wrap.open = !MOBILE.matches || !!v.open.phone;
    wrap.ontoggle = () => { if (MOBILE.matches) { v.open.phone = wrap.open; save(); } };
    const sum = el("summary", "pm-handle");
    sum.append(head);
    wrap.append(sum,
      section("needs", "Needs you", needs, needsYou(d.needs_you), {hot: needs > 0, page: "questions"}),
      section("working", "Working on", d.working_on.length || null, workingOn(d.working_on), {page: "plans"}),
      section("checklist", "Checklist", null, checklistBox(d.checklist), {page: "checklist"}),
      section("plans", "Plans", d.plans.length || null, plansBox(d), {page: "plans"}),
      section("changes", "Recent changes", null, changesBox(d.changes), {page: "changes"}));
    side.append(wrap);
  }

  /* ── the pages ──────────────────────────────────────────────────── */
  function pageHead(title, sub) {
    const h = tgt(el("div", "panehead pm-pagehead"), "pagehead");
    h.append(el("h2", null, title));
    if (sub) h.append(el("span", "count", sub));
    return h;
  }

  function phaseStrip(p) {
    const strip = el("span", "pm-phases");
    strip.setAttribute("aria-label", `${p.done} of ${p.total} done`);
    for (const ph of p.phases) {
      const seg = el("span", `pm-ph ph-${ph.status}`);
      seg.title = `${ph.id}${ph.title ? " " + ph.title : ""} — ${ph.status.replace(/_/g, " ")}`;
      strip.append(seg);
    }
    return strip;
  }

  function drawPlans() {
    page.textContent = "";
    if (v.mid) { drawMilestone(); return; }
    if (HAS_BOARD()) BoardView.unmount();
    const d = doc;
    page.append(pageHead("Plans", d ? plural(d.plans.length, "plan") : ""));
    if (!d) { page.append(failed ? missing() : el("p", "pm-quiet", "Reading…")); return; }
    if (!d.plans.length && !d.unmarked.length) {
      page.append(paneNote("No plan yet", "Work with more than one step gets a plan doc under docs/ that says where it "
        + "stands. Ask the assistant to plan something new; it writes the plan before any code."));
    }
    const sentence = Object.fromEntries(d.working_on.map((w) => [w.path || w.milestone, w.sentence]));
    for (const p of d.plans) {
      const key = p.path || `m:${p.milestone}`;
      const card = el("div", `pm-plan st-${p.status}`);
      card.dataset.key = key;
      tgt(card, p.path ? `plan:${p.path}` : `ms:${p.milestone}`);
      const top = button("pm-plantop", null, () => {
        if (p.source === "engine") { v.mid = p.milestone; save(); drawPlans(); return; }
        v.open[key] = !v.open[key]; save(); drawPlans();
      }, p.source === "engine" ? "Open its board" : "Show its phases");
      const words = el("span", "pm-planwords");
      const cur = p.status === "in_progress" && p.phases.find((ph) => ph.id === p.current);
      words.title = p.source === "engine" ? `milestone ${p.milestone}, built by the engine` : p.path;
      words.append(el("span", "pm-title", p.title),
        el("span", "pm-where", cur ? `now ${cur.id} · ${cur.title || ""}` : p.source === "engine" ? `milestone ${p.milestone}` : p.path));
      top.append(el("span", `pm-pill st-${p.status}`, PLAN_WORDS[p.status] || p.status), words, phaseStrip(p),
        el("span", "pm-frac", p.total ? `${p.done}/${p.total}` : ""));
      card.append(top);
      const said = sentence[p.path || p.milestone];
      if (said) top.title = said;
      if (v.open[key] && p.source !== "engine") {
        const list = el("ol", "pm-phaselist");
        for (const ph of p.phases) {
          const li = tgt(el("li", `ph-${ph.status}`), `phase:${p.path}#${ph.id}`);
          li.append(el("span", "pm-id", ph.id), el("span", null, ph.title || ""), el("span", "pm-where", ph.status.replace(/_/g, " ")));
          list.append(li);
        }
        card.append(list);
        if (p.rows.length) list.title = `Serves ${p.rows.join(", ")}`;
        const acts = el("div", "pm-acts");
        if (p.status !== "done") {
          acts.append(button("primary needs-edit", p.status === "in_progress" ? "Continue it" : "Start it", () => ask(
            `Work on the plan ${p.path}${p.current ? `: phase ${p.current} is next` : ""}. Follow its phases, keep its `
            + "status block true (change a phase's status in the commit that finishes it), and stop at the end of the phase.")));
        }
        acts.append(button(null, "Ask about it", () => ask(`What does the plan ${p.path} say, where does it stand, and what is left?`)));
        card.append(acts);
      }
      page.append(card);
    }
    if (d.unmarked.length) {
      const sec = el("section", "pm-unmarked");
      sec.append(addBlocksNote(d));
      sec.append(fold("unmarked", "Which ones", () => {
        const ul = el("ul", "pm-paths");
        for (const path of d.unmarked) ul.append(tgt(el("li", "mono", path), `plan:${path}`));
        return ul;
      }));
      page.append(sec);
    }
  }

  /* a milestone the engine builds: its board (the kanban, the checklist, the graph), here */
  function drawMilestone() {
    const back = button("linkbtn pm-back", "← All plans", () => { v.mid = ""; save(); drawPlans(); });
    page.append(back);
    const slot = el("div", "pm-board");
    page.append(slot);
    if (HAS_BOARD()) BoardView.mount(slot, {mid: v.mid});
  }

  let ck = null;   // the checklist, as last read
  async function drawChecklist() {
    const mine = ++pageToken;
    page.textContent = "";
    page.append(pageHead("Checklist", doc && doc.checklist.total ? `${doc.checklist.verified} of ${doc.checklist.total} verified` : ""));
    if (!ck) page.append(el("p", "pm-quiet", "Reading the checklist…"));
    try { ck = await api(`/api/p/${PID}/brd`); } catch (err) { ck = {error: err.message}; }
    if (mine !== pageToken || v.page !== "checklist") return;
    page.textContent = "";
    page.append(pageHead("Checklist", doc && doc.checklist.total ? `${doc.checklist.verified} of ${doc.checklist.total} verified` : ""));
    if (ck.error || ck.available === false) { page.append(el("div", "errbox", ck.error || "No docs/brd here.")); return; }
    if (!(ck.rows || []).length) { page.append(paneNote("No checklist yet", ck.note || "docs/brd has no rows.")); return; }
    const CLOSED = new Set(["implemented_verified", "out_of_scope_demo", "not_applicable", "superseded"]);
    const rows = ck.rows;
    const counts = {open: rows.filter((r) => !CLOSED.has(r.status)).length, all: rows.length,
                    verified: rows.filter((r) => r.status === "implemented_verified").length};
    const tools = el("div", "pm-tools");
    for (const [f, label] of [["open", "Open"], ["verified", "Verified"], ["all", "All"]]) {
      const b = button(`pm-chip${v.filter === f ? " on" : ""}`, `${label} ${counts[f]}`, () => { v.filter = f; save(); drawChecklist(); });
      b.setAttribute("aria-pressed", String(v.filter === f));
      tools.append(b);
    }
    const search = el("input", "pm-search");
    search.type = "search";
    search.placeholder = "Find a row…";
    search.value = v.search || "";
    tools.append(search);
    page.append(tools);
    const list = el("div", "pm-rows");
    page.append(list);
    const paint = () => {
      const q = (v.search || "").toLowerCase();
      list.textContent = "";
      const shown = rows.filter((r) => (v.filter === "all" || (v.filter === "open" ? !CLOSED.has(r.status) : r.status === "implemented_verified"))
        && (!q || `${r.id} ${r.text} ${r.cells.join(" ")}`.toLowerCase().includes(q)));
      if (!shown.length) list.append(el("p", "pm-quiet", v.filter === "open" && !q ? "Every row is done." : "No row matches."));
      for (const r of shown.slice(0, 500)) {
        const key = `row:${r.id}`;
        const item = el("div", `pm-reqrow${CLOSED.has(r.status) ? "" : " open"}`);
        item.dataset.key = key;
        tgt(item, key);
        const top = button("pm-reqtop", null, () => { v.open[key] = !v.open[key]; save(); paint(); });
        top.append(el("span", "pm-id", r.id), el("span", "pm-text", r.text || r.cells.slice(1, 3).join(" · ")),
          el("span", `pm-pill rs-${r.status}`, r.status.replace(/_/g, " ")),
          el("span", "pm-where", r.tests.length ? plural(r.tests.length, "test") : "no test"));
        item.append(top);
        if (v.open[key]) {
          const more = el("div", "pm-reqmore");
          more.append(el("p", null, r.cells.slice(1).filter((c) => c && c !== r.status && c !== "—").join(" · ")));
          for (const t of r.tests) more.append(el("div", "mono pm-test", t));
          if (!CLOSED.has(r.status)) more.append(button("needs-edit", "Work on this row", () => ask(
            `Make checklist row ${r.id} true: build what it needs, cite a passing test, and set its status in the matrix.`)));
          item.append(more);
        }
        list.append(item);
      }
    };
    search.oninput = () => { v.search = search.value; save(); paint(); };
    paint();
  }

  async function drawQuestions() {
    const mine = ++pageToken;
    const d = doc;
    page.textContent = "";
    page.append(pageHead("Questions", d ? plural(d.needs_you.length, "waits", "wait") + " for you" : ""));
    if (!d) { page.append(failed ? missing() : el("p", "pm-quiet", "Reading…")); return; }
    if (!d.needs_you.length) { page.append(paneNote("Nothing waits for you", "The engine's questions and the requirements' open questions show here.")); return; }
    // the engine's questions in full (options with their words, why it blocks), from each milestone's board
    const mids = [...new Set(d.needs_you.filter((q) => q.source === "engine").map((q) => q.milestone))];
    const full = {};
    await Promise.all(mids.map(async (mid) => {
      try { for (const q of (await api(`/api/p/${PID}/board/${enc(mid)}`)).questions || []) full[`${mid}:${q.qid}`] = q; }
      catch { /* the summary is enough to answer in words */ }
    }));
    if (mine !== pageToken || v.page !== "questions") return;
    keepDrafts();
    page.textContent = "";
    page.append(pageHead("Questions", plural(d.needs_you.length, "waits", "wait") + " for you"));
    for (const q of d.needs_you) page.append(q.source === "engine" ? engineQuestion(q, full[`${q.milestone}:${q.id}`]) : brdQuestion(q));
  }
  function keepDrafts() { for (const ta of page.querySelectorAll("textarea[data-q]")) drafts[ta.dataset.q] = ta.value; }
  function wordsBox(key, placeholder) {
    const ta = el("textarea");
    ta.dataset.q = key;
    ta.rows = 2;
    ta.placeholder = placeholder;
    ta.value = drafts[key] || "";
    return ta;
  }
  async function answer(q, body, done) {
    try {
      const got = await api(`/api/p/${PID}/board/${enc(q.milestone)}/act`, {op: "answer", ref: q.id, answer: body});
      toast(got.message || "Answered");
      if (done) done();
    } catch (err) { toast((err.data || {}).message || err.message, true); }
    refresh();
  }
  function engineQuestion(q, f) {
    const card = el("section", "pm-qcard");
    card.dataset.key = `q:${q.milestone}:${q.id}`;
    tgt(card, `q:${q.id}`);
    const head = el("div", "pm-qhead");
    head.append(el("span", "pm-id", q.id), el("span", "pm-where", `${q.milestone}${q.card ? " · " + q.card : ""} · ${q.kind}`));
    head.append(button("linkbtn", "Open the board", () => { v.mid = q.milestone; go("plans"); }));
    card.append(head, el("p", "pm-qtext", (f && f.problem) || q.text));
    if (f && f.why) card.append(fold(`why:${q.milestone}:${q.id}`, "Why it blocks", () => el("p", "pm-where", f.why)));
    const opts = el("div", "pm-acts");
    for (const o of (f && f.options) || q.options.map((k) => ({key: k, label: k}))) {
      const rec = (f ? f.recommended : q.recommended) === o.key;
      const b = button(`${rec ? "primary" : ""} needs-edit`, `${o.label}${rec ? " (recommended)" : ""}`,
        () => answer(q, {choice: o.key, text: ""}), o.description || "");
      tgt(b, `qopt:${q.id}:${o.key}`);
      opts.append(b);
    }
    const key = `${q.milestone}:${q.id}`;
    const words = el("div", "pm-words needs-edit");
    const ta = wordsBox(key, "Your answer…");
    words.append(ta, button(null, "Send", () => { const t = ta.value.trim(); if (!t) { ta.focus(); return; } answer(q, t, () => { delete drafts[key]; }); }));
    words.hidden = !drafts[key];
    opts.append(button("linkbtn needs-edit", "In my words", () => { words.hidden = false; ta.focus(); }));
    card.append(opts, words);
    return card;
  }
  function brdQuestion(q) {
    const card = el("section", "pm-qcard");
    card.dataset.key = `q:brd:${q.id}`;
    tgt(card, `q:${q.id}`);
    const head = el("div", "pm-qhead");
    head.title = `${q.kind} · ${q.state} · docs/brd/requirements/open_questions.md`;
    head.append(el("span", "pm-id", q.id), el("span", "pm-qtext", q.text));
    card.append(head);
    const key = `brd:${q.id}`;
    const ta = wordsBox(key, "Your decision…");
    const decide = el("div", "pm-words needs-edit");
    decide.hidden = !drafts[key];
    const acts = el("div", "pm-acts");
    acts.append(button(null, "Talk it through", () => ask(`Open question ${q.id} (${q.text}) in docs/brd/requirements/open_questions.md: `
      + "what does it say, what are the options, and what do you recommend?")));
    acts.append(button("needs-edit", "Decide", () => { decide.hidden = false; ta.focus(); }));
    decide.append(ta, button("primary", "Record", () => {
      const t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      delete drafts[key];
      ask(`The owner decided open question ${q.id} (${q.text}): "${t}". Record it in docs/brd/requirements/open_questions.md `
        + "(the entry's resolution and its state), update the requirement rows it touches, and commit.");
    }));
    card.append(acts, decide);
    return card;
  }

  async function drawChanges() {
    const mine = ++pageToken;
    page.textContent = "";
    page.append(pageHead("Changes", ""));
    let list = doc ? doc.changes : [];
    try { list = (await api(`/api/p/${PID}/project/status?changes=60`)).project.changes; } catch { /* the last ones */ }
    if (mine !== pageToken || v.page !== "changes") return;
    page.textContent = "";
    page.append(pageHead("Changes", plural(list.length, "commit")));
    if (!list.length) { page.append(el("p", "pm-quiet", "No commits yet.")); return; }
    let day = "";
    for (const ch of list) {
      const d = (ch.at || "").slice(0, 10);
      if (d !== day) { day = d; page.append(el("h3", "pm-h pm-day", d)); }
      const row = el("div", "pm-change");
      row.dataset.key = `c:${ch.sha}`;
      tgt(row, `commit:${ch.sha}`);
      row.append(el("span", "pm-text", ch.subject),
        el("span", "pm-where", `${ch.sha} · ${ch.author} · ${(ch.at || "").slice(11, 16)}`));
      page.append(row);
    }
  }

  async function drawSettings() {
    const mine = ++pageToken;
    page.textContent = "";
    page.append(pageHead("Settings", ""));
    let info = {};
    try { info = await api(`/api/p/${PID}/board`); } catch (err) { info = {error: err.message}; }
    if (mine !== pageToken || v.page !== "settings") return;
    page.textContent = "";
    page.append(pageHead("Settings", ""));
    const s = doc ? doc.setup : null;
    // one row per setting: its name, its value, its action; the why is on hover
    const rows = el("div", "pm-setrows");
    page.append(rows);
    const row = (name, why, value, ...acts) => {
      const r = tgt(el("div", "pm-setrow"), `setting:${name.toLowerCase().replace(/\W+/g, "-")}`);
      r.title = why;
      r.append(el("span", "pm-setname", name), value, ...acts);
      rows.append(r);
    };
    row("How it is built", s && s.practices.file ? `From ${s.practices.file}, committed: tests, architecture rules, the checks a change must pass`
      : "No docs/brd/practices.toml: the defaults", el("span", "pm-setval", s ? s.practices.line.replace(/^no practices file /, "defaults ") : "…"),
      button("needs-edit", "Change", () => ask("Show me the project's practices (docs/brd/practices.toml) "
        + "in plain words and what each preset would change; change nothing until I choose.")));

    if (info.installed === false || failed) {
      row("Builder", "operonx-project builds and checks the project; the studio talks to it", failed ? missing() : el("span", "pm-bad", "not installed"));
      return;
    }
    const ms = info.models || {};
    const pick = el("select", "needs-edit");
    for (const m of ["", "sonnet", "opus", "haiku", "fable"]) {
      const o = el("option", null, m || "default");
      o.value = m;
      o.selected = (ms.model || "") === m;
      pick.append(o);
    }
    pick.onchange = async () => {
      try { toast((await api(`/api/p/${PID}/board/settings`, {model: pick.value})).message); }
      catch (err) { toast((err.data || {}).message || err.message, true); }
    };
    const roles = Object.entries(ms.models || {});
    row("Engine model", "The model the engine's sessions run on; a change applies to the next session"
      + (roles.length ? `\nPer role: ${roles.map(([r, m]) => `${r} ${m}`).join(", ")}` : ""), pick);

    const dmn = info.daemon || {};
    const run = button(`${dmn.running ? "" : "primary"} needs-edit`, dmn.running ? "Stop" : "Run", async () => {
      run.disabled = true;
      try { toast((await api(`/api/p/${PID}/board/daemon`, {action: dmn.running ? "stop" : "start"})).message); }
      catch (err) { toast((err.data || {}).message || err.message, true); }
      drawSettings();
      refresh();
    });
    row("Engine daemon", "It drives the milestones the engine builds; work done in the conversation does not need it",
      el("span", `pm-setval ${dmn.running ? "" : "pm-quiet"}`, dmn.running ? "running" : "stopped"), run);
    if (info.sandbox === false) row("Sandbox", "This machine runs the engine's coders without the shell sandbox", el("span", "pm-bad", "off"));
  }

  function drawPage() {
    main.classList.toggle("paged", v.page !== "now");
    if (v.page !== "plans" && HAS_BOARD()) BoardView.unmount();
    if (v.page === "now") { page.textContent = ""; return; }
    if (v.page === "plans") drawPlans();
    else if (v.page === "checklist") drawChecklist();
    else if (v.page === "questions") drawQuestions();
    else if (v.page === "changes") drawChanges();
    else if (v.page === "settings") drawSettings();
  }

  /* ── reading the status ─────────────────────────────────────────── */
  async function refresh() {
    const mine = ++token;
    try {
      const got = await api(`/api/p/${PID}/project/status`);
      if (mine !== token) return;
      const before = doc;
      doc = got.project;
      failed = null;
      if (base) whatHappened(before);
    } catch (err) {
      if (mine !== token) return;
      const d = err.data || {};
      failed = {message: d.message || err.message, unavailable: d.status === "unavailable"};
    }
    if (on) {
      drawSide();
      paintBar();
      // the pages drawn from the document follow it; a page being typed into is left alone
      const typing = page.contains(document.activeElement) && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName);
      if (!typing && (v.page === "questions" || v.page === "settings" || (v.page === "plans" && !v.mid)
        || (base && (v.page === "changes" || v.page === "checklist")))) drawPage();
    }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!on || document.hidden) return;
    timer = setTimeout(refresh, 15000);
  }

  /* ── the screen follows the assistant's work (choreo.js, hand.js) ── */
  let base = null;            // the status document when the assistant's turn began
  let baseEnd = null;
  const played = new Set();   // what this turn already lit
  const CAN = () => typeof Hand !== "undefined" && typeof Choreo !== "undefined";
  function whatHappened(before) {
    if (!CAN() || !on) return;
    const fresh = Choreo.changed(base || before, doc).filter((s) => !played.has(`${s.point}|${s.words}`));
    for (const s of fresh) played.add(`${s.point}|${s.words}`);
    Hand.play(fresh, {front: true});
  }
  document.addEventListener("oxtool", (ev) => {
    if (!CAN() || !on) return;
    const {item, phase} = ev.detail;
    Hand.play(Choreo.steps(item, phase, {tab: state.tab, page: v.page}));
  });

  /* ── the bar ───────────────────────────────────────────────────── */
  function paintBar() {
    for (const b of bar.querySelectorAll("button[data-ppage]")) {
      const here = b.dataset.ppage === v.page;
      b.classList.toggle("active", here);
      b.setAttribute("aria-selected", String(here));
    }
    const badge = bar.querySelector('button[data-ppage="questions"] .pm-badge');
    if (badge) { const n = doc ? doc.needs_you.length : 0; badge.textContent = n ? String(n) : ""; badge.hidden = !n; }
  }
  for (const b of bar.querySelectorAll("button[data-ppage]")) b.addEventListener("click", () => go(b.dataset.ppage));
  bar.querySelector("[data-pback]").onclick = () => switchTab(recall(`pmodeFrom:${PID}`, "flow"));

  function go(name) {
    v.page = PAGES[name] ? name : "now";
    save();
    paintBar();
    drawPage();
    pushView();
  }

  /* ── entering and leaving ──────────────────────────────────────── */
  function enter() {
    if (!on) {
      on = true;
      document.body.classList.add("pmode");
      bar.hidden = false;
    }
    if (window.oxAssistant && window.oxAssistant.center) window.oxAssistant.center(chat);
  }
  function leave() {
    if (!on) return;
    on = false;
    clearTimeout(timer);
    document.body.classList.remove("pmode");
    bar.hidden = true;
    if (HAS_BOARD()) BoardView.unmount();
    if (window.oxAssistant && window.oxAssistant.uncenter) window.oxAssistant.uncenter();
  }

  function show(opts) {
    if (opts && opts.page) v.page = PAGES[opts.page] ? opts.page : "now";
    if (opts && opts.mid !== undefined) v.mid = opts.mid;
    save();
    enter();
    paintBar();
    drawSide();
    drawPage();
    refresh();
  }

  // the tab before Project mode is where its back arrow returns
  let prev = state.tab;
  document.addEventListener("oxview", () => {
    if (state.tab !== "project") { if (prev !== state.tab) store(`pmodeFrom:${PID}`, state.tab); prev = state.tab; leave(); }
    else prev = "project";
  });
  // a turn that ended may have changed the project: read it again
  document.addEventListener("oxassistant", (ev) => {
    const now = !!(ev.detail && ev.detail.busy);
    // the turn's start is what "what just happened" compares with, until a while after it ends (two refreshes
    // race at the end: the turn's own and the pulse's; whichever lands compares, `played` keeps it to once)
    if (!busy && now) { clearTimeout(baseEnd); base = doc; played.clear(); }
    if (busy && !now) {
      clearTimeout(baseEnd);
      baseEnd = setTimeout(() => { base = null; }, 30000);
      if (on) { refresh(); if (v.page === "checklist" || v.page === "changes") drawPage(); }
    }
    busy = now;
  });
  document.addEventListener("oxturnended", () => { if (on) refresh(); });
  document.addEventListener("visibilitychange", () => { if (on && !document.hidden) refresh(); });
  MOBILE.addEventListener("change", () => { if (on) drawSide(); });

  /* open what holds a target the hand is about to point at: a plan's phases are drawn once it is unfolded */
  function reveal(target) {
    const m = /^phase:(.+)#[^#]+$/.exec(target || "");
    if (!m || v.page !== "plans" || v.open[m[1]]) return;
    v.open[m[1]] = true;
    save();
    drawPlans();
  }

  registerPane("project", {el: box, show});
  return {page: () => v.page, status: () => doc, refresh, go, reveal};
})();
