/* operonx studio — Project mode › Environments (docs/WORKSPACE_PLAN.md W3).
 *
 * Where the project's commands run (operonx_studio/environments.py): this machine, and the hosts the owner adds
 * over SSH. A host is set up once — host, port, user, folder; its key scanned, its fingerprint checked and
 * trusted; a private key and variables pasted, written and never shown again — then worked from here: test the
 * connection, open a terminal there, bring its folder to a branch, read its processes, resources, logs and
 * files, run a command. Production asks before anything runs, and the assistant only reads there.
 */

const EnvPage = (() => {
  const K = () => `envs:${PID}`;
  let host = null;
  let envs = [];
  let v = null;           // {sel}
  let scanned = null;     // {env, fingerprints, changed}: the last scan, until trusted
  let out = null;         // {title, text, ok}: the last answer
  const LEVEL = {run: "run and read", read: "read only", none: "nothing"};

  function button(cls, text, onclick, title) {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    b.onclick = onclick;
    return b;
  }
  const save = () => store(K(), v);
  const cur = () => envs.find((e) => e.id === v.sel) || envs[0];

  async function mount(page) {
    host = page;
    v = Object.assign({sel: "local"}, recall(K(), {}));
    page.textContent = "";
    page.append(el("p", "pm-quiet", "Reading the environments…"));
    try { await load(); }
    catch (err) { page.textContent = ""; page.append(el("p", "pm-quiet", (err.data || {}).error || err.message)); return; }
    if (host !== page) return;
    draw();
  }
  function unmount() { host = null; }
  async function load() { envs = (await api(`/api/p/${PID}/environments`)).environments; }

  async function act(body, title, btn) {
    if (btn) btn.disabled = true;
    out = {title, text: "…", ok: true};
    drawOut();
    try {
      let got = await api(`/api/p/${PID}/environments`, body);
      if (got.needs_confirm) {
        if (!confirm(got.needs_confirm)) { out = null; drawOut(); return null; }
        got = await api(`/api/p/${PID}/environments`, {...body, confirm: true});
      }
      out = {title, text: got.said || (got.ok ? "done" : ""), ok: got.ok !== false};
      if (got.env || body.op === "delete" || body.op === "save") { await load(); draw(); } else drawOut();
      return got;
    } catch (err) {
      out = {title, text: (err.data || {}).error || err.message, ok: false};
      drawOut();
      return null;
    } finally { if (btn) btn.disabled = false; }
  }

  function draw() {
    if (!host) return;
    host.textContent = "";
    const head = el("div", "pm-pagehead gv-head");
    head.append(el("h2", "pm-title", "Environments"), el("span", "pm-sub", `${envs.length} · where commands run`));
    const tools = el("span", "gv-tools");
    tools.append(button("primary", "Add a host", () => { v.sel = ""; save(); draw(); }, "A machine reached over SSH"));
    head.append(tools);
    const grid = el("div", "tm-grid ev-grid");
    const rail = el("ul", "tm-rail");
    for (const e of envs) {
      const li = el("li", "tm-item" + (e.id === v.sel ? " on" : ""));
      li.append(el("span", `tm-dot ${e.kind === "local" || (e.trusted.length && e.key_set) ? "idle" : ""}`),
        el("span", "tm-name", e.name || e.id));
      if (e.production) li.append(el("span", "chip ev-prod", "production"));
      li.append(el("span", "tm-meta", e.kind === "local" ? "the checkout" : `${e.user}@${e.host}${e.port === 22 ? "" : `:${e.port}`}`));
      li.title = e.where;
      li.onclick = () => { v.sel = e.id; scanned = null; out = null; save(); draw(); };
      rail.append(li);
    }
    const body = el("div", "ev-body");
    grid.append(rail, body);
    host.append(head, grid);
    const e = v.sel === "" ? null : cur();
    if (!e) { body.append(form(null)); return; }
    body.append(summary(e), work(e), el("div", "ev-out"));
    if (e.kind === "ssh") body.append(trust(e), secrets(e), form(e));
    else body.append(secrets(e));
    drawOut();
  }

  function section(title, hint) {
    const s = el("section", "ev-sec");
    s.append(el("h3", "pm-h", title));
    if (hint) s.append(el("p", "ev-hint", hint));
    return s;
  }

  function summary(e) {
    const s = el("div", "ev-sum");
    const where = el("code", null, e.where);
    where.title = e.where;
    s.append(el("b", null, e.name || e.id), where);
    if (e.kind === "ssh") {
      s.append(el("span", "chip" + (e.trusted.length ? "" : " ev-warn"), e.trusted.length ? "host key trusted" : "host key not trusted"),
        el("span", "chip" + (e.key_set ? "" : " ev-warn"), e.key_set ? "key set" : "no key"));
    }
    if (e.production) s.append(el("span", "chip ev-prod", "production"));
    s.append(el("span", "chip", `assistant: ${LEVEL[e.production && e.assistant === "run" ? "read" : e.assistant]}`));
    return s;
  }

  function field(label, input) {
    const f = el("label", "ev-field");
    f.append(el("span", null, label), input);
    return f;
  }
  function input(value, ph, type) {
    const i = el("input");
    i.type = type || "text"; i.value = value == null ? "" : value; i.placeholder = ph || ""; i.spellcheck = false;
    return i;
  }

  function form(e) {
    const s = section(e ? "Connection" : "Add a host", e ? null : "Reached over SSH with a private key; its host key is checked before anything connects.");
    const id = input(e ? e.id : "", "staging");
    id.disabled = !!e;
    const name = input(e ? e.name : "", "Staging");
    const hostI = input(e ? e.host : "", "10.0.0.5 or host.example.com");
    const port = input(e ? e.port : 22, "22", "number");
    const user = input(e ? e.user : "", "deploy");
    const wd = input(e ? e.workdir : "", "/srv/app");
    const prod = el("input");
    prod.type = "checkbox"; prod.checked = !!(e && e.production);
    const who = el("select");
    for (const [k, t] of Object.entries(LEVEL)) who.append(new Option(t, k));
    who.value = e ? e.assistant : "run";
    const g = el("div", "ev-form");
    g.append(field("Id", id), field("Name", name), field("Host", hostI), field("Port", port), field("User", user),
      field("Folder", wd), field("The assistant may", who));
    const p = el("label", "ev-check");
    p.append(prod, el("span", null, "Production — runs ask first; the assistant only reads"));
    const go = button("primary", e ? "Save" : "Add", (ev) => act({op: "save", id: id.value.trim(), name: name.value,
      host: hostI.value, port: Number(port.value) || 22, user: user.value, workdir: wd.value, production: prod.checked,
      assistant: who.value}, "Save", ev.currentTarget).then((got) => { if (got && got.env) { v.sel = got.env.id; save(); draw(); } }));
    const row = el("div", "ev-row");
    row.append(p, go);
    if (e) row.append(button("linkbtn ev-del", "Delete", (ev) => act({op: "delete", env: e.id}, "Delete", ev.currentTarget)
      .then((got) => { if (got && got.ok) { v.sel = "local"; save(); draw(); } }), "Delete it, its key and its variables"));
    s.append(g, row);
    return s;
  }

  function trust(e) {
    const s = section("Host key", "Scan, compare the fingerprint with the host's own (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on it), then trust it.");
    if (e.trusted.length) {
      const ul = el("ul", "ev-fps");
      for (const f of e.trusted) ul.append(el("li", null, f));
      s.append(ul);
    }
    const row = el("div", "ev-row");
    row.append(button("pm-chip", e.trusted.length ? "Scan again" : "Scan", async (ev) => {
      const got = await act({op: "scan", env: e.id}, "Scan", ev.currentTarget);
      if (got) { scanned = {env: e.id, ...got}; draw(); }
    }));
    if (scanned && scanned.env === e.id) {
      const box = el("div", "ev-scan" + (scanned.changed ? " changed" : ""));
      box.append(el("b", null, scanned.changed ? "The host's key CHANGED since you trusted it" : "The host offers"));
      const ul = el("ul", "ev-fps");
      for (const f of scanned.fingerprints) ul.append(el("li", null, f));
      box.append(ul, button("primary", "Trust these", (ev) => act({op: "trust", env: e.id}, "Trust", ev.currentTarget)
        .then(() => { scanned = null; draw(); })));
      s.append(box);
    }
    s.append(row);
    return s;
  }

  function secrets(e) {
    const s = section(e.kind === "ssh" ? "Key and variables" : "Variables",
      "Written here, never shown again — not to you, not to the assistant. Values in any output read •••.");
    if (e.kind === "ssh") {
      const key = el("textarea", "ev-key");
      key.placeholder = e.key_set ? "A key is set. Paste another to replace it." : "-----BEGIN OPENSSH PRIVATE KEY-----";
      key.rows = 3; key.spellcheck = false;
      const row = el("div", "ev-row");
      row.append(button("pm-chip", e.key_set ? "Replace the key" : "Set the key", (ev) => {
        const text = key.value; key.value = "";
        act({op: "key", env: e.id, key: text}, "Key", ev.currentTarget);
      }));
      s.append(key, row);
    }
    const ul = el("ul", "ev-vars");
    for (const n of e.vars) {
      const li = el("li");
      li.append(el("code", null, n), el("span", "ev-dots", "•••"),
        button("tm-x", "×", (ev) => act({op: "vars", env: e.id, vars: {[n]: null}}, "Variables", ev.currentTarget), `Remove ${n}`));
      ul.append(li);
    }
    const k = input("", "NAME"), val = input("", "value", "password");
    const add = el("li", "ev-add");
    add.append(k, val, button("pm-chip", "Add", (ev) => {
      if (!k.value.trim()) return;
      act({op: "vars", env: e.id, vars: {[k.value.trim()]: val.value}}, "Variables", ev.currentTarget);
    }));
    ul.append(add);
    s.append(ul);
    return s;
  }

  function work(e) {
    const s = section("Work there");
    const row = el("div", "ev-row");
    const read = (op, title) => button("pm-chip", title, (ev) => act({op, env: e.id}, title, ev.currentTarget));
    row.append(read("test", "Test"), read("status", "Status"), read("processes", "Processes"), read("resources", "Resources"),
      button("pm-chip", "Open a terminal", async () => {
        try {
          const t = await api(`/api/p/${PID}/terminals`, {env: e.id, title: e.name || e.id});
          if (typeof TerminalPage !== "undefined") TerminalPage.show(t.id);
          ProjectMode.go("terminal");
        } catch (err) { out = {title: "Terminal", text: (err.data || {}).error || err.message, ok: false}; drawOut(); }
      }, "A login shell there, on the Terminal page"));
    const br = input("", "branch"), path = input("", "/var/log/app.log"), cmd = input("", "a command");
    const line = (inp, label, fn, title) => {
      const r = el("div", "ev-line");
      r.append(inp, button("pm-chip", label, fn, title));
      inp.onkeydown = (ev) => { if (ev.key === "Enter") fn({currentTarget: r.lastChild}); };
      return r;
    };
    s.append(row,
      line(br, "Checkout", (ev) => br.value.trim() && act({op: "checkout", env: e.id, branch: br.value.trim()}, `Checkout ${br.value}`, ev.currentTarget),
        "Clone the project's remote into the folder the first time, then fetch, switch and fast-forward"),
      line(path, "Logs", (ev) => path.value.trim() && act({op: "logs", env: e.id, path: path.value.trim()}, `Logs ${path.value}`, ev.currentTarget),
        "The file's last 200 lines"),
      line(cmd, "Run", (ev) => cmd.value.trim() && act({op: "run", env: e.id, command: cmd.value}, cmd.value, ev.currentTarget),
        "In the folder, with the variables, to its end"));
    const files = button("linkbtn", "Files in the folder", (ev) => act({op: "files", env: e.id, path: path.value.trim() || "."}, "Files", ev.currentTarget));
    s.append(files);
    return s;
  }

  function drawOut() {
    const box = host && host.querySelector(".ev-out");
    if (!box) return;
    box.textContent = "";
    if (!out) return;
    box.append(el("div", "ev-outh" + (out.ok ? "" : " err"), out.title), el("pre", "ev-pre", out.text));
  }

  return {mount, unmount};
})();
