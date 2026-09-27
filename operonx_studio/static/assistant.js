/* operonx studio — the assistant.
 *
 * The primary way to get things done here: say what you want; the agent
 * (headless Claude Code on the studio host, operonx_studio/assistant.py)
 * reads and changes the project, runs it, and shows its work.
 *
 * What lives where: conversations are the server's (SQLite beside the
 * studio's state), so this file holds only what is on screen — the open
 * session, its items, and the turn being followed. A turn's events come
 * as NDJSON windows resumed by cursor (a dropped connection costs a
 * reconnect, never an event), with a held poll as the fallback.
 *
 * Four placements of one component:
 *   dock   the project page's right column (desktop)
 *   focus  the whole stage, with the session list beside (Ctrl/⌘ J)
 *   sheet  full screen on a phone, opened from the Ask bar
 *   hero   the home page: a composer first, a conversation once started
 *
 * Nothing the model writes is ever parsed as HTML: markdown is rendered
 * with textContent and a small block/inline tokenizer.
 */

(function () {
  "use strict";

  const W = window;
  const match = location.pathname.match(/^\/p\/([^/]+)/);
  const PROJECT = match ? match[1] : null;
  const SCOPE = PROJECT || "home";
  const PHONE = W.matchMedia("(max-width: 760px)");

  /* ── small things ─────────────────────────────────────────────────── */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const icon = (name, cls) => (W.Icons ? W.Icons.svg(name, cls) : document.createTextNode(""));
  const ibtn = (name, label, cls) => {
    const b = el("button", "ax-ib" + (cls ? " " + cls : ""));
    b.type = "button";
    b.append(icon(name));
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  };
  const tbtn = (label, cls, name) => {
    const b = el("button", cls || "");
    b.type = "button";
    if (name) b.append(icon(name));
    b.append(el("span", null, label));
    return b;
  };
  const local = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    drop(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // the project page has a toast; the home page gets this small one
  const toast = (text, bad) => {
    if (typeof W.toast === "function") { W.toast(text, bad); return; }
    let t = document.getElementById("toast");
    if (!t) { t = el("div"); t.id = "toast"; document.body.append(t); }
    t.textContent = text;
    t.classList.toggle("bad", !!bad);
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2600);
  };

  async function call(path, body, method) {
    let res;
    const opts = body === undefined && !method ? {} : {
      method: method || "POST", headers: {"content-type": "application/json"},
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    try { res = await fetch(path, opts); }
    catch { throw new Error("The studio did not answer — check the connection"); }
    if (res.status === 401) { location.href = "/login"; throw new Error("signed out"); }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`The studio is unreachable (${res.status}) — the tunnel may have dropped`); }
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
    return data;
  }

  const fmt = {
    tokens(n) {
      if (n == null) return "—";
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(n);
    },
    ms(ms) {
      if (ms == null) return "";
      if (ms < 1000) return `${Math.round(ms)} ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
      const m = Math.floor(ms / 60000);
      return `${m} min ${Math.round((ms % 60000) / 1000)} s`;
    },
    secs(s) { return s < 60 ? `${Math.floor(s)} s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; },
    money(v) { return v == null ? "" : v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`; },
    ago(t) {
      const s = Date.now() / 1000 - t;
      if (s < 60) return "just now";
      if (s < 3600) return `${Math.floor(s / 60)} min ago`;
      if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
      if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
      return new Date(t * 1000).toLocaleDateString(undefined, {month: "short", day: "numeric"});
    },
    model(name) {
      if (!name) return "Default model";
      const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(name);
      if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
      return name[0].toUpperCase() + name.slice(1);
    },
  };

  // the same rule as assistant.title_from: the first line, cut at a word
  function titleFrom(message) {
    const line = (String(message).trim().split("\n").find((l) => l.trim()) || "New conversation")
      .replace(/\s+/g, " ").replace(/^[\s.:;,-]+|[\s.:;,-]+$/g, "");
    if (line.length <= 60) return line || "New conversation";
    const cut = line.slice(0, 60).replace(/\s+\S*$/, "");
    return (cut.length > 30 ? cut : line.slice(0, 60)).replace(/[\s.:;,-]+$/, "") + "…";
  }

  /* ── markdown, safely ─────────────────────────────────────────────── */

  const LINK_ICON = {run: "list", op: "graph", tab: "right", monitor: "chart", eval: "evals", project: "folder"};

  function studioLink(label, href) {
    const kind = href.slice(7).split("/")[0];
    const b = el("button", `ax-chip ax-chip-${kind}`);
    b.type = "button";
    b.title = href.replace(/^studio:/, "");
    b.append(icon(LINK_ICON[kind] || "right"), el("span", null, label));
    b.onclick = () => {
      if (kind === "project") { location.href = `/p/${encodeURIComponent(href.slice(15))}`; return; }
      if (W.oxStudioLink) {
        W.oxStudioLink(href);
        if (A.mode === "sheet" || A.mode === "focus") placement.leave();
      } else if (PROJECT) location.href = `/p/${PROJECT}`;
    };
    return b;
  }

  function inline(parent, text) {
    // no lookbehind: an engine without it (older iOS Safari) would reject
    // the whole script bundle, not just this pattern
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      // *emphasis* only at a word's start: a*b*c stays text
      if (m[5] && m.index > 0 && /\w/.test(text[m.index - 1])) continue;
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (m[1]) parent.append(el("code", null, tok.slice(1, -1)));
      else if (m[2]) { const b = el("strong"); inline(b, tok.slice(2, -2)); parent.append(b); }
      else if (m[3]) { const d = el("del"); inline(d, tok.slice(2, -2)); parent.append(d); }
      else if (m[4]) {
        const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
        const [label, href] = [lm[1], lm[2]];
        if (href.startsWith("studio:")) parent.append(studioLink(label, href));
        else if (/^https?:\/\//i.test(href)) {
          const a = el("a", null, label);
          a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
          parent.append(a);
        } else parent.append(document.createTextNode(label));
      } else if (m[5]) { const i = el("em"); inline(i, tok.slice(1, -1)); parent.append(i); }
      else if (m[6]) {
        const a = el("a", null, tok);
        a.href = tok; a.target = "_blank"; a.rel = "noopener noreferrer";
        parent.append(a);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  const FOLD_LINES = 12;     // a longer block in the user's message folds

  // opts.name: a file's name for the head; opts.fold: fold past FOLD_LINES
  function codeBlock(lang, body, opts) {
    opts = opts || {};
    const box = el("div", "ax-code");
    const head = el("div", "ax-code-head");
    head.append(el("span", "ax-code-lang", [opts.name, lang || (opts.name ? "" : "code")].filter(Boolean).join(" · ")));
    const copy = ibtn("copy", "Copy", "ax-copy");
    copy.onclick = () => copyText(body, copy);
    head.append(copy);
    const pre = el("pre");
    pre.append(el("code", null, body));
    box.append(head, pre);
    if (opts.fold) foldable(box, body.split("\n").length);
    return box;
  }

  // a long block shows its first lines and a "Show all"
  function foldable(box, lines, all) {
    if (lines <= FOLD_LINES) return null;
    all = all || `Show all ${lines} lines`;
    box.classList.add("folded");
    const more = el("button", "ax-code-more", all);
    more.type = "button";
    more.onclick = () => {
      const folded = box.classList.toggle("folded");
      more.textContent = folded ? all : "Show less";
    };
    box.append(more);
    return more;
  }

  // JSON the user sent: a tree folded past its first level, or the raw text
  function jsonBlock(value, raw, name) {
    const box = el("div", "ax-code ax-json");
    const head = el("div", "ax-code-head");
    const n = Array.isArray(value) ? value.length : Object.keys(value).length;
    const unit = Array.isArray(value) ? (n === 1 ? "item" : "items") : (n === 1 ? "key" : "keys");
    head.append(el("span", "ax-code-lang", `${name ? name + " · " : ""}json · ${n} ${unit}`), el("span", "ax-spacer"));
    const flip = el("button", "ax-code-flip", "Raw");
    flip.type = "button";
    flip.title = "Show the text as sent";
    const copy = ibtn("copy", "Copy", "ax-copy");
    copy.onclick = () => copyText(raw, copy);
    head.append(flip, copy);
    const tree = el("div", "ax-tree");
    tree.append(W.Values.render(value, {open: true}));
    const pre = el("pre");
    pre.append(el("code", null, raw));
    pre.hidden = true;
    // each view folds by its own length: the tree by its rows, the text by its lines
    let more = null;
    const refold = () => {
      box.classList.remove("folded");
      if (more) more.remove();
      more = pre.hidden ? foldable(box, n, `Show all ${n} ${unit}`) : foldable(box, raw.split("\n").length);
    };
    flip.onclick = () => {
      pre.hidden = !pre.hidden;
      tree.hidden = !pre.hidden;
      flip.textContent = pre.hidden ? "Raw" : "Tree";
      refold();
    };
    box.append(head, tree, pre);
    refold();
    return box;
  }

  function copyText(text, button) {
    const done = () => {
      if (!button) return;
      button.replaceChildren(icon("check"));
      setTimeout(() => button.replaceChildren(icon("copy")), 1200);
    };
    if (navigator.clipboard && W.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {});
    else {
      const t = el("textarea"); t.value = text; document.body.append(t); t.select();
      try { document.execCommand("copy"); done(); } catch { /* nothing to do */ }
      t.remove();
    }
  }

  const isBlockStart = (line) => /^\s*`{3,}[^`]*$/.test(line) || /^#{1,4}\s/.test(line) || /^\s*>/.test(line)
    || /^\s*([-*+]|\d+[.)])\s+/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);

  function md(target, text) {
    target.textContent = "";
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // a fence closes on a backtick run at least as long as its opener;
      // its info string is the language, then (a file's) name
      const fence = /^\s*(`{3,})([^`]*)$/.exec(line);
      if (fence) {
        const close = new RegExp(`^\\s*\`{${fence[1].length},}\\s*$`);
        const body = [];
        i += 1;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        i += 1;   // the closing fence (absent while streaming: the block so far)
        const [lang, ...name] = fence[2].trim().split(/\s+/);
        target.append(codeBlock(lang, body.join("\n"), {name: name.join(" ")}));
        continue;
      }
      if (!line.trim()) { i += 1; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const hd = el(`h${Math.min(h[1].length + 2, 6)}`, "ax-h");
        inline(hd, h[2]);
        target.append(hd);
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { target.append(el("hr")); i += 1; continue; }
      if (/^\s*>/.test(line)) {
        const q = el("blockquote");
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
        md(q, body.join("\n"));
        target.append(q);
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const cells = (ln) => ln.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const wrap = el("div", "ax-table");
        const table = el("table");
        const hr = el("tr");
        for (const c of cells(line)) { const th = el("th"); inline(th, c); hr.append(th); }
        const thead = el("thead"); thead.append(hr); table.append(thead);
        const tbody = el("tbody");
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          const tr = el("tr");
          for (const c of cells(lines[i])) { const td = el("td"); inline(td, c); tr.append(td); }
          tbody.append(tr);
          i += 1;
        }
        table.append(tbody);
        wrap.append(table);
        target.append(wrap);
        continue;
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        // a list, one level of nesting by indent
        const ordered = /\d/.test(li[2]);
        const list = el(ordered ? "ol" : "ul");
        if (ordered) list.start = parseInt(li[2], 10) || 1;
        const base = li[1].length;
        let lastItem = null, sub = null;
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) {
            if (m[1].length > base + 1 && lastItem) {
              if (!sub) { sub = el(/\d/.test(m[2]) ? "ol" : "ul"); lastItem.append(sub); }
              const it = el("li"); inline(it, m[3]); sub.append(it);
            } else {
              sub = null;
              lastItem = el("li"); inline(lastItem, m[3]); list.append(lastItem);
            }
            i += 1;
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && lastItem) {
            lastItem.append(document.createTextNode(" ")); inline(lastItem, lines[i].trim()); i += 1;
          } else break;
        }
        target.append(list);
        continue;
      }
      const p = el("p");
      let first = true;
      while (i < lines.length && lines[i].trim() && !(isBlockStart(lines[i]) && !first)) {
        if (!first) p.append(el("br"));
        inline(p, lines[i]);
        first = false;
        i += 1;
        if (i < lines.length && isBlockStart(lines[i])) break;
      }
      target.append(p);
    }
  }

  /* ── state ────────────────────────────────────────────────────────── */

  const A = {
    mode: "dock",
    session: null,           // the open session (server shape)
    items: [],
    bySeq: new Map(),         // seq → item
    nodes: new Map(),         // seq → rendered node
    running: null,            // {id, cursor, state, detail, t0}
    queue: null,              // a message typed while a turn runs
    agent: null,              // {reach, cwd, model}
    models: ["opus", "sonnet", "haiku"],
    sessions: [],
    search: "",
    archived: false,
    details: local.get("ax:details", false),
    suggestions: null,
    followToken: 0,
    view: null,               // the view context the next message carries
    dropped: new Set(),       // chips the user removed for the next message
    editing: null,            // {turn} when the composer edits an earlier message
    lastEnded: new Set(),
    blocks: [],               // the composer's pasted cards: {kind, lang, name, text, lines, chars, detail}
    boxKey: null,             // whose draft the box holds (null until one is loaded)
    images: [],               // the composer's images: {blob?, url, name, mime, w, h, ref?, sid?}
    imagesByKey: new Map(),   // draft key → its images (in memory: bytes stay out of localStorage)
    boxH: {},                 // mode → the composer height set by hand (0: grows with the text)
  };
  const K_CURRENT = `ax:${SCOPE}:current`;

  /* ── the component ────────────────────────────────────────────────── */

  const root = el("section", "ax");
  root.setAttribute("aria-label", "Assistant");

  // header
  const head = el("header", "ax-head");
  const bSessions = ibtn("sessions", "Conversations", "ax-b-sessions");
  const title = el("button", "ax-title");
  title.type = "button";
  title.title = "Rename this conversation";
  const titleText = el("span", null, "New conversation");
  title.append(titleText);
  const bInfo = ibtn("info", "Conversation details", "ax-b-info");
  const bNew = ibtn("new", "New conversation  ( /new )", "ax-b-new");
  const bFocus = ibtn("expand", "Focus  ( Ctrl J )", "ax-b-focus");
  const bClose = ibtn("x", "Close", "ax-b-close");
  head.append(bSessions, title, el("span", "ax-spacer"), bInfo, bNew, bFocus, bClose);

  // sessions pane
  const side = el("aside", "ax-side");
  const sideHead = el("div", "ax-side-head");
  const search = el("input", "ax-search");
  search.type = "search";
  search.placeholder = "Search conversations";
  search.setAttribute("aria-label", "Search conversations");
  const sideNew = tbtn("New", "ax-side-new", "plus");
  sideHead.append(search, sideNew);
  const list = el("div", "ax-list");
  list.setAttribute("role", "list");
  const sideFoot = el("div", "ax-side-foot");
  const bArchived = tbtn("Archived", "ax-link", "archive");
  sideFoot.append(bArchived);
  side.append(sideHead, list, sideFoot);

  // the conversation
  const main = el("div", "ax-main");
  const log = el("div", "ax-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  const jump = tbtn("New messages", "ax-jump", "chevron");
  jump.hidden = true;
  const status = el("div", "ax-status");
  status.hidden = true;
  const statusDot = el("span", "ax-dot");
  const statusText = el("span", "ax-status-text");
  const statusTime = el("span", "ax-status-time");
  const statusStop = tbtn("Stop", "ax-stop", "stop");
  statusStop.title = "Stop  ( Esc )";
  status.append(statusDot, statusText, statusTime, statusStop);

  // composer: one box — the pasted cards, the words, then its toolbar
  const composer = el("form", "ax-composer");
  const queued = el("div", "ax-queued");
  queued.hidden = true;
  const chips = el("div", "ax-ctx");
  const inputWrap = el("div", "ax-input");
  const grip = el("div", "ax-grip");
  grip.title = "Drag to resize · double-click to fit the text again";
  grip.setAttribute("aria-hidden", "true");
  const tray = el("div", "ax-tray");
  tray.hidden = true;
  const input = el("textarea");
  input.rows = 2;
  input.placeholder = PROJECT ? "Ask, or describe a task  ( / for commands )"
    : "Describe what you want to build, or ask about your projects…";
  input.setAttribute("aria-label", "Message the assistant");
  const slash = el("div", "ax-slash");
  slash.hidden = true;
  slash.setAttribute("role", "listbox");
  const tools = el("div", "ax-tools");
  const modelPick = el("button", "ax-model");
  modelPick.type = "button";
  modelPick.title = "Which model answers in this conversation";
  const meter = el("button", "ax-meter");
  meter.type = "button";
  meter.hidden = true;
  const meterRing = el("span", "ax-ring");
  const meterText = el("span", "ax-meter-text");
  meter.append(meterRing, meterText);
  const bExpand = ibtn("unfold", "Expand the editor", "ax-b-expand");
  const send = el("button", "ax-send");
  send.type = "submit";
  send.append(icon("up"));
  send.title = "Send  ( Enter )";
  send.setAttribute("aria-label", "Send");
  const bAttach = ibtn("plus", "Attach images or files", "ax-b-attach");
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  // images, and the text files that become cards; a phone offers its photos and camera
  fileInput.accept = "image/png,image/jpeg,image/gif,image/webp,image/*,.py,.json,.jsonl,.csv,.md,.txt,.log,.yaml,.yml,.toml,.js,.ts,.sql,.sh";
  tools.append(bAttach, fileInput, modelPick, el("span", "ax-spacer"), meter, bExpand, send);
  inputWrap.append(grip, tray, input, tools);
  composer.append(queued, chips, slash, inputWrap);

  // a pasted card, opened: read it, fix it, or take it out
  const peek = el("div", "ax-peek");
  peek.hidden = true;

  const pop = el("div", "ax-pop");
  pop.hidden = true;

  // dropping files anywhere on the assistant
  const dropzone = el("div", "ax-drop");
  dropzone.append(icon("plus"), el("span", null, "Drop images or text files"));

  // the foot holds what sits under the transcript; "New messages" floats above it
  const foot = el("div", "ax-foot");
  foot.append(jump, status, composer);
  main.append(log, foot, peek);
  const body = el("div", "ax-body");
  body.append(side, main);
  root.append(head, body, pop, dropzone);

  /* ── rendering the transcript ─────────────────────────────────────── */

  let turnEl = null;      // the current visual turn
  let replyEl = null;     // where its answer goes
  let actEl = null;       // the open activity group, if the last thing was a step

  const stepIcon = (item) => {
    if (item.kind === "thinking") return "spark";
    const n = item.name || "";
    if (/^mcp__studio__/.test(n)) return "graph";
    if (n === "Bash") return "terminal";
    if (/^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return "file";
    if (/^(Grep|Glob|LS)$/.test(n)) return "search";
    if (/^Web/.test(n)) return "globe";
    return "box";
  };

  function newTurn(userItem) {
    turnEl = el("div", "ax-turn");
    if (userItem) turnEl.dataset.turn = userItem.turn || "";
    replyEl = el("div", "ax-reply");
    actEl = null;
    if (userItem) turnEl.append(renderUser(userItem));
    turnEl.append(replyEl);
    log.append(turnEl);
  }

  // the user's words keep their line breaks; only `code` and links are marked up
  function inlineUser(parent, text) {
    const re = /(`[^`\n]+`)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) parent.append(el("code", null, m[1].slice(1, -1)));
      else {
        const a = el("a", null, m[2]);
        a.href = m[2]; a.target = "_blank"; a.rel = "noopener noreferrer";
        parent.append(a);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  function userBlock(lang, name, body) {
    if ((!lang || lang === "json") && W.Values) {
      let v;
      try { v = JSON.parse(body); } catch { v = undefined; }
      if (v && typeof v === "object") return jsonBlock(v, body, name);
    }
    return codeBlock(lang, body, {name, fold: true});
  }

  /* The user's message: pasted blocks as blocks (a wall sent before the
   * composer made cards is found and shown as one), the words as typed. */
  function userBody(target, text) {
    target.textContent = "";
    const words = (t) => { const w = el("div", "ax-words"); inlineUser(w, t); target.append(w); };
    const segs = W.Paste ? W.Paste.split(text) : [{t: "text", text}];
    let blocks = 0;
    for (const s of segs) {
      if (s.t === "block") { target.append(userBlock(s.lang, s.name, s.text)); blocks += 1; continue; }
      const found = W.Paste && W.Paste.loose(s.text);
      if (!found) { words(s.text); continue; }
      if (found.before) words(found.before);
      target.append(userBlock(found.block.lang, "", found.block.text));
      blocks += 1;
    }
    target.classList.toggle("rich", blocks > 0);
  }

  const attUrl = (ref) => (A.session ? `/api/assistant/sessions/${A.session.id}/attachments/${ref.id}` : "");

  // the images a message carried, as thumbnails; a click shows one large
  function userImages(atts) {
    // one image keeps its shape; several sit as square tiles
    const row = el("div", "ax-uimgs" + (atts.length === 1 ? " one" : ""));
    for (const a of atts) {
      const b = el("button", "ax-uimg");
      b.type = "button";
      b.title = a.name || "image";
      const img = el("img");
      img.src = a.url || attUrl(a);
      img.alt = a.name || "image";
      img.loading = "lazy";
      b.append(img);
      b.onclick = () => showImage(img.src, a.name);
      row.append(b);
    }
    return row;
  }

  function renderUser(item) {
    const box = el("div", "ax-user");
    const bubble = el("div", "ax-bubble");
    userBody(bubble, item.text || "");
    if ((item.attachments || []).length) {
      bubble.prepend(userImages(item.attachments));
      bubble.classList.add("withimgs");
      if (!item.text) bubble.classList.add("imgsonly");
    }
    box.append(bubble);
    if (item.turn && !item.imported) {
      const acts = el("div", "ax-uacts");
      const edit = ibtn("new", "Edit and resend", "ax-mini");
      edit.onclick = () => startEdit(item);
      acts.append(edit);
      box.append(acts);
    }
    A.nodes.set(item.seq, box);
    return box;
  }

  function summarize(steps) {
    const count = {};
    let thought = 0;
    for (const s of steps) {
      if (s.kind === "thinking") { thought += s.ms || 0; continue; }
      const n = s.name || "";
      if (n === "ToolSearch") continue;        // loading tools is plumbing, not work
      const key = /^mcp__studio__/.test(n) ? "studio" : n === "Read" ? "read" : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)
        ? "edit" : n === "Bash" ? "run" : /^(Grep|Glob|LS)$/.test(n) ? "search" : /^Web/.test(n) ? "web" : "tool";
      count[key] = (count[key] || 0) + 1;
    }
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const bits = [];
    if (count.read) bits.push(`read ${plural(count.read, "file", "files")}`);
    if (count.edit) bits.push(`edited ${plural(count.edit, "file", "files")}`);
    if (count.run) bits.push(`ran ${plural(count.run, "command", "commands")}`);
    if (count.search) bits.push(`searched ${plural(count.search, "time", "times")}`);
    if (count.web) bits.push(`looked up ${plural(count.web, "page", "pages")}`);
    if (count.studio) bits.push(`used the studio ${count.studio}×`);
    if (count.tool) bits.push(`used ${plural(count.tool, "tool", "tools")}`);
    if (!bits.length) return thought ? `Thought for ${fmt.ms(thought)}` : "Thought";
    const s = bits.join(", ");
    return s[0].toUpperCase() + s.slice(1);
  }

  function paintActivity(group) {
    const steps = group._steps.map((seq) => A.bySeq.get(seq)).filter(Boolean);
    const live = steps.find((s) => s.status === "running" || (s.kind === "thinking" && s.ms == null));
    // a step that failed and was recovered from is a detail, not the verdict:
    // the group keeps its check and says how many; the step itself is red
    const failed = steps.filter((s) => s.status === "error").length;
    group.classList.toggle("live", !!live && !!A.running);
    group.classList.toggle("warned", failed > 0);
    const [ico, sum, time] = group._head;
    ico.replaceChildren(live && A.running ? el("span", "ax-spin") : icon("check"));
    sum.textContent = live && A.running
      ? (live.kind === "thinking" ? "Thinking…" : `${live.label || live.name}…`)
      : summarize(steps);
    const ms = steps.reduce((a, s) => a + (s.ms || 0), 0);
    const n = steps.filter((s) => s.kind !== "thinking").length;
    time.textContent = [failed ? `${failed} failed` : "", n > 1 ? `${n} steps` : "", ms ? fmt.ms(ms) : ""]
      .filter(Boolean).join(" · ");
  }

  function renderStep(item) {
    const row = el("div", "ax-step" + (item.status === "error" ? " bad" : ""));
    const top = el("button", "ax-step-head");
    top.type = "button";
    const state = item.status === "running" || (item.kind === "thinking" && item.ms == null)
      ? el("span", "ax-spin") : icon(item.status === "error" ? "alert" : stepIcon(item));
    const label = el("span", "ax-step-label");
    // a label recorded with an absolute path inside the project reads relative
    const cwd = A.agent && A.agent.cwd ? A.agent.cwd.replace(/\/$/, "") + "/" : null;
    if (cwd && item.label && item.label.includes(cwd)) item = {...item, label: item.label.split(cwd).join("")};
    if (item.kind === "thinking") label.textContent = item.ms != null ? `Thought for ${fmt.ms(item.ms)}` : "Thinking";
    else {
      const m = /^(\S+)\s+(.*)$/.exec(item.label || item.name || "");
      if (m && /^(Read|Edited|Wrote|Ran|Searched|Listed|Fetched|Planned|Delegated)$/.test(m[1])) {
        label.append(document.createTextNode(m[1] + " "), el("code", null, m[2]));
      } else label.textContent = item.label || item.name || "tool";
    }
    top.append(state, label, el("span", "ax-step-ms", item.ms != null ? fmt.ms(item.ms) : ""));
    row.append(top);
    const hasBody = item.kind === "thinking" ? !!(item.text || "").trim() : !!(item.input || item.output);
    if (hasBody) {
      top.classList.add("more");
      const io = el("div", "ax-step-io");
      io.hidden = true;
      top.onclick = () => {
        if (!io.childNodes.length) {
          if (item.kind === "thinking") io.append(el("pre", "ax-think", item.text));
          else {
            if (item.input) io.append(el("div", "ax-io-label", "Input"), el("pre", null, item.input));
            if (item.output) io.append(el("div", "ax-io-label", item.status === "error" ? "Error" : "Result"),
              el("pre", null, item.output));
          }
        }
        io.hidden = !io.hidden;
        row.classList.toggle("open", !io.hidden);
      };
      row.append(io);
    }
    return row;
  }

  function addStep(item) {
    if (!actEl) {
      actEl = el("div", "ax-act");
      const h = el("button", "ax-act-head");
      h.type = "button";
      const ico = el("span", "ax-act-ico");
      const sum = el("span", "ax-act-sum");
      const time = el("span", "ax-act-time");
      h.append(ico, sum, time, icon("chevron", "ax-act-chev"));
      const steps = el("div", "ax-act-steps");
      steps.hidden = true;
      h.onclick = () => { steps.hidden = !steps.hidden; h.parentNode.classList.toggle("open", !steps.hidden); };
      actEl.append(h, steps);
      actEl._head = [ico, sum, time];
      actEl._steps = [];
      actEl._list = steps;
      replyEl.append(actEl);
    }
    const row = renderStep(item);
    actEl._list.append(row);
    actEl._steps.push(item.seq);
    row._group = actEl;
    A.nodes.set(item.seq, row);
    paintActivity(actEl);
  }

  function renderText(item) {
    const box = el("div", "ax-text");
    md(box, item.text || "");
    A.nodes.set(item.seq, box);
    return box;
  }

  function renderChanges(item) {
    const card = el("div", "ax-card ax-changes");
    const files = item.files || [];
    const plus = files.reduce((s, f) => s + (f.added || 0), 0);
    const minus = files.reduce((s, f) => s + (f.removed || 0), 0);
    const top = el("div", "ax-card-head");
    top.append(icon("file"), el("b", null, `Changed ${files.length} file${files.length === 1 ? "" : "s"}`),
      el("span", "ax-add", `+${plus}`), el("span", "ax-del", `−${minus}`));
    const flist = el("div", "ax-files");
    for (const f of files) {
      const r = el("div", "ax-file");
      const p = el("span", "ax-path", f.path);
      p.title = f.path;
      r.append(p);
      if (f.new) r.append(el("span", "ax-new", "new"));
      r.append(el("span", "ax-add", `+${f.added || 0}`), el("span", "ax-del", `−${f.removed || 0}`));
      flist.append(r);
    }
    const fold = el("details", "ax-diff-fold");
    fold.append(el("summary", null, "Show the diff"));
    fold.addEventListener("toggle", () => {
      if (!fold.open || fold._filled) return;
      fold._filled = true;
      const box = el("div", "ax-diff");
      for (const ln of String(item.diff || "(no diff)").split("\n")) {
        if (/^(diff --git |index |new file mode|deleted file mode|similarity |rename |--- )/.test(ln)) continue;
        if (ln.startsWith("+++ ")) { box.append(el("div", "file", ln.replace(/^\+\+\+ (b\/)?/, ""))); continue; }
        box.append(el("div", ln.startsWith("@@") ? "hunk" : ln.startsWith("+") ? "add" : ln.startsWith("-") ? "del" : "", ln || " "));
      }
      fold.append(box);
    });
    const acts = el("div", "ax-card-acts");
    const note = el("span", "ax-card-note");
    const keep = tbtn("Keep", "ax-btn");
    const undo = tbtn("Undo", "ax-btn ax-btn-quiet", "resume");
    undo.title = "Put these files back as they were before this turn";
    const paint = () => {
      card.dataset.state = item.state || "pending";
      keep.hidden = undo.hidden = !!item.state || !PROJECT;
      note.textContent = item.state === "kept" ? "Kept"
        : item.state === "undone" ? `Undone — ${item.restored ?? files.length} file${(item.restored ?? files.length) === 1 ? "" : "s"} put back` : "";
    };
    const mark = (state, restored) => {
      item.state = state;
      if (restored != null) item.restored = restored;
      paint();
      if (A.session) call(`/api/assistant/sessions/${A.session.id}/items/${item.seq}`,
        {state, ...(restored != null ? {restored} : {})}).catch(() => {});
    };
    keep.onclick = () => mark("kept");
    undo.onclick = async () => {
      keep.disabled = undo.disabled = true;
      try {
        const got = await call(`/api/p/${PROJECT}/chat/undo`, {
          sha: item.sha, files: files.filter((f) => !f.new).map((f) => f.path),
          new_files: files.filter((f) => f.new).map((f) => f.path)});
        mark("undone", (got.restored || []).length);
      } catch (err) {
        note.textContent = `Undo failed: ${err.message}`;
        keep.disabled = undo.disabled = false;
      }
    };
    acts.append(note, el("span", "ax-spacer"), undo, keep);
    card.append(top, flist, fold, acts);
    paint();
    A.nodes.set(item.seq, card);
    return card;
  }

  function renderError(item) {
    const card = el("div", "ax-card ax-error");
    const top = el("div", "ax-card-head");
    top.append(icon("alert"), el("span", null, (item.text || "Something went wrong").split("\n")[0].slice(0, 300)));
    card.append(top);
    const more = String(item.text || "");
    if (more.includes("\n") || more.length > 300) {
      const fold = el("details");
      fold.append(el("summary", null, "Details"), el("pre", null, more));
      card.append(fold);
    }
    if (item.retry && item.turn) {
      const acts = el("div", "ax-card-acts");
      const retry = tbtn("Try again", "ax-btn", "refresh");
      retry.onclick = () => redo({retry_of: item.turn});
      retry.dataset.retry = item.turn;
      acts.append(el("span", "ax-spacer"), retry);
      card.append(acts);
    }
    A.nodes.set(item.seq, card);
    return card;
  }

  function renderEnd(item) {
    const f = el("div", "ax-turnfoot");
    const bits = [];
    if (item.state === "stopped") bits.push("Stopped");
    if (item.ms) bits.push(fmt.ms(item.ms));
    if (item.cost != null) bits.push(fmt.money(item.cost));
    if (item.model) bits.push(fmt.model(item.model));
    if (item.context) bits.push(`${fmt.tokens(item.context)} context`);
    const meta = el("span", "ax-turnmeta", bits.join(" · "));
    const acts = el("span", "ax-turnacts");
    const copy = ibtn("copy", "Copy the answer", "ax-mini");
    copy.onclick = () => {
      const turnItems = A.items.filter((x) => x.turn === item.turn && x.kind === "text");
      copyText(turnItems.map((x) => x.text).join("\n\n"), copy);
    };
    acts.append(copy);
    if (item.turn) {
      const again = ibtn("refresh", "Regenerate", "ax-mini ax-regen");
      again.onclick = () => redo({retry_of: item.turn});
      acts.append(again);
    }
    f.append(acts, meta);
    if (item.state === "stopped") f.classList.add("stopped");
    A.nodes.set(item.seq, f);
    return f;
  }

  function append(item) {
    A.bySeq.set(item.seq, item);
    if (item.kind === "user") { newTurn(item); return; }
    if (!replyEl) newTurn(null);
    if (item.kind === "tool" || item.kind === "thinking") { addStep(item); return; }
    if (item.kind !== "turn_end") actEl = null;
    let node;
    if (item.kind === "text") node = renderText(item);
    else if (item.kind === "changes") node = renderChanges(item);
    else if (item.kind === "error") node = renderError(item);
    else if (item.kind === "compact") {
      node = el("div", "ax-divider");
      node.append(el("span", null, item.pre && item.post
        ? `Context compacted · ${fmt.tokens(item.pre)} → ${fmt.tokens(item.post)} tokens` : "Context compacted"));
      A.nodes.set(item.seq, node);
    } else if (item.kind === "note") { node = el("div", "ax-note", item.text || ""); A.nodes.set(item.seq, node); }
    else if (item.kind === "turn_end") {
      node = renderEnd(item);
      for (const g of replyEl.querySelectorAll(".ax-act")) paintActivity(g);
      actEl = null;
    } else return;
    replyEl.append(node);
  }

  function replace(item) {
    const old = A.bySeq.get(item.seq);
    if (!old) { A.items.push(item); append(item); return; }
    Object.assign(old, item);
    const node = A.nodes.get(item.seq);
    if (!node) return;
    if (item.kind === "tool" || item.kind === "thinking") {
      const row = renderStep(old);
      row._group = node._group;
      node.replaceWith(row);
      A.nodes.set(item.seq, row);
      if (row._group) paintActivity(row._group);
    } else if (item.kind === "changes") node.replaceWith(renderChanges(old));
    else if (item.kind === "text") md(node, old.text || "");
  }

  // streaming text: one markdown render per frame, whatever the delta rate
  const dirty = new Set();
  let frame = 0;
  function delta(seq, text) {
    const item = A.bySeq.get(seq);
    if (!item) return;
    item.text = (item.text || "") + text;
    if (item.kind === "thinking") return;
    dirty.add(seq);
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      const stick = nearBottom();
      for (const s of dirty) { const n = A.nodes.get(s); const it = A.bySeq.get(s); if (n && it) md(n, it.text); }
      dirty.clear();
      if (stick) toBottom();
    });
  }

  function renderAll() {
    log.textContent = "";
    A.nodes.clear();
    A.bySeq.clear();
    turnEl = replyEl = actEl = null;
    if (!A.items.length) { renderEmpty(); return; }
    for (const it of A.items) append(it);
    for (const g of log.querySelectorAll(".ax-act")) paintActivity(g);
    markLast();
    toBottom();
  }

  // only the last answer offers Regenerate; only the last error, Retry
  function markLast() {
    const turns = log.querySelectorAll(".ax-turn");
    turns.forEach((t, i) => t.classList.toggle("last", i === turns.length - 1));
  }

  /* ── the empty conversation ───────────────────────────────────────── */

  const HOME_STARTS = [
    {kind: "setup", label: "Build a question-answerer over my documents",
     prompt: "Create a new project from the RAG template that answers questions over documents, then show me how to try it."},
    {kind: "setup", label: "Start an HTTP API that scores text",
     prompt: "Create a new project from the HTTP API template and walk me through its flow."},
    {kind: "setup", label: "Set up a voice agent",
     prompt: "Create a new project from the voice agent template and explain how a call flows through it."},
    {kind: "failure", label: "Which of my projects had failures today?",
     prompt: "Go through my projects and tell me which had failing runs in the last day, and why."},
  ];
  const START_ICON = {failure: "alert", eval: "evals", setup: "wand", try: "play", learn: "book", op: "graph"};

  async function loadSuggestions() {
    if (!PROJECT) return HOME_STARTS;
    const node = (W.__oxview || {}).node;
    try {
      const got = await call(`/api/p/${PROJECT}/assistant/suggest${node ? `?node=${encodeURIComponent(node)}` : ""}`);
      return got.suggestions || [];
    } catch { return []; }
  }

  function renderEmpty() {
    log.textContent = "";
    const box = el("div", "ax-empty");
    const hello = el("div", "ax-hello");
    const mark = el("span", "ax-mark");
    mark.append(icon("spark"));
    hello.append(mark, el("h2", null, PROJECT ? "What should we work on?" : "What do you want to build?"),
      el("p", null, PROJECT
        ? "Describe a task in your own words. I can read and change this project, run its services and jobs, and dig through its runs."
        : "Describe it in your own words — I'll set up a working project from a template, or answer questions about the ones you have."));
    box.append(hello);
    const grid = el("div", "ax-starts");
    box.append(grid);
    const fill = (starts) => {
      grid.textContent = "";
      for (const s of starts.slice(0, 6)) {
        const c = el("button", `ax-start ax-start-${s.kind}`);
        c.type = "button";
        const ic = el("span", "ax-start-ico");
        ic.append(icon(START_ICON[s.kind] || "spark"));
        const t = el("span", "ax-start-text");
        t.append(el("span", "ax-start-label", s.label));
        if (s.why) t.append(el("span", "ax-start-why", s.why));
        c.append(ic, t);
        c.onclick = () => submit(s.prompt);
        grid.append(c);
      }
    };
    if (A.suggestions) fill(A.suggestions);
    else {
      for (let i = 0; i < 3; i += 1) grid.append(el("div", "ax-start ax-skel"));
      loadSuggestions().then((s) => { A.suggestions = s; if (!A.items.length) fill(s); });
    }
    const tip = el("div", "ax-tip");
    tip.append(el("kbd", null, "/"), document.createTextNode(" commands"),
      el("span", "ax-dotsep", "·"), el("kbd", null, "Shift ↵"), document.createTextNode(" new line"));
    if (A.mode !== "sheet") tip.append(el("span", "ax-dotsep", "·"), el("kbd", null, "Ctrl J"), document.createTextNode(" focus"));
    box.append(tip);
    log.append(box);
  }

  /* ── scrolling ────────────────────────────────────────────────────── */

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  const toBottom = () => { log.scrollTop = log.scrollHeight; jump.hidden = true; };
  log.addEventListener("scroll", () => { if (nearBottom()) jump.hidden = true; }, {passive: true});
  jump.onclick = toBottom;

  /* ── header, meter, details ───────────────────────────────────────── */

  function paintHead() {
    const s = A.session;
    titleText.textContent = s && s.title ? s.title : "New conversation";
    title.disabled = !s;
    const u = (s && s.usage) || {};
    const pct = u.context_tokens && u.context_window ? u.context_tokens / u.context_window : 0;
    meter.hidden = pct < 0.5;
    meter.classList.toggle("hot", pct >= 0.8);
    meterRing.style.setProperty("--pct", String(Math.min(100, Math.round(pct * 100))));
    meterText.textContent = `${Math.round(pct * 100)}%`;
    meter.title = pct >= 0.8
      ? `Context ${Math.round(pct * 100)}% full — compact it to keep going`
      : `Context ${Math.round(pct * 100)}% full`;
    const model = (s && s.model) || null;
    modelPick.replaceChildren(el("span", "ax-model-dot"),
      el("span", null, model ? fmt.model(model) : fmt.model((s && s.usage && s.usage.model) || (A.agent && A.agent.model) || "")));
    modelPick.classList.toggle("pinned", !!model);
  }

  function renameInline() {
    if (!A.session) return;
    const inp = el("input", "ax-title-edit");
    inp.value = A.session.title || "";
    title.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      inp.replaceWith(title);
      const v = inp.value.trim();
      if (save && v && v !== A.session.title) {
        try {
          const got = await call(`/api/assistant/sessions/${A.session.id}`, {title: v}, "PATCH");
          A.session = got.session;
          paintHead();
          refreshList();
        } catch (err) { toast(err.message, true); }
      }
    };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") finish(true); if (ev.key === "Escape") finish(false); };
    inp.onblur = () => finish(true);
  }
  title.onclick = renameInline;

  function openPop(build, anchor) {
    if (!pop.hidden && pop._anchor === anchor) { pop.hidden = true; return; }
    pop.textContent = "";
    pop._anchor = anchor;
    build(pop);
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    // below an anchor in the top half, above one in the bottom half (the
    // composer's toolbar); lined up with whichever edge it is nearer
    const low = r.top - rr.top > rr.height / 2;
    pop.style.top = low ? "" : `${r.bottom - rr.top + 6}px`;
    pop.style.bottom = low ? `${rr.bottom - r.top + 6}px` : "";
    const leftish = r.left + r.width / 2 < rr.left + rr.width / 2;
    pop.style.left = leftish ? `${Math.max(8, r.left - rr.left)}px` : "";
    pop.style.right = leftish ? "" : `${Math.max(8, rr.right - r.right)}px`;
  }
  document.addEventListener("pointerdown", (ev) => {
    if (!pop.hidden && !pop.contains(ev.target) && !(pop._anchor && pop._anchor.contains(ev.target))) pop.hidden = true;
  });

  function modelMenu(box) {
    box.append(el("div", "ax-pop-title", "Model for this conversation"));
    const opts = [[null, "Default", "Whatever Claude Code uses by default"],
      ["opus", "Opus", "Most capable, slower"], ["sonnet", "Sonnet", "Balanced"], ["haiku", "Haiku", "Fastest, cheapest"]];
    for (const [value, label, sub] of opts) {
      const b = el("button", "ax-opt" + (((A.session && A.session.model) || null) === value ? " on" : ""));
      b.type = "button";
      b.append(el("span", "ax-opt-label", label), el("span", "ax-opt-sub", sub));
      b.onclick = async () => { pop.hidden = true; await setModel(value); };
      box.append(b);
    }
  }

  async function setModel(value) {
    if (!A.session) await ensureSession({model: value});
    else {
      try {
        const got = await call(`/api/assistant/sessions/${A.session.id}`, {model: value}, "PATCH");
        A.session = got.session;
      } catch (err) { toast(err.message, true); return; }
    }
    paintHead();
    toast(`This conversation now uses ${value ? fmt.model(value) : "the default model"}`);
  }
  modelPick.onclick = () => openPop(modelMenu, modelPick);

  function detailsPanel(box) {
    const s = A.session;
    const u = (s && s.usage) || {};
    box.classList.add("ax-details");
    box.append(el("div", "ax-pop-title", "This conversation"));
    const row = (k, v, mono) => {
      const r = el("div", "ax-kv");
      r.append(el("span", "ax-k", k), el("span", "ax-v" + (mono ? " mono" : ""), v));
      box.append(r);
      return r;
    };
    row("Model", fmt.model((s && s.model) || u.model || (A.agent && A.agent.model) || ""));
    if (u.context_window) {
      const pct = Math.round(100 * (u.context_tokens || 0) / u.context_window);
      const r = row("Context", `${fmt.tokens(u.context_tokens || 0)} of ${fmt.tokens(u.context_window)} · ${pct}%`);
      const bar = el("div", "ax-bar");
      const fill = el("span");
      fill.style.width = `${Math.min(100, pct)}%`;
      if (pct >= 80) bar.classList.add("hot");
      bar.append(fill);
      r.after(bar);
    }
    row("Turns", String(u.turns || 0));
    if (u.cost_usd != null) row("Cost", fmt.money(u.cost_usd));
    if (u.input_tokens != null) row("Tokens", `${fmt.tokens(u.input_tokens)} in · ${fmt.tokens(u.output_tokens)} out · ${fmt.tokens(u.cache_read_tokens)} cached`);
    if (u.rate && u.rate.five_hour != null) row("Plan usage", `${Math.round(100 * u.rate.five_hour)}% of 5 h · ${Math.round(100 * (u.rate.seven_day || 0))}% of 7 d`);
    if (A.agent) {
      row("Reach", {read: "Reads only", edit: "Reads and edits files", full: "Edits files and runs commands"}[A.agent.reach] || A.agent.reach);
      row("Works in", A.agent.cwd || "—", true);
    }
    if (s && s.claude_session) {
      const r = row("Session", s.claude_session.slice(0, 18) + "…", true);
      const c = ibtn("copy", "Copy the Claude session id", "ax-mini");
      c.onclick = () => copyText(s.claude_session, c);
      r.append(c);
    }
    const acts = el("div", "ax-pop-acts");
    const compact = tbtn("Compact", "ax-btn", "compress");
    compact.disabled = !(s && s.claude_session) || !!A.running;
    compact.title = "Summarize the conversation so far, to free the context";
    compact.onclick = () => { pop.hidden = true; doCompact(); };
    const exp = tbtn("Export", "ax-btn ax-btn-quiet", "download");
    exp.disabled = !A.items.length;
    exp.onclick = () => { pop.hidden = true; exportMarkdown(); };
    acts.append(compact, exp);
    box.append(acts);
    const toggle = el("label", "ax-toggle");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = A.details;
    cb.onchange = () => { A.details = cb.checked; local.set("ax:details", A.details); root.classList.toggle("details", A.details); };
    toggle.append(cb, el("span", null, "Show time and cost under every answer"));
    box.append(toggle);
    if ("Notification" in W && Notification.permission !== "denied") {
      const n = el("label", "ax-toggle");
      const nb = el("input");
      nb.type = "checkbox";
      nb.checked = Notification.permission === "granted" && local.get("ax:notify", false);
      nb.onchange = async () => {
        if (nb.checked && Notification.permission !== "granted") nb.checked = (await Notification.requestPermission()) === "granted";
        local.set("ax:notify", nb.checked);
      };
      n.append(nb, el("span", null, "Notify me when a long task finishes"));
      box.append(n);
    }
  }
  bInfo.onclick = () => openPop(detailsPanel, bInfo);
  meter.onclick = () => openPop(detailsPanel, bInfo);

  /* ── sessions ─────────────────────────────────────────────────────── */

  let listToken = 0;
  async function refreshList() {
    const mine = ++listToken;
    const q = new URLSearchParams({archived: A.archived ? "1" : "0", limit: "200"});
    if (PROJECT) q.set("scope", PROJECT);
    if (A.search) q.set("q", A.search);
    try {
      const got = await call(`/api/assistant/sessions?${q}`);
      if (mine !== listToken) return;
      A.sessions = got.sessions || [];
      A.models = got.models || A.models;
    } catch { return; }
    paintList();
  }

  function paintList() {
    list.textContent = "";
    bArchived.classList.toggle("on", A.archived);
    bArchived.querySelector("span").textContent = A.archived ? "Back to conversations" : "Archived";
    if (!A.sessions.length) {
      list.append(el("div", "ax-list-empty", A.search ? "No conversation matches." : A.archived ? "Nothing archived." : "No conversations yet."));
      return;
    }
    const now = Date.now() / 1000;
    const bucket = (s) => s.running ? "Working now" : now - s.updated < 86400 ? "Today"
      : now - s.updated < 172800 ? "Yesterday" : now - s.updated < 604800 ? "This week" : "Earlier";
    let last = null;
    for (const s of A.sessions) {
      const b = bucket(s);
      if (b !== last) { list.append(el("div", "ax-group", b)); last = b; }
      const row = el("div", "ax-row" + (A.session && A.session.id === s.id ? " on" : "") + (s.running ? " running" : ""));
      row.setAttribute("role", "listitem");
      const open = el("button", "ax-row-open");
      open.type = "button";
      const t = el("span", "ax-row-title", s.title || "New conversation");
      const meta = el("span", "ax-row-meta");
      if (!PROJECT) meta.append(el("span", "ax-row-scope", s.scope_name), el("span", "ax-dotsep", "·"));
      meta.append(document.createTextNode(s.running ? "working…" : fmt.ago(s.updated)));
      open.append(s.running ? el("span", "ax-livedot") : el("span", "ax-row-gap"), t, meta);
      open.onclick = () => {
        if (s.scope !== SCOPE && s.scope !== "home") { location.href = `/p/${s.scope}#assistant=${s.id}`; return; }
        if (s.scope === "home" && PROJECT) { location.href = `/#assistant=${s.id}`; return; }
        openSession(s.id);
        if (A.mode !== "focus" || PHONE.matches) root.classList.remove("side-open");
      };
      const more = ibtn("more", "More", "ax-row-more");
      more.onclick = (ev) => { ev.stopPropagation(); openPop((box) => rowMenu(box, s), more); };
      row.append(open, more);
      list.append(row);
    }
  }

  function rowMenu(box, s) {
    const item = (label, name, fn, cls) => {
      const b = tbtn(label, "ax-opt ax-opt-row" + (cls ? " " + cls : ""), name);
      b.onclick = async () => { pop.hidden = true; await fn(); };
      box.append(b);
    };
    item("Rename", "new", async () => {
      const v = prompt("Rename the conversation", s.title || "");
      if (!v || !v.trim()) return;
      await call(`/api/assistant/sessions/${s.id}`, {title: v.trim()}, "PATCH").catch((e) => toast(e.message, true));
      if (A.session && A.session.id === s.id) { A.session.title = v.trim(); paintHead(); }
      refreshList();
    });
    item(s.archived ? "Unarchive" : "Archive", "archive", async () => {
      await call(`/api/assistant/sessions/${s.id}`, {archived: !s.archived}, "PATCH").catch((e) => toast(e.message, true));
      if (A.session && A.session.id === s.id && !s.archived) newSession();
      refreshList();
    });
    item("Delete", "trash", async () => {
      if (!confirm(`Delete “${s.title || "this conversation"}”? This cannot be undone.`)) return;
      await call(`/api/assistant/sessions/${s.id}`, undefined, "DELETE").catch((e) => toast(e.message, true));
      if (A.session && A.session.id === s.id) newSession();
      refreshList();
    }, "danger");
  }

  let searchTimer = 0;
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { A.search = search.value.trim(); refreshList(); }, 200);
  };
  bArchived.onclick = () => { A.archived = !A.archived; refreshList(); };
  sideNew.onclick = () => { newSession(); if (A.mode !== "focus") root.classList.remove("side-open"); input.focus(); };
  bSessions.onclick = () => {
    const open = !root.classList.contains("side-open");
    root.classList.toggle("side-open", open);
    if (open) { refreshList(); search.focus(); }
  };

  /* ── open, new, restore ───────────────────────────────────────────── */

  function newSession() {
    writeDraft();       // what was typed stays with the conversation it was typed in
    A.followToken += 1;
    A.session = null;
    A.items = [];
    A.running = null;
    A.queue = null;
    A.editing = null;
    local.drop(K_CURRENT);
    paintHead();
    paintBusy();
    paintEditing();
    renderAll();
    paintList();
    loadDraft();
  }

  async function ensureSession(extra) {
    if (A.session) return A.session;
    const got = await call("/api/assistant/sessions", {scope: SCOPE, ...(extra || {})});
    A.session = got.session;
    A.boxKey = draftKey();              // what is in the box now belongs to it
    local.set(K_CURRENT, A.session.id);
    paintHead();
    return A.session;
  }

  async function openSession(id) {
    writeDraft();
    const mine = ++A.followToken;
    let got;
    try { got = await call(`/api/assistant/sessions/${id}`); }
    catch (err) {
      if (err.status === 404) { local.drop(K_CURRENT); newSession(); return; }
      toast(err.message, true);
      return;
    }
    if (mine !== A.followToken) return;
    A.session = got.session;
    A.agent = got.agent || A.agent;
    A.models = got.models || A.models;
    A.items = got.items || [];
    A.running = null;
    A.editing = null;
    local.set(K_CURRENT, id);
    paintHead();
    paintEditing();
    loadDraft();
    renderAll();
    paintList();
    if (got.running) follow(got.running.id, got.running.cursor, got.running);
    else paintBusy();
  }

  /* ── the wire ─────────────────────────────────────────────────────── */

  function applyEvent(ev) {
    const r = A.running;
    if (ev.t === "state" && r) { r.state = ev.state; r.detail = ev.detail || ""; paintStatus(); }
    else if (ev.t === "item") {
      const it = ev.item;
      const stick = nearBottom();
      if (it.kind === "user" && pendingUser) { pendingUser.remove(); pendingUser = null; }
      if (A.bySeq.has(it.seq)) replace(it);
      else { A.items.push(it); append(it); markLast(); }
      if (stick) toBottom(); else jump.hidden = false;
    } else if (ev.t === "delta") delta(ev.seq, ev.text);
    else if (ev.t === "usage" && A.session) { A.session.usage = ev.usage; paintHead(); }
    else if (ev.t === "done") finished(ev);
  }

  async function streamOnce(r) {
    const res = await fetch(`/api/assistant/turns/${r.id}/stream?cursor=${r.cursor}`);
    if (res.status === 404) { const e = new Error("gone"); e.status = 404; throw e; }
    if (res.status === 401) { location.href = "/login"; throw new Error("signed out"); }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const {value, done} = await reader.read();
      if (done) return false;
      buf += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.t === "hb") continue;
        if (typeof ev.i === "number") { if (ev.i < r.cursor) continue; r.cursor = ev.i + 1; }
        if (A.running !== r) return true;
        applyEvent(ev);
        if (ev.t === "done") return true;
      }
    }
  }

  async function pollOnce(r) {
    const got = await call(`/api/assistant/turns/${r.id}?cursor=${r.cursor}`);
    for (const ev of got.events) {
      if (typeof ev.i === "number") { if (ev.i < r.cursor) continue; r.cursor = ev.i + 1; }
      if (A.running !== r) return true;
      applyEvent(ev);
      if (ev.t === "done") return true;
    }
    return !got.alive;
  }

  async function follow(id, cursor, info) {
    const r = {id, cursor: cursor || 0, state: (info && info.state) || "starting", detail: "",
      t0: info && info.started ? info.started * 1000 : Date.now()};
    A.running = r;
    paintBusy();
    let streaming = local.get("ax:stream", true), misses = 0;
    while (A.running === r) {
      try {
        const done = streaming ? await streamOnce(r) : await pollOnce(r);
        misses = 0;
        if (done) break;
      } catch (err) {
        if (err.status === 404) {
          if (A.running === r) finished({state: "lost"});
          break;
        }
        misses += 1;
        if (streaming && misses >= 2) { streaming = false; }   // a proxy that will not stream: poll
        if (misses > 40) {
          if (A.running === r) {
            A.running = null;
            paintBusy();
            toast("Lost the connection to the assistant — it may still be working; reopen the conversation to reattach", true);
          }
          break;
        }
        await sleep(Math.min(6000, 500 * misses));
      }
    }
  }

  function finished(ev) {
    const r = A.running;
    A.running = null;
    if (ev.state === "lost") toast("That task is no longer running — the studio restarted", true);
    if (ev.usage && A.session) A.session.usage = ev.usage;
    paintBusy();
    paintHead();
    markLast();
    for (const g of log.querySelectorAll(".ax-act.live")) paintActivity(g);
    if (r && A.session) {
      A.lastEnded.add(r.id);
      // the title may have been named by the model by now
      setTimeout(() => A.session && call(`/api/assistant/sessions/${A.session.id}`).then((got) => {
        if (A.session && got.session.id === A.session.id) { A.session = got.session; paintHead(); refreshListIfShown(); }
      }).catch(() => {}), 4000);
      if (document.hidden && local.get("ax:notify", false) && "Notification" in W && Notification.permission === "granted") {
        try { new Notification("The assistant is done", {body: A.session.title || "Your task finished"}); } catch { /* no notifications */ }
      }
    }
    refreshListIfShown();
    if (A.queue) { const q = A.queue; A.queue = null; paintQueue(); submit(q.text, false, q.images); }
  }

  const refreshListIfShown = () => { if (root.classList.contains("side-open") || A.mode === "focus") refreshList(); };

  let tick = 0;
  function paintBusy() {
    const busy = !!A.running;
    root.classList.toggle("busy", busy);
    status.hidden = !busy;
    send.replaceChildren(icon(busy ? "stop" : "up"));
    send.classList.toggle("stop", busy);
    send.title = busy ? "Stop" : "Send  ( Enter )";
    send.setAttribute("aria-label", busy ? "Stop" : "Send");
    clearInterval(tick);
    if (busy) { paintStatus(); tick = setInterval(paintStatus, 1000); }
    document.body.classList.toggle("ax-busy", busy);
    document.dispatchEvent(new CustomEvent("oxassistant", {detail: {busy}}));
    askbarPaint();
  }

  function paintStatus() {
    const r = A.running;
    if (!r) return;
    const words = {starting: "Starting", thinking: "Thinking", writing: "Writing", compacting: "Compacting the conversation",
      stopping: "Stopping"};
    statusText.textContent = r.state === "tool" && r.detail ? r.detail : `${words[r.state] || "Working"}…`;
    statusTime.textContent = fmt.secs((Date.now() - r.t0) / 1000);
  }

  async function stop() {
    const r = A.running;
    if (!r) return;
    r.state = "stopping";
    paintStatus();
    try { await call(`/api/assistant/turns/${r.id}/stop`, {}); } catch (err) { toast(err.message, true); }
  }
  statusStop.onclick = stop;

  /* ── sending ──────────────────────────────────────────────────────── */

  let pendingUser = null;

  function viewForMessage() {
    const v = Object.assign({}, W.__oxview || {});
    for (const k of A.dropped) delete v[k];
    return PROJECT ? v : null;
  }

  /* Send a message. `fromBox`: it is the composer's, so the box empties
   * now and comes back if the send fails; a message from elsewhere (a
   * starter, another screen, the queue) leaves what is being typed alone. */
  async function submit(text, fromBox, images) {
    text = String(text || "").trim();
    images = fromBox ? A.images.slice() : (images || []);
    if (!text && !images.length) return;
    if (!images.length && text.startsWith("/") && runCommand(text)) return;
    const snap = fromBox ? takeBox() : null;
    closeSlash();
    if (A.running) { A.queue = {text, images}; paintQueue(); return; }
    if (A.editing) {
      const t = A.editing.turn;
      A.editing = null;
      paintEditing();
      let ok = false;
      try {
        const refs = await uploadImages(A.session.id, images);
        ok = await redo({edit_of: t, message: text, attachments: refs.map((r) => r.id)});
      } catch (err) { toast(err.message, true); }
      if (!ok && snap) { A.editing = {turn: t}; putBox(snap); paintEditing(); }
      return;
    }
    let sess;
    try { sess = await ensureSession(); } catch (err) { toast(err.message, true); if (snap) putBox(snap); return; }
    if (A.mode === "hero") placement.enterFocus();
    if (!A.items.length) log.textContent = "";
    // show the message at once; the server's copy replaces it
    newTurn({seq: -1, text, kind: "user", attachments: images.map((im) => ({url: im.url, name: im.name}))});
    pendingUser = turnEl;
    toBottom();
    let got;
    try {
      // images go up first (the browser already resized them), then the turn names them
      const refs = await uploadImages(sess.id, images);
      got = await call(`/api/assistant/sessions/${sess.id}/turns`,
        {message: text, view: viewForMessage(), ...(refs.length ? {attachments: refs.map((r) => r.id)} : {})});
    } catch (err) {
      if (pendingUser) { pendingUser.remove(); pendingUser = null; }
      if (snap) putBox(snap);
      toast(err.message, true);
      return;
    }
    A.dropped.clear();
    paintChips();
    // the server titles a new conversation from its first message; so does
    // the header, at once (the model's title replaces both when it lands)
    if (!A.session.title) {
      A.session.title = text ? titleFrom(W.Paste ? W.Paste.gist(text) : text) : (images[0] && images[0].name) || "Image";
      paintHead();
      refreshListIfShown();
    }
    // the pending message stays until the server's copy arrives (the first event)
    follow(got.turn, 0);
    refreshListIfShown();
  }

  async function redo(opts) {
    if (!A.session || A.running) return false;
    // an answer that changed files: its edits stay unless the user puts them back
    const from = A.items.findIndex((x) => x.turn === (opts.retry_of || opts.edit_of));
    const pending = A.items.slice(Math.max(0, from)).filter((x) => x.kind === "changes" && x.state !== "undone");
    if (pending.length && PROJECT) {
      const n = pending.reduce((a, c) => a + (c.files || []).length, 0);
      const putBack = confirm(`That answer changed ${n} file${n === 1 ? "" : "s"}. Put ${n === 1 ? "it" : "them"} back before trying again?\n\nOK — put back first · Cancel — keep the files as they are`);
      if (putBack) {
        for (const c of pending) {
          try {
            await call(`/api/p/${PROJECT}/chat/undo`, {sha: c.sha, files: (c.files || []).filter((f) => !f.new).map((f) => f.path),
              new_files: (c.files || []).filter((f) => f.new).map((f) => f.path)});
            await call(`/api/assistant/sessions/${A.session.id}/items/${c.seq}`, {state: "undone"});
          } catch (err) { toast(`Could not put the files back: ${err.message}`, true); return false; }
        }
      }
    }
    try {
      await call(`/api/assistant/sessions/${A.session.id}/turns`, {...opts, view: viewForMessage()});
    } catch (err) { toast(err.message, true); return false; }
    await openSession(A.session.id);
    return true;
  }

  // an earlier message back in the box, its long blocks as cards again;
  // what was being typed waits in the draft and returns on cancel
  function startEdit(item) {
    if (A.running) { toast("Wait for the current answer, or stop it, to edit a message"); return; }
    writeDraft();
    A.editing = {turn: item.turn};
    const u = W.Paste ? W.Paste.unpack(item.text || "") : {text: item.text || "", blocks: []};
    input.value = u.text;
    A.blocks = u.blocks;
    A.images = (item.attachments || []).map((ref) => ({ref, sid: A.session && A.session.id, url: attUrl(ref),
      name: ref.name, mime: ref.mime, w: ref.w, h: ref.h}));
    paintTray();
    autosize();
    paintEditing();
    input.focus();
  }

  function cancelEdit() {
    A.editing = null;
    paintEditing();
    loadDraft();
  }

  function paintEditing() {
    root.classList.toggle("editing", !!A.editing);
    queued.hidden = !(A.queue || A.editing);
    queued.textContent = "";
    if (A.editing) {
      queued.append(icon("new"), el("span", null, "Editing an earlier message — sending replaces it and everything after"));
      const x = ibtn("x", "Cancel editing", "ax-mini");
      x.onclick = cancelEdit;
      queued.append(x);
    } else if (A.queue) paintQueue();
  }

  function paintQueue() {
    if (A.editing) return;
    queued.hidden = !A.queue;
    queued.textContent = "";
    if (!A.queue) return;
    const n = (A.queue.images || []).length;
    const g = ((W.Paste ? W.Paste.gist(A.queue.text) : A.queue.text) || "").replace(/\s+/g, " ")
      + (n ? ` (+${n} image${n === 1 ? "" : "s"})` : "");
    queued.append(icon("clock"), el("span", null, `Queued: ${g.slice(0, 90)}${g.length > 90 ? "…" : ""}`));
    const x = ibtn("x", "Don't send it", "ax-mini");
    x.onclick = () => { A.queue = null; paintQueue(); };
    queued.append(x);
  }

  async function doCompact() {
    if (!A.session || !A.session.claude_session || A.running) return;
    try {
      const got = await call(`/api/assistant/sessions/${A.session.id}/compact`, {});
      follow(got.turn, 0);
    } catch (err) { toast(err.message, true); }
  }

  function exportMarkdown() {
    const s = A.session;
    const out = [`# ${(s && s.title) || "Conversation"}`, ""];
    for (const it of A.items) {
      if (it.kind === "user") out.push(`## You`, "", it.text || "", "");
      else if (it.kind === "text") out.push(it.text || "", "");
      else if (it.kind === "tool") out.push(`> ${it.status === "error" ? "✗" : "✓"} ${it.label || it.name}`, "");
      else if (it.kind === "changes") out.push("```diff", it.diff || "", "```", "");
      else if (it.kind === "error") out.push(`> **Error:** ${it.text}`, "");
      else if (it.kind === "compact") out.push("---", "*Context compacted*", "---", "");
    }
    const blob = new Blob([out.join("\n")], {type: "text/markdown"});
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${((s && s.title) || "conversation").replace(/[^\w.-]+/g, "_").slice(0, 60)}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ── slash commands ───────────────────────────────────────────────── */

  const COMMANDS = [
    ["/new", "Start a new conversation", () => newSession()],
    ["/sessions", "Show your conversations", () => { root.classList.add("side-open"); refreshList(); search.focus(); }],
    ["/compact", "Summarize the conversation to free the context", () => doCompact()],
    ["/model", "Choose the model: /model opus | sonnet | haiku | default", (arg) => {
      const v = (arg || "").toLowerCase();
      if (!v) { openPop(modelMenu, modelPick); return; }
      if (v === "default") setModel(null);
      else if (A.models.includes(v)) setModel(v);
      else toast(`No model “${v}” — try opus, sonnet, haiku or default`, true);
    }],
    ["/retry", "Regenerate the last answer", () => {
      const last = [...A.items].reverse().find((x) => x.turn);
      if (last) redo({retry_of: last.turn});
    }],
    ["/focus", "Give the conversation the whole screen", () => placement.toggleFocus()],
    ["/export", "Download the conversation as Markdown", () => exportMarkdown()],
    ["/help", "What you can ask for", () => {
      A.items.push({seq: -Date.now(), kind: "note", text: "Say what you want in your own words — “why did yesterday's calls fail?”, “add an eval for the refund flow”, “make the greeting shorter and test it”. Commands: " + COMMANDS.map((c) => c[0]).join(" ")});
      renderAll();
    }],
  ];

  function runCommand(text) {
    const [name, ...rest] = text.split(/\s+/);
    const cmd = COMMANDS.find((c) => c[0] === name.toLowerCase());
    if (!cmd) return false;
    input.value = "";
    autosize();
    closeSlash();
    saveDraft();
    cmd[2](rest.join(" "));
    return true;
  }

  let slashIndex = 0;
  function paintSlash() {
    const v = input.value;
    if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) { closeSlash(); return; }
    const hits = COMMANDS.filter((c) => c[0].startsWith(v.toLowerCase()));
    if (!hits.length) { closeSlash(); return; }
    slashIndex = Math.min(slashIndex, hits.length - 1);
    slash.textContent = "";
    hits.forEach((c, i) => {
      const b = el("button", "ax-slash-row" + (i === slashIndex ? " on" : ""));
      b.type = "button";
      b.setAttribute("role", "option");
      b.append(el("span", "ax-slash-name", c[0]), el("span", "ax-slash-desc", c[1]));
      b.onmousedown = (ev) => { ev.preventDefault(); input.value = c[0] + " "; closeSlash(); if (c[0] !== "/model") submit(c[0]); else input.focus(); };
      slash.append(b);
    });
    slash._hits = hits;
    slash.hidden = false;
  }
  function closeSlash() { slash.hidden = true; slashIndex = 0; }

  /* ── the composer ─────────────────────────────────────────────────── */

  /* Height: two lines at rest, growing with the text to half the panel
   * (40% of a phone's screen), then scrolling. The grip on the top edge
   * sets a height by hand, remembered per placement; Expand gives the
   * words the whole column. */
  const MIN_BOX = 56;          // two lines of text
  const expanded = () => root.classList.contains("expanded");
  const handH = (mode) => (mode in A.boxH ? A.boxH[mode] : (A.boxH[mode] = local.get(`ax:boxh:${mode}`, 0) || 0));

  function autosize() {
    if (expanded()) { input.style.height = ""; return; }
    const hero = A.mode === "hero";
    const room = hero ? W.innerHeight : (root.clientHeight || W.innerHeight);
    const cap = Math.max(120, Math.round(room * (hero ? 0.35 : A.mode === "sheet" ? 0.4 : 0.5)));
    const hand = hero ? 0 : Math.min(handH(A.mode), Math.round(room * 0.7));
    input.style.height = "auto";
    input.style.height = `${Math.min(Math.max(cap, hand), Math.max(input.scrollHeight, hand))}px`;
  }

  grip.addEventListener("pointerdown", (ev) => {
    if (A.mode === "hero" || expanded()) return;
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    const y0 = ev.clientY, h0 = input.offsetHeight;
    const max = Math.round((root.clientHeight || W.innerHeight) * 0.7);
    root.classList.add("sizing");
    const move = (e) => { input.style.height = `${Math.max(MIN_BOX, Math.min(max, h0 + y0 - e.clientY))}px`; };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      root.classList.remove("sizing");
      const h = input.offsetHeight <= MIN_BOX + 2 ? 0 : input.offsetHeight;
      A.boxH[A.mode] = h;
      if (h) local.set(`ax:boxh:${A.mode}`, h); else local.drop(`ax:boxh:${A.mode}`);
      autosize();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => { A.boxH[A.mode] = 0; local.drop(`ax:boxh:${A.mode}`); autosize(); });

  function setExpanded(on) {
    if (on === expanded()) return;
    root.classList.toggle("expanded", on);
    bExpand.replaceChildren(icon(on ? "fold" : "unfold"));
    bExpand.title = on ? "Back to the conversation  ( Esc )" : "Expand the editor";
    bExpand.setAttribute("aria-label", bExpand.title);
    autosize();
    if (!on) requestAnimationFrame(toBottom);
    input.focus();
  }
  bExpand.onclick = () => setExpanded(!expanded());

  // the panel changes size (a drag, a rotation, the window): the cap moves
  let sizeFrame = 0;
  new ResizeObserver(() => {
    if (!sizeFrame) sizeFrame = requestAnimationFrame(() => { sizeFrame = 0; autosize(); });
  }).observe(root);

  /* Pasted cards: a paste past 12 lines or 2,000 characters becomes a card
   * (static/paste.js says what it is); the message carries it as a fenced
   * block ahead of the words. */
  const PASTE_ICON = {json: "braces", code: "code", log: "terminal", text: "file"};

  function paintTray() {
    tray.textContent = "";
    tray.hidden = !A.blocks.length && !A.images.length;
    A.images.forEach((im, i) => {
      const t = el("div", "ax-thumb");
      t.title = `${im.name || "image"}${im.w ? ` · ${im.w}×${im.h}` : ""}`;
      const open = el("button", "ax-thumb-open");
      open.type = "button";
      const img = el("img");
      img.src = im.url;
      img.alt = im.name || "image";
      open.append(img);
      open.onclick = () => showImage(im.url, im.name, () => { A.images.splice(i, 1); paintTray(); saveDraft(); });
      const x = ibtn("x", "Remove", "ax-thumb-x");
      x.onclick = () => { A.images.splice(i, 1); paintTray(); saveDraft(); input.focus(); };
      t.append(open, x);
      tray.append(t);
    });
    A.blocks.forEach((b, i) => {
      // compact: what it is, then its size and what is in it
      const card = el("div", `ax-paste ax-paste-${b.kind || "text"}`);
      card.dataset.label = W.Paste.label(b);
      const open = el("button", "ax-paste-open");
      open.type = "button";
      open.title = `${card.dataset.label} — preview or edit`;
      const ico = el("span", "ax-paste-ico");
      ico.append(icon(PASTE_ICON[b.kind] || "file"));
      const words = el("span", "ax-paste-words");
      words.append(el("span", "ax-paste-label", b.name || W.Paste.langLabel(b.lang)));
      const n = b.lines != null ? b.lines : b.text.split("\n").length;
      words.append(el("span", "ax-paste-sub", [b.detail, `${n} line${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ")));
      open.append(ico, words);
      open.onclick = () => openPeek(i);
      const x = ibtn("x", "Remove", "ax-paste-x");
      x.onclick = () => { A.blocks.splice(i, 1); paintTray(); saveDraft(); input.focus(); };
      card.append(open, x);
      tray.append(card);
    });
  }

  function addBlock(c) {
    A.blocks.push({kind: c.kind, lang: c.lang, name: c.name || "", text: c.text, lines: c.lines, chars: c.chars,
      detail: c.detail || ""});
    paintTray();
    saveDraft();
  }

  input.addEventListener("paste", (ev) => {
    const files = [...((ev.clipboardData && ev.clipboardData.files) || [])];
    if (files.length) { ev.preventDefault(); addFiles(files); return; }
    const text = ev.clipboardData && ev.clipboardData.getData("text/plain");
    if (!text || !W.Paste || !W.Paste.wantsCard(text)) return;  // a short paste stays in the words
    ev.preventDefault();
    addBlock(W.Paste.classify(text));
  });

  function openPeek(i) {
    const b = A.blocks[i];
    if (!b) return;
    peek.textContent = "";
    const top = el("div", "ax-peek-head");
    const ico = el("span", "ax-paste-ico");
    ico.append(icon(PASTE_ICON[b.kind] || "file"));
    const lang = el("select", "ax-peek-lang");
    lang.setAttribute("aria-label", "What this is");
    const langs = {...W.Paste.LABEL};
    if (!langs[b.lang]) langs[b.lang] = W.Paste.langLabel(b.lang);
    for (const [k, v] of Object.entries(langs)) { const o = el("option", null, v); o.value = k; lang.append(o); }
    lang.value = b.lang;
    const x = ibtn("x", "Close  ( Esc )", "ax-peek-x");
    top.append(ico, el("b", "ax-peek-title", W.Paste.label(b)), el("span", "ax-spacer"), lang, x);
    const area = el("textarea", "ax-peek-text");
    area.value = b.text;
    area.spellcheck = false;
    area.setAttribute("aria-label", "The pasted text");
    const acts = el("div", "ax-peek-acts");
    const remove = tbtn("Remove", "ax-btn ax-btn-quiet", "trash");
    const inline = tbtn("Put inline", "ax-btn ax-btn-quiet");
    inline.title = "As plain words in the box, not a card";
    const save = tbtn("Save", "ax-btn primary");
    save.title = "Save  ( Ctrl Enter )";
    acts.append(remove, inline, el("span", "ax-spacer"), save);
    peek.append(top, area, acts);
    const close = () => { peek.hidden = true; peek.textContent = ""; root.classList.remove("peeking"); input.focus(); };
    x.onclick = close;
    remove.onclick = () => { A.blocks.splice(i, 1); paintTray(); saveDraft(); close(); };
    inline.onclick = () => {
      A.blocks.splice(i, 1);
      paintTray();
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + area.value + input.value.slice(at);
      close();
      autosize();
      saveDraft();
    };
    save.onclick = () => {
      const text = area.value;
      if (!text.trim()) A.blocks.splice(i, 1);
      else if (text !== b.text || lang.value !== b.lang) {
        const c = text !== b.text ? W.Paste.classify(text) : {...b};
        // the language picked by hand wins over the guess
        const chosen = lang.value !== b.lang ? lang.value : c.lang;
        A.blocks[i] = {...b, ...c, lang: chosen, kind: W.Paste.kindOf(chosen),
          detail: chosen === c.lang ? c.detail || "" : ""};
      }
      paintTray();
      saveDraft();
      close();
    };
    area.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save.onclick(); }
    });
    peek.hidden = false;
    root.classList.add("peeking");
    area.focus();
    area.setSelectionRange(0, 0);
    area.scrollTop = 0;
  }

  /* Images and files. An image is resized here to a 1568 px long edge
   * (what the model sees anyway) and kept in memory until the message is
   * sent, then uploaded; at most 8 a message. A text file becomes a card,
   * sent as a fenced block under its name. */
  const MAX_IMAGES = 8;
  const MAX_EDGE = 1568;
  const MAX_BYTES = 5 * 1024 * 1024;
  const KEEP = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const TEXT_LANG = {py: "python", json: "json", jsonl: "jsonl", csv: "csv", md: "markdown", txt: "text", log: "log",
    yaml: "yaml", yml: "yaml", toml: "toml", js: "javascript", ts: "typescript", sql: "sql", sh: "bash"};

  function decode(file) {
    if (W.createImageBitmap) return createImageBitmap(file);
    return new Promise((ok, bad) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => bad(new Error("unreadable"));
      img.src = URL.createObjectURL(file);
    });
  }

  async function prepareImage(file) {
    const pic = await decode(file);
    const w0 = pic.width, h0 = pic.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
    // small enough and a kept type: the file as it is (a GIF keeps its motion)
    if (scale === 1 && KEEP.has(file.type) && file.size <= MAX_BYTES) {
      if (pic.close) pic.close();
      return {blob: file, mime: file.type, w: w0, h: h0};
    }
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const canvas = el("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(pic, 0, 0, w, h);
    if (pic.close) pic.close();
    const encode = (type, q) => new Promise((ok) => canvas.toBlob(ok, type, q));
    let blob = file.type === "image/png" ? await encode("image/png") : null;
    if (!blob || blob.size > MAX_BYTES) blob = await encode("image/jpeg", 0.88);
    return {blob, mime: blob.type, w, h};
  }

  async function addFiles(files) {
    let room = MAX_IMAGES - A.images.length, skipped = 0;
    for (const file of files) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (file.type.startsWith("image/")) {
        if (room <= 0) { skipped += 1; continue; }
        room -= 1;
        try {
          const got = await prepareImage(file);
          A.images.push({...got, url: URL.createObjectURL(got.blob),
            name: file.name && file.name !== "image.png" ? file.name : `pasted-image.${got.mime.split("/")[1].replace("jpeg", "jpg")}`});
        } catch { toast(`Can't read ${file.name || "that image"}`, true); room += 1; }
      } else if (TEXT_LANG[ext] || file.type.startsWith("text/")) {
        if (file.size > 2 * 1024 * 1024) { toast(`${file.name} is over 2 MB — too long to send as text`, true); continue; }
        const text = await file.text();
        const c = W.Paste.classify(text);
        const lang = TEXT_LANG[ext] || c.lang;
        addBlock({...c, name: file.name, lang, kind: W.Paste.kindOf(lang), detail: lang === c.lang ? c.detail : ""});
      } else {
        toast(`${file.name}: images and text files only for now`, true);
      }
    }
    if (skipped) toast(`At most ${MAX_IMAGES} images a message — ${skipped} left out`, true);
    paintTray();
    saveDraft();
    input.focus();
  }

  const blobB64 = (blob) => new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => bad(new Error("could not read the image"));
    r.readAsDataURL(blob);
  });

  // upload what is not up yet (an edit's images already are), in order
  async function uploadImages(sid, images) {
    const refs = [];
    for (const im of images) {
      if (im.ref && im.sid === sid) { refs.push(im.ref); continue; }
      if (!im.blob) continue;
      const got = await call(`/api/assistant/sessions/${sid}/attachments`,
        {name: im.name, mime: im.mime, data: await blobB64(im.blob), w: im.w, h: im.h});
      im.ref = got.attachment;
      im.sid = sid;
      refs.push(im.ref);
    }
    return refs;
  }

  // one image, large, over the conversation; Remove when it is still in the box
  function showImage(src, name, remove) {
    peek.textContent = "";
    const top = el("div", "ax-peek-head");
    const x = ibtn("x", "Close  ( Esc )", "ax-peek-x");
    top.append(el("b", "ax-peek-title", name || "Image"), el("span", "ax-spacer"), x);
    const stage = el("div", "ax-peek-img");
    const img = el("img");
    img.src = src;
    img.alt = name || "image";
    stage.append(img);
    peek.append(top, stage);
    if (remove) {
      const acts = el("div", "ax-peek-acts");
      const rm = tbtn("Remove", "ax-btn ax-btn-quiet", "trash");
      rm.onclick = () => { remove(); close(); };
      acts.append(rm);
      peek.append(acts);
    }
    const close = () => { peek.hidden = true; peek.textContent = ""; root.classList.remove("peeking"); document.removeEventListener("keydown", esc, true); input.focus(); };
    const esc = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); } };
    document.addEventListener("keydown", esc, true);
    x.onclick = close;
    stage.onclick = (ev) => { if (ev.target === stage) close(); };
    peek.hidden = false;
    root.classList.add("peeking");
  }

  bAttach.onclick = () => fileInput.click();
  fileInput.onchange = () => { const f = [...fileInput.files]; fileInput.value = ""; if (f.length) addFiles(f); };

  // drag and drop onto the assistant, wherever it sits
  let dragDepth = 0;
  const hasFiles = (ev) => ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes("Files");
  root.addEventListener("dragenter", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth += 1;
    root.classList.add("dropping");
  });
  root.addEventListener("dragover", (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; } });
  root.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) root.classList.remove("dropping"); });
  root.addEventListener("drop", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    root.classList.remove("dropping");
    addFiles([...ev.dataTransfer.files]);
  });

  /* Drafts: each conversation keeps what is being typed (and its cards),
   * in this browser, until it is sent. A new conversation's draft is the
   * scope's. */
  // the box holds one conversation's draft and writes back only to it
  // (on a page load nothing is loaded yet, so nothing is written over)
  const draftKey = () => (A.session ? `ax:draft:${A.session.id}` : `ax:draft:${SCOPE}:new`);
  let draftTimer = 0;
  function writeDraft() {
    clearTimeout(draftTimer);
    const key = A.boxKey;
    if (!key || A.editing) return;       // an edit is not a draft
    if (A.images.length) A.imagesByKey.set(key, A.images); else A.imagesByKey.delete(key);
    if (!input.value.trim() && !A.blocks.length) { local.drop(key); return; }   // images alone live in memory
    local.set(key, {t: Date.now(), text: input.value, blocks: A.blocks});
  }
  function saveDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(writeDraft, 300); }
  // leaving the page writes what the timer has not yet
  W.addEventListener("pagehide", writeDraft);
  function loadDraft() {
    A.boxKey = draftKey();
    A.images = A.imagesByKey.get(A.boxKey) || [];
    const d = local.get(A.boxKey, null);
    input.value = (d && typeof d.text === "string") ? d.text : "";
    A.blocks = (d && Array.isArray(d.blocks)) ? d.blocks.filter((b) => b && typeof b.text === "string") : [];
    paintTray();
    autosize();
  }
  function pruneDrafts() {
    // drafts older than 30 days go; a quota never breaks the page
    try {
      const old = Date.now() - 30 * 86400e3;
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith("ax:draft:") && !((local.get(k, null) || {}).t > old)) localStorage.removeItem(k);
      }
    } catch { /* no storage */ }
  }

  // the box's contents leave on send, and come back if the send fails
  function takeBox() {
    const snap = {text: input.value, blocks: A.blocks, images: A.images};
    clearTimeout(draftTimer);
    if (!A.editing && A.boxKey) { local.drop(A.boxKey); A.imagesByKey.delete(A.boxKey); }
    input.value = "";
    A.blocks = [];
    A.images = [];
    paintTray();
    setExpanded(false);
    autosize();
    return snap;
  }
  function putBox(snap) {
    input.value = snap.text;
    A.blocks = snap.blocks;
    A.images = snap.images || [];
    paintTray();
    autosize();
    saveDraft();
  }

  // Esc empties the box as an edit, so Ctrl Z brings the words back
  function clearBox() {
    input.focus();
    input.select();
    let done = false;
    try { done = document.execCommand("delete"); } catch { done = false; }
    if (!done || input.value) input.value = "";
    autosize();
    closeSlash();
    saveDraft();
  }

  input.addEventListener("input", () => { autosize(); paintSlash(); saveDraft(); });
  input.addEventListener("keydown", (ev) => {
    if (!slash.hidden && slash._hits) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); slashIndex = (slashIndex + 1) % slash._hits.length; paintSlash(); return; }
      if (ev.key === "ArrowUp") { ev.preventDefault(); slashIndex = (slashIndex - 1 + slash._hits.length) % slash._hits.length; paintSlash(); return; }
      if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey && input.value.trim() !== slash._hits[slashIndex][0])) {
        ev.preventDefault();
        input.value = slash._hits[slashIndex][0] + " ";
        closeSlash();
        return;
      }
      if (ev.key === "Escape") { closeSlash(); return; }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      composer.requestSubmit();
      return;
    }
    if (ev.key === "ArrowUp" && !input.value && !A.blocks.length && !A.running) {
      const last = [...A.items].reverse().find((x) => x.kind === "user" && x.turn && !x.imported);
      if (last) { ev.preventDefault(); startEdit(last); }
    }
    if (ev.key === "Escape") {
      // one thing at a time: the big editor, an edit, the words, a running turn, then the placement
      ev.preventDefault();
      if (expanded()) setExpanded(false);
      else if (A.editing) cancelEdit();
      else if (input.value) { clearBox(); toast("Cleared — Ctrl Z brings it back"); }
      else if (A.running) stop();
      else if (A.mode === "focus" || A.mode === "sheet") placement.leave();
    }
  });
  composer.onsubmit = (ev) => {
    ev.preventDefault();
    const typed = input.value.trim();
    if (A.running && !typed && !A.blocks.length && !A.images.length) { stop(); return; }
    if (typed.startsWith("/") && runCommand(typed)) return;      // a command leaves the cards be
    submit(W.Paste ? W.Paste.compose(input.value, A.blocks) : input.value, true);
  };

  /* context chips: what rides along with the next message */
  const CHIP_LABEL = {node: (v) => v, run: (v) => `run ${String(v).slice(0, 10)}`, tab: (v) => ({
    flow: "Flow", traces: "Runs", monitor: "Monitor", playground: "Playground", evals: "Evals", jobs: "Jobs", review: "Review",
    prompts: "Prompts", services: "Services", alerts: "Alerts", resources: "Resources", settings: "Settings"}[v] || v)};
  const CHIP_ICON = {node: "graph", run: "list", tab: "right"};
  function paintChips() {
    chips.textContent = "";
    const v = W.__oxview || {};
    if (!PROJECT) { chips.hidden = true; return; }
    let n = 0;
    for (const k of ["node", "run", "tab"]) {
      if (!v[k] || A.dropped.has(k)) continue;
      const c = el("span", `ax-ctxchip ax-ctx-${k}`);
      c.title = k === "tab" ? "The screen you are on rides along" : "The assistant will know you mean this";
      c.append(icon(CHIP_ICON[k]), el("span", null, CHIP_LABEL[k](v[k])));
      const x = el("button", "ax-ctx-x");
      x.type = "button";
      x.setAttribute("aria-label", `Don't send ${k}`);
      x.append(icon("x"));
      x.onclick = () => { A.dropped.add(k); paintChips(); };
      c.append(x);
      chips.append(c);
      n += 1;
    }
    chips.hidden = !n;
  }
  let sugNode = null;
  document.addEventListener("oxview", () => {
    A.dropped.clear();
    paintChips();
    // new starters only when what is pointed at changed
    const node = (W.__oxview || {}).node || null;
    if (node !== sugNode && !A.items.length && PROJECT && !A.running) { sugNode = node; A.suggestions = null; renderEmpty(); }
  });

  /* ── the flow changed after an answer ─────────────────────────────── */

  document.addEventListener("oxflowchanged", (ev) => {
    const ops = (ev.detail && ev.detail.ops) || [];
    if (!ops.length || !A.session || !replyEl) return;
    const recent = A.running || A.lastEnded.size;
    if (!recent) return;
    const card = el("div", "ax-card ax-flow");
    const top = el("div", "ax-card-head");
    top.append(icon("graph"), el("b", null, "The flow changed"),
      el("span", "ax-card-note", `${ops.length} op${ops.length === 1 ? "" : "s"}: ${ops.slice(0, 4).join(", ")}${ops.length > 4 ? "…" : ""}`));
    const acts = el("div", "ax-card-acts");
    const show = tbtn("Show on the canvas", "ax-btn", "right");
    show.onclick = () => { W.oxStudioLink && W.oxStudioLink(`studio:op/${ops[0]}`); if (A.mode !== "dock") placement.leave(); };
    acts.append(el("span", "ax-spacer"), show);
    card.append(top, acts);
    replyEl.append(card);
    if (nearBottom()) toBottom();
  });

  // a turn that ended elsewhere (another tab, another device) — the pulse hears it
  document.addEventListener("oxturnended", (ev) => {
    for (const e of (ev.detail && ev.detail.ended) || []) {
      if (A.lastEnded.has(e.turn) || (A.session && A.session.id === e.session && A.running)) continue;
      A.lastEnded.add(e.turn);
      if (A.session && A.session.id === e.session) { openSession(e.session); continue; }
      toast(`The assistant finished “${e.title || "a task"}”`);
    }
    refreshListIfShown();
  });

  /* ── placement: dock, focus, sheet, hero ──────────────────────────── */

  const dock = document.getElementById("chatdock");
  const askbar = el("button", "ax-askbar");
  askbar.type = "button";
  const askText = el("span", "ax-askbar-text", "Ask the assistant…");
  askbar.append(icon("spark"), askText);

  function askbarPaint() {
    askbar.classList.toggle("busy", !!A.running);
    askText.textContent = A.running ? "The assistant is working…" : "Ask the assistant…";
  }

  const placement = {
    home: null,
    set(mode) {
      setExpanded(false);
      A.mode = mode;
      root.classList.remove("dock", "focus", "sheet", "hero");
      root.classList.add(mode);
      document.body.classList.toggle("ax-focus", mode === "focus");
      document.body.classList.toggle("ax-sheet", mode === "sheet");
      bFocus.replaceChildren(icon(mode === "focus" ? "collapse" : "expand"));
      bFocus.title = mode === "focus" ? "Leave focus  ( Esc )" : "Focus  ( Ctrl J )";
      bFocus.hidden = mode === "sheet";
      bClose.hidden = mode === "hero";
      if (mode === "focus" && !PHONE.matches) { root.classList.add("side-open"); refreshList(); }
      if (mode === "dock") root.classList.remove("side-open");
      requestAnimationFrame(() => { autosize(); toBottom(); });
    },
    enterFocus() {
      if (PHONE.matches) { this.openSheet(); return; }
      const stage = this.stage();
      stage.append(root);
      stage.hidden = false;
      this.set("focus");
      input.focus();
    },
    stage() {
      let s = document.getElementById("axstage");
      if (!s) {
        s = el("div");
        s.id = "axstage";
        const mainEl = document.querySelector(".main") || document.body;
        mainEl.append(s);
      }
      return s;
    },
    openSheet() {
      const s = this.stage();
      s.append(root);
      s.hidden = false;
      this.set("sheet");
      setTimeout(() => input.focus(), 50);
    },
    leave() {
      const s = document.getElementById("axstage");
      if (IS_HOME()) {
        if (s) s.hidden = true;
        this.placeHero();
        newSession();
        document.dispatchEvent(new CustomEvent("oxassistant-list"));
        return;
      }
      if (dock) dock.append(root);
      if (s) s.hidden = true;
      this.set("dock");
      if (PHONE.matches && W.oxSide && W.oxSide.hide) {
        // on a phone the dock is not where the assistant lives
        const st = W.oxSide.state();
        if (st.tab === "assistant") W.oxSide.hide("inspect");
      }
    },
    toggleFocus() { if (A.mode === "focus" || A.mode === "sheet") this.leave(); else this.enterFocus(); },
    placeHero() {
      const slot = document.getElementById("axhero");
      if (slot) slot.append(root);
      this.set("hero");
    },
  };
  const IS_HOME = () => !PROJECT;
  bFocus.onclick = () => placement.toggleFocus();
  bClose.onclick = () => {
    if (A.mode === "focus" || A.mode === "sheet") placement.leave();
    else if (W.oxSide) W.oxSide.show("inspect");
  };
  bNew.onclick = () => { newSession(); input.focus(); };
  // a phone opens the full sheet; a tablet, the side panel over the content
  askbar.onclick = () => (PHONE.matches || !W.oxSide ? placement.openSheet() : W.oxSide.show("assistant"));

  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "j" || ev.key === "J")) {
      ev.preventDefault();
      if (IS_HOME()) { if (A.mode === "focus") placement.leave(); else placement.enterFocus(); }
      else placement.toggleFocus();
    }
  });

  /* ── the page's hooks ─────────────────────────────────────────────── */

  // another screen hands the assistant a task (the prompt workbench)
  W.oxAsk = (text) => {
    if (PHONE.matches) placement.openSheet();
    else if (A.mode === "dock" && W.oxSide) W.oxSide.show("assistant");
    if (A.running) { A.queue = {text, images: []}; paintQueue(); toast("Queued — it goes when the current answer is done"); return; }
    submit(text);
  };
  // the inspector's "Ask about this": the selection rides along; start typing
  W.oxAssistant = {
    focus() {
      if (PHONE.matches) placement.openSheet();
      else if (A.mode === "dock" && W.oxSide) W.oxSide.show("assistant");
      A.dropped.delete("node");
      paintChips();
      input.focus();
    },
    open(id, focus) { openSession(id); if (focus && A.mode === "hero") placement.enterFocus(); },
    busy: () => !!A.running,
  };

  /* ── boot ─────────────────────────────────────────────────────────── */

  async function importOld() {
    // the old panel kept its conversation in this browser; carry it over once
    const key = `oxchat:${SCOPE}:log`;
    const log0 = local.get(key, null);
    if (!Array.isArray(log0) || !log0.length) return null;
    try {
      const got = await call("/api/assistant/import", {scope: SCOPE, log: log0, session: local.get(`oxchat:${SCOPE}:session`, null)});
      for (const k of ["log", "session", "turn", "changes"]) local.drop(`oxchat:${SCOPE}:${k}`);
      return got.session.id;
    } catch { return null; }
  }

  async function boot() {
    pruneDrafts();
    root.classList.toggle("details", A.details);
    paintHead();
    paintChips();
    const imported = await importOld();
    const fromHash = /#assistant=([\w-]+)/.exec(location.hash);
    // a project page picks up where it was; home starts fresh (its last
    // conversations are one click away under Recent conversations)
    const id = (fromHash && fromHash[1]) || imported || (PROJECT ? local.get(K_CURRENT, null) : null);
    if (fromHash) history.replaceState(null, "", location.pathname + location.search);
    if (id) await openSession(id);
    else { renderAll(); loadDraft(); }
    if (fromHash && !PHONE.matches) placement.enterFocus();
    else if (fromHash) placement.openSheet();
  }

  if (PROJECT) {
    if (dock) dock.append(root);
    placement.set("dock");
    document.body.append(askbar);
    // the side panel's Assistant tab: the dock on a desktop, the full sheet on a phone
    const sync = (detail) => {
      if (!dock) return;
      dock.hidden = !detail.on;
      if (detail.on && PHONE.matches && A.mode === "dock") placement.openSheet();
      if (detail.on && A.mode === "dock") requestAnimationFrame(toBottom);
    };
    document.addEventListener("oxdock", (ev) => sync(ev.detail));
    if (W.oxSide) { const st = W.oxSide.state(); sync({on: st.on && st.tab === "assistant"}); }
  } else {
    placement.placeHero();
  }
  PHONE.addEventListener("change", () => { if (A.mode === "sheet" && !PHONE.matches) placement.leave(); });
  // a link to a conversation on this same page changes only the hash
  W.addEventListener("hashchange", () => {
    const m = /#assistant=([\w-]+)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    openSession(m[1]);
    if (PHONE.matches) placement.openSheet(); else placement.enterFocus();
  });
  boot();
})();
