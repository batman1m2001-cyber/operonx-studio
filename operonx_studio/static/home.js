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

async function loadProjects() {
  const box = $("#projects");
  box.textContent = "";
  const {projects} = await api("/api/projects");
  if (!projects.length) {
    $("#filter").hidden = true;
    box.append(el("div", "empty",
      "No projects yet — open a folder with an operonx.toml, or create one."));
    return;
  }
  $("#filter").hidden = projects.length < 6;
  for (const p of projects) {
    const card = el("div", "card");
    card.dataset.hay = `${p.name} ${p.root}`.toLowerCase();
    const left = el("div");
    const nameRow = el("div", "name");
    const dot = el("span", "hdot");
    dot.title = "…";
    nameRow.append(dot, p.name);
    left.append(nameRow);
    left.append(el("div", "path mono", p.root));
    const sig = el("div", "sig");
    left.append(sig);
    card.append(left);
    if (!p.exists) {
      card.classList.add("dead");
      card.append(el("span", "gone",
        "operonx.toml is gone — moved or deleted? Fix it, or ✕ to forget"));
    }
    card.append(el("div", "spacer"));
    const forget = el("button", "forget", "✕");
    forget.title = "Remove from recents";
    forget.onclick = async (ev) => {
      ev.stopPropagation();
      await api("/api/forget", {id: p.id});
      loadProjects();
    };
    card.append(forget);
    card.dataset.pid = p.id;
    card.onclick = () => { if (p.exists) location.href = `/p/${p.id}`; };
    box.append(card);
  }
  paintHealth();
}

/* Signal arrives after the cards: the list must never wait on it. */
async function paintHealth() {
  let health;
  try { ({health} = await api("/api/projects/health")); }
  catch { return; }
  for (const card of document.querySelectorAll("#projects .card")) {
    const info = health[card.dataset.pid];
    if (!info) continue;
    const dot = card.querySelector(".hdot");
    if (info.ok === true) { dot.classList.add("ok"); dot.title = "extracts cleanly"; }
    else if (info.ok === false) {
      dot.classList.add("bad");
      dot.title = info.error || "extraction fails";
      card.title = info.error || "";
    }
    const sig = card.querySelector(".sig");
    const bits = [];
    if (info.ops) bits.push(`${info.ops} ops · ${info.graphs} graph${info.graphs > 1 ? "s" : ""}`);
    if (info.runs) bits.push(`${info.runs} run${info.runs > 1 ? "s" : ""} · newest ${ago(info.newest)}`);
    sig.textContent = bits.join("   ·   ");
  }
}

$("#filter").oninput = () => {
  const q = $("#filter").value.trim().toLowerCase();
  for (const card of document.querySelectorAll("#projects .card"))
    card.hidden = !!q && !card.dataset.hay.includes(q);
};

/* ── folder browser modal, shared by open and new ─────────────────── */

function modal(title, build) {
  const back = el("div", "modal-back");
  const box = el("div", "modal");
  box.append(el("h2", null, title));
  back.append(box);
  back.onclick = (ev) => { if (ev.target === back) back.remove(); };
  build(box, () => back.remove());
  $("#modal-root").append(back);
}

function browser(box, onPick) {
  const pathInput = el("input"); pathInput.type = "text"; pathInput.className = "mono";
  const list = el("div", "browser");
  box.append(pathInput, list);
  async function go(path) {
    let data;
    try { data = await api(`/api/fs?path=${encodeURIComponent(path)}`); }
    catch (e) { list.textContent = ""; list.append(el("div", "row", String(e.message))); return; }
    pathInput.value = data.path;
    onPick(data.path);
    list.textContent = "";
    if (data.parent) {
      const up = el("div", "row", "‥ up");
      up.onclick = () => go(data.parent);
      list.append(up);
    }
    for (const d of data.dirs) {
      const row = el("div", "row");
      row.append(el("span", null, d.name));
      if (d.is_project) row.append(el("span", "tag", "operonx project"));
      row.onclick = () => go(d.path);
      list.append(row);
    }
  }
  pathInput.onchange = () => go(pathInput.value);
  go("~");
  return {go};
}

$("#btn-open").onclick = () => modal("Open project", (box) => {
  let current = "~";
  browser(box, (p) => current = p);
  const err = el("div", "err");
  const foot = el("div", "foot");
  const open = el("button", "primary", "Open this folder");
  open.onclick = async () => {
    try {
      const {id} = await api("/api/open", {path: current});
      location.href = `/p/${id}`;
    } catch (e) { err.textContent = e.message; }
  };
  foot.append(open);
  box.append(err, foot);
});

$("#btn-new").onclick = () => modal("New project", (box) => {
  const nameField = el("div", "field");
  nameField.append(el("label", null, "Project name"));
  const name = el("input"); name.type = "text"; name.placeholder = "my_project";
  nameField.append(name);
  box.append(nameField);
  box.append(el("label", "field", "Create inside:"));
  let current = "~";
  browser(box, (p) => current = p);
  const err = el("div", "err");
  const foot = el("div", "foot");
  const create = el("button", "primary", "Create");
  create.onclick = async () => {
    try {
      const {id} = await api("/api/new", {path: current, name: name.value});
      location.href = `/p/${id}`;
    } catch (e) { err.textContent = e.message; }
  };
  foot.append(create);
  box.append(err, foot);
});

loadProjects();
