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
 *   center Project mode's centre, beside the project's state (projectmode.js)
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
    if (!res.ok) {
      if (W.Account) W.Account.refused(res.status, data.error);
      const e = new Error(data.error || res.statusText); e.status = res.status; throw e;
    }
    return data;
  }

  const fmt = {
    tokens(n) {
      if (n == null) return "—";
      if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
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

  const B = W.oxBlocks;
  // what a registered block draws with (static/blocks.js): the page's own helpers
  const ctx = {
    el, icon, fmt, inline, copyText, toast, PROJECT,
    codeBlock: (...a) => codeBlock(...a),
    md: (...a) => md(...a),
    studioLink: (...a) => studioLink(...a),
    status: (k) => B.status(k),
    get A() { return A; },
  };

  const LINK_ICON = {run: "list", op: "graph", tab: "right", monitor: "chart", eval: "evals", project: "folder", file: "file",
                     point: "target", board: "roadmap"};

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

  /* ── references (D4): inline code resolved against the project ───── */

  const RF = W.oxRefs;
  // the project's tree and points, read once per conversation and again when a turn ends
  const refState = {files: null, root: "", points: new Map(), at: 0};
  let refWorld = null;       // the world the text being drawn resolves in (its turn's)
  async function loadRefs() {
    if (!PROJECT || !RF) return;
    const at = ++refState.at;
    const [tree, status] = await Promise.all([
      call(`/api/p/${PROJECT}/project/files`).catch(() => null),
      call(`/api/p/${PROJECT}/project/status`).catch(() => null),
    ]);
    if (at !== refState.at) return;
    if (tree && tree.ok) { refState.files = RF.index(tree.files); refState.root = tree.root || ""; }
    const pts = new Map();
    const doc = status && status.project;
    if (doc) {
      for (const r of (doc.checklist && doc.checklist.open) || []) pts.set(r.id, `row:${r.id}`);
      for (const q of doc.needs_you || []) pts.set(q.id, `q:${q.id}`);
      const phases = new Map();
      for (const p of doc.plans || []) {
        if (p.path) pts.set(p.path, `plan:${p.path}`);
        for (const ph of p.phases || []) phases.set(ph.id, phases.has(ph.id) ? null : `phase:${p.path}#${ph.id}`);
      }
      // a phase id names a point only when one plan has it
      for (const [id, t] of phases) if (t && !pts.has(id)) pts.set(id, t);
    }
    refState.points = pts;
    // what was drawn before the tree came: draw again where the text names code
    for (const it of A.items) {
      const n = it.kind === "text" && it.text && it.text.includes("`") ? A.nodes.get(it.seq) : null;
      if (n) { refWorld = worldFor(it); md(n, it.text); }
    }
    refWorld = null;
  }
  function opNames() {
    const out = new Set();
    const ir = typeof state !== "undefined" && state && state.ir;
    for (const g of (ir && ir.graphs) || []) (function walk(gr) {
      for (const n of (gr && gr.nodes) || []) { if (n.name) out.add(n.name); if (n.graph) walk(n.graph); }
    })(g);
    return out;
  }
  function worldFor(item) {
    if (!RF) return null;
    const turn = item && item.turn;
    const mine = turn ? A.items.filter((x) => x.turn === turn) : [];
    return {files: refState.files, root: refState.root, ops: opNames(), points: refState.points,
            touched: RF.touched(mine, refState.root)};
  }
  const TOUCH = {read: ["·", "read this turn"], modified: ["●", "modified this turn"], created: ["+", "created this turn"],
                 deleted: ["−", "deleted this turn"]};
  function openFile(path, line) {
    if (W.oxStudioLink) {
      W.oxStudioLink(`studio:file/${encodeURIComponent(path)}${line ? `#L${line}` : ""}`);
      if (A.mode === "sheet" || A.mode === "focus") placement.leave();
    } else if (PROJECT) location.href = `/p/${PROJECT}/project`;
  }
  function refCode(code, sentence) {
    const r = refWorld ? RF.classify(code, refWorld, sentence) : {kind: "code"};
    if (r.kind === "point") return studioLink(code, `studio:point/${r.target}`);
    if (r.kind === "op") return studioLink(code, `studio:op/${encodeURIComponent(r.name)}`);
    if (r.kind === "file") {
      const b = el("button", `ax-ref ax-ref-file${r.touch ? " t-" + r.touch : ""}`);
      b.type = "button";
      b.title = `${r.path}${r.line ? `:${r.line}${r.end ? "-" + r.end : ""}` : ""}${r.touch ? " — " + TOUCH[r.touch][1] : ""}`;
      b.append(icon("file"), el("span", null, code));
      if (r.touch) b.append(el("b", "ax-touch", TOUCH[r.touch][0]));
      b.onclick = () => openFile(r.path, r.line);
      return b;
    }
    if (r.kind === "command") {
      const c = el("code", "ax-ref-cmd", code);
      c.title = "Copy";
      c.tabIndex = 0;
      const copy = () => { copyText(code); toast("Copied"); };
      c.onclick = copy;
      c.onkeydown = (e) => { if (e.key === "Enter") copy(); };
      return c;
    }
    return el("code", r.kind === "symbol" ? "ax-ref-sym" : r.kind === "config" ? "ax-ref-cfg" : null, code);
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
      if (m[1]) parent.append(refCode(tok.slice(1, -1), text));
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

  // > [!WARNING] title: a thin rule in the status colour, an icon, the body as markdown (D3)
  function callout(c) {
    const st = B.status(c.kind);
    const box = el("div", `ax-callout st-${st.tone}`);
    box.setAttribute("role", c.kind === "error" || c.kind === "warning" ? "alert" : "note");
    const head = el("div", "ax-callout-head");
    head.append(icon(st.icon));
    inline(head, c.title);
    const bodyEl = el("div", "ax-callout-body");
    md(bodyEl, c.body);
    box.append(head, bodyEl);
    return box;
  }

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
        const closed = i < lines.length;
        i += 1;   // the closing fence (absent while streaming: the block so far)
        const [lang, ...name] = fence[2].trim().split(/\s+/);
        // a language a block registered (ox-graph, …) is drawn by it (VISUAL_CHAT_PLAN D2)
        const drawn = lang && B && B.has(lang) ? B.fence(lang, body.join("\n"), closed, ctx) : null;
        target.append(drawn || codeBlock(lang, body.join("\n"), {name: name.join(" ")}));
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
        const c = B && B.callout(body);
        if (c) { target.append(callout(c)); continue; }
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
    models: ["fable", "opus", "sonnet", "haiku"],
    catalog: null,            // GET /api/assistant/models: the menu's models, efforts, defaults
    rate: null,               // the plan's limits as last heard, studio-wide: {five_hour: {used, resets}, …, at}
    account: null,            // who the assistant's Claude runs as
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
  const nudge = el("div", "ax-nudge");
  nudge.hidden = true;
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
  // the screen follows the work (hand.js): on, or off for good
  const bFollow = ibtn("pointer", "", "ax-follow");
  const paintFollow = () => {
    const on = typeof Hand !== "undefined" && Hand.follow();
    bFollow.classList.toggle("on", on);
    bFollow.setAttribute("aria-pressed", String(on));
    bFollow.title = on ? "The screen follows the assistant's work: click to stop" : "Let the screen follow the assistant's work";
    bFollow.setAttribute("aria-label", "Follow the assistant's work");
  };
  bFollow.hidden = typeof Hand === "undefined" || !PROJECT;
  bFollow.onclick = () => { Hand.setFollow(!Hand.follow()); paintFollow(); };
  document.addEventListener("oxhandfollow", paintFollow);
  paintFollow();
  tools.append(bAttach, fileInput, modelPick, bFollow, el("span", "ax-spacer"), meter, bExpand, send);
  inputWrap.append(grip, tray, input, tools);
  // signing in: this card takes the box's place while it is needed
  const signin = el("div", "ax-signin");
  signin.hidden = true;
  composer.append(nudge, queued, chips, slash, inputWrap, signin);

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
  // the foot's height: where the log scrolls under a floating composer (Project mode's glass)
  new ResizeObserver(() => main.style.setProperty("--ax-foot-h", `${foot.offsetHeight}px`)).observe(foot);
  const body = el("div", "ax-body");
  body.append(side, main);
  root.append(head, body, pop, dropzone);

  /* ── rendering the transcript ─────────────────────────────────────── */

  let turnEl = null;      // the current visual turn
  let replyEl = null;     // where its answer goes
  let actEl = null;       // the open activity group, if the last thing was a step

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
      const c = W.oxTools.classOf(s).cls;
      if (c !== "plumbing") count[c] = (count[c] || 0) + 1;      // loading tools is plumbing, not work
    }
    const bits = Object.keys(count).map((c) => W.oxTools.words(c, steps.filter((s) => s.kind !== "thinking"
      && W.oxTools.classOf(s).cls === c)));
    if (!bits.length) return thought ? `Thought for ${fmt.ms(thought)}` : "Thought";
    return bits.map((b, i) => (i ? b[0].toLowerCase() + b.slice(1) : b)).join(", ");
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

  /* a tool row (VISUAL_CHAT_PLAN D5): the class's icon and verb in its colour,
     the resource it acted on, its state and time; the input, output and exit
     status one click away. Thinking keeps its plain row. */
  const TL = W.oxTools;
  function toolRoot() {
    return refState.root || (A.agent && A.agent.cwd ? A.agent.cwd.replace(/\/$/, "") : "");
  }
  // renderAll asks every row for its turn's items, files and severities: one
  // pass answers each once, not once per row (VISUAL_CHAT_PLAN V7 render gate)
  let turnMemo = null;
  function memo(key, make) {
    if (!turnMemo) return make();
    if (!turnMemo.has(key)) turnMemo.set(key, make());
    return turnMemo.get(key);
  }
  function itemsOfTurn(turn) {
    return memo("i" + turn, () => A.items.filter((x) => x.turn === turn));
  }
  function turnTouched(item) {
    return RF && item && item.turn ? memo("t" + item.turn, () => RF.touched(itemsOfTurn(item.turn), toolRoot())) : null;
  }
  // a path a tool used is a fact: it is a chip, in the tree or not
  function fileChip(path, touched) {
    const p = RF ? RF.rel(path, toolRoot()) : path;
    const touch = touched && touched.get(p);
    const b = el("button", `ax-ref ax-ref-file${touch ? " t-" + touch : ""}`);
    b.type = "button";
    b.title = p + (touch ? " — " + TOUCH[touch][1] : "");
    b.append(icon("file"), el("span", null, p.split("/").pop()));
    if (touch) b.append(el("b", "ax-touch", TOUCH[touch][0]));
    b.onclick = (e) => { e.stopPropagation(); openFile(p, 0); };
    return b;
  }
  function toolRes(res, touched) {
    if (!res || !res.value) return null;
    if (res.kind === "file") return fileChip(res.value, touched);
    // a command reads as the one that matters: `cd x && uv run pytest` → `uv run pytest`
    const line = (res.kind === "cmd" ? TL.mainCommand(res.value) : String(res.value)).split("\n")[0];
    const c = el("code", "ax-tool-res " + res.kind, line + (/\n/.test(res.value) ? " …" : ""));
    c.title = res.value.length > 400 ? res.value.slice(0, 400) + "…" : res.value;
    return c;
  }
  // D8: a failed call whose class later worked is "recovered" (amber); one that never did stays "failed" (red)
  function turnSeverity(item) {
    return item && item.turn ? memo("s" + item.turn, () => TL.severities(itemsOfTurn(item.turn), turnTouched(item))) : new Map();
  }
  function stepState(item, sev) {
    const running = item.status === "running" || (item.kind === "thinking" && item.ms == null);
    const s = sev && sev.get(item.seq);
    return B.status(running ? (A.running ? "running" : "stopped")
      : item.status === "error" ? (s === "recovered" ? "recovered" : "error") : s === "warning" ? "warning" : "done");
  }
  function stateMark(st) {
    const s = el("span", `ax-tool-st st-${st.tone}`);
    s.title = st.word;
    s.append(st.spin ? el("span", "ax-spin") : icon(st.icon));
    return s;
  }
  /* D6: a test run's report — the bar, the counts, the failures a click away */
  function testReport(t) {
    const box = el("div", "ax-tests" + (t.failed || t.errors ? " bad" : "") + (t.live ? " live" : ""));
    const ran = t.passed + t.failed + t.errors + t.skipped;
    // a run still going (D6, live): what ran so far, and the rest of the bar when the runner says its share
    const total = (t.live && t.pct ? Math.max(ran, ran * 100 / t.pct) : ran) || 1;
    const bar = el("div", "ax-tests-bar");
    bar.setAttribute("aria-hidden", "true");
    for (const [k, n] of [["ok", t.passed], ["err", t.failed + t.errors], ["skip", t.skipped], ["rest", total - ran]]) {
      if (n > 0) { const seg = el("span", "seg-" + k); seg.style.flexGrow = String(n / total); bar.append(seg); }
    }
    const nums = el("div", "ax-tests-nums");
    const bits = [[t.passed, "passed", "ok"], [t.failed, "failed", "err"], [t.errors, t.errors === 1 ? "error" : "errors", "err"],
      [t.skipped, "skipped", "skip"]].filter(([n, , k]) => n || k === "ok");
    bits.forEach(([n, w, k], i) => {
      if (i) nums.append(el("span", "ax-tests-dot", "·"));
      nums.append(el("span", "n-" + k, `${n} ${w}`));
    });
    if (t.live) nums.append(el("span", "ax-tests-dot", "·"), el("span", "n-live", t.pct != null ? `running · ${t.pct}%` : "running"));
    else if (t.ms != null) nums.append(el("span", "ax-tests-dot", "·"), el("span", "n-ms", fmt.ms(t.ms)));
    nums.append(el("span", "ax-tests-runner", t.runner));
    box.append(bar, nums);
    const fails = t.failures || [];
    if (fails.length) {
      const tog = el("button", "ax-tests-tog", `${fails.length} ${fails.length === 1 ? "failure" : "failures"}`);
      tog.type = "button";
      tog.setAttribute("aria-expanded", "false");
      const list = el("ol", "ax-tests-fails");
      list.hidden = true;
      for (const f of fails) {
        const li = el("li");
        const head = el("button", "ax-tests-fail");
        head.type = "button";
        head.append(icon("x"), el("code", null, f.id), el("span", null, f.line || ""));
        li.append(head);
        if (f.context) {
          const pre = el("pre", null, f.context);
          pre.hidden = true;
          head.onclick = () => { pre.hidden = !pre.hidden; li.classList.toggle("open", !pre.hidden); };
          li.append(pre);
        }
        list.append(li);
      }
      tog.onclick = () => {
        list.hidden = !list.hidden;
        tog.setAttribute("aria-expanded", String(!list.hidden));
      };
      box.append(tog, list);
    }
    return box;
  }
  function toolDetails(item, step) {
    const io = el("div", "ax-step-io");
    if (step && item.status === "error") io.append(el("div", "ax-io-label", "Step"), el("div", "ax-io-step", step));
    const inp = TL.inputOf(item);
    if (inp && Object.keys(inp).length && W.Values) {
      io.append(el("div", "ax-io-label", "Input"));
      const tree = el("div", "ax-tree");
      tree.append(W.Values.render(inp, {open: true}));
      io.append(tree);
    } else if (item.input) io.append(el("div", "ax-io-label", "Input"), el("pre", null, item.input));
    if (item.output) io.append(el("div", "ax-io-label", item.status === "error" ? "Error" : "Output"),
      el("pre", null, item.output));
    const code = TL.exitOf(item);
    if (code != null) {
      const ex = el("div", "ax-io-exit " + (code ? "st-err" : "st-ok"));
      ex.append(el("span", "ax-io-label", "Exit status"), el("b", null, String(code)));
      io.append(ex);
    }
    return io;
  }
  function withDetails(row, head, build) {
    head.classList.add("more");
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    head.setAttribute("aria-expanded", "false");
    const io = el("div", "ax-step-io");
    io.hidden = true;
    const flip = () => {
      if (!io.childNodes.length) io.append(...build().childNodes);
      io.hidden = !io.hidden;
      row.classList.toggle("open", !io.hidden);
      head.setAttribute("aria-expanded", String(!io.hidden));
    };
    head.onclick = (e) => { if (!e.target.closest(".ax-ref")) flip(); };
    head.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); flip(); } };
    row.append(io);
  }

  function renderStep(item, step, sev, noTests) {
    if (item.kind === "thinking") return renderThought(item);
    const touched = turnTouched(item);
    const c = TL.classOf(item, touched);
    const st = stepState(item, sev || turnSeverity(item));
    const row = el("div", `ax-step ax-tool tc-${c.cls}` + (st.kind === "recovered" ? " recovered st-warn"
      : item.status === "error" ? " bad st-err" : ""));
    const head = el("div", "ax-step-head");
    const verb = el("span", "ax-tool-verb");
    verb.append(icon(c.icon), el("span", null, c.verb));
    head.append(verb);
    const res = toolRes(c.res, touched);
    if (res) head.append(res);
    else if (c.cls === "tool" && item.label && item.label !== item.name) head.append(el("span", "ax-tool-res", item.label));
    head.append(el("span", "ax-spacer"));
    if (st.kind === "recovered") head.append(el("span", "ax-tool-sev", "recovered"));
    head.append(stateMark(st), el("span", "ax-step-ms", item.ms != null ? fmt.ms(item.ms) : ""));
    row.append(head);
    // the first line of what went wrong, without opening the row
    if (item.status === "error" && item.output && !item.tests) {
      const first = String(item.output).split("\n").find((l) => l.trim() && !/^Exit code \d+$/.test(l)) || "";
      if (first) row.append(el("div", "ax-tool-err", first.slice(0, 240)));
    }
    if (item.tests && !noTests) row.append(testReport(item.tests));
    if (item.input || item.output) withDetails(row, head, () => toolDetails(item, step));
    return row;
  }

  function renderThought(item) {
    const row = el("div", "ax-step");
    const head = el("div", "ax-step-head");
    head.append(item.ms == null ? el("span", "ax-spin") : icon("spark"),
      el("span", "ax-step-label", item.ms != null ? `Thought for ${fmt.ms(item.ms)}` : "Thinking"),
      el("span", "ax-step-ms", item.ms != null ? fmt.ms(item.ms) : ""));
    row.append(head);
    if ((item.text || "").trim()) withDetails(row, head, () => { const d = el("div"); d.append(el("pre", "ax-think", item.text)); return d; });
    return row;
  }

  /* D5: runs of one class are one row — "Read 6 files" with the files as chips; opening it shows each call */
  function renderTools(items, step, noTests) {
    const touched = items.length ? turnTouched(items[0]) : null;
    const sev = items.length ? turnSeverity(items[0]) : new Map();
    const groups = TL.fold(items, touched);
    const out = [];
    for (const g of groups) {
      if (g.items.length === 1 || groups.length === 1) { for (const it of g.items) out.push(renderStep(it, step, sev, noTests)); continue; }
      const row = el("div", `ax-step ax-tool ax-fold tc-${g.cls}`);
      const head = el("div", "ax-step-head");
      const verb = el("span", "ax-tool-verb");
      verb.append(icon(TL.ICON[g.cls]), el("span", null, TL.words(g.cls, g.items, touched)));
      head.append(verb);
      const files = TL.filesOf(g.items, touched);
      const chips = el("span", "ax-fold-chips");
      for (const f of files.slice(0, 4)) chips.append(fileChip(f, touched));
      if (files.length > 4) chips.append(el("span", "ax-fold-more", `+${files.length - 4}`));
      if (files.length) head.append(chips);
      const worst = g.items.find((i) => i.status === "running") || g.items.find((i) => sev.get(i.seq) === "failed")
        || g.items.find((i) => i.status === "error") || g.items[0];
      const ms = g.items.reduce((a, i) => a + (i.ms || 0), 0);
      head.append(el("span", "ax-spacer"), stateMark(stepState(worst, sev)), el("span", "ax-step-ms", ms ? fmt.ms(ms) : ""));
      row.append(head);
      if (g.items.some((i) => i.status === "error")) row.classList.add("warned");
      withDetails(row, head, () => { const d = el("div", "ax-fold-calls"); d.append(...g.items.map((i) => renderStep(i, step, sev, noTests))); return d; });
      out.push(row);
    }
    return out;
  }

  /* the progress card (docs/ASSISTANT_PROGRESS_PLAN.md D4): the turn's
     plan as the steps tool last posted it, with the tool calls each step made */
  const P = W.oxProgress;

  function progOf(turn) {
    if (turn._prog) return turn._prog;
    const card = el("section", "ax-prog");
    card.setAttribute("aria-label", "Progress");
    const title = el("div", "ax-prog-title");
    const chip = el("span", "ax-prog-chip");
    const top = el("div", "ax-prog-top");
    top.append(title, chip);
    const count = el("span", "ax-prog-count");
    const pct = el("span", "ax-prog-pct");
    const meta = el("div", "ax-prog-meta");
    meta.append(count, pct);
    const bar = el("div", "ax-prog-bar");
    const fill = el("span");
    bar.append(fill);
    const list = el("ol", "ax-prog-steps");
    const say = el("div", "ax-sr");
    say.setAttribute("aria-live", "polite");
    card.append(top, meta, bar, list, say);
    turn.querySelector(".ax-reply").prepend(card);
    const prog = {turn, card, title, chip, count, pct, fill, list, say, plan: null, active: null,
      auto: null, tools: new Map(), open: new Set(), shut: new Set(), ended: false};
    card._prog = prog;
    turn._prog = prog;
    return prog;
  }

  function progLive(prog) {
    const turns = log.querySelectorAll(".ax-turn");
    return !prog.ended && !!A.running && turns[turns.length - 1] === prog.turn;
  }

  function takePlan(item) {
    const prog = progOf(turnEl);
    // tool calls before the first plan (the fallback's) belong to its first step
    if (prog.auto && item.plan.steps.length) prog.tools.set(item.plan.steps[0].title, prog.auto);
    prog.auto = null;
    const before = prog.plan;
    prog.plan = item.plan;
    prog.turnId = item.turn;
    const now = item.plan.steps.find((s) => s.state === "active" || s.state === "waiting" || s.state === "blocked");
    if ((now ? now.title : null) !== prog.active) A.handOn = null;   // a new step: the hand has not reached it yet
    prog.active = now ? now.title : null;
    A.nodes.set(item.seq, prog.card);
    paintProg(prog);
    // the screen goes where the active step works (D5): live turns only, not a reload
    if (progLive(prog)) document.dispatchEvent(new CustomEvent("oxplan", {detail: {before, after: item.plan}}));
  }

  // what the hand rings now: the focus box names it (D5); a press on the rail is the way there, not the place
  A.handOn = null;
  document.addEventListener("oxhandpoint", (ev) => {
    const t = ev.detail && ev.detail.target;
    if (!t || /^(tab|page):/.test(t)) return;
    A.handOn = t;
    for (const c of log.querySelectorAll(".ax-prog.live")) paintProg(c._prog);
  });

  function paintProg(prog) {
    // a plan the assistant posted, or (D3) the steps its tool calls make
    const steps = prog.plan ? prog.plan.steps : P.fallback(prog.auto.map((q) => A.bySeq.get(q)).filter(Boolean));
    const live = progLive(prog);
    const {chip, done, n, pct, say} = P.summary(steps, live);
    prog.title.textContent = prog.plan ? prog.plan.title || "Plan" : "Steps";
    prog.chip.textContent = chip[0];
    prog.chip.className = "ax-prog-chip st-" + chip[1];
    // steps the page makes from the tool calls grow as the turn goes: "13 of 14" would be 14 of 15 a moment
    // later, so they are counted, never measured
    prog.count.textContent = prog.plan ? `${done} of ${n} steps` : `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
    prog.pct.textContent = prog.plan ? `${pct}%` : "";
    prog.fill.style.width = `${pct}%`;
    prog.card.classList.toggle("live", live);
    prog.card.classList.toggle("auto", !prog.plan);
    if (live) { A.progress = prog.plan ? pct : null; askbarPaint(); }
    // D12: steps that say what they wait on are drawn as a structure; the list then holds the selected step
    const shape = prog.plan && W.oxGraph && W.oxGraph.draw ? P.structure(steps) : null;
    prog.card.classList.toggle("dag", !!shape);
    if (shape) {
      const at = prog.sel != null && prog.sel < steps.length ? prog.sel
        : steps.findIndex((s) => /^(active|waiting|blocked|failed)$/.test(s.state));
      paintShape(prog, shape, steps, live, at);
      prog.list.replaceChildren(...(at >= 0 ? [progStep(prog, steps[at], at, live)] : []));
    } else {
      if (prog.shape) { prog.shape.remove(); prog.shape = null; }
      // live, the card sticks above the reply: the steps done before the last one fold into a line, so the
      // card stays short and the words under it stay readable
      const first = steps.findIndex((s) => s.state !== "done" && s.state !== "skipped");
      const fold = live && !prog.all ? (first < 0 ? steps.length : first) - 1 : 0;
      const kept = prog.list.scrollTop;
      const rows = steps.map((step, i) => i < fold ? null : progStep(prog, step, i, live)).filter(Boolean);
      if (fold >= 2) {
        const li = el("li", "ax-pstep ax-pstep-fold done st-ok");
        const dot = el("span", "ax-pstep-dot");
        dot.append(icon(B.status("done").icon));
        const more = el("button", "ax-pstep-head more", `${fold} earlier steps done`);
        more.type = "button";
        more.setAttribute("aria-expanded", "false");
        more.onclick = () => { prog.all = true; paintProg(prog); };
        const main = el("div", "ax-pstep-main");
        main.append(more);
        li.append(dot, main);
        prog.list.replaceChildren(li, ...rows);
      } else {
        prog.list.replaceChildren(...steps.map((step, i) => progStep(prog, step, i, live)));
      }
      // past the cap the list scrolls: a new running step comes into sight, else the reader's place is kept
      prog.list.scrollTop = kept;
      const at = live ? steps.findIndex((st) => st.state === "active") : -1;
      if (at !== prog.seen) {
        prog.seen = at;
        const now = at >= 0 && prog.list.scrollHeight > prog.list.clientHeight ? prog.list.querySelector(".ax-pstep.active") : null;
        if (now) prog.list.scrollTop = now.offsetTop - prog.list.offsetTop - 8;
      }
    }
    if (say !== prog.said) { prog.said = say; prog.say.textContent = say; }
  }

  function paintShape(prog, shape, steps, live, at) {
    const G = W.oxGraph;
    for (const n of shape.nodes) if (n.state === "active" && !live) n.state = "stopped";
    const L = G.layout(shape, {w: Math.max(240, Math.min(640, innerWidth - 70)), h: 400});
    const hot = steps.findIndex((s) => s.state === "active" || s.state === "waiting" || s.state === "blocked");
    const D = G.draw(shape, L, {highlight: new Set(hot >= 0 ? ["s" + (hot + 1)] : []), affected: () => false,
      flash: new Set(), focusable: true});
    const had = prog.shape && prog.shape.contains(document.activeElement) ? document.activeElement.getAttribute("data-id") : null;
    const box = el("div", "ax-prog-shape");
    D.svg.setAttribute("width", L.width);
    D.svg.setAttribute("height", L.height);
    box.append(D.svg);
    const pick = (i) => {
      const key = steps[i].title;
      prog.sel = i;
      prog.open.add(key);
      prog.shut.delete(key);
      paintProg(prog);
    };
    for (const [id, g] of D.nodeEls) {
      const i = +id.slice(1) - 1;
      g.classList.toggle("sel", i === at);
      g.setAttribute("aria-pressed", String(i === at));
      g.addEventListener("click", () => pick(i));
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(i); }
        else if (ev.key.startsWith("Arrow")) {
          ev.preventDefault();
          const to = G.nearest(L, id, ev.key);
          if (to) D.nodeEls.get(to).focus();
        }
      });
    }
    if (prog.shape) prog.shape.replaceWith(box);
    else prog.list.before(box);
    prog.shape = box;
    if (had && D.nodeEls.get(had)) D.nodeEls.get(had).focus();
  }

  /* D12: a step's facts — the calls it made, their files, tests and commands, and its progress */
  function stepFactsOf(prog, step, seqs) {
    const items = prog.turnId ? itemsOfTurn(prog.turnId) : seqs.map((q) => A.bySeq.get(q)).filter(Boolean);
    const touched = items.length ? turnTouched(items[0]) : null;
    return P.stepFacts(step, seqs, items, touched, RF ? (p) => RF.rel(p, toolRoot()) : undefined);
  }
  function stepMeter(pr) {
    const m = el("span", "ax-pstep-meter");
    const bad = pr.kind === "tests" && pr.done < pr.total ? " bad" : "";
    const bar = el("span", "ax-pstep-mbar" + bad);
    const fill = el("span");
    bar.append(fill);
    if (pr.live) {
      // still running: the bar is the runner's share done when it says one, else the share passed so far
      m.title = `${pr.done} passed${pr.total > pr.done ? `, ${pr.total - pr.done} failed` : ""} so far`
        + (pr.pct != null ? ` · ${pr.pct}% of the run` : "");
      fill.style.width = `${pr.pct != null ? pr.pct : Math.round(pr.done / pr.total * 100)}%`;
      m.append(bar, el("span", "ax-pstep-mnum" + bad, `${pr.done}${bad ? ` · ${pr.total - pr.done}✗` : ""}`));
      return m;
    }
    m.title = pr.kind === "sub" ? `${pr.done} of ${pr.total} subtasks done` : `${pr.done} of ${pr.total} tests passed`;
    fill.style.width = `${Math.round(pr.done / pr.total * 100)}%`;
    m.append(bar, el("span", "ax-pstep-mnum" + bad, `${pr.done}/${pr.total}`));
    return m;
  }

  function progStep(prog, step, i, live) {
    const state = step.state === "active" && !live ? "stopped" : step.state;
    const st = B.status(state);
    const li = el("li", `ax-pstep ${state} st-${st.tone}`);
    const dot = el("span", "ax-pstep-dot");
    dot.append(st.spin ? el("span", "ax-spin") : icon(st.icon));
    const main = el("div", "ax-pstep-main");
    const head = el("button", "ax-pstep-head");
    head.type = "button";
    const meta = state === "done" && step.ms != null ? `Completed · ${fmt.ms(step.ms)}`
      : st.word;
    const key = step.key || step.title;
    const seqs = step.seqs || prog.tools.get(key) || [];
    const facts = stepFactsOf(prog, step, seqs);
    head.append(el("span", "ax-pstep-num", `${i + 1}`), el("span", "ax-pstep-title", step.title));
    if (facts.progress) head.append(stepMeter(facts.progress));
    head.append(el("span", "ax-pstep-meta", meta));
    main.append(head);
    if (state === "active") {
      const focus = el("div", "ax-pstep-focus");
      const where = P.targetWords(A.handOn || step.target || "");
      if (where) {
        const line = el("div", "ax-pstep-where", "Studio is focusing on ");
        line.append(el("b", null, where));
        focus.append(line);
      }
      if (step.detail) focus.append(el("div", "ax-pstep-detail", step.detail));
      const now = seqs.map((q) => A.bySeq.get(q)).filter((t) => t && t.kind === "tool" && t.status === "running").pop();
      if (now) {
        const tool = el("div", "ax-pstep-now");
        tool.append(el("span", "ax-spin"), el("span", null, now.label || now.name));
        focus.append(tool);
      }
      if (focus.childNodes.length) main.append(focus);
    }
    const says = state === "active" || state === "waiting" || state === "blocked";
    if ((state === "waiting" || state === "blocked") && step.detail) main.append(el("div", `ax-pstep-ask st-${st.tone}`, step.detail));
    const sub = step.sub || [];
    const hasBody = !!(step.result || step.error || facts.calls.length || sub.length || (step.detail && !says));
    if (state === "failed" && !prog.shut.has(key)) prog.open.add(key);
    if (hasBody) {
      head.classList.add("more");
      const open = prog.open.has(key);
      li.classList.toggle("open", open);
      head.setAttribute("aria-expanded", String(open));
      head.dataset.step = key;
      head.onclick = () => {
        if (prog.open.has(key)) { prog.open.delete(key); prog.shut.add(key); }
        else prog.open.add(key);
        paintProg(prog);
        // the card is drawn anew: the keyboard stays on this step
        const again = [...prog.list.querySelectorAll(".ax-pstep-head")].find((h) => h.dataset.step === key);
        if (again) again.focus();
      };
      if (open) {
        const body = el("div", "ax-pstep-body");
        // D12's order: what it left or why it failed, its files, its tests, its calls, how it ran
        if (step.result) body.append(el("div", "ax-pstep-result", step.result));
        if (step.error) body.append(el("div", "ax-pstep-error", step.error));
        if (step.detail && !says) body.append(el("div", "ax-pstep-detail", step.detail));
        if (sub.length) {
          const ul = el("ul", "ax-pstep-sub");
          for (const t of sub) {
            const ts = B.status(t.state === "active" && !live ? "stopped" : t.state);
            const li2 = el("li", `st-${ts.tone}`);
            li2.append(ts.spin ? el("span", "ax-spin") : icon(ts.icon), el("span", null, t.title));
            li2.title = ts.word;
            ul.append(li2);
          }
          body.append(ul);
        }
        if (facts.files.length) {
          const fl = el("div", "ax-pstep-files");
          const touched = new Map(facts.files.map((f) => [f.path, f.how]));
          for (const f of facts.files) fl.append(fileChip(f.path, touched));
          body.append(fl);
        }
        for (const t of facts.tests) body.append(testReport(t));
        body.append(...renderTools(facts.calls, step.title, true));
        const runs = facts.commands.filter((c) => c.cmd);
        if (runs.length || facts.ms != null) {
          const ex = el("details", "ax-pstep-exec");
          ex.append(el("summary", null, "Execution" + (facts.ms != null ? ` · ${fmt.ms(facts.ms)}` : "")));
          const tb = el("ol");
          for (const c of runs) {
            const li3 = el("li", c.exit ? "st-err" : c.exit === 0 ? "st-ok" : "");
            li3.append(el("code", null, c.cmd.split("\n")[0]),
              el("span", "ax-pstep-exit", c.exit == null ? "running" : `exit ${c.exit}`),
              el("span", "ax-step-ms", c.ms != null ? fmt.ms(c.ms) : ""));
            tb.append(li3);
          }
          if (runs.length) ex.append(tb);
          body.append(ex);
        }
        main.append(body);
      }
    }
    li.append(dot, main);
    return li;
  }

  function addStep(item) {
    // a tool belongs to the step that was active when it started
    let prog = turnEl && turnEl._prog;
    if (prog && prog.active) {
      if (!prog.tools.has(prog.active)) prog.tools.set(prog.active, []);
      prog.tools.get(prog.active).push(item.seq);
      A.nodes.set(item.seq, prog.card);
      paintProg(prog);
      return;
    }
    // no plan posted (D3): the page makes one from what the tools did;
    // loading tools is plumbing, and thinking stays in the activity row
    if (item.kind === "tool" && item.name !== "ToolSearch" && !(prog && prog.plan)) {
      prog = progOf(turnEl);
      (prog.auto = prog.auto || []).push(item.seq);
      A.nodes.set(item.seq, prog.card);
      paintProg(prog);
      return;
    }
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
    refWorld = worldFor(item);
    md(box, item.text || "");
    refWorld = null;
    A.nodes.set(item.seq, box);
    return box;
  }

  /* D7: a file's diff is a registered block, so the progress card and the
     Files page open the same viewer — ```ox-diff in a reply draws it too */
  function diffView(f, head) {
    const box = el("div", "ax-diff");
    if (head) box.append(el("div", "file", f.path));
    for (const l of f.lines) box.append(el("div", l.t === "ctx" ? "" : l.t, l.s || " "));
    if (!f.lines.length) box.append(el("div", "hunk", "(no lines: a binary file or an empty one)"));
    return box;
  }
  if (B) B.register("ox-diff", {
    validate: (body) => {
      const files = TL.splitDiff(body);
      return files.length ? {ok: true, value: files} : {ok: false, reason: "no file in the diff"};
    },
    render: (files) => { const box = el("div", "ax-diffs"); for (const f of files) box.append(diffView(f, true)); return box; },
  });

  const TOUCH_WORD = {modified: "Modified", created: "Created", deleted: "Deleted"};
  /* D7: the turn's file activity — the strip, the files (by folder past 6), each with its own diff, the reads folded */
  function renderChanges(item) {
    const card = el("div", "ax-card ax-changes");
    const files = item.files || [];
    const touchOf = (f) => (f.deleted ? "deleted" : f.new ? "created" : "modified");
    const touched = (item.turn && turnTouched(item)) || new Map();
    const changed = new Set(files.map((f) => f.path));
    const reads = [...touched].filter(([p, t]) => t === "read" && !changed.has(p)).map(([p]) => p);
    const count = {modified: 0, created: 0, deleted: 0};
    for (const f of files) count[touchOf(f)]++;
    const plus = files.reduce((s, f) => s + (f.added || 0), 0);
    const minus = files.reduce((s, f) => s + (f.removed || 0), 0);
    const top = el("div", "ax-card-head ax-act-strip");
    top.append(icon("file"));
    const bits = [];
    if (reads.length) bits.push(["read", `Read ${reads.length}`]);
    for (const k of ["modified", "created", "deleted"]) if (count[k]) bits.push([k, `${TOUCH_WORD[k]} ${count[k]}`]);
    bits.forEach(([k, w], i) => {
      if (i) top.append(el("span", "ax-tests-dot", "·"));
      const b = el("span", "ax-strip-" + k);
      b.append(el("b", "ax-touch", TOUCH[k][0]), el("span", null, w));
      top.append(b);
    });
    top.append(el("span", "ax-spacer"), el("span", "ax-add", `+${plus}`), el("span", "ax-del", `−${minus}`));
    // another person's assistant worked in this project at the same time:
    // the diff can't tell whose edit is whose, so the card says so (§2.3)
    const overlap = (item.overlap || []).length
      ? el("p", "ax-overlap", `${item.overlap.join(", ")}'s assistant was working in this project at the same time — `
                              + "some of these changes may be theirs. Check the diff before you undo.")
      : null;
    const diffs = new Map();
    let split = null;
    const diffOf = (path) => {
      if (!split) { split = TL.splitDiff(item.diff); for (const f of split) diffs.set(f.path, f); }
      return diffs.get(path) || {path, lines: []};
    };
    const flist = el("div", "ax-files");
    const fileRow = (f, short) => {
      const t = touchOf(f);
      const row = el("div", "ax-file t-" + t);
      const head = el("div", "ax-file-head");
      head.append(el("b", "ax-touch", TOUCH[t][0]));
      const p = el("span", "ax-path", short || f.path);
      p.title = `${f.path} — ${TOUCH[t][1]}`;
      head.append(p);
      if (t !== "modified") head.append(el("span", "ax-new", t === "created" ? "new" : "deleted"));
      head.append(el("span", "ax-add", `+${f.added || 0}`), el("span", "ax-del", `−${f.removed || 0}`));
      row.append(head);
      withDetails(row, head, () => { const d = el("div"); d.append(diffView(diffOf(f.path))); return d; });
      return row;
    };
    if (files.length > 6) {
      const groups = new Map();
      for (const f of files) {
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(f);
      }
      for (const [dir, fs] of groups) {
        flist.append(el("div", "ax-files-dir", dir === "." ? "./" : dir + "/"));
        for (const f of fs) flist.append(fileRow(f, f.path.slice(dir === "." ? 0 : dir.length + 1)));
      }
    } else for (const f of files) flist.append(fileRow(f));
    let readFold = null;
    if (reads.length) {
      readFold = el("div", "ax-step ax-reads");
      const head = el("div", "ax-step-head");
      const verb = el("span", "ax-tool-verb");
      verb.append(icon("file"), el("span", null, `Read ${reads.length} ${reads.length === 1 ? "file" : "files"}`));
      head.append(verb);
      readFold.append(head);
      withDetails(readFold, head, () => {
        const d = el("div", "ax-reads-list");
        for (const p of reads) d.append(fileChip(p, touched));
        return d;
      });
    }
    const acts = el("div", "ax-card-acts");
    const note = el("span", "ax-card-note");
    const keep = tbtn("Keep", "ax-btn");
    const undo = tbtn("Undo", "ax-btn ax-btn-quiet needs-edit", "resume");
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
          // a deleted file is in files: undo checks it back out of the snapshot
          sha: item.sha, files: files.filter((f) => !f.new).map((f) => f.path),
          new_files: files.filter((f) => f.new).map((f) => f.path)});
        mark("undone", (got.restored || []).length);
      } catch (err) {
        note.textContent = `Undo failed: ${err.message}`;
        keep.disabled = undo.disabled = false;
      }
    };
    acts.append(note, el("span", "ax-spacer"), undo, keep);
    card.append(...[top, overlap, flist, readFold, acts].filter(Boolean));
    paint();
    A.nodes.set(item.seq, card);
    return card;
  }

  function renderError(item) {
    const card = el("div", "ax-card ax-error st-err");
    const top = el("div", "ax-card-head");
    top.append(icon(B.status("fatal").icon), el("span", null, (item.text || "Something went wrong").split("\n")[0].slice(0, 300)));
    card.append(top);
    const more = String(item.text || "");
    if (more.includes("\n") || more.length > 300) {
      const fold = el("details");
      fold.append(el("summary", null, "Details"), el("pre", null, more));
      card.append(fold);
    }
    if (item.resume && item.turn) {
      // a turn stopped mid-work: what it did is done, so the conversation goes on from it rather than redoing it
      const acts = el("div", "ax-card-acts");
      const go = tbtn("Continue", "ax-btn primary", "play");
      go.onclick = () => resume();
      acts.append(el("span", "ax-spacer"), go);
      card.append(acts);
    }
    if (item.retry && item.turn) {
      const acts = el("div", "ax-card-acts");
      const retry = tbtn("Try again", "ax-btn", "refresh");
      retry.onclick = () => redo({retry_of: item.turn});
      retry.dataset.retry = item.turn;
      acts.append(el("span", "ax-spacer"));
      if (item.auth) {
        const sign = tbtn("Sign in", "ax-btn primary");
        sign.onclick = () => openSignin("claudeai", "The assistant needs a Claude sign-in to answer.");
        acts.append(sign);
      }
      if (item.model_error) {
        // the model the account can't use: the same message on the default
        const dflt = tbtn("Use the default model", "ax-btn primary");
        dflt.onclick = async () => { if (await setModel(null, true)) redo({retry_of: item.turn}); };
        acts.append(dflt);
      }
      acts.append(retry);
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
    if (item.model) bits.push(fmt.model(item.model) + (item.effort ? ` · ${EFFORT_LABEL[item.effort] || item.effort}` : ""));
    if (item.tokens) bits.push(`${fmt.tokens(item.tokens.in)} in · ${fmt.tokens(item.tokens.out)} out`);
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
    const strip = outcomeStrip(item);
    const node = strip ? el("div", "ax-turnend") : f;
    if (strip) node.append(strip, f);
    A.nodes.set(item.seq, node);
    return node;
  }

  /* D8: the turn's outcome in one line, facts only — state, time, cost, files,
     the last run per runner, steps, failures (by class past 3, as a bar) */
  function outcomeStrip(item) {
    const turnItems = item.turn ? itemsOfTurn(item.turn) : [];
    if (!turnItems.some((x) => x.kind === "tool" || x.kind === "changes" || x.kind === "error")) return null;
    const o = TL.outcome(turnItems, item, turnTouched(item));
    const st = B.status(o.state === "done" ? "done" : o.state);
    const strip = el("div", `ax-outcome st-${st.tone}`);
    const line = el("div", "ax-outcome-line");
    const mark = el("span", "ax-outcome-st");
    mark.append(icon(st.icon || "dot"), el("b", null, o.state === "fatal" ? "Stopped by an error" : st.word));
    const parts = [mark];
    const add = (cls, text) => parts.push(el("span", cls, text));
    if (o.ms) add("ax-outcome-n", fmt.ms(o.ms));
    if (o.cost != null) add("ax-outcome-n", fmt.money(o.cost));
    const fw = [["modified", "modified"], ["created", "created"], ["deleted", "deleted"]]
      .filter(([k]) => o.files[k]).map(([k, w]) => `${o.files[k]} ${w}`);
    if (fw.length) add("ax-outcome-files", fw.join(" · "));
    for (const t of o.tests) {
      const b = el("span", "ax-outcome-test " + (t.failed || t.errors ? "st-err" : "st-ok"));
      b.append(icon(t.failed || t.errors ? "x" : "check"),
        el("span", null, `${t.runner} ${t.passed} passed` + (t.failed + t.errors ? ` · ${t.failed + t.errors} failed` : "")
          + (t.skipped ? ` · ${t.skipped} skipped` : "")));
      parts.push(b);
    }
    if (o.steps) add("ax-outcome-n", `Steps ${o.steps.done}/${o.steps.total}`);
    let list = null;
    if (o.failures.length) {
      const failed = o.failures.filter((f) => f.severity === "failed").length;
      const b = el("button", "ax-outcome-fails");
      b.type = "button";
      b.setAttribute("aria-expanded", "false");
      const cls = Object.entries(o.byClass).sort((a, z) => z[1] - a[1]);
      const words = `${o.failures.length} failed` + (o.failures.length >= 3 ? `: ${cls.map(([c, n]) => `${n} ${c}`).join(", ")}` : "")
        + (failed < o.failures.length ? ` (${o.failures.length - failed} recovered)` : "");
      if (o.failures.length >= 3) {
        const bar = el("span", "ax-outcome-bar");
        bar.setAttribute("aria-hidden", "true");
        for (const [c, n] of cls) {
          const seg = el("span", "tc-" + c);
          seg.style.flexGrow = String(n);
          bar.append(seg);
        }
        b.append(bar);
      }
      b.append(el("span", null, words));
      list = el("ol", "ax-outcome-list");
      list.hidden = true;
      for (const f of o.failures) {
        const li = el("li", `tc-${f.cls} ` + (f.severity === "recovered" ? "st-warn" : "st-err"));
        li.append(icon(TL.ICON[f.cls]), el("b", null, f.cls),
          el("span", null, f.line || "(no output)"), el("em", null, f.severity === "recovered" ? "recovered" : "failed"));
        list.append(li);
      }
      b.onclick = () => { list.hidden = !list.hidden; b.setAttribute("aria-expanded", String(!list.hidden)); };
      list._tog = b;
    }
    parts.forEach((p, i) => { if (i) line.append(el("span", "ax-tests-dot", "·")); line.append(p); });
    strip.append(line);
    if (list) strip.append(list._tog, list);
    return strip;
  }

  function append(item) {
    A.bySeq.set(item.seq, item);
    if (item.kind === "user") { newTurn(item); return; }
    if (!replyEl) newTurn(null);
    if (item.kind === "tool" && item.plan) { takePlan(item); return; }
    if (item.kind === "tool" || item.kind === "thinking") { addStep(item); return; }
    if (item.kind !== "turn_end") actEl = null;
    // a kind a block registered is drawn by it (VISUAL_CHAT_PLAN D2)
    let node = B && B.has("item:" + item.kind) ? B.item(item.kind, item, ctx) : null;
    if (node) A.nodes.set(item.seq, node);
    else if (item.kind === "text") node = renderText(item);
    else if (item.kind === "changes") node = renderChanges(item);
    else if (item.kind === "error") node = renderError(item);
    else if (item.kind === "compact") {
      node = el("div", "ax-divider");
      node.append(el("span", null, item.pre && item.post
        ? `Context compacted · ${fmt.tokens(item.pre)} → ${fmt.tokens(item.post)} tokens` : "Context compacted"));
      A.nodes.set(item.seq, node);
    } else if (item.kind === "note") { node = el("div", "ax-note", item.text || ""); A.nodes.set(item.seq, node); }
    else if (item.kind === "turn_end") {
      switchDivider(item);
      node = renderEnd(item);
      for (const g of replyEl.querySelectorAll(".ax-act")) paintActivity(g);
      if (turnEl && turnEl._prog) { turnEl._prog.ended = true; paintProg(turnEl._prog); }
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
    if (node._prog) { paintProg(node._prog); return; }
    if (item.kind === "tool" || item.kind === "thinking") {
      const row = renderStep(old);
      row._group = node._group;
      node.replaceWith(row);
      A.nodes.set(item.seq, row);
      if (row._group) paintActivity(row._group);
    } else if (B && B.has("item:" + item.kind)) {
      const fresh = B.item(item.kind, old, ctx);
      node.replaceWith(fresh);
      A.nodes.set(item.seq, fresh);
    } else if (item.kind === "changes") node.replaceWith(renderChanges(old));
    else if (item.kind === "text") { refWorld = worldFor(old); md(node, old.text || ""); refWorld = null; }
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
      for (const s of dirty) { const n = A.nodes.get(s); const it = A.bySeq.get(s); if (n && it) { refWorld = worldFor(it); md(n, it.text); } }
      refWorld = null;
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
    // the transcript's render time, for scripts/perf/render_chat.py (VISUAL_CHAT_PLAN V0)
    const t0 = performance.now();
    turnMemo = new Map();
    try {
      for (const it of A.items) append(it);
      for (const g of log.querySelectorAll(".ax-act")) paintActivity(g);
    } finally { turnMemo = null; }
    markLast();
    toBottom();
    try { performance.measure("ax:render", {start: t0, detail: A.items.length}); } catch { /* an old engine */ }
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
  // Project mode: building the project by its conventions (docs/PROJECT_MODE_PLAN.md D5)
  const PROJECT_STARTS = [
    {kind: "learn", label: "Where are we?", prompt: "Where does the project stand? What needs me, what is in progress, and what should come next?"},
    {kind: "setup", label: "Build the next thing", prompt: "What should we build next? Look at the open checklist rows and the plans, propose the next step, and wait for my go."},
    {kind: "setup", label: "Plan something new", prompt: "I want to build something new. Ask me what it is, then write a plan doc with a status block before changing any code."},
  ];
  const START_ICON = {failure: "alert", eval: "evals", setup: "wand", try: "play", learn: "book", op: "graph"};

  // a viewer's assistant only reads (the server filters project starters too)
  const VIEWER = document.body.dataset.role === "viewer";
  const VIEWER_CANNOT = new Set(["setup", "try"]);

  async function loadSuggestions() {
    if (!PROJECT) return VIEWER ? HOME_STARTS.filter((s) => !VIEWER_CANNOT.has(s.kind)) : HOME_STARTS;
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
    const pm = A.mode === "center";
    hello.append(mark, el("h2", null, pm ? "What are we building?" : PROJECT ? "What should we work on?" : VIEWER ? "What do you want to know?" : "What do you want to build?"));
    // Project mode says no more than its question: the starters and the state beside it do the rest
    if (!pm) hello.append(el("p", null, PROJECT
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
    if (pm) fill(VIEWER ? PROJECT_STARTS.slice(0, 1) : PROJECT_STARTS);
    else if (A.suggestions) fill(A.suggestions);
    else {
      for (let i = 0; i < 3; i += 1) grid.append(el("div", "ax-start ax-skel"));
      loadSuggestions().then((s) => { A.suggestions = s; if (!A.items.length) fill(s); });
    }
    if (pm) { log.append(box); return; }
    const tip = el("div", "ax-tip");
    tip.append(el("kbd", null, "/"), document.createTextNode(" commands"),
      el("span", "ax-dotsep", "·"), el("kbd", null, "Shift ↵"), document.createTextNode(" new line"));
    if (A.mode !== "sheet" && !pm) tip.append(el("span", "ax-dotsep", "·"), el("kbd", null, "Ctrl J"), document.createTextNode(" focus"));
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
    // the context ring is always there: grey, amber from 80%, red from 95%
    const pct = u.context_tokens && u.context_window ? u.context_tokens / u.context_window : 0;
    const shown = pct > 0 && pct < 0.01 ? "<1" : String(Math.round(pct * 100));
    meter.hidden = false;
    meter.classList.toggle("hot", pct >= 0.8 && pct < 0.95);
    meter.classList.toggle("full", pct >= 0.95);
    meterRing.style.setProperty("--pct", String(Math.min(100, Math.round(pct * 100))));
    meterText.textContent = `${shown}%`;
    meter.title = (u.context_window ? `Context ${fmt.tokens(u.context_tokens || 0)} of ${fmt.tokens(u.context_window)} · ${shown}%`
      : "Context") + (pct >= 0.8 ? " — compact it to keep going" : "") + "  ( /usage )";
    if (u.rate && u.rate.status) takeRate({...u.rate, at: u.rate.at || null}, true);
    const p = pillText();
    modelPick.replaceChildren(el("span", "ax-model-dot"),
      el("span", null, p.name + (p.effort ? ` · ${EFFORT_LABEL[p.effort] || p.effort}` : "")));
    modelPick.classList.toggle("pinned", p.pinned);
    modelPick.title = "The model and effort for this conversation";
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
    pop.className = "ax-pop";          // each menu adds its own class
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
    // never past the panel's edges (a 330 px card on a 390 px phone)
    const pr = pop.getBoundingClientRect();
    if (pr.left < rr.left + 8) { pop.style.left = "8px"; pop.style.right = ""; }
    else if (pr.right > rr.right - 8) { pop.style.right = "8px"; pop.style.left = ""; }
  }
  document.addEventListener("pointerdown", (ev) => {
    if (!pop.hidden && !pop.contains(ev.target) && !(pop._anchor && pop._anchor.contains(ev.target))) pop.hidden = true;
  });
  // Esc closes an open menu before anything else hears it
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !pop.hidden) { pop.hidden = true; ev.stopPropagation(); ev.preventDefault(); }
  }, true);

  /* Model and effort. The pill reads "Opus 5.5 · High"; its menu lists
   * Default (what Claude Code picks, and what that resolved to last), the
   * models with what each is good for and its window, and the effort
   * levels. A conversation already bigger than a model's window is warned
   * before switching, with Compact first. */
  const EFFORT_LABEL = {low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max"};
  const EFFORT_SUB = {low: "fastest, least thinking", medium: "", high: "", xhigh: "", max: "slowest, most thinking"};

  async function loadCatalog(force) {
    if (A.catalog && !force) return A.catalog;
    try { A.catalog = await call(`/api/assistant/models?scope=${encodeURIComponent(SCOPE)}`); }
    catch { A.catalog = A.catalog || {models: [], efforts: Object.keys(EFFORT_LABEL), default: {}}; }
    A.models = A.catalog.models.map((m) => m.id);
    return A.catalog;
  }

  // what a model choice means now: its full name and window
  function modelFacts(choice) {
    const cat = A.catalog || {models: [], default: {}};
    if (!choice) return {full: (cat.default || {}).full || (A.agent && A.agent.model) || null, window: (cat.default || {}).window};
    const m = cat.models.find((x) => x.id === choice);
    return m ? {full: m.full, window: m.window} : {full: choice, window: null};
  }

  function pillText() {
    const s = A.session;
    const choice = s ? s.model : ((A.catalog || {}).new || {}).model;
    const effort = s ? s.effort : ((A.catalog || {}).new || {}).effort;
    const f = modelFacts(choice);
    return {name: f.full ? fmt.model(f.full) : "Default model", pinned: !!choice, effort};
  }

  function modelMenu(box) {
    box.classList.add("ax-models");
    const s = A.session;
    const cat = A.catalog || {models: [], efforts: Object.keys(EFFORT_LABEL), default: {}};
    const cur = s ? s.model || null : null;
    const curEffort = s ? s.effort || null : null;
    const used = s && s.usage ? s.usage.context_tokens || 0 : 0;
    box.append(el("div", "ax-pop-title", "Model"));
    const opts = [[null, "Default", "Recommended · Claude Code's pick", modelFacts(null)]]
      .concat(cat.models.map((m) => [m.id, fmt.model(m.full) || m.label, m.good, {full: m.full, window: m.window}]));
    for (const [value, label, good, f] of opts) {
      const b = el("button", "ax-opt ax-model-opt" + (cur === value ? " on" : ""));
      b.type = "button";
      const head = el("span", "ax-opt-label");
      head.append(el("span", null, value === null && f.full ? `Default · ${fmt.model(f.full)}` : label));
      if (f.window) head.append(el("span", "ax-opt-win", `${fmt.tokens(f.window)} context`));
      b.append(head, el("span", "ax-opt-sub", good));
      const over = f.window && used > f.window;
      if (over) {
        b.classList.add("warn");
        b.append(el("span", "ax-opt-warn", `This conversation is ${fmt.tokens(used)}, over its ${fmt.tokens(f.window)} window — compact first`));
      }
      b.onclick = async () => {
        pop.hidden = true;
        if (over) {
          if (!confirm(`This conversation is ${fmt.tokens(used)} tokens, more than ${label}'s ${fmt.tokens(f.window)} window.\n\nCompact it first, then switch?`)) return;
          A.afterCompact = () => setModel(value);
          doCompact();
          return;
        }
        await setModel(value);
      };
      box.append(b);
    }
    box.append(el("div", "ax-pop-title", "Effort"));
    const seg = el("div", "ax-effort");
    for (const e of [null, ...(cat.efforts || Object.keys(EFFORT_LABEL))]) {
      const b = el("button", "ax-effort-opt" + (curEffort === e ? " on" : ""), e ? EFFORT_LABEL[e] || e : "Default");
      b.type = "button";
      b.title = e ? (EFFORT_SUB[e] ? `${EFFORT_LABEL[e]}: ${EFFORT_SUB[e]}` : EFFORT_LABEL[e]) : "Claude Code's default effort";
      b.onclick = async () => { await setEffort(e); seg.querySelectorAll(".on").forEach((x) => x.classList.remove("on")); b.classList.add("on"); paintDefaultBox(); };
      seg.append(b);
    }
    box.append(seg);
    const toggle = el("label", "ax-toggle ax-usenew");
    const cb = el("input");
    cb.type = "checkbox";
    const paintDefaultBox = () => {
      const d = cat.studio_defaults || {};
      const sm = A.session ? A.session.model || null : null, se = A.session ? A.session.effort || null : null;
      cb.checked = (d.model || null) === sm && (d.effort || null) === se;
    };
    paintDefaultBox();
    cb.onchange = async () => {
      const body = cb.checked ? {model: A.session ? A.session.model : null, effort: A.session ? A.session.effort : null} : {};
      try {
        const got = await call("/api/assistant/defaults", body, "PUT");
        cat.studio_defaults = got.studio_defaults;
        toast(cb.checked ? "New conversations start with this model and effort" : "New conversations start on the default model");
      } catch (err) { toast(err.message, true); cb.checked = !cb.checked; }
    };
    toggle.append(cb, el("span", null, "Use for new conversations"));
    box.append(toggle);
  }

  async function patchSession(body) {
    if (!A.session) { await ensureSession(body); return true; }
    try {
      const got = await call(`/api/assistant/sessions/${A.session.id}`, body, "PATCH");
      A.session = got.session;
      return true;
    } catch (err) { toast(err.message, true); return false; }
  }

  async function setModel(value, quiet) {
    if (!(await patchSession({model: value}))) return false;
    paintHead();
    if (!quiet) toast(`This conversation now uses ${value ? fmt.model(modelFacts(value).full || value) : "the default model"}`);
    return true;
  }

  async function setEffort(value) {
    if (!(await patchSession({effort: value}))) return false;
    paintHead();
    toast(value ? `Effort: ${EFFORT_LABEL[value] || value}` : "Effort: Claude Code's default");
    return true;
  }

  /* A divider where an answer came from another model or effort than the
   * one before it: "Switched to Sonnet 5 · High". */
  function switchDivider(end) {
    const i = A.items.indexOf(end);
    const prev = [...A.items.slice(0, i < 0 ? A.items.length : i)].reverse().find((x) => x.kind === "turn_end" && x.model);
    if (!prev || !end.model || !turnEl) return;
    if (prev.model === end.model && (prev.effort || null) === (end.effort || null)) return;
    const d = el("div", "ax-divider ax-switch");
    d.append(el("span", null, `Switched to ${fmt.model(end.model)} · ${end.effort ? EFFORT_LABEL[end.effort] || end.effort : "default effort"}`));
    turnEl.before(d);
  }

  modelPick.onclick = async () => { await loadCatalog(); openPop(modelMenu, modelPick); };

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
    row("Model", fmt.model((s && s.model) || u.model || (A.agent && A.agent.model) || "")
      + (s && s.effort ? ` · ${EFFORT_LABEL[s.effort] || s.effort}` : ""));
    const usage = tbtn("Context, tokens and plan limits", "ax-link ax-usage-link", "chart");
    usage.onclick = () => { pop.hidden = true; openUsage(); };
    box.append(usage);
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
  meter.onclick = () => openUsage();

  /* ── usage: the context ring's card, plan limits and nudges ─────────── */

  const WINDOW_NAME = {five_hour: "5-hour session", seven_day: "Week", seven_day_opus: "Week, Opus",
    seven_day_sonnet: "Week, Sonnet"};
  const PLAN_NAME = {max: "Claude Max", pro: "Claude Pro", team: "Claude Team", enterprise: "Claude Enterprise"};
  const windowsOf = (rate) => Object.entries(rate || {})
    .filter(([, w]) => w && typeof w === "object" && w.used != null)
    .map(([name, w]) => ({name, label: WINDOW_NAME[name] || name.replace(/_/g, " "), used: +w.used, resets: w.resets}));

  // when a window resets: a time today, or a weekday and a time
  function resetAt(epoch) {
    if (!epoch) return "";
    const d = new Date(epoch * 1000), now = new Date();
    const time = d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
    return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, {weekday: "short"})} ${time}`;
  }

  // a reading of the plan's limits: the newest one wins
  function takeRate(rate, fromSession) {
    if (!rate) return;
    if (fromSession && A.rate && A.rate.at) return;           // the studio-wide one carries its time
    if (A.rate && rate.at && A.rate.at && rate.at < A.rate.at) return;
    A.rate = rate;
    paintNudge();
  }

  /* From 80% of a plan window, a line above the box says so; at a limit,
   * Send waits for the reset. */
  function paintNudge() {
    const wins = windowsOf(A.rate);
    const limited = A.rate && A.rate.status === "rejected";
    const worst = wins.slice().sort((a, b) => b.used - a.used)[0];
    const atLimit = limited || (worst && worst.used >= 1);
    const hot = worst && worst.used >= 0.8;
    nudge.hidden = !(hot || atLimit);
    nudge.classList.toggle("limit", !!atLimit);
    nudge.textContent = "";
    if (!nudge.hidden) {
      const w = limited && A.rate.limited_by ? (wins.find((x) => x.name === A.rate.limited_by) || worst) : worst;
      nudge.append(icon(atLimit ? "alert" : "clock"), el("span", null, atLimit
        ? `The ${w.label.toLowerCase()} limit is reached${w.resets ? ` · it resets at ${resetAt(w.resets)}` : ""}`
        : `${Math.round(w.used * 100)}% of this ${w.label.toLowerCase()} used${w.resets ? ` · resets ${resetAt(w.resets)}` : ""}`));
      const more = el("button", "ax-nudge-more", "Usage");
      more.type = "button";
      more.onclick = openUsage;
      nudge.append(more);
    }
    const blocked = !!atLimit && !A.running;
    send.disabled = blocked;
    send.title = blocked ? `The plan's limit is reached — Send comes back at ${resetAt((worst || {}).resets) || "the reset"}`
      : (A.running ? "Stop" : "Send  ( Enter )");
  }

  async function openUsage() {
    openPop(usageCard, meter);
    try {
      const got = await call("/api/assistant/usage");
      if (got.rate) takeRate(got.rate);
      A.account = got.account || A.account;
      if (!pop.hidden && pop.classList.contains("ax-usage")) { pop.textContent = ""; usageCard(pop); }
    } catch { /* the card shows what it has */ }
  }

  function usageCard(box) {
    box.classList.add("ax-usage");
    const s = A.session;
    const u = (s && s.usage) || {};
    const bar = (frac, cls) => {
      const b = el("div", "ax-bar" + (cls ? " " + cls : ""));
      const f = el("span");
      f.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
      b.append(f);
      return b;
    };
    const line = (k, v) => { const r = el("div", "ax-kv"); r.append(el("span", "ax-k", k), el("span", "ax-v", v)); box.append(r); return r; };
    box.append(el("div", "ax-pop-title", "This conversation"));
    if (u.context_window) {
      const frac = (u.context_tokens || 0) / u.context_window;
      line("Context", `${fmt.tokens(u.context_tokens || 0)} of ${fmt.tokens(u.context_window)} · ${frac > 0 && frac < 0.01 ? "<1" : Math.round(frac * 100)}%`);
      box.append(bar(frac, frac >= 0.95 ? "full" : frac >= 0.8 ? "hot" : ""));
    } else line("Context", s ? "after the first answer" : "no conversation yet");
    if (u.input_tokens != null)
      line("Tokens", `${fmt.tokens((u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_write_tokens || 0))} in · ${fmt.tokens(u.output_tokens)} out · ${fmt.tokens(u.cache_read_tokens)} cached`);
    line("Turns", String(u.turns || 0));
    if (u.cost_usd != null) {
      const c = el("div", "ax-usage-cost", `≈ ${fmt.money(u.cost_usd)} at API prices`);
      c.title = "What these tokens would cost on the API. On a Claude subscription nothing is billed per token.";
      box.append(c);
    }
    const acts = el("div", "ax-pop-acts");
    const compact = tbtn("Compact", "ax-btn" + ((u.context_window && (u.context_tokens || 0) / u.context_window >= 0.95) ? " primary" : ""), "compress");
    compact.disabled = !(s && s.claude_session) || !!A.running;
    compact.title = "Summarize the conversation so far, to free the context";
    compact.onclick = () => { pop.hidden = true; doCompact(); };
    acts.append(compact);
    box.append(acts);

    const head = el("div", "ax-pop-title ax-usage-head");
    head.append(el("span", null, "Plan limits"));
    if (A.rate && A.rate.at) head.append(el("span", "ax-usage-asof", `as of ${fmt.ago(A.rate.at)}`));
    box.append(head);
    const wins = windowsOf(A.rate);
    if (!wins.length) box.append(el("div", "ax-usage-none", "Not heard yet: the first answer brings them."));
    for (const w of wins) {
      const r = line(w.label, `${Math.round(w.used * 100)}% used${w.resets ? ` · resets ${resetAt(w.resets)}` : ""}`);
      r.classList.add("ax-kv-wide");
      box.append(bar(w.used, w.used >= 1 ? "full" : w.used >= 0.8 ? "hot" : ""));
    }

    box.append(el("div", "ax-pop-title", "Account"));
    box.append(accountBlock(A.account, () => { pop.hidden = true; }));
  }
  document.addEventListener("oxrate", (ev) => { if (ev.detail) takeRate(ev.detail); });

  /* ── your own Claude sign-in (plan §3; per person since TEAM_PLAN P4) ───
   * Each person signs in to Claude in their own place on the studio, so
   * this machine's Claude Code — and everyone else's sign-in — is never
   * touched. Only the machine login's owner falls back to it until they
   * sign in; anyone else is asked to. Signing in is the
   * Claude Code extension's flow: the sign-in page opens in a new tab, and
   * the code it shows afterwards is pasted back here. */
  const who = (a) => [a.email || a.org || "Claude", PLAN_NAME[a.plan] || (a.method === "console" ? "API account" : a.plan || "")]
    .filter(Boolean).join(" · ");

  async function refreshAccount(fresh) {
    try { A.account = (await call(`/api/assistant/account${fresh ? "?fresh=1" : ""}`)).account; } catch { /* keep what we had */ }
    return A.account;
  }

  // who the assistant runs as, with what can be done about it
  function accountBlock(a, before) {
    const box = el("div", "ax-account");
    const line = el("div", "ax-account-who");
    const acts = el("div", "ax-account-acts");
    const act = (label, cls, fn) => { const b = tbtn(label, "ax-btn " + cls); b.onclick = () => { if (before) before(); fn(); }; acts.append(b); };
    if (!a) line.textContent = "…";
    else if (a.logged_in == null) line.textContent = "The account could not be read";
    else if (a.source === "studio" && a.logged_in) {
      line.append(el("span", null, "Signed in as "), el("b", null, who(a)));
      act("Switch account", "ax-btn-quiet", () => openSignin("claudeai", "Sign in with the account to switch to."));
      act("Sign out", "ax-btn-quiet", signOut);
    } else if (a.logged_in) {
      line.append(el("span", null, "Using this machine's login ("), el("b", null, who(a)), el("span", null, ")"));
      const why = el("div", "ax-account-note", "Give the studio its own sign-in to use another account; this machine's Claude Code stays as it is.");
      box.append(line, why);
      act("Sign in with Claude", "primary", () => openSignin("claudeai"));
      box.append(acts);
      return box;
    } else {
      line.textContent = a.source === "none" ? "Not signed in — the assistant runs under your own Claude account"
        : "Not signed in";
      act("Sign in with Claude", "primary", () => openSignin("claudeai"));
    }
    box.append(line, acts);
    return box;
  }

  async function signOut() {
    const a = A.account || {};
    if (!confirm(`Sign your assistant out of ${a.email || "its Claude account"}?\n\nOnly your own sign-in on this studio; this machine's Claude Code isn't touched.`)) return;
    try {
      A.account = (await call("/api/assistant/logout", {})).account;
      toast(A.account.logged_in ? `Signed out — using this machine's login (${A.account.email || "Claude"})` : "Signed out");
      if (!A.account.logged_in) openSignin("claudeai");
    } catch (err) { toast(err.message, true); }
  }

  let login = null;      // {id, url, method}
  function closeSignin() {
    signin.hidden = true;
    signin.textContent = "";
    inputWrap.hidden = false;
    root.classList.remove("signing");
    input.focus();
  }

  /* The card, step by step: sign in on Claude's page; paste the code;
   * signed in. `why` says what brought it up (a failed turn, say). */
  function openSignin(method, why, quiet) {
    // the card lives in the assistant's box: bring the assistant into view —
    // unless the page is only loading (`quiet`): then the card waits in the
    // box, and a phone's screen is not covered by it on every page
    if (!quiet && A.mode === "dock" && W.oxSide) W.oxSide.show("assistant");
    else if (!quiet && A.mode === "dock" && PHONE.matches) placement.openSheet();
    signin.textContent = "";
    signin.hidden = false;
    inputWrap.hidden = true;
    root.classList.add("signing");
    const head = el("div", "ax-signin-head");
    const mark = el("span", "ax-signin-mark");
    mark.append(icon("spark"));
    head.append(mark, el("b", null, "Sign in to Claude"));
    const body = el("div", "ax-signin-body");
    signin.append(head, body);
    const machine = A.account && A.account.logged_in && A.account.source !== "studio";
    const step1 = (err) => {
      body.textContent = "";
      body.append(el("p", null, why || "Sign in with your own Claude account. It is yours alone on this studio: no one else's assistant uses it, and this machine's Claude Code stays as it is."));
      if (err) body.append(el("p", "ax-signin-err", err));
      const go = tbtn("Sign in with Claude", "ax-btn primary");
      go.onclick = () => start("claudeai");
      const other = el("div", "ax-signin-other");
      const alt = (label, m) => { const b = el("button", "ax-linkbtn", label); b.type = "button"; b.onclick = () => start(m); return b; };
      other.append(alt("Console account (API billing)", "console"), el("span", "ax-dotsep", "·"), alt("SSO", "sso"));
      const row = el("div", "ax-signin-acts");
      row.append(go);
      if (machine || (A.account && A.account.logged_in)) {
        const later = tbtn("Not now", "ax-btn ax-btn-quiet");
        later.onclick = closeSignin;
        row.append(later);
      }
      body.append(row, other);
    };
    const step2 = (url, err) => {
      body.textContent = "";
      const p1 = el("p");
      p1.append("Sign in on the page that opened, then paste the code it shows here. ");
      const again = el("a", null, "Open the sign-in page again");
      again.href = url;
      again.target = "_blank";
      again.rel = "noopener noreferrer";
      p1.append(again);
      body.append(p1);
      const field = el("input", "ax-signin-code");
      field.type = "text";
      field.placeholder = "Paste the code";
      field.autocomplete = "off";
      field.spellcheck = false;
      field.setAttribute("aria-label", "The code from the sign-in page");
      body.append(field);
      if (err) body.append(el("p", "ax-signin-err", err));
      const row = el("div", "ax-signin-acts");
      const cont = tbtn("Continue", "ax-btn primary");
      const cancel = tbtn("Cancel", "ax-btn ax-btn-quiet");
      row.append(cont, cancel);
      body.append(row);
      cancel.onclick = async () => {
        const l = login;
        login = null;
        if (l) call(`/api/assistant/login/${l.id}`, undefined, "DELETE").catch(() => {});
        if (A.account && A.account.logged_in) closeSignin(); else step1();
      };
      const send = async () => {
        const code = field.value.trim();
        if (!code || !login) return;
        cont.disabled = true;
        cont.querySelector("span").textContent = "Checking…";
        try {
          const got = await call(`/api/assistant/login/${login.id}/code`, {code});
          login = null;
          A.account = got.account;
          done(got.account);
        } catch (err2) {
          login = null;
          // the CLI ends a sign-in on a wrong code: start again
          step1(`${err2.message} — start again.`);
        }
      };
      cont.onclick = send;
      field.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); send(); } });
      setTimeout(() => field.focus(), 50);
    };
    const done = (a) => {
      body.textContent = "";
      const ok = el("p", "ax-signin-ok");
      ok.append(icon("check"), el("span", null, `Signed in as ${who(a)}`));
      body.append(ok);
      toast(`The assistant now signs in as ${a.email || "your account"}`);
      setTimeout(closeSignin, 1600);
      loadCatalog(true).then(paintHead);
    };
    const start = async (m) => {
      // a tab opened now, inside the click: a tab opened after the request
      // returns is a popup, and browsers block those
      const tab = W.open("", "_blank");
      body.textContent = "";
      body.append(el("p", null, "Starting the sign-in…"));
      try {
        const got = await call("/api/assistant/login", {method: m});
        login = {id: got.login_id, url: got.url, method: m};
        if (tab && !tab.closed) { try { tab.location.href = got.url; } catch { /* opened elsewhere */ } }
        else W.open(got.url, "_blank", "noopener");
        step2(got.url);
      } catch (err) {
        if (tab && !tab.closed) tab.close();
        step1(err.message);
      }
    };
    if (login) step2(login.url); else step1();
    if (method && method !== "claudeai" && !login) start(method);
  }

  // Settings and other screens show the same account block
  W.oxAccountBlock = async () => accountBlock(await refreshAccount());

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
    local.set(K_CURRENT, "");          // chosen: a reload keeps it blank
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
    loadRefs();
    paintList();
    if (got.running) follow(got.running.id, got.running.cursor, got.running);
    else paintBusy();
  }

  /* ── the wire ─────────────────────────────────────────────────────── */

  function applyEvent(ev) {
    const r = A.running;
    if (ev.t === "state" && r) { r.state = ev.state; r.detail = ev.detail || ""; r.step = ev.step || ""; paintStatus(); askbarPaint(); }
    else if (ev.t === "item") {
      const it = ev.item;
      const stick = nearBottom();
      if (it.kind === "user" && pendingUser) { pendingUser.remove(); pendingUser = null; }
      // the screen follows the work (choreo.js): a tool starting, and the same tool ending
      const was = A.bySeq.get(it.seq);
      const phase = it.kind !== "tool" ? null
        : !was ? (it.status === "running" ? "start" : null)
        : was.status === "running" && it.status !== "running" ? "end" : null;
      if (A.bySeq.has(it.seq)) replace(it);
      else { A.items.push(it); append(it); markLast(); }
      if (phase) document.dispatchEvent(new CustomEvent("oxtool", {detail: {item: A.bySeq.get(it.seq) || it, phase}}));
      if (stick) toBottom(); else jump.hidden = false;
    } else if (ev.t === "delta") delta(ev.seq, ev.text);
    if (ev.t === "item" && ev.item.kind === "error" && ev.item.auth) {
      refreshAccount(true).then(() => openSignin("claudeai", "The assistant's Claude sign-in didn't work. Sign in again to carry on."));
    }
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
    loadRefs();
    if (ev.state === "lost") toast("That task is no longer running — the studio restarted", true);
    if (ev.usage && A.session) A.session.usage = ev.usage;
    paintBusy();
    paintHead();
    markLast();
    for (const g of log.querySelectorAll(".ax-act.live")) paintActivity(g);
    for (const c of log.querySelectorAll(".ax-prog.live")) paintProg(c._prog);
    A.progress = A.handOn = null;
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
    // a model switch waiting on the compaction it asked for
    if (A.afterCompact) { const f = A.afterCompact; A.afterCompact = null; if (ev.state === "done") f(); }
    loadCatalog(true).then(paintHead);   // what "Default" resolved to may be news
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
    if (typeof paintNudge === "function") paintNudge();
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
      stopping: "Stopping", waiting: "Waiting for a background task"};
    statusText.textContent = r.step && /^(thinking|tool|writing)$/.test(r.state) ? r.step
      : r.state === "tool" && r.detail ? r.detail
      : r.state === "waiting" && r.detail ? `Waiting for a background task · ${r.detail}` : `${words[r.state] || "Working"}…`;
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

  async function resume() {
    if (!A.session || A.running) return false;
    try {
      await call(`/api/assistant/sessions/${A.session.id}/turns`, {message: "Continue where you stopped.", view: viewForMessage()});
    } catch (err) { toast(err.message, true); return false; }
    await openSession(A.session.id);
    return true;
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
    ["/model", "Choose the model: /model fable | opus | sonnet | haiku | default | claude-…", async (arg) => {
      const v = (arg || "").trim().toLowerCase();
      await loadCatalog();
      if (!v) { openPop(modelMenu, modelPick); return; }
      if (v === "default") setModel(null);
      else if (A.models.includes(v) || /^claude-[a-z0-9][a-z0-9.-]{1,60}$/.test(v)) setModel(v);
      else toast(`No model “${v}” — try ${A.models.join(", ")} or default`, true);
    }],
    ["/usage", "Context, tokens and the plan's limits", () => openUsage()],
    ["/effort", "How hard it thinks: /effort low | medium | high | xhigh | max | default", (arg) => {
      const v = (arg || "").trim().toLowerCase().replace(/^extra\s*high$/, "xhigh");
      if (!v) { loadCatalog().then(() => openPop(modelMenu, modelPick)); return; }
      if (v === "default") setEffort(null);
      else if (EFFORT_LABEL[v]) setEffort(v);
      else toast(`No effort “${v}” — try low, medium, high, xhigh, max or default`, true);
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
      b.onmousedown = (ev) => { ev.preventDefault(); input.value = c[0] + " "; closeSlash(); if (c[0] !== "/model" && c[0] !== "/effort") submit(c[0]); else input.focus(); };
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
    const step = A.running && A.running.step;
    askbar.classList.toggle("busy", !!A.running);
    askbar.classList.toggle("stepped", !!step);
    askbar.style.setProperty("--ax-prog", `${A.progress || 0}%`);
    askText.textContent = step || (A.running ? "The assistant is working…" : "Ask the assistant…");
  }

  const placement = {
    home: null,
    set(mode) {
      setExpanded(false);
      const prevMode = A.mode;
      A.mode = mode;
      root.classList.remove("dock", "focus", "sheet", "hero", "center");
      root.classList.add(mode);
      document.body.classList.toggle("ax-focus", mode === "focus");
      document.body.classList.toggle("ax-sheet", mode === "sheet");
      bFocus.replaceChildren(icon(mode === "focus" ? "collapse" : "expand"));
      bFocus.title = mode === "focus" ? "Leave focus  ( Esc )" : "Focus  ( Ctrl J )";
      bFocus.hidden = mode === "sheet" || mode === "center";
      // docked in the side panel, the panel's own toggle (and Esc) close it,
      // and Inspect is the tab beside it: no second ×; in Project mode it is the screen
      bClose.hidden = mode === "hero" || mode === "dock" || mode === "center";
      if (mode === "focus" && !PHONE.matches) { root.classList.add("side-open"); refreshList(); }
      if (mode === "dock") root.classList.remove("side-open");
      // the empty conversation speaks to where it is (Project mode has its own starters)
      if (!A.items.length && (mode === "center" || prevMode === "center")) renderEmpty();
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
    toggleFocus() {
      if (A.mode === "center") return;   // Project mode: the conversation already has the screen
      if (A.mode === "focus" || A.mode === "sheet") this.leave(); else this.enterFocus();
    },
    center(slot) {
      if (!slot) return;
      const s = document.getElementById("axstage");
      if (s) s.hidden = true;
      slot.append(root);
      if (A.mode !== "center") this.set("center");
    },
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
    if (A.mode === "center") { /* already on screen */ }
    else if (PHONE.matches) placement.openSheet();
    else if (A.mode === "dock" && W.oxSide) W.oxSide.show("assistant");
    if (A.running) { A.queue = {text, images: []}; paintQueue(); toast("Queued — it goes when the current answer is done"); return; }
    submit(text);
  };
  // the inspector's "Ask about this": the selection rides along; start typing
  W.oxAssistant = {
    focus() {
      if (A.mode === "center") { /* already on screen */ }
      else if (PHONE.matches) placement.openSheet();
      else if (A.mode === "dock" && W.oxSide) W.oxSide.show("assistant");
      A.dropped.delete("node");
      paintChips();
      input.focus();
    },
    open(id, focus) { openSession(id); if (focus && A.mode === "hero") placement.enterFocus(); },
    busy: () => !!A.running,
    // Project mode takes the conversation into its centre, and gives it back on leaving
    center(slot) { placement.center(slot); },
    uncenter() { if (A.mode === "center") placement.leave(); },
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
    loadCatalog().then(paintHead);
    call("/api/assistant/usage").then((got) => {
      if (got.rate) takeRate(got.rate);
      A.account = got.account;
      // no sign-in anywhere (neither the studio's nor this machine's): the card first
      if (A.account && A.account.logged_in === false && A.mode !== "hero") openSignin("claudeai", undefined, true);
    }).catch(() => {});
    root.classList.toggle("details", A.details);
    paintHead();
    paintChips();
    const imported = await importOld();
    const fromHash = /#assistant=([\w-]+)/.exec(location.hash);
    // a project page picks up where it was; home starts fresh (its last
    // conversations are one click away under Recent conversations)
    let id = (fromHash && fromHash[1]) || imported || (PROJECT ? local.get(K_CURRENT, null) : null);
    // a browser that never chose here (another device, the public link) picks up the latest conversation
    if (!id && PROJECT && local.get(K_CURRENT, null) === null) {
      try {
        const got = await call(`/api/assistant/sessions?scope=${PROJECT}&limit=5`);
        id = ((got.sessions || []).find((s) => s.title || s.preview) || {}).id || null;
      } catch { /* a blank conversation, as before */ }
    }
    if (fromHash) history.replaceState(null, "", location.pathname + location.search);
    if (id) await openSession(id);
    else { renderAll(); loadDraft(); }
    if (fromHash && A.mode === "center") { /* Project mode: already the screen */ }
    else if (fromHash && !PHONE.matches) placement.enterFocus();
    else if (fromHash) placement.openSheet();
  }

  if (PROJECT) {
    if (dock) dock.append(root);
    placement.set("dock");
    // the page opened in Project mode (its address) before this file ran
    if (document.body.classList.contains("pmode")) placement.center(document.getElementById("pmchat"));
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
    if (A.mode === "center") return;
    if (PHONE.matches) placement.openSheet(); else placement.enterFocus();
  });
  boot();
})();
