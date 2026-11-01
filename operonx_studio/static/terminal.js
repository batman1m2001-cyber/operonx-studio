/* operonx studio — Project mode › Terminal (docs/WORKSPACE_PLAN.md W2).
 *
 * Real shells on a PTY in the checkout or one of its worktrees (operonx_studio/terminals.py): a rail of the
 * project's terminals — working (what runs in the foreground) or idle, how long since they printed, the card
 * they work for, who opened them — and one or two of them live, side by side. A terminal the assistant opens
 * shows here too. xterm.js (static/vendor/xterm, MIT) loads when the page first opens: 290 KB the rest of
 * the studio never needs.
 */

const TerminalPage = (() => {
  const enc = encodeURIComponent;
  let host = null;       // the page element while mounted
  let timer = null;
  let list = [];
  let places = [];
  let hosts = [];        // environments over SSH (W3): a new terminal can open there
  const K = () => `terms:${PID}`;
  const v = () => Object.assign({panes: [], split: false, focus: 0}, recall(K(), {}));
  let view = null;
  const live = {};       // terminal id -> {term, fit, ws, el}
  let loading = null;
  function button(cls, text, onclick, title) {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    b.onclick = onclick;
    return b;
  }

  function lib() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (loading) return loading;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/static/vendor/xterm/xterm.css";
    document.head.append(css);
    const script = (src) => new Promise((ok, bad) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => bad(new Error(`could not load ${src}`));
      document.head.append(s);
    });
    loading = script("/static/vendor/xterm/xterm.js").then(() => script("/static/vendor/xterm/addon-fit.js"));
    return loading;
  }

  function ago(t) {
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }
  const short = (p) => {
    const root = places[0] || "";
    if (p === root) return "checkout";
    return p.startsWith(root + "/") ? p.slice(root.length + 1) : p.split("/").slice(-2).join("/");
  };

  function colours() {
    const cs = getComputedStyle(document.documentElement);
    const c = (n, d) => (cs.getPropertyValue(n) || "").trim() || d;
    return {background: c("--surface", "#111"), foreground: c("--text", "#ddd"), cursor: c("--accent", "#a78bfa"),
            selectionBackground: c("--accent-ring", "rgba(120,90,220,.3)")};
  }

  async function load() {
    const got = await api(`/api/p/${PID}/terminals`);
    list = got.terminals;
    places = got.places;
    try { hosts = (await api(`/api/p/${PID}/environments`)).environments.filter((e) => e.kind === "ssh"); } catch { hosts = []; }
  }

  async function mount(page) {
    host = page;
    view = v();
    page.textContent = "";
    page.append(el("p", "pm-quiet", "Loading the terminals…"));
    try { await Promise.all([lib(), load()]); }
    catch (err) { page.textContent = ""; page.append(el("p", "pm-quiet", (err.data || {}).error || err.message)); return; }
    if (host !== page) return;
    view.panes = view.panes.filter((id) => list.some((t) => t.id === id));
    draw();
    clearInterval(timer);
    timer = setInterval(tick, 3000);
  }

  function unmount() {
    clearInterval(timer);
    timer = null;
    for (const id of Object.keys(live)) detach(id);
    host = null;
  }

  async function tick() {
    if (!host || document.hidden) return;
    try { await load(); } catch { return; }
    // a terminal the assistant opened shows in a free pane at once
    for (const t of list) if (!view.panes.includes(t.id) && !view.seen?.includes(t.id) && t.by === "assistant") show(t.id);
    view.seen = list.map((t) => t.id);
    rail();
  }

  const save = () => store(K(), view);

  function draw() {
    host.textContent = "";
    const head = el("div", "pm-pagehead gv-head");
    head.append(el("h2", "pm-title", "Terminal"),
      el("span", "pm-sub", list.length ? `${list.length} open` : ""));
    const where = el("select", "tm-where");
    where.title = "Where the new terminal starts: the checkout, one of its worktrees, or a host (Environments)";
    for (const p of places) where.append(new Option(short(p), p));
    for (const e of hosts) where.append(new Option(`${e.name || e.id} (ssh)`, `env:${e.id}`));
    where.hidden = places.length + hosts.length < 2;
    const add = button("primary", "New terminal", async () => {
      const env = where.value.startsWith("env:") ? where.value.slice(4) : "";
      let t;
      try { t = await api(`/api/p/${PID}/terminals`, env ? {env} : {cwd: where.value || places[0]}); }
      catch (err) { toast((err.data || {}).error || err.message); return; }
      list.push(t);
      show(t.id);
    }, "A login shell in the project");
    const split = button("pm-chip" + (view.split ? " on" : ""), "Split", () => {
      view.split = !view.split; save(); draw();
    }, "Two terminals side by side");
    const tools = el("span", "gv-tools");
    tools.append(where, split, add);
    head.append(tools);
    const grid = el("div", "tm-grid");
    grid.append(el("ul", "tm-rail"), el("div", "tm-panes" + (view.split ? " split" : "")));
    host.append(head, grid);
    rail();
    panes();
  }

  function rail() {
    const ul = host && host.querySelector(".tm-rail");
    if (!ul) return;
    ul.textContent = "";
    if (!list.length) { ul.append(el("li", "pm-quiet", "No terminal yet.")); return; }
    for (const t of list) {
      const li = el("li", "tm-item" + (view.panes.includes(t.id) ? " on" : ""));
      li.dataset.oxTarget = `terminal:${t.id}`;
      const dot = el("span", `tm-dot ${t.state}`);
      const name = el("span", "tm-name", t.title);
      const state = t.state === "working" ? `working · ${t.running}` : t.state === "ended" ? `ended · exit ${t.exit_code}` : "idle";
      const meta = el("span", "tm-meta", `${state} · ${ago(t.last)} · ${short(t.cwd)}`);
      li.append(dot, name);
      if (t.by === "assistant") li.append(el("span", "chip", "assistant"));
      if (t.env) li.append(el("span", "chip", t.env));
      if (t.card) li.append(el("span", "chip", t.card));
      const x = button("tm-x", "×", async (e) => {
        e.stopPropagation();
        if (t.state === "working" && !confirm(`${t.title} is running ${t.running}. Close it and stop that?`)) return;
        await fetch(`/api/p/${PID}/terminals/${enc(t.id)}`, {method: "DELETE"});
        list = list.filter((o) => o.id !== t.id);
        view.panes = view.panes.filter((id) => id !== t.id);
        detach(t.id); save(); draw();
      }, "Close the terminal (everything it runs stops)");
      li.append(x, meta);
      li.title = `${t.cwd}${t.card ? `\nfor ${t.card}` : ""}\nopened by ${t.by === "assistant" ? "the assistant" : "you"}`;
      li.onclick = () => show(t.id);
      ul.append(li);
    }
  }

  function show(id) {
    if (!view) view = v();   // before the page is mounted: remembered, mount() opens it
    const n = view.split ? 2 : 1;
    if (!view.panes.includes(id)) {
      const at = Math.min(view.focus, n - 1);
      const was = view.panes[at];
      view.panes[at] = id;
      if (was && was !== id) detach(was);
    }
    view.panes = view.panes.slice(0, n);
    view.focus = view.panes.indexOf(id);
    save();
    if (host) { rail(); panes(); }
  }

  function panes() {
    const box = host.querySelector(".tm-panes");
    const n = view.split ? 2 : 1;
    for (const id of Object.keys(live)) if (!view.panes.slice(0, n).includes(id)) detach(id);
    box.textContent = "";
    for (let i = 0; i < n; i++) {
      const id = view.panes[i];
      const pane = el("div", "tm-pane" + (i === view.focus ? " focus" : ""));
      pane.onclick = () => { view.focus = i; save(); for (const p of box.children) p.classList.toggle("focus", p === pane); };
      box.append(pane);
      const t = list.find((o) => o.id === id);
      if (!t) { pane.append(el("p", "pm-quiet", n > 1 ? "Pick a terminal on the left for this side." : "Open a terminal, or pick one on the left.")); continue; }
      attach(t, pane);
    }
  }

  function attach(t, pane) {
    let l = live[t.id];
    if (!l) {
      const term = new window.Terminal({fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                                        theme: colours(), cursorBlink: true, scrollback: 5000});
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      const node = el("div", "tm-term");
      term.open(node);
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/p/${PID}/terminals/${enc(t.id)}/ws`);
      ws.binaryType = "arraybuffer";
      ws.onmessage = (m) => {
        if (typeof m.data === "string") {
          const d = JSON.parse(m.data);
          if (d.ended) term.write(`\r\n\x1b[2m[ended · exit ${d.exit_code}]\x1b[0m\r\n`);
        } else term.write(new Uint8Array(m.data));
      };
      ws.onclose = (e) => { if (e.code === 4403) term.write("\r\n[not allowed: an editor's sign-in is needed]\r\n"); };
      term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({i: d})); });
      const size = () => {
        try { fit.fit(); } catch { return; }
        if (ws.readyState === 1) ws.send(JSON.stringify({r: [term.rows, term.cols]}));
      };
      ws.onopen = size;
      const ro = new ResizeObserver(() => size());
      l = live[t.id] = {term, fit, ws, node, ro};
    }
    pane.append(l.node);
    l.ro.observe(pane);
    requestAnimationFrame(() => { try { l.fit.fit(); } catch { /* not laid out yet */ } l.term.focus(); });
  }

  function detach(id) {
    const l = live[id];
    if (!l) return;
    l.ro.disconnect();
    try { l.ws.close(); } catch { /* closed */ }
    l.term.dispose();
    delete live[id];
  }

  return {mount, unmount, show};
})();
