/* operonx studio — Project mode: the studio as the place a project is built
 * from (docs/PROJECT_MODE_PLAN.md D3).
 *
 * A mode of the studio, chat first: the main menu gives way to the
 * project's own icon bar, the assistant (Claude Code, working by the
 * project's conventions) takes the centre, and beside it the project's
 * state, read from the engine's one status document (`operonx-project api
 * {"op": "status"}`, D2) — what needs the owner and the cards in progress
 * (docs/CYCLES_PLAN.md: what links to no card is not here). The screen and the assistant
 * read the same document, so they never disagree. The column refreshes
 * after every assistant turn, every 15 s while it shows, and when the tab
 * comes back.
 *
 *   Now        the conversation, and beside it where the project stands
 *   Board      docs/brd/board.md's cards (board.js)
 *   Git        what changed, the branches, the history (git.js)
 *   Files      the project's files, read-only; what changed lately is marked
 *   Settings   the standard, and what the assistant may do with git
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
  const v = Object.assign({page: "now", open: {}, fopen: {}, file: "", fonly: false}, recall(K, {}));
  delete v.mid;
  if (v.page === "plans") v.page = "board";
  const PAGES = {now: "Now", board: "Board", changes: "Git", files: "Files", terminal: "Terminal",
                 environments: "Environments", settings: "Settings"};
  let doc = null;      // the last status document
  let failed = null;   // why there is none: {message, unavailable}
  let token = 0;
  let pageToken = 0;
  let timer = null;
  let busy = false;    // the assistant's turn, as last heard
  let on = false;      // the mode is showing
  const drafts = {};   // words being typed on Settings, kept across redraws

  // board.js's view (a top-level const: not on window)
  const HAS_BOARD = () => typeof BoardView !== "undefined";
  const HAS_TERM = () => typeof TerminalPage !== "undefined";
  const HAS_GIT = () => typeof GitPage !== "undefined";
  const HAS_ENV = () => typeof EnvPage !== "undefined";
  const save = () => store(K, v);
  const enc = encodeURIComponent;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
  // a name the assistant's hand can reach (hand.js, docs/ALIVE_ASSISTANT_PLAN.md D2)
  const tgt = (n, name) => { n.dataset.oxTarget = name; return n; };
  const ask = (text) => { if (window.oxAsk) window.oxAsk(text); if (MOBILE.matches) go("now"); };

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
  const grip = el("div", "pm-grip");
  grip.title = "Drag to resize · double-click for the default width";
  main.append(page, grip, chat, side);
  box.append(main);

  /* ── the split: drag the conversation's edge; the width is this browser's ── */
  const chatWidth = (w) => {
    if (w) chat.style.setProperty("--pm-chat-w", `${w}px`); else chat.style.removeProperty("--pm-chat-w");
  };
  chatWidth(v.chatw);
  grip.onpointerdown = (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const x0 = e.clientX, w0 = chat.getBoundingClientRect().width;
    grip.onpointermove = (m) => {
      const room = main.getBoundingClientRect().width - side.getBoundingClientRect().width - 360;
      chatWidth(Math.round(Math.max(300, Math.min(room, w0 + x0 - m.clientX))));
    };
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      document.body.classList.remove("resizing");
      v.chatw = Math.round(chat.getBoundingClientRect().width);
      save();
    };
  };
  grip.ondblclick = () => { v.chatw = 0; chatWidth(0); save(); };

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

  /* the cards that wait on the owner: in "needs you", or the assistant's question on one (CYCLES_PLAN: cards only) */
  function needsYou(items) {
    if (!items.length) return el("p", "pm-quiet", "Nothing waits for you.");
    return capped("more-needs", items, 3, (q) => {
      const id = q.source === "board" ? q.id : q.card;
      const act = q.source === "assistant" && window.oxAssistant ? () => window.oxAssistant.open(q.session, true)
        : HAS_BOARD() ? () => BoardView.open({card: id}) : () => go("board");
      const row = button("pm-item pm-q pm-one", null, act, `${id} · ${q.text}`);
      row.dataset.key = `q:${q.source}:${q.id}`;
      tgt(row, `card:${id}`);
      row.append(el("span", "pm-id", id), el("span", "pm-text", q.text || q.kind));
      return row;
    });
  }

  function workingOn(items) {
    const list = el("div", "pm-list");
    if (!items.length) { list.append(el("p", "pm-quiet", "Nothing is in progress.")); return list; }
    for (const w of items) {
      const row = button("pm-item pm-w", null, () => {
        if (HAS_BOARD()) BoardView.open({card: w.card}); else go("board");
      }, `${w.path} · ${w.card}`);
      row.dataset.key = `w:${w.card}`;
      tgt(row, `card:${w.card}`);
      row.append(el("span", "pm-title", w.title), el("span", "pm-sentence", w.sentence));
      list.append(row);
    }
    return list;
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
    const waiting = d.needs_you.filter((q) => q.source === "board" || q.card);
    const needs = waiting.length;
    const work = d.working_on.filter((w) => w.card);
    head.append(el("span", needs ? "hot" : null, needs ? `${plural(needs, "thing")} need${needs === 1 ? "s" : ""} you` : "Nothing needs you"),
      el("span", null, `${work.length} in progress`));
    // on a phone the column folds above the conversation: the summary is its handle
    const wrap = el("details", "pm-wrap");
    wrap.open = !MOBILE.matches || !!v.open.phone;
    wrap.ontoggle = () => { if (MOBILE.matches) { v.open.phone = wrap.open; save(); } };
    const sum = el("summary", "pm-handle");
    sum.append(head);
    wrap.append(sum,
      section("needs", "Needs you", needs, needsYou(waiting), {hot: needs > 0}),
      section("working", "Working on", work.length || null, workingOn(work), {page: "board"}));
    side.append(wrap);
  }

  /* ── the pages ──────────────────────────────────────────────────── */
  function pageHead(title, sub) {
    const h = tgt(el("div", "panehead pm-pagehead"), "pagehead");
    h.append(el("h2", null, title));
    if (sub) h.append(el("span", "count", sub));
    return h;
  }

  /* the Board page: the cards (board.js), nothing else */
  function drawBoard() {
    page.textContent = "";
    const slot = el("div", "pm-board");
    page.append(slot);
    if (HAS_BOARD()) BoardView.mount(slot);
    else slot.append(el("p", "pm-quiet", "No board yet (docs/brd/board.md)."));
  }

  /* ── Files: the tree on the left, the file on the right ─────────── */
  const MARK = {uncommitted: "changed, not committed", recent: "committed in the last two hours"};
  let ftree = null;     // {files, changed} as last read
  async function drawFiles() {
    const mine = ++pageToken;
    page.textContent = "";
    page.append(pageHead("Files", ""));
    try { ftree = await api(`/api/p/${PID}/project/files`); }
    catch (err) { ftree = null; if (mine === pageToken) page.append(el("p", "pm-quiet", (err.data || {}).message || err.message)); return; }
    if (mine !== pageToken || v.page !== "files") return;
    page.textContent = "";
    const n = Object.keys(ftree.changed).length;
    const head = pageHead("Files", `${plural(ftree.files.length, "file")}${n ? ` · ${n} changed lately` : ""}`);
    const only = button("pm-chip" + (v.fonly ? " on" : ""), "Changed only", () => { v.fonly = !v.fonly; save(); drawFiles(); },
                        "Only the files changed and not committed, or committed in the last two hours");
    only.disabled = !n && !v.fonly;
    head.append(only);
    const grid = el("div", "pm-fgrid");
    const list = el("nav", "pm-ftree");
    list.setAttribute("aria-label", "Files");
    const view = el("section", "pm-fview");
    grid.append(list, view);
    page.append(head, grid);
    fillTree(list);
    if (v.file && ftree.files.includes(v.file)) openFile(v.file, view);
    else view.append(el("p", "pm-quiet", "Pick a file."));
  }
  function fillTree(list) {
    const paths = v.fonly ? ftree.files.filter((p) => ftree.changed[p]) : ftree.files;
    const root = {dirs: {}, files: []};
    for (const p of paths) {
      const parts = p.split("/");
      let at = root;
      for (const d of parts.slice(0, -1)) at = at.dirs[d] || (at.dirs[d] = {dirs: {}, files: []});
      at.files.push(p);
    }
    const dirty = (node) => node.files.some((p) => ftree.changed[p]) || Object.values(node.dirs).some(dirty);
    const walk = (node, prefix, depth, into) => {
      for (const name of Object.keys(node.dirs).sort()) {
        const path = prefix + name + "/", sub = node.dirs[name];
        const open = v.fonly || !!v.fopen[path];
        const row = button("pm-frow pm-fdir" + (open ? " open" : ""), "", () => {
          if (v.fopen[path]) delete v.fopen[path]; else v.fopen[path] = 1;
          save(); list.textContent = ""; fillTree(list);
        }, path);
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.append(el("i", "pm-fcaret"), el("span", "pm-fname", name));
        if (dirty(sub)) row.append(el("b", "pm-fdot"));
        into.append(row);
        if (open) walk(sub, path, depth + 1, into);
      }
      for (const p of node.files) {
        const mark = ftree.changed[p];
        const row = button("pm-frow pm-ffile" + (p === v.file ? " on" : ""), "", () => {
          v.file = p; save();
          for (const r of list.querySelectorAll(".pm-ffile.on")) r.classList.remove("on");
          row.classList.add("on");
          openFile(p, page.querySelector(".pm-fview"));
        }, mark ? `${p} — ${MARK[mark]}` : p);
        row.style.paddingLeft = `${22 + depth * 14}px`;
        row.append(el("span", "pm-fname", p.split("/").pop()));
        if (mark) row.append(el("b", "pm-fdot " + mark));
        tgt(row, `file:${p}`);
        into.append(row);
      }
    };
    walk(root, "", 0, list);
    if (!paths.length) list.append(el("p", "pm-quiet", v.fonly ? "Nothing changed lately." : "No files."));
  }
  let fileToken = 0;
  let fline = null;     // {line, end} the next open of v.file scrolls to and marks
  async function openFile(path, view) {
    const mine = ++fileToken;
    view.textContent = "";
    const head = el("div", "pm-fhead");
    head.append(el("span", "pm-fpath", path));
    view.append(head);
    let got;
    try { got = await api(`/api/p/${PID}/project/file?path=${enc(path)}`); }
    catch (err) { if (mine === fileToken) view.append(el("p", "pm-quiet", (err.data || {}).message || err.message)); return; }
    if (mine !== fileToken) return;
    const mark = ftree && ftree.changed[path];
    head.append(el("span", "pm-where", `${got.size.toLocaleString()} bytes${mark ? " · " + MARK[mark] : ""}`));
    if (got.binary) { view.append(el("p", "pm-quiet", "A binary file: not shown.")); return; }
    // the numbers in a gutter beside the text, one <pre> each: a 10k-line file is two nodes, not 10k
    const lines = got.text.replace(/\n$/, "").split("\n").length;
    const body = el("div", "pm-codebox");
    const gutter = el("pre", "pm-gutter", Array.from({length: lines}, (_, i) => i + 1).join("\n"));
    gutter.setAttribute("aria-hidden", "true");
    body.append(gutter, el("pre", "pm-code", got.text));
    view.append(body);
    if (got.truncated) view.append(el("p", "pm-quiet", "The first 400 KB only."));
    const at = fline && fline.line ? fline : null;
    fline = null;
    if (at && at.line <= lines) {
      const lh = parseFloat(getComputedStyle(gutter).lineHeight) || 18.75;
      const pad = parseFloat(getComputedStyle(gutter).paddingTop) || 0;
      const n = Math.max(1, Math.min(lines, at.end || at.line) - at.line + 1);
      const mark = el("div", "pm-lmark");
      mark.style.top = `${pad + (at.line - 1) * lh}px`;
      mark.style.height = `${n * lh}px`;
      body.append(mark);
      head.append(el("span", "pm-where", `line ${at.line}${n > 1 ? `–${at.line + n - 1}` : ""}`));
      // the line a third of the way down, under the sticky head
      view.scrollTop = Math.max(0, pad + (at.line - 1) * lh - view.clientHeight / 3);
    }
  }

  async function drawSettings() {
    const mine = ++pageToken;
    page.textContent = "";
    page.append(pageHead("Settings", ""));
    let git = null;
    try { git = await api(`/api/p/${PID}/git`); } catch (err) { git = {error: err.message}; }
    if (mine !== pageToken || v.page !== "settings") return;
    page.textContent = "";
    page.append(pageHead("Settings", ""));
    // one row per setting: its name, its value, its action; the why is on hover
    let rows = null;
    const group = (title) => {
      page.append(el("h3", "pm-h pm-setgroup", title));
      rows = el("div", "pm-setrows");
      page.append(rows);
      return rows;
    };
    const row = (name, why, value, ...acts) => {
      const r = tgt(el("div", "pm-setrow"), `setting:${name.toLowerCase().replace(/\W+/g, "-")}`);
      r.title = why;
      r.append(el("span", "pm-setname", name), value, ...acts);
      rows.append(r);
      return r;
    };

    standardRows(group, row);
    gitRows(group, row, git);
    if (failed) { group("Builder"); row("Builder", "operonx-project reads the project's status; the studio talks to it", missing()); }
  }

  /* ── the standard (PROJECT_STANDARD_PLAN D1, D3) ─────────────────── */
  const STANDARD_ASK = "Bring this project up to the standard: start with project_status, then follow "
    + "\"Bringing a project up to the standard\" in your knowledge, item by item, and commit. "
    + "Then reply in under 150 words: the details go in the commit message.";
  const standardOf = () => (doc && doc.standard) || [];
  function standardRows(group, row) {
    const std = standardOf();
    if (!std.length) return;
    const met = std.filter((x) => x.ok).length;
    const box = group(`Standard · ${met} of ${std.length}`);
    for (const x of std) {
      const val = el("span", `pm-setval ${x.ok ? "pm-ok" : "pm-bad"}`, `${x.ok ? "✓" : "✗"} ${x.line}`);
      row(x.name[0].toUpperCase() + x.name.slice(1), x.ok ? x.line : `${x.line}\nFix: ${x.fix}`, val);
    }
    if (met < std.length) {
      const r = el("div", "pm-acts");
      r.append(button("primary needs-edit", "Bring it up to the standard", () => ask(STANDARD_ASK)));
      box.after(r);
    }
  }

  /* ── git: what the assistant may do (PROJECT_STANDARD_PLAN D6) ───── */
  const LEVEL_WORDS = {off: "Nothing", commit: "Commit", push: "Commit, push branches", pr: "… and open pull requests",
                       merge: "… and merge pull requests"};
  async function saveGit(body) {
    try { await api(`/api/p/${PID}/git`, body); toast("Saved"); }
    catch (err) { toast((err.data || {}).error || err.message, true); }
    drawSettings();
  }
  function gitRows(group, row, git) {
    group("Git");
    if (!git || git.error) { row("Git", "", el("span", "pm-bad", (git && git.error) || "…")); return; }
    // who commits
    const id = git.identity;
    const who = el("span", `pm-setval ${id ? "" : "pm-bad"}`, id ? `${id.name} <${id.email}>` : "not set: the assistant cannot commit");
    const form = el("div", "pm-words pm-gitid needs-edit");
    form.hidden = !drafts["git:name"] && !drafts["git:email"];
    const nm = el("input"); nm.placeholder = "Name"; nm.value = drafts["git:name"] ?? (id ? id.name : "");
    const em = el("input"); em.placeholder = "Email"; em.type = "email"; em.value = drafts["git:email"] ?? (id ? id.email : "");
    nm.oninput = () => { drafts["git:name"] = nm.value; };
    em.oninput = () => { drafts["git:email"] = em.value; };
    form.append(nm, em, button("primary", "Save", () => {
      delete drafts["git:name"]; delete drafts["git:email"];
      saveGit({identity: {name: nm.value, email: em.value}});
    }));
    const r = row("Commit as", "The name and email every commit is made with, yours and the assistant's; "
      + "also written to the repo's own git config", who, button("needs-edit", "Change", () => { form.hidden = false; nm.focus(); }));
    r.after(form);
    // where it pushes
    row("Remote", git.remote ? `${git.remote}\nPushes as ${git.push_as}` : "No remote named origin",
      el("span", "pm-setval", git.remote ? `${git.host || git.remote} · as ${git.push_as}` : "none"));
    // what the assistant may do
    const pick = el("select", "needs-edit");
    for (const l of git.levels) {
      const o = el("option", null, LEVEL_WORDS[l] || l);
      o.value = l;
      o.selected = git.level === l;
      pick.append(o);
    }
    pick.onchange = () => saveGit({level: pick.value});
    row("The assistant may", "Enforced in git for the assistant: a step past this is refused, with the reason", pick);
    // never pushed to
    const prot = el("input", "pm-search needs-edit");
    prot.value = (git.protected || []).join(", ");
    prot.placeholder = "main, production";
    prot.onchange = () => saveGit({protected: prot.value});
    row("Protected branches", "The assistant never pushes to these (comma-separated); it pushes a branch and opens "
      + "a pull request instead", prot);
  }

  function drawPage() {
    main.classList.toggle("paged", v.page !== "now");
    page.classList.toggle("pm-page-files", v.page === "files" || v.page === "terminal" || v.page === "changes" || v.page === "environments");
    if (v.page !== "board" && HAS_BOARD()) BoardView.unmount();
    if (v.page !== "terminal" && HAS_TERM()) TerminalPage.unmount();
    if (v.page !== "changes" && HAS_GIT()) GitPage.unmount();
    if (v.page !== "environments" && HAS_ENV()) EnvPage.unmount();
    if (v.page === "now") { page.textContent = ""; return; }
    if (v.page === "board") drawBoard();
    else if (v.page === "changes") { if (HAS_GIT()) GitPage.mount(page); }
    else if (v.page === "files") drawFiles();
    else if (v.page === "terminal") { if (HAS_TERM()) TerminalPage.mount(page); }
    else if (v.page === "environments") { if (HAS_ENV()) EnvPage.mount(page); }
    else if (v.page === "settings") drawSettings();
  }

  /* ── reading the status ─────────────────────────────────────────── */
  async function refresh() {
    const mine = ++token;
    let before = null;
    try {
      const got = await api(`/api/p/${PID}/project/status`);
      if (mine !== token) return;
      before = doc;
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
      if (!typing && v.page === "settings") drawPage();
      else if (v.page === "files" && ftree) {
        api(`/api/p/${PID}/project/files`).then((got) => {
          const list = page.querySelector(".pm-ftree");
          if (!list || v.page !== "files") return;
          ftree = got; list.textContent = ""; fillTree(list);
        }).catch(() => { /* the last tree */ });
      }
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
    if (HAS_TERM()) TerminalPage.unmount();
    if (HAS_GIT()) GitPage.unmount();
    if (HAS_ENV()) EnvPage.unmount();
    if (window.oxAssistant && window.oxAssistant.uncenter) window.oxAssistant.uncenter();
  }

  function show(opts) {
    if (opts && opts.page) v.page = PAGES[opts.page] ? opts.page : "now";
    // studio:file/<path>#L<n>: that file, at that line (not remembered: a reload opens the file at its top)
    if (opts && opts.file) {
      v.file = opts.file;
      fline = {line: opts.line || 0, end: opts.end || 0};
      // its folders open in the tree, so the file is in view there too
      const parts = opts.file.split("/");
      for (let i = 1; i < parts.length; i++) v.fopen[parts.slice(0, i).join("/") + "/"] = 1;
    }
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
      if (on) { refresh(); if (v.page === "changes") drawPage(); }
    }
    busy = now;
  });
  document.addEventListener("oxturnended", () => { if (on) refresh(); });
  document.addEventListener("visibilitychange", () => { if (on && !document.hidden) refresh(); });
  MOBILE.addEventListener("change", () => { if (on) drawSide(); });

  registerPane("project", {el: box, show});
  /* a file on the Files page, its folders open (the Board's plan docs) */
  function file(path) {
    v.file = path;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) v.fopen[parts.slice(0, i).join("/") + "/"] = 1;
    go("files");
  }

  return {page: () => v.page, status: () => doc, refresh, go, file};
})();
