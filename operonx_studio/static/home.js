/* operonx studio — home. The launcher: recents with live signal, a
 * filter for when seventeen projects stop being a glance, and the
 * open/new folder browser. */

"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const ago = (epoch) => {
  const s = Date.now() / 1000 - epoch;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/* The empty state doubles as onboarding: what a project is, and the two
 * ways to get one. */
function emptyState() {
  const box = el("div", "emptystate");
  box.append(Icons.svg("graph", "emptyicon"));
  box.append(el("h2", null, "No projects yet"));
  box.append(el("p", null,
    "A project is a folder with an operonx.toml. Open one you already have, "
    + "or create a new one with a working example graph."));
  const row = el("div", "actions");
  const neu = Icons.button("plus", "New project");
  neu.onclick = () => $("#btn-new").click();
  const open = Icons.button("folder", "Open project", "primary");
  open.onclick = () => $("#btn-open").click();
  row.append(neu, open);
  box.append(row);
  return box;
}

async function loadProjects() {
  const box = $("#projects");
  let projects;
  try { ({projects} = await api("/api/projects")); }
  catch (e) {
    box.textContent = "";
    box.append(el("div", "errbox", `Could not list projects: ${e.message}`));
    return;
  }
  box.textContent = "";
  if (!projects.length) {
    $("#filterwrap").hidden = true;
    box.classList.add("empty");
    box.append(emptyState());
    return;
  }
  box.classList.remove("empty");
  $("#filterwrap").hidden = projects.length < 6;
  for (const p of projects) {
    const row = el("div", "projrow");
    row.dataset.hay = `${p.name} ${p.root}`.toLowerCase();
    row.dataset.pid = p.id;
    const dot = el("span", "hdot");
    dot.title = "checking…";
    const main = el("div", "projmain");
    const top = el("div", "projtop");
    top.append(el("span", "name", p.name));
    main.append(top);
    main.append(el("div", "path mono", p.root));
    const sig = el("div", "sig");
    main.append(sig);
    if (!p.exists) {
      row.classList.add("dead");
      sig.classList.add("bad");
      sig.textContent = "operonx.toml is gone — moved or deleted? Fix it, or remove it from this list.";
    }
    const forget = Icons.button("x", undefined, "forget", "Remove from this list");
    forget.onclick = async (ev) => {
      ev.stopPropagation();
      await api("/api/forget", {id: p.id});
      loadProjects();
    };
    row.append(dot, main);
    if (p.exists) row.append(Icons.svg("right", "go"));
    row.append(forget);
    if (p.exists) {
      // the whole row is the link; the forget button stays its own target
      row.tabIndex = 0;
      row.setAttribute("role", "link");
      row.setAttribute("aria-label", `Open ${p.name}`);
      const go = () => { location.href = `/p/${p.id}`; };
      row.onclick = go;
      row.onkeydown = (ev) => { if (ev.key === "Enter") go(); };
    }
    box.append(row);
  }
  paintHealth();
}

/* Signal arrives after the rows: the list must never wait on it. */
async function paintHealth() {
  let health;
  try { ({health} = await api("/api/projects/health")); }
  catch { return; }
  for (const row of document.querySelectorAll("#projects .projrow")) {
    const info = health[row.dataset.pid];
    if (!info) continue;
    const dot = row.querySelector(".hdot");
    const sig = row.querySelector(".sig");
    if (info.ok === true) { dot.classList.add("ok"); dot.title = "extracts cleanly"; }
    else if (info.ok === false) {
      dot.classList.add("bad");
      dot.title = "extraction fails";
      sig.classList.add("bad");
      sig.textContent = String(info.error || "extraction fails").trim().split("\n").pop();
      continue;
    }
    const bits = [];
    if (info.ops) bits.push(`${info.ops} ops · ${info.graphs} graph${info.graphs > 1 ? "s" : ""}`);
    if (info.runs) bits.push(`${info.runs} run${info.runs > 1 ? "s" : ""}, newest ${ago(info.newest)}`);
    sig.textContent = bits.join("  ·  ");
  }
}

$("#filter").oninput = () => {
  const q = $("#filter").value.trim().toLowerCase();
  let shown = 0;
  for (const row of document.querySelectorAll("#projects .projrow")) {
    row.hidden = !!q && !row.dataset.hay.includes(q);
    if (!row.hidden) shown += 1;
  }
  let none = $("#projects .nomatch");
  if (!shown && !none) {
    none = el("div", "nomatch note", "No project matches that filter.");
    $("#projects").append(none);
  }
  if (none) none.hidden = shown > 0;
};

/* ── folder browser modal, shared by open and new ─────────────────── */

