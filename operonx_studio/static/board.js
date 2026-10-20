/* operonx studio — Board: an operonx-project milestone, three ways.
 *
 * A project driven by operonx-project keeps its board in its own store
 * (.operonx/project/project.db); the studio reads it (projectboard.py) and
 * acts only through the engine (`operonx-project api`), so an answer here
 * follows the same rules as one from the CLI or Telegram — a stale one is
 * refused and says what is current.
 *
 *   Board      what is moving, and what is stuck (the columns, the card)
 *   Checklist  which requirements are met, with what evidence (the BRD's matrix)
 *   Graph      what depends on what, in waves
 *   Project    the whole project's checklist, from the checkout's docs/brd
 *
 * "Waiting on you" sits above them. The tab appears when the project has a
 * store or a BRD folder (docs/brd, made by `operonx init`); before the first
 * milestone it is the project's checklist alone. It follows the milestone
 * by its event cursor.
 */

"use strict";

const BoardView = (() => {
  const box = $("#board");
  const tabBtn = document.querySelector('.tabs button[data-tab="board"]');
  const K = `board:${PID}`;
  const v = Object.assign({mid: "", view: "board", card: "", filter: "all"}, recall(K, {}));
  let token = 0;
  let timer = null;
  let last = null;     // the milestone as last drawn: {cursor, questions}
  let drafts = {};     // words being typed into a question, kept across redraws
  let asking = false;  // the New request box is open

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
  const ROW_OK = new Set(["implemented_verified"]);
  const ROW_OUT = new Set(["out_of_scope_demo", "not_applicable", "superseded"]);

  function hours(s) {
    if (s == null) return "—";
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const money = (x) => x == null ? "—" : `$${Number(x).toFixed(2)}`;

  /* ── acting: everything goes to the engine ───────────────────────── */
  async function act(body, done) {
    try {
      const got = await api(`${base()}/${enc(v.mid)}/act`, body);
      toast(got.message || "Done");
      if (done) done(got);
    } catch (err) {
      const d = err.data || {};
      toast(d.message || err.message, true);
      if (d.status === "stale" || d.status === "already") last = null;
    }
    refresh(true);
  }

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
      box.append(paneNote("No board here", "This project is not driven by operonx-project. Start a milestone with "
        + "`operonx project start --title … --source <requirements>` and run its daemon; the board shows here."));
      return;
    }
    if (list.error) { box.textContent = ""; box.append(el("div", "errbox", list.error)); return; }
    const ms = list.milestones || [];
    if (!ms.length) {
      let ck = null;
      if (list.brd) {
        try { ck = await api(`/api/p/${PID}/brd`); } catch (err) { ck = {error: err.message}; }
        if (mine !== token) return;
      }
      drawProject(ck, list);
      return;
    }
    if (!ms.some((m) => m.id === v.mid)) v.mid = ms[ms.length - 1].id;
    let data;
    try { data = await api(`${base()}/${enc(v.mid)}`); }
    catch (err) { box.textContent = ""; box.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    if (v.view === "project" && !list.brd) v.view = "board";
    let checklist = null;
    if (v.view === "checklist" || v.view === "project") {
      const url = v.view === "project" ? `/api/p/${PID}/brd` : `${base()}/${enc(v.mid)}/checklist`;
      try { checklist = await api(url); }
      catch (err) { checklist = {error: err.message}; }
      if (mine !== token) return;
    }
    let card = null;
    if (v.card && data.cards.some((c) => c.id === v.card)) {
      try { card = await api(`${base()}/${enc(v.mid)}/card/${enc(v.card)}`); } catch { card = null; }
      if (mine !== token) return;
    }
    draw(ms, data, checklist, card, list);
    last = {cursor: data.cursor, questions: data.questions.map((q) => q.id).join()};
    schedule();
  }

  /* the board follows its milestone: a cheap read every few seconds, a
   * redraw only when the event cursor moved */
  function schedule() {
    clearTimeout(timer);
    if (state.tab !== "board" || document.hidden) return;
    timer = setTimeout(() => refresh(false), 3000);
  }
  async function refresh(force) {
    if (state.tab !== "board") return;
    if (force || !last) { show(); return; }
    try {
      const d = await api(`${base()}/${enc(v.mid)}`);
      if (d.cursor !== last.cursor || d.questions.map((q) => q.id).join() !== last.questions) { show(); return; }
    } catch { /* the next tick tries again */ }
    schedule();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.tab === "board") refresh(false); });

  /* ── the page ─────────────────────────────────────────────────────── */
  /* a project with a BRD and no milestone yet: its checklist is the board */
  function drawProject(ck, info) {
    clearTimeout(timer);
    last = null;
    keepAsk();
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Board"), el("span", "count", "project checklist"), el("div", "spacer"), askBtn(),
      daemonCtl(info));
    box.append(head);
    if (asking) box.append(askBox());
    box.append(paneNote("No milestone yet", "The checklist below is docs/brd as this checkout has it. Tick the "
      + "rows to build and press Build: a milestone plans them as cards, and the daemon (Run) moves them here."));
    if (ck) box.append(checklistView(ck, true));
    else box.append(paneNote("No BRD folder", "`operonx-project brd init` makes docs/brd/."));
  }

  /* Run / Stop: the project's daemon, which drives every milestone */
  function daemonCtl(info) {
    const wrap = el("span", "bdctl");
    const d = (info && info.daemon) || {};
    if (info && info.sandbox === false) {
      const b = el("span", "chip cwarn", "unsandboxed");
      b.title = "This machine runs the coders without the shell sandbox (.operonx/project/settings.toml)";
      wrap.append(b);
    }
    const ms = (info && info.models) || {};
    const roles = Object.entries(ms.models || {});
    if (ms.model || roles.length) {
      const m = el("span", "chip", `models: ${ms.model || "default"}${roles.length ? ` +${roles.length}` : ""}`);
      m.title = "The models the sessions run on (.operonx/project/settings.toml); the assistant changes them"
        + (roles.length ? `\n${roles.map(([r, x]) => `${r}: ${x}`).join("\n")}` : "");
      wrap.append(m);
    }
    const pr = info && info.practices;
    if (pr) wrap.append(practicesChip(pr));
    wrap.append(el("span", `status ${d.running ? "s-run" : "s-idle"}`, d.running ? "daemon running" : "daemon stopped"));
    const b = el("button", `${d.running ? "" : "primary"} needs-edit`, d.running ? "Stop" : "Run");
    b.type = "button";
    b.title = d.running ? "Stop the daemon: running sessions stop, the board keeps its state"
      : "Start the daemon: it runs the queued commands and drives the milestones";
    b.onclick = async () => {
      b.disabled = true;
      try {
        const got = await api(`${base()}/daemon`, {action: d.running ? "stop" : "start"});
        toast(got.message || got.status);
      } catch (err) { toast((err.data || {}).message || err.message, true); }
      refresh(true);
    };
    wrap.append(b);
    return wrap;
  }

  /* how the project is built (docs/brd/practices.toml): one chip, the details on hover */
  function practicesChip(pr) {
    if (pr.error) {
      const c = el("span", "chip cwarn", "practices: broken");
      c.title = `${pr.error}: a milestone will not start until it parses (ask the assistant to fix it)`;
      return c;
    }
    const arch = [pr.style, pr.layers ? `${pr.layers} layers` : "", pr.contexts ? `${pr.contexts} contexts` : "",
                  pr.private === "forbid" ? "no private access" : ""].filter(Boolean);
    const c = el("span", "chip", [`TDD ${pr.tdd}`, ...(arch.length ? [arch.join(", ")] : [])].join(" · "));
    c.title = "How the project is built (docs/brd/practices.toml, committed); the assistant reads and sets it"
      + `\nTests: ${pr.tdd}${pr.tdd === "strict" ? " (they must fail before the code)" : pr.tdd === "off" ? " (none written)" : ""}`
      + (arch.length || pr.forbid || pr.command ? `\nArchitecture, checked every round: ${[...arch, pr.forbid ? `${pr.forbid} forbidden import rule(s)` : "", pr.command ? "its own command" : ""].filter(Boolean).join(", ")}` : "")
      + (pr.done ? `\nDone means ${pr.done} more check(s) pass` : "")
      + (pr.lessons ? `\nLessons: ${pr.lessons}` : "");
    return c;
  }

  /* New request: the owner's words become rows (the engine extracts them into
   * the BRD) and a milestone for them, which waits for approval */
  function keepAsk() {
    const ta = box.querySelector("textarea[data-ask]");
    if (ta) { drafts.__ask = ta.value; drafts.__askAt = document.activeElement === ta ? ta.selectionStart : -1; }
  }
  function askBtn() {
    const b = el("button", `${asking ? "" : "primary"} needs-edit`, asking ? "Close request" : "New request");
    b.type = "button";
    b.title = "Ask for something new in your words: it becomes requirements in the checklist and a milestone "
      + "planned for them, which waits for your approval";
    b.onclick = () => { keepAsk(); asking = !asking; drafts.__askAt = null; show(); };
    return b;
  }
  function askBox() {
    const sec = el("section", "bdask needs-edit");
    sec.append(el("div", "bdwaithead", "New request"));
    sec.append(el("div", "note", "Say what you want, as you would to a person. The engine writes it into the BRD "
      + "as your request, turns it into checklist rows, plans cards for them and asks for your approval."));
    const ta = el("textarea");
    ta.dataset.ask = "1";
    ta.rows = 4;
    ta.placeholder = "e.g. The tip screen should remember the last tip percent I used.";
    ta.value = drafts.__ask || "";
    const row = el("div", "bdopts");
    const send = el("button", "primary", "Send request");
    send.type = "button";
    send.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      send.disabled = true;
      try {
        const got = await api(`${base()}/request`, {text});
        toast(got.message);
        delete drafts.__ask;
        asking = false;
        Object.assign(v, {mid: got.milestone, view: "board", card: ""});
        save();
      } catch (err) { toast((err.data || {}).message || err.message, true); send.disabled = false; return; }
      refresh(true);
    };
    row.append(send);
    sec.append(ta, row);
    const at = drafts.__askAt == null ? ta.value.length : drafts.__askAt;  // a redraw keeps the caret
    if (at >= 0) setTimeout(() => { ta.focus(); ta.setSelectionRange(at, at); }, 0);
    return sec;
  }

  async function build(rows) {
    const title = prompt(`A milestone for ${rows.length} row${rows.length > 1 ? "s" : ""}: its title`, "");
    if (!title || !title.trim()) return;
    try {
      const got = await api(`${base()}/new`, {title: title.trim(), rows});
      toast(got.message);
      Object.assign(v, {mid: got.milestone, view: "board", card: ""});
      save();
    } catch (err) { toast((err.data || {}).message || err.message, true); }
    refresh(true);
  }

  function draw(list, data, checklist, card, info) {
    const brd = info && info.brd;
    const m = data.milestone;
    // keep what is being typed: a redraw must not eat the owner's words
    for (const ta of box.querySelectorAll("textarea[data-q]")) drafts[ta.dataset.q] = ta.value;
    keepAsk();
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
    head.append(el("div", "spacer"), views(brd), controls(m, data), askBtn(), daemonCtl(info));
    box.append(head);
    if (asking) box.append(askBox());
    box.append(summary(m, data));
    if (data.questions.length) box.append(waiting(data.questions));
    if (v.view === "checklist" || v.view === "project") box.append(checklistView(checklist, v.view === "project"));
    else if (v.view === "graph") box.append(graphView(data));
    else box.append(columnsView(data));
    if (card && v.view !== "checklist" && v.view !== "project") box.append(cardPanel(card, data));
  }

  function views(brd) {
    const seg = el("div", "viewseg bdviews");
    seg.setAttribute("role", "radiogroup");
    const keys = [["board", "Board"], ["checklist", "Checklist"], ["graph", "Graph"]];
    if (brd) keys.push(["project", "Project"]);
    for (const [key, label] of keys) {
      const b = el("button", v.view === key ? "on" : null, label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(v.view === key));
      b.onclick = () => go({view: key});
      seg.append(b);
    }
    return seg;
  }

  function controls(m, data) {
    const wrap = el("span", "bdctl");
    const btn = (label, cls, fn, title) => {
      const b = el("button", `${cls || ""} needs-edit`, label);
      b.type = "button";
      if (title) b.title = title;
      b.onclick = fn;
      wrap.append(b);
    };
    const live = ["discovering", "requirements", "planning", "running", "verifying", "waiting_human", "awaiting_approval"];
    if (m.state === "paused") btn("Resume", "primary", () => act({op: "unpause"}));
    else if (live.includes(m.state)) btn("Pause", null, () => act({op: "pause"}), "Running cards end their round; nothing new starts");
    else if (m.state === "failed") {
      btn("Retry", "primary", () => act({op: "retry"}), "Failed cards go back to Ready and the milestone runs again");
    } else if (m.state === "budget_exhausted") {
      btn("Add budget", "primary", () => {
        const usd = prompt(`Extra budget for ${m.id}, in US$`, "5");
        if (usd && Number(usd) > 0) act({op: "retry", usd: Number(usd)});
      }, "Raise the cap; the milestone goes on where it stopped");
    }
    const sh = data && data.shipped;
    if (data && data.shippable && !sh) {  // an adopted baseline (m0) has no branch: nothing to ship
      btn("Ship", "primary", () => {
        if (confirm(`Ship ${m.id}? Its branch is pushed and the PR opened (on GitLab: a link to open the MR).`)) {
          act({op: "ship"});
        }
      }, "Push the milestone's branch and open its PR: the one step the engine never takes by itself");
    }
    if (sh && sh.pr) {
      const a = el("a", "chip", sh.merged ? "merged" : sh.remote === "gitlab" ? "Open the MR form" : "PR");
      a.href = sh.pr;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = `${sh.branch} → ${sh.base}`;
      wrap.append(a);
    } else if (sh) wrap.append(el("span", "chip", `pushed ${sh.branch}`));
    if (sh && sh.remote === "github" && !sh.merged && data.merge_granted) {
      btn("Merge", null, () => {
        if (confirm(`Merge ${m.id}'s PR into ${sh.base}? Its checks are read first.`)) act({op: "merge"});
      }, "Merge the PR once its checks pass (granted in settings.toml)");
    }
    if (!["done", "cancelled"].includes(m.state)) {
      btn("Cancel", "danger", () => {
        if (confirm(`Cancel ${m.id} (${m.title})? Its cards stop; merged work stays on its branch.`)) act({op: "cancel"});
      });
    }
    return wrap;
  }

  function summary(m, data) {
    const s = el("div", "bdsum");
    const [label, cls] = STATE[m.state] || [m.state, "s-idle"];
    s.append(el("span", `status ${cls}`, label));
    const bits = [m.mode.toUpperCase(), `${m.done}/${m.cards} cards done`,
                  `${money(m.cost_usd)} of ${money(m.budget_usd)}`,
                  `${hours(m.running_s)} of ${m.max_hours == null ? "—" : `${m.max_hours} h`}`];
    if (m.replans) bits.push(`${m.replans} replan${m.replans > 1 ? "s" : ""}`);
    for (const b of bits) s.append(el("span", "bdbit", b));
    // linked milestones (D17): what this one waits for, and who waits for it
    for (const n of data.needs || []) {
      const c = el("span", `chip ${n.state === "done" ? "" : "cwarn"}`, `needs ${n.ref}: ${n.state ? (STATE[n.state] || [n.state])[0] : "not found"}`);
      c.title = "This milestone starts when the one it needs is delivered";
      s.append(c);
    }
    for (const n of data.needed_by || []) {
      const c = el("span", "chip", `needed by ${n.ref}`);
      c.title = "That milestone waits until this one is delivered";
      s.append(c);
    }
    const arch = data.architecture;
    if (arch) {
      const c = el("span", `chip ${arch.ok ? "cok" : ""}`, arch.ok ? "architecture clean" : `${arch.violations} architecture violation${arch.violations === 1 ? "" : "s"} before it`);
      c.title = arch.ok ? "The architecture check passed on the milestone's base: every round keeps it so"
        : "Already in the code when the milestone started: they cost its cards nothing; a new one fails a round";
      s.append(c);
    }
    const wrap = el("div", "bdhead");
    wrap.append(s);
    if (m.reason) wrap.append(el("div", "bdreason", m.resume_at
      ? `${m.reason} (it goes on by itself ${fmtAgo(m.resume_at * 1000).replace(" ago", "")})` : m.reason));
    if (data.retro) wrap.append(retroView(data.retro));
    if (data.plan && (data.plan.notes || []).length && m.state === "awaiting_approval") {
      const notes = el("div", "bdnotes");
      notes.append(el("b", null, "The plan's review still says:"));
      const ul = el("ul");
      for (const n of data.plan.notes.slice(0, 8)) ul.append(el("li", null, typeof n === "string" ? n : (n.note || JSON.stringify(n))));
      notes.append(ul);
      wrap.append(notes);
    }
    return wrap;
  }

  /* a delivered milestone's retrospective: where the rounds and the money went, and what it taught */
  function retroView(retro) {
    const rep = retro.report || {};
    const cards = rep.cards || [];
    const box = el("div", "bdnotes");
    const stages = Object.entries(rep.by_stage || {}).map(([k, x]) => `${k} ${money(x)}`).join(" · ");
    box.append(el("b", null, "Retrospective"), el("span", null,
      ` ${money(rep.cost_usd)} over ${cards.length} card${cards.length === 1 ? "" : "s"}, ${rep.rounds} round${rep.rounds === 1 ? "" : "s"}`
      + (stages ? ` · ${stages}` : "")));
    const costly = cards.filter((c) => c.rounds > 1 || (c.questions || []).length || (c.rewritten || []).length);
    const ul = el("ul");
    for (const c of costly.slice(0, 6)) {
      const bits = [`${c.rounds} rounds`, money(c.cost_usd)];
      if ((c.failed_checks || []).length) bits.push(`failed on ${c.failed_checks.join(", ")}`);
      if ((c.questions || []).length) bits.push(`${c.questions.length} question${c.questions.length > 1 ? "s" : ""} for you`);
      if ((c.rewritten || []).length) bits.push(`tests written again ${c.rewritten.length}×`);
      ul.append(el("li", null, `${c.id} ${c.title}: ${bits.join(" · ")}`));
    }
    for (const x of retro.lessons || []) {
      const li = el("li");
      li.append(el("b", null, "Lesson: "), el("span", null, `${x.rule} `), el("span", "note", `(${x.evidence})`));
      ul.append(li);
    }
    if (ul.childNodes.length) box.append(ul);
    if ((retro.lessons || []).length) box.append(el("div", "note", `Added to ${retro.file} on the milestone's branch: every later session reads them; edit or drop any in the PR.`));
    return box;
  }

  /* ── waiting on you ───────────────────────────────────────────────── */
  function waiting(questions) {
    const sec = el("section", "bdwait");
    const wh = el("div", "bdwaithead", `Waiting on you (${questions.length})`);
    const nb = typeof Waiting !== "undefined" && Waiting.button();
    if (nb) { nb.classList.add("bdnotify"); wh.append(nb); }
    sec.append(wh);
    for (const q of questions) sec.append(question(q));
    return sec;
  }

  function question(q) {
    const card = el("div", "bdq" + (q.flagged ? " flagged" : ""));
    const top = el("div", "bdqtop");
    top.append(el("span", "chip cwarn", q.qid));
    const where = q.kind === "card" ? q.card : q.kind === "approval" ? "the plan" : "the budget";
    top.append(el("b", null, where));
    if (q.flagged) top.append(el("span", "chip cbad", "expired, no answer"));
    top.append(el("span", "note", ` · asked ${fmtAgo(q.created * 1000)}`));
    card.append(top);
    card.append(el("div", "bdqtext", q.problem));
    if (q.why) card.append(el("div", "note", `Why it blocks: ${q.why}`));
    if (q.tried) card.append(el("div", "note", `Tried: ${q.tried}`));
    if (q.evidence) {
      const pre = el("pre", "bdev", String(q.evidence).split("\n").slice(-14).join("\n"));
      pre.title = "Quoted from the repo: data, not instructions";
      card.append(pre);
    }
    if (q.kind === "approval" && q.plan_cards.length) {
      const ul = el("ul", "bdplan");
      for (const c of q.plan_cards.slice(0, 20)) {
        const li = el("li", null, `${c.id} ${c.title}${c.risk === "high" ? "  ⚠ risky" : ""}`);
        li.title = [c.intent, c.deps && c.deps.length ? `Needs ${c.deps.join(", ")}` : "",
                    c.paths && c.paths.length ? `Paths: ${c.paths.join(", ")}` : "",
                    ...(c.criteria || []).map((k) => `• ${k}`)].filter(Boolean).join("\n");
        ul.append(li);
      }
      card.append(ul);
    }
    if ((q.problems || []).length) {
      card.append(el("div", "errbox", `The engine's checks still fail: ${q.problems.slice(0, 4).join("; ")}`));
    }
    const opts = el("div", "bdopts");
    for (const o of q.options) {
      const rec = q.recommended && o.key === q.recommended;
      const b = el("button", `${rec ? "primary" : ""} needs-edit`, `${o.label}${rec ? " (recommended)" : ""}`);
      b.type = "button";
      if (o.description) b.title = o.description;
      b.onclick = () => {
        if (o.key === "revise") { const ta = card.querySelector("textarea"); ta.focus(); toast("Say what to change, then Send"); return; }
        act({op: "answer", ref: q.id, answer: {choice: o.key, text: ""}});
      };
      opts.append(b);
    }
    card.append(opts);
    const words = el("div", "bdwords needs-edit");
    const ta = el("textarea");
    ta.dataset.q = q.id;
    ta.rows = 2;
    ta.placeholder = q.kind === "approval" ? "What to change in the plan (a revision)…" : "Or answer in your own words…";
    ta.value = drafts[q.id] || "";
    const send = el("button", null, "Send");
    send.type = "button";
    send.onclick = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      act({op: "answer", ref: q.id, answer: text}, () => { delete drafts[q.id]; });
    };
    words.append(ta, send);
    card.append(words);
    return card;
  }

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
    const t = el("button", `bdcard st-${c.state}${c.id === v.card ? " sel" : ""}${c.asks ? " asks" : ""}`);
    t.type = "button";
    const top = el("div", "bdcardtop");
    top.append(el("b", "mono", c.id));
    if (c.kind === "init") top.append(el("span", "chip", "init"));
    if (c.risk === "high") top.append(el("span", "chip cwarn", "risky"));
    if (c.asks) top.append(el("span", "chip cwarn", "asks you"));
    if (c.red && c.red.red) {
      const r = el("span", "chip cok", "red first");
      r.title = "Strict TDD: its acceptance tests failed before the code" + (c.red.rewritten ? " (written again: the first set passed already)" : "");
      top.append(r);
    } else if (c.red) top.append(el("span", "chip cwarn", "tests passed early"));
    if (c.tdd === "off") top.append(el("span", "chip", "no tests"));
    if (c.taken) {
      // short on the tile: who (the assistant, or a name), the full actor on hover
      const who = /\/assistant$/.test(c.taken) ? "assistant" : c.taken.replace(/^[a-z]+:/, "");
      const chip = el("span", "chip ctaken", c.waiting_for_submit ? `${who} works it` : who);
      chip.title = `Taken by ${c.taken}${c.waiting_for_submit ? ": the engine waits for a submit" : ""}`;
      top.append(chip);
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
    if (c.cost_usd) meta.push(money(c.cost_usd));
    if (meta.length) t.append(el("div", "bdcardmeta", meta.join(" · ")));
    if (["failed", "blocked", "cancelled"].includes(c.state) && c.reason) t.append(el("div", "bdcardwhy", c.reason.slice(0, 140)));
    t.onclick = () => go({card: c.id === v.card ? "" : c.id});
    return t;
  }

  function cardPanel(got, data) {
    const c = got.card;
    const p = el("section", "bdpanel");
    const top = el("div", "bdpaneltop");
    top.append(el("b", "mono", c.id), el("span", null, ` ${c.title}`));
    top.append(el("span", "chip", CARD[c.state] || c.state));
    if (c.stage) top.append(el("span", "chip crun", c.stage));
    top.append(el("div", "spacer"));
    if (["pending", "ready", "blocked"].includes(c.state)) {
      const up = el("button", "linkbtn needs-edit", "Run it sooner");
      up.type = "button";
      up.title = "Lower priority runs first";
      up.onclick = () => act({op: "prioritize", card: c.id, priority: (c.priority || 0) - 1});
      top.append(up);
    }
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
    fact("Held-out tests", c.heldout ? `${c.heldout} file(s), hidden from the implementer` : "");
    fact("Test first", c.tdd === "off" ? "off: no tests written; the checks and the review judge it"
      : !c.red ? "" : c.red.red ? `failed before the code${c.red.rewritten ? " (the first set passed already: written again)" : ""}`
      : `${c.red.passed} passed before the code, after a rewrite`);
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

  function eventText(e) {
    const d = e.data || {};
    if (e.kind === "card.state") return `${d.from} → ${d.to}${d.reason ? ` — ${String(d.reason).slice(0, 160)}` : ""}`;
    if (d.reason) return String(d.reason).slice(0, 160);
    const s = JSON.stringify(d);
    return s === "{}" ? "" : s.slice(0, 160);
  }

  /* ── Checklist: the requirements matrix ───────────────────────────── */
  function checklistView(ck, selectable) {
    const wrap = el("div", "bdcheck");
    if (!ck) return wrap;
    if (ck.error) { wrap.append(el("div", "errbox", ck.error)); return wrap; }
    if (!ck.rows.length) { wrap.append(paneNote("No requirements yet", ck.note || "The matrix has no rows yet.")); return wrap; }
    const counts = el("div", "bdsum");
    const total = ck.rows.length;
    const ok = ck.rows.filter((r) => ROW_OK.has(r.status)).length;
    counts.append(el("span", "bdbit", `${ok}/${total} verified`));
    for (const [st, n] of Object.entries(ck.counts)) if (!ROW_OK.has(st)) counts.append(el("span", "bdbit", `${n} ${st.replaceAll("_", " ")}`));
    counts.append(el("span", "note", ` · from ${ck.branch || ck.brd}`));
    wrap.append(counts);
    const seg = el("div", "viewseg bdfilter");
    for (const [key, label] of [["all", "All"], ["open", "Not verified"], ["asked", "Blocked by a question"]]) {
      const b = el("button", v.filter === key ? "on" : null, label);
      b.type = "button";
      b.onclick = () => go({filter: key});
      seg.append(b);
    }
    wrap.append(seg);
    const col = (name) => ck.header.findIndex((h) => h.toLowerCase().startsWith(name));
    const short = col("requirement");
    const rows = ck.rows.filter((r) => v.filter === "all" ? true
      : v.filter === "open" ? !ROW_OK.has(r.status) && !ROW_OUT.has(r.status) : r.questions.length > 0);
    const scroll = el("div", "bdtablewrap");
    const table = el("table", "bdtable");
    const thead = el("thead");
    const hr = el("tr");
    const picked = new Set();
    const buildBtn = el("button", "primary needs-edit", "Build");
    buildBtn.type = "button";
    buildBtn.disabled = true;
    buildBtn.onclick = () => build([...picked]);
    const openRow = (r) => !ROW_OK.has(r.status) && !ROW_OUT.has(r.status);
    if (selectable && ck.rows.some(openRow)) {
      const bar = el("div", "bdbuild");
      bar.append(el("span", "note", "Tick the rows to build, then"), buildBtn);
      wrap.append(bar);
    }
    if (selectable) hr.append(el("th", null, ""));
    for (const h of ["ID", "Status", "Requirement", "Tests", "Questions"]) hr.append(el("th", null, h));
    thead.append(hr);
    const tb = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      if (selectable) {
        const td = el("td");
        if (openRow(r)) {
          const cb = el("input");
          cb.type = "checkbox";
          cb.setAttribute("aria-label", `build ${r.id}`);
          cb.onchange = () => {
            cb.checked ? picked.add(r.id) : picked.delete(r.id);
            buildBtn.disabled = !picked.size;
            buildBtn.textContent = picked.size ? `Build ${picked.size}` : "Build";
          };
          td.append(cb);
        }
        tr.append(td);
      }
      tr.append(el("td", "mono", r.id));
      const st = el("td");
      st.append(el("span", `chip ${ROW_OK.has(r.status) ? "cok" : r.status === "needs_clarification" ? "cwarn" : ""}`, r.status.replaceAll("_", " ")));
      tr.append(st, el("td", null, short >= 0 ? r.cells[short] || "" : ""));
      const tests = el("td", "mono bdtests");
      for (const t of r.tests) tests.append(el("div", null, t));
      tr.append(tests, el("td", "mono", r.questions.join(", ")));
      tb.append(tr);
    }
    table.append(thead, tb);
    scroll.append(table);
    wrap.append(scroll);
    if ((ck.questions || []).length) {
      wrap.append(el("div", "stitle bdqhead", "Questions in the BRD"));
      const ul = el("ul", "bdqlist");
      for (const q of ck.questions) {
        const li = el("li");
        li.append(el("span", "mono", q.id), el("span", `chip ${q.state === "resolved" ? "cok" : "cwarn"}`, q.state), el("span", null, ` ${q.topic}`));
        ul.append(li);
      }
      wrap.append(ul);
    }
    return wrap;
  }

  /* ── Graph: the card DAG in waves, plain wires ────────────────────── */
  function graphView(data) {
    const wrap = el("div", "bdgraph");
    const waves = data.graph.waves;
    if (!waves.length) { wrap.append(paneNote("No cards yet", "The plan's cards show here once it is approved.")); return wrap; }
    const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
    const W = 190, H = 58, GX = 70, GY = 18, PAD = 12;
    const height = Math.max(...waves.map((w) => w.length)) * (H + GY) + PAD * 2 + 22;
    const width = waves.length * (W + GX) - GX + PAD * 2;
    const plane = el("div", "bdplane");
    plane.style.width = `${width}px`;
    plane.style.height = `${height}px`;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "wires bdwires");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const at = {};
    waves.forEach((wave, i) => {
      const lab = el("div", "bdwave", `Wave ${i + 1}`);
      lab.style.left = `${PAD + i * (W + GX)}px`;
      plane.append(lab);
      wave.forEach((id, j) => {
        const x = PAD + i * (W + GX), y = PAD + 22 + j * (H + GY);
        at[id] = {x, y};
        const n = tile(byId[id]);
        n.classList.add("bdnode");
        Object.assign(n.style, {left: `${x}px`, top: `${y}px`, width: `${W}px`, height: `${H}px`});
        plane.append(n);
      });
    });
    for (const [from, to] of data.graph.edges) {
      if (!at[from] || !at[to]) continue;
      const a = at[from], b = at[to];
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, dx = Math.max(30, (x2 - x1) / 2);
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
      path.setAttribute("class", `bdwire${byId[from].state === "done" ? " met" : ""}`);
      svg.append(path);
    }
    plane.prepend(svg);
    wrap.append(plane);
    return wrap;
  }

  /* the assistant points at a milestone, a card or a view (performUi "open_board") */
  function open(patch) {
    const keep = Object.fromEntries(Object.entries(patch || {}).filter(([k, x]) => ["mid", "card", "view"].includes(k) && x));
    if (keep.mid && keep.mid !== v.mid && !keep.card) keep.card = "";
    Object.assign(v, keep); save();
    if (state.tab !== "board") switchTab("board"); else show();
  }

  probe();
  registerPane("board", {el: box, show});
  return {show, probe, open};
})();
