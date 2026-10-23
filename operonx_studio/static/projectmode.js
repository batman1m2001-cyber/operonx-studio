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
 *   /p/<pid>/project[/<page>]
 */

"use strict";

const ProjectMode = (() => {
  const box = $("#project");
  const bar = $("#prail");
  const K = `pmode:${PID}`;
  const v = Object.assign({page: "now", open: {}}, recall(K, {}));
  const PAGES = {now: "Now"};
  let doc = null;      // the last status document
  let failed = null;   // why there is none: {message, unavailable}
  let token = 0;
  let timer = null;
  let busy = false;    // the assistant's turn, as last heard
  let on = false;      // the mode is showing

  const save = () => store(K, v);
  const enc = encodeURIComponent;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

  function ago(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  /* ── the frame: the conversation in the centre, the state beside ─── */
  const main = el("div", "pm-main");
  const chat = el("div", "pm-chat");
  chat.id = "pmchat";
  const side = el("aside", "pm-status");
  side.setAttribute("aria-label", "Where the project stands");
  main.append(chat, side);
  box.append(main);

  /* ── the status column ─────────────────────────────────────────── */
  function section(key, title, count, body, opts) {
    const s = el("section", "pm-sec");
    s.dataset.key = key;
    const h = el("h3", "pm-h");
    h.append(el("span", null, title));
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

  function needsYou(items) {
    const list = el("div", "pm-list");
    if (!items.length) { list.append(el("p", "pm-quiet", "Nothing waits for you.")); return list; }
    for (const q of items) {
      const row = el("button", "pm-item pm-q");
      row.type = "button";
      row.dataset.key = `q:${q.source}:${q.milestone || ""}:${q.id}`;
      const where = q.source === "engine" ? `${q.milestone}${q.card ? " · " + q.card : ""}` : "requirements";
      row.append(el("span", "pm-id", q.id), el("span", "pm-text", q.text || q.kind), el("span", "pm-where", where));
      row.title = q.source === "engine" ? "Open it on the milestone's board" : "Ask the assistant about this question";
      row.onclick = () => {
        if (q.source === "engine") performUi("open_board", {mid: q.milestone, card: q.card || ""});
        else if (window.oxAsk) window.oxAsk(`Open question ${q.id} (${q.text}) in docs/brd/requirements/open_questions.md: `
          + "what does it say, what are the options, and what do you recommend?");
      };
      list.append(row);
    }
    return list;
  }

  function workingOn(items) {
    const list = el("div", "pm-list");
    if (!items.length) { list.append(el("p", "pm-quiet", "Nothing is in progress.")); return list; }
    for (const w of items) {
      const row = el("div", "pm-item pm-w");
      row.dataset.key = `w:${w.path || w.milestone}`;
      row.append(el("span", "pm-title", w.title), el("span", "pm-sentence", w.sentence));
      row.title = w.path || `milestone ${w.milestone}`;
      list.append(row);
    }
    return list;
  }

  function checklist(c) {
    const wrap = el("div", "pm-check");
    if (!c.total) { wrap.append(el("p", "pm-quiet", "No checklist yet (docs/brd).")); return wrap; }
    const pct = Math.round((100 * c.verified) / c.total);
    const meter = el("div", "pm-meter");
    meter.setAttribute("role", "progressbar");
    meter.setAttribute("aria-valuenow", String(pct));
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    const fill = el("span");
    fill.style.width = `${pct}%`;
    meter.append(fill);
    wrap.append(el("p", "pm-line", `${c.verified} of ${c.total} requirements verified`), meter);
    if (c.open.length) {
      wrap.append(fold("open-rows", `${plural(c.open.length, "row")} still open`, () => {
        const l = el("div", "pm-list");
        for (const r of c.open) {
          const row = el("div", "pm-item pm-row");
          row.dataset.key = `r:${r.id}`;
          row.append(el("span", "pm-id", r.id), el("span", "pm-text", r.what || r.note || ""),
            el("span", "pm-where", r.status.replace(/_/g, " ")));
          l.append(row);
        }
        return l;
      }));
    }
    return wrap;
  }

  const PLAN_WORDS = {in_progress: "in progress", plan: "planned", parked: "parked", done: "done"};
  function plans(d) {
    const wrap = el("div", "pm-plans");
    const counts = {};
    for (const p of d.plans) counts[p.status] = (counts[p.status] || 0) + 1;
    const parts = ["in_progress", "plan", "parked", "done"].filter((s) => counts[s]).map((s) => `${counts[s]} ${PLAN_WORDS[s]}`);
    wrap.append(el("p", "pm-line", parts.length ? parts.join(" · ") : "No plan says where it stands yet."));
    for (const e of d.plan_errors) wrap.append(el("p", "pm-bad", e));
    if (d.unmarked.length) {
      const note = el("div", "pm-note");
      note.append(el("span", null, `${plural(d.unmarked.length, "plan doc")} ${d.unmarked.length === 1 ? "has" : "have"} no status block.`));
      const ask = el("button", "linkbtn", "Ask the assistant to add them");
      ask.type = "button";
      ask.onclick = () => window.oxAsk && window.oxAsk("Add the status block (docs/PROJECT_MODE_PLAN D1: title, status, "
        + "phases with their status, rows, updated) to every plan doc that has none: "
        + `${d.unmarked.join(", ")}. Read each plan and the git log to set each phase's real status; `
        + "then run operonx-project brd check and fix what it says.");
      note.append(ask);
      wrap.append(note);
    }
    return wrap;
  }

  function changes(list) {
    const l = el("div", "pm-list");
    if (!list.length) { l.append(el("p", "pm-quiet", "No commits yet.")); return l; }
    for (const ch of list.slice(0, 6)) {
      const row = el("div", "pm-item pm-commit");
      row.dataset.key = `c:${ch.sha}`;
      row.title = `${ch.sha} · ${ch.author} · ${ch.at}`;
      row.append(el("span", "pm-text", ch.subject), el("span", "pm-where", ago(ch.at)));
      l.append(row);
    }
    return l;
  }

  function drawSide() {
    side.textContent = "";
    if (failed) {
      side.append(section("engine", "Project status", null, failed.unavailable
        ? paneNote("The builder is not installed", `${failed.message}. Install it beside the studio: `
          + "./install.sh in the operonx-studio checkout installs operonx-project with it.")
        : el("div", "errbox", failed.message)));
      return;
    }
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
      section("needs", "Needs you", needs, needsYou(d.needs_you), {hot: needs > 0}),
      section("working", "Working on", d.working_on.length || null, workingOn(d.working_on)),
      section("checklist", "Checklist", null, checklist(d.checklist)),
      section("plans", "Plans", d.plans.length || null, plans(d)),
      section("changes", "Recent changes", null, changes(d.changes)));
    const s = d.setup;
    const setup = el("p", "pm-setup", `${s.practices.line} · ${s.engine ? `the engine's daemon ${s.daemon ? "is running" : "is stopped"}` : "the engine has not run here"}${s.model ? ` · model ${s.model}` : ""}`);
    wrap.append(setup);
    side.append(wrap);
  }

  /* ── reading the status ─────────────────────────────────────────── */
  async function refresh() {
    const mine = ++token;
    try {
      const got = await api(`/api/p/${PID}/project/status`);
      if (mine !== token) return;
      doc = got.project;
      failed = null;
    } catch (err) {
      if (mine !== token) return;
      const d = err.data || {};
      failed = {message: d.message || err.message, unavailable: d.status === "unavailable"};
    }
    if (on) drawSide();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!on || document.hidden) return;
    timer = setTimeout(refresh, 15000);
  }

  /* ── the bar ───────────────────────────────────────────────────── */
  function paintBar() {
    for (const b of bar.querySelectorAll("button[data-ppage]")) {
      const here = b.dataset.ppage === v.page;
      b.classList.toggle("active", here);
      b.setAttribute("aria-selected", String(here));
    }
    const qs = bar.querySelector('button[data-ppage="questions"] .pm-badge');
    if (qs) { const n = doc ? doc.needs_you.length : 0; qs.textContent = n ? String(n) : ""; qs.hidden = !n; }
  }
  for (const b of bar.querySelectorAll("button[data-ppage]")) b.onclick = () => go(b.dataset.ppage);
  bar.querySelector("[data-pback]").onclick = () => switchTab(recall(`pmodeFrom:${PID}`, "flow"));

  function go(page) {
    v.page = PAGES[page] ? page : "now";
    save();
    paintBar();
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
    if (window.oxAssistant && window.oxAssistant.uncenter) window.oxAssistant.uncenter();
  }

  function show(opts) {
    if (opts && opts.page) v.page = PAGES[opts.page] ? opts.page : "now";
    enter();
    paintBar();
    drawSide();
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
    if (busy && !now && on) refresh();
    busy = now;
  });
  document.addEventListener("oxturnended", () => { if (on) refresh(); });
  document.addEventListener("visibilitychange", () => { if (on && !document.hidden) refresh(); });
  MOBILE.addEventListener("change", () => { if (on) drawSide(); });

  registerPane("project", {el: box, show});
  return {page: () => v.page, status: () => doc, refresh};
})();