function modal(title, build) {
  const back = el("div", "modal-back");
  const box = el("div", "modal");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", title);
  const head = el("div", "modalhead");
  head.append(el("h2", null, title));
  const x = Icons.button("x", undefined, "", "Close");
  head.append(x);
  box.append(head);
  back.append(box);
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  x.onclick = close;
  back.onclick = (ev) => { if (ev.target === back) close(); };
  build(box, close);
  $("#modal-root").append(back);
  const first = box.querySelector("input");
  if (first) first.focus();
}

function browser(box, onPick) {
  const field = el("div", "field");
  field.append(el("label", null, "Folder"));
  const pathInput = el("input"); pathInput.type = "text"; pathInput.className = "mono";
  pathInput.setAttribute("aria-label", "Folder path");
  field.append(pathInput);
  const list = el("div", "browser");
  box.append(field, list);
  async function go(path) {
    let data;
    try { data = await api(`/api/fs?path=${encodeURIComponent(path)}`); }
    catch (e) { list.textContent = ""; list.append(el("div", "row bad", String(e.message))); return; }
    pathInput.value = data.path;
    onPick(data.path);
    list.textContent = "";
    const item = (icon, label, tag, onClick) => {
      const row = el("button", "row");
      row.type = "button";
      row.append(Icons.svg(icon), el("span", "rowname", label));
      if (tag) row.append(el("span", "tag", tag));
      row.onclick = onClick;
      list.append(row);
    };
    if (data.parent) item("up", "Up one level", null, () => go(data.parent));
    for (const d of data.dirs) {
      item("folder", d.name, d.is_project ? "operonx project" : null, () => go(d.path));
    }
    if (!data.dirs.length) list.append(el("div", "note rowempty", "No folders inside."));
  }
  pathInput.onchange = () => go(pathInput.value);
  go("~");
  return {go};
}

function footer(box, close, label, action) {
  const err = el("div", "err");
  err.setAttribute("role", "alert");
  const foot = el("div", "foot");
  const cancel = el("button", null, "Cancel");
  cancel.type = "button";
  cancel.onclick = close;
  const ok = el("button", "primary", label);
  ok.type = "button";
  ok.onclick = async () => {
    err.textContent = "";
    ok.disabled = true;
    try { await action(); }
    catch (e) { err.textContent = e.message; ok.disabled = false; }
  };
  foot.append(cancel, ok);
  box.append(err, foot);
}

$("#btn-open").onclick = () => modal("Open project", (box, close) => {
  box.append(el("p", "modalhint", "Pick the folder that holds the project's operonx.toml."));
  let current = "~";
  browser(box, (p) => current = p);
  footer(box, close, "Open this folder", async () => {
    const {id} = await api("/api/open", {path: current});
    location.href = `/p/${id}`;
  });
});

$("#btn-new").onclick = () => modal("New project", async (box, close) => {
  // start from something that already works: each template runs offline,
  // with a service, a dataset, an eval and a job
  const pickField = el("div", "field");
  pickField.append(el("label", null, "Start from"));
  const gallery = el("div", "tplgrid");
  gallery.setAttribute("role", "radiogroup");
  pickField.append(gallery);
  box.append(pickField);
  let chosen = "http-api";
  try {
    const {templates} = await api("/api/templates");
    for (const t of templates) {
      const card = el("button", "tplcard" + (t.id === chosen ? " sel" : ""));
      card.type = "button";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(t.id === chosen));
      card.append(el("b", null, t.title), el("span", null, t.description));
      card.onclick = () => {
        chosen = t.id;
        for (const c of gallery.children) { c.classList.toggle("sel", c === card); c.setAttribute("aria-checked", String(c === card)); }
        if (!name.value || name.dataset.auto) { name.value = t.id === "blank" ? "" : t.id.replace(/-/g, "_"); name.dataset.auto = "1"; }
      };
      gallery.append(card);
    }
  } catch { /* the blank project, then */ chosen = "blank"; }
  const nameField = el("div", "field");
  nameField.append(el("label", null, "Project name"));
  const name = el("input"); name.type = "text"; name.placeholder = "my_project";
  name.value = "http_api"; name.dataset.auto = "1";
  name.oninput = () => { delete name.dataset.auto; };
  name.setAttribute("aria-label", "Project name");
  nameField.append(name);
  box.append(nameField);
  let current = "~";
  browser(box, (p) => current = p);
  box.querySelector(".browser").previousElementSibling.querySelector("label").textContent = "Create inside";
  footer(box, close, "Create project", async () => {
    const {id} = await api("/api/new", {path: current, name: name.value, template: chosen});
    location.href = `/p/${id}`;
  });
});

loadProjects();
