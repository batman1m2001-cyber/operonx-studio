/* operonx studio — the Resources screen. Split from studio.js, same
 * bundle, same order. */

/* ── the Resource Hub (docs/STUDIO_EXPERIENCE_PLAN.md §6) ─────────────
 * Every resource the project declares, by category, from its own file
 * ([resources] overlay, resources.yaml): what each one is set to, whether the
 * variables it needs are set (by name; a value never leaves the server), and
 * what uses it — an op, the project's config, or a parameter that picks it per
 * run (with how often lately). A row opens onto its fields, each edited as
 * what it is, written through safewrite; a secret's value goes to .env. A
 * resource is added with a form built from its category, and deleted only
 * when nothing uses it. */
async function showResources() {
  const box = $("#resources");
  let hub;
  try { hub = await api(`/api/p/${PID}/resources/hub`); }
  catch (e) { box.textContent = ""; box.append(loadError(e, showResources)); return; }
  box.textContent = "";
  const page = el("div", "rh");
  // the title and its actions on one row, what the screen is beneath —
  // as every other screen's header reads
  const head = el("div", "panehead rh-head");
  const q = el("input", "rt-search rh-search");
  q.type = "search";
  q.placeholder = "Find a resource";
  q.setAttribute("aria-label", "Find a resource");
  const add = Icons.button("plus", "Add a resource", "primary needs-edit", "Declare a new resource in " + hub.file);
  head.append(el("h2", null, "Resources"), el("div", "spacer"), q, add);
  page.append(head, el("p", "panesub rh-sub",
    `The models, services and stores ops call by name, in ${hub.file}. Secret values stay in .env and never leave the server.`));
  const adder = el("div", "rh-adder");
  adder.hidden = true;
  page.append(adder);
  add.onclick = () => { adder.hidden = !adder.hidden; if (!adder.hidden) addForm(adder, hub); };

  const list = el("div", "rh-list");
  page.append(list);
  if (!hub.categories.length) {
    list.append(paneNote("No resources declared",
      `Resources are the LLMs, stores and services ops call by name. Add one, and it is written to ${hub.file}.`));
  }
  const draw = () => {
    list.textContent = "";
    const needle = q.value.trim().toLowerCase();
    for (const cat of hub.categories) {
      const rows = cat.resources.filter(r => !needle || `${cat.name} ${r.name} ${JSON.stringify(r.fields)}`.toLowerCase().includes(needle));
      if (!rows.length) continue;
      const sec = el("section", "rh-cat");
      const ch = el("div", "rh-cathead");
      ch.append(el("h3", null, cat.name), el("span", "rh-count", String(rows.length)));
      if (cat.chooser) {
        const pick = el("span", "rh-chooser", `picked per run by ${cat.chooser}`);
        ch.append(pick);
        api(`/api/p/${PID}/resources/usage?param=${encodeURIComponent(cat.chooser)}`).then(u => {
          cat._usage = u.counts || {};
          for (const n of sec.querySelectorAll("[data-usage]")) {
            const c = cat._usage[n.dataset.usage] || 0;
            n.textContent = c ? `${c} run${c === 1 ? "" : "s"} in ${u.days} days` : `no run in ${u.days} days`;
          }
        }).catch(() => {});
      }
      sec.append(ch);
      for (const r of rows) sec.append(resourceRow(cat, r, hub));
      list.append(sec);
    }
  };
  q.oninput = draw;
  draw();
  box.append(page);
}

/* The two or three fields that say what a resource is (a model, a URL). */
function resourceSummary(cat, r) {
  const prefer = ["model", "base_url", "url", "host", "api_type", "backend", "path", "prompts", "database"];
  const keys = Object.keys(r.fields);
  const picked = [...prefer.filter(k => keys.includes(k)), ...keys.filter(k => !prefer.includes(k))]
    .filter(k => !(cat.fields[k] || {}).secret).slice(0, 2);
  return picked.map(k => [k, r.fields[k]]);
}

function envLight(r) {
  const vars = Object.entries(r.env || {});
  if (!vars.length) return null;
  const missing = vars.filter(([, st]) => st === "missing").map(([v]) => v);
  const chip = el("span", "rh-env " + (missing.length ? "bad" : "ok"));
  chip.append(el("i", "rh-dot"), missing.length ? `${missing.join(", ")} not set` : "env set");
  chip.title = vars.map(([v, st]) => `${v}: ${st}`).join("\n");
  return chip;
}

function resourceRow(cat, r, hub) {
  const row = el("div", "rh-row");
  const top = el("button", "rh-top");
  top.type = "button";
  top.setAttribute("aria-expanded", "false");
  top.append(el("span", "rh-name mono", r.name));
  const sum = el("span", "rh-sum");
  for (const [k, v] of resourceSummary(cat, r)) {
    const it = el("span", "rh-kv");
    it.append(el("span", "rh-k", k), el("span", "rh-v mono", typeof v === "string" ? v : JSON.stringify(v)));
    sum.append(it);
  }
  top.append(sum);
  const env = envLight(r);
  if (env) top.append(env);
  const used = el("span", "rh-used");
  const ops = r.used_by.filter(u => u.op), cfg = r.used_by.filter(u => u.config);
  if (ops.length) used.append(`used by ${ops.slice(0, 3).map(u => u.op).join(", ")}${ops.length > 3 ? ` +${ops.length - 3}` : ""}`);
  else if (cfg.length) used.append(`named in ${cfg[0].config}`);
  else if (cat.chooser) { const u = el("span", null, "…"); u.dataset.usage = r.name; used.append(u); }
  else used.append(el("span", "rh-unused", "not used"));
  top.append(used);
  const caret = el("span", "rh-caret", "▸");
  top.append(caret);
  const body = el("div", "rh-body");
  body.hidden = true;
  top.onclick = () => {
    body.hidden = !body.hidden;
    caret.textContent = body.hidden ? "▸" : "▾";
    top.setAttribute("aria-expanded", String(!body.hidden));
    if (!body.hidden && !body.childNodes.length) hubResourceDetail(body, cat, r, hub);
  };
  row.append(top, body);
  return row;
}

/* One edit to the project's resources file, through the YAML editor's door. */
function hubEdit(hub, op, path, extra) {
  return (apply, base) => ({run: () => api(`/api/p/${PID}/yaml`, {file: hub.file, op, path, ...extra, apply, base})});
}

function hubResourceDetail(body, cat, r, hub) {
  if (!r.editable) {
    body.append(el("div", "note", `Declared outside ${hub.file} (operonx's defaults or another file): shown, not edited here.`));
  }
  const form = el("div", "rh-form");
  for (const [k, v] of Object.entries(r.fields)) {
    const info = cat.fields[k] || {type: "str"};
    const f = el("div", "cf-field");
    const h = el("div", "cf-head");
    h.append(el("span", "cf-name mono", k), el("span", "cf-type", info.type + (info.secret ? " · secret" : "")));
    f.append(h);
    const ref = typeof v === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(v) : null;
    if (info.secret) {
      // the file names a variable; its value goes to .env, never shown
      f.append(el("div", "rh-ref mono", typeof v === "string" ? v : "••••"));
      if (ref && r.editable) {
        const line = el("div", "yv-add");
        const val = el("input", "cf-text");
        val.type = "password";
        val.autocomplete = "off";
        val.placeholder = `a new value for ${ref[1]}`;
        const go = el("button", "small needs-edit", "Set in .env");
        go.type = "button";
        go.onclick = async () => {
          if (!val.value) return;
          try { const got = await api(`/api/p/${PID}/env`, {var: ref[1], value: val.value}); val.value = ""; wrote(got, `${ref[1]} set in .env`); }
          catch (e) { toast(e.message, true); }
        };
        line.append(val, go);
        f.append(line);
      }
      form.append(f);
      continue;
    }
    if (!r.editable || (typeof v === "object" && v !== null)) {
      f.append(el("div", "rh-ref mono", typeof v === "string" ? v : JSON.stringify(v)));
    } else {
      const c = el("input", "cf-text");
      if (info.type === "bool") { c.type = "checkbox"; c.className = "cf-switch"; c.checked = !!v; }
      else if (info.type === "int" || info.type === "float") { c.type = "number"; c.step = "any"; c.value = String(v); }
      else { c.type = "text"; c.value = String(v); }
      f.append(c);
      // a file this project holds (an agent's prompts): open it here
      if (typeof v === "string" && /\.ya?ml$/i.test(v) && !v.includes("${")) {
        const ed = Icons.button("prompt", "Edit the file", "small ghost", `Edit ${v} in the studio`);
        ed.onclick = () => YamlView.open(v);
        f.append(ed);
      }
      c.setAttribute("aria-label", `${r.name} ${k}`);
      const read = () => (c.type === "checkbox" ? c.checked : c.type === "number" ? Number(c.value) : c.value);
      Configure.review(f, (apply, base) => hubEdit(hub, "set", [cat.name, r.name, k], {value: read()})(apply, base), `${r.name}.${k} saved`);
    }
    form.append(f);
  }
  if (cat.name === "llm" && r.editable) form.append(priceRow(r.name, r.fields));
  body.append(form);
  if (!r.editable) return;
  // a field the category takes that this one does not write yet
  const missing = Object.entries(cat.fields).filter(([k]) => !(k in r.fields));
  const acts = el("div", "rh-acts");
  if (missing.length) {
    const more = el("div", "yv-add");
    const pick = el("select");
    for (const [k, info] of missing) { const o = el("option", null, `${k}${info.default != null ? ` (default ${info.default})` : ""}`); o.value = k; pick.append(o); }
    const val = el("input", "cf-text");
    val.type = "text";
    val.placeholder = "value";
    more.append(pick, val);
    const f = el("div", "cf-field");
    f.append(el("div", "cf-head", "Add a field"), more);
    Configure.review(f, (apply, base) => {
      const info = cat.fields[pick.value] || {};
      let value = val.value;
      if (info.type === "int" || info.type === "float") value = Number(value);
      if (info.type === "bool") value = /^(true|yes|1)$/i.test(value);
      return hubEdit(hub, "add", [cat.name, r.name], {key: pick.value, value})(apply, base);
    }, `${r.name}: field added`);
    acts.append(f);
  }
  const tools = el("div", "rh-tools");
  const open = Icons.button("prompt", "Open in the YAML editor", "small ghost", `${hub.file}, at ${cat.name}.${r.name}`);
  open.onclick = () => { YamlView.open(hub.file); };
  const del = Icons.button("trash", "Delete", "small danger needs-edit", `Remove ${r.name} from ${hub.file}`);
  const delOut = el("div", "cf-out");
  del.onclick = async () => {
    delOut.textContent = "";
    try {
      const plan = await api(`/api/p/${PID}/resources/delete`, {category: cat.name, name: r.name});
      const box2 = el("div");
      const diff = el("div", "diffbox");
      for (const ln of plan.diff.split("\n")) diff.append(el("div", ln.startsWith("-") && !ln.startsWith("---") ? "del" : null, ln));
      const yes = el("button", "small danger needs-edit", `Delete ${r.name}`);
      yes.type = "button";
      yes.onclick = async () => {
        try { const got = await api(`/api/p/${PID}/resources/delete`, {category: cat.name, name: r.name, apply: true, base: plan.base}); wrote(got, `${r.name} deleted`); showResources(); }
        catch (e) { refusal(e, delOut); }
      };
      box2.append(diff, yes);
      delOut.append(box2);
    } catch (e) { delOut.append(el("div", "cf-msg bad", e.message)); }
  };
  tools.append(open, del);
  acts.append(tools, delOut);
  body.append(acts);
}

/* A new resource: its category, its name, and the fields its category takes
 * (the ones the project writes for others first); a secret field names a
 * variable and its value goes to .env. */
function addForm(box, hub) {
  box.textContent = "";
  const known = new Set(hub.categories.map(c => c.name));
  const cats = [...hub.categories.map(c => c.name), ...hub.known_categories.filter(c => !known.has(c))];
  const card = el("div", "rh-addcard");
  card.append(el("h3", null, "Add a resource"));
  const top = el("div", "yv-add");
  const cat = el("select");
  for (const c of cats) { const o = el("option", null, known.has(c) ? c : `${c} (new in this project)`); o.value = c; cat.append(o); }
  const name = el("input", "cf-text mono");
  name.type = "text";
  name.placeholder = "its name (e.g. gpt-large)";
  top.append(cat, name);
  card.append(top);
  const fieldsBox = el("div", "rh-form");
  card.append(fieldsBox);
  let readers = [];
  const paint = () => {
    fieldsBox.textContent = "";
    readers = [];
    const c = hub.categories.find(x => x.name === cat.value);
    const fields = c ? c.fields : {};
    const shown = Object.entries(fields).filter(([, i]) => i.written || i.required);
    const rest = Object.entries(fields).filter(([, i]) => !(i.written || i.required));
    const one = (k, info, into) => {
      const f = el("div", "cf-field");
      f.append(el("div", "cf-head"));
      f.firstChild.append(el("span", "cf-name mono", k), el("span", "cf-type", info.type + (info.required ? " · required" : "") + (info.secret ? " · secret" : "")));
      if (info.secret) {
        const v = el("input", "cf-text mono rh-var");
        v.type = "text";
        // the variable follows the resource's name until it is typed in
        const suggest = () => `${(name.value || cat.value).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${k.toUpperCase()}`;
        v.value = suggest();
        v.oninput = () => { v.dataset.typed = "1"; };
        v._suggest = suggest;
        const val = el("input", "cf-text");
        val.type = "password";
        val.autocomplete = "off";
        val.placeholder = "its value (goes to .env)";
        const line = el("div", "yv-add");
        line.append(v, val);
        f.append(line);
        readers.push(() => (val.value ? {secret: [k, {var: v.value.trim(), value: val.value}]} : {}));
      } else {
        const c2 = el("input", "cf-text");
        if (info.type === "bool") { c2.type = "checkbox"; c2.className = "cf-switch"; c2.checked = !!info.default; }
        else { c2.type = info.type === "int" || info.type === "float" ? "number" : "text"; c2.placeholder = info.default != null ? `default ${info.default}` : ""; }
        f.append(c2);
        readers.push(() => {
          if (c2.type === "checkbox") return c2.checked !== !!info.default ? {field: [k, c2.checked]} : {};
          if (c2.value === "") return {};
          return {field: [k, c2.type === "number" ? Number(c2.value) : c2.value]};
        });
      }
      into.append(f);
    };
    for (const [k, info] of shown) one(k, info, fieldsBox);
    if (rest.length) {
      const more = el("details", "cf-more");
      more.append(el("summary", null, `${rest.length} more fields this category takes`));
      for (const [k, info] of rest) one(k, info, more);
      fieldsBox.append(more);
    }
    if (!Object.keys(fields).length) fieldsBox.append(el("div", "note", "A category the project has not used: add its fields in the YAML editor once it exists."));
  };
  cat.onchange = paint;
  name.oninput = () => {
    for (const v of fieldsBox.querySelectorAll(".rh-var")) if (!v.dataset.typed) v.value = v._suggest();
  };
  paint();
  const out = el("div", "cf-out");
  const bar = el("div", "cf-bar");
  const review = el("button", "small needs-edit", "Review");
  review.type = "button";
  const cancel = el("button", "small ghost", "Cancel");
  cancel.type = "button";
  cancel.onclick = () => { box.hidden = true; };
  bar.append(review, cancel);
  card.append(bar, out);
  const body = () => {
    const fields = {}, secrets = {};
    for (const read of readers) {
      const got = read();
      if (got.field) fields[got.field[0]] = got.field[1];
      if (got.secret) secrets[got.secret[0]] = got.secret[1];
    }
    return {category: cat.value, name: name.value.trim(), fields, secrets};
  };
  review.onclick = async () => {
    out.textContent = "";
    let plan;
    try { plan = await api(`/api/p/${PID}/resources/add`, body()); }
    catch (e) { out.append(el("div", "cf-msg bad", e.message)); return; }
    const diff = el("div", "diffbox");
    for (const ln of plan.diff.split("\n")) diff.append(el("div", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : null, ln));
    out.append(diff);
    if ((plan.env_changes || []).length) out.append(el("div", "note", `.env: ${plan.env_changes.join(", ")}`));
    const apply = el("button", "primary small needs-edit", "Add it");
    apply.type = "button";
    apply.onclick = async () => {
      apply.disabled = true;
      apply.textContent = "Writing…";
      try {
        const got = await api(`/api/p/${PID}/resources/add`, {...body(), apply: true, base: plan.base, env_base: plan.env_base});
        wrote(got, `${body().name} added to ${hub.file}`);
        showResources();
      } catch (e) { apply.disabled = false; apply.textContent = "Add it"; refusal(e, out); }
    };
    out.append(apply);
  };
  box.append(card);
}

function priceRow(name, det) {
  const wrap = el("div", "pricerow");
  const perM = (v) => (v == null || v === "" ? null : Number(v) * 1e6);
  const fmt = (v) => (v === 0 ? "$0" : `$${Number(v.toPrecision(6))}`);
  const pin = perM(det.cost_per_input_token), pout = perM(det.cost_per_output_token);
  const line = el("div", "resrow");
  line.append(el("span", "reskey", "price"));
  const val = el("span", "resval priceval");
  if (pin == null && pout == null) {
    val.append(el("span", "unpriced", "Not priced"), " — calls show as unpriced in Runs and Monitor");
  } else {
    val.textContent = `${fmt(pin || 0)} in · ${fmt(pout || 0)} out per 1M tokens`;
  }
  const edit = el("button", "linkbtn needs-edit", pin == null && pout == null ? "Set prices" : "Edit");
  edit.type = "button";
  line.append(val, edit);
  wrap.append(line);

  const form = el("div", "priceform");
  form.hidden = true;
  const field = (label, value) => {
    const f = el("label", "pricefield");
    f.append(el("span", null, label));
    const i = el("input");
    i.type = "number"; i.min = "0"; i.step = "0.01"; i.inputMode = "decimal";
    i.value = value == null ? "" : String(Number(value.toPrecision(6)));
    i.placeholder = "0";
    f.append(i, el("span", "priceunit", "USD / 1M tokens"));
    return [f, i];
  };
  const [fIn, iIn] = field("Input", pin);
  const [fOut, iOut] = field("Output", pout);
  const diff = el("pre", "diffbox");
  diff.hidden = true;
  const err = el("div", "err");
  const acts = el("div", "priceacts");
  const cancel = el("button", "small", "Cancel");
  cancel.type = "button";
  const preview = el("button", "small", "Preview change");
  preview.type = "button";
  const apply = el("button", "small primary", "Save to resources file");
  apply.type = "button";
  apply.hidden = true;
  acts.append(cancel, preview, apply);
  form.append(fIn, fOut, el("p", "note pricehint", "For an in-house model, 0 declares it free — different from leaving it unpriced."), diff, err, acts);
  wrap.append(form);

  const body = () => ({resource: name, input_per_1m: iIn.value || 0, output_per_1m: iOut.value || 0});
  edit.onclick = () => { form.hidden = !form.hidden; };
  cancel.onclick = () => { form.hidden = true; diff.hidden = true; apply.hidden = true; err.textContent = ""; };
  preview.onclick = async () => {
    err.textContent = "";
    try {
      const r = await api(`/api/p/${PID}/resources/price`, body());
      diff.textContent = "";
      for (const ln of (r.diff || "No change.").split("\n")) {
        diff.append(el("div", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : null, ln));
      }
      diff.hidden = false;
      apply.hidden = !r.changed;
      base = r.base;
    } catch (e) { err.textContent = e.message; }
  };
  let base = null;
  apply.onclick = async () => {
    try {
      const got = await api(`/api/p/${PID}/resources/price`, {...body(), apply: true, base});
      wrote(got, "Prices saved — new calls are priced from now on");
      form.hidden = true;
    } catch (e) {
      const fresh = refusal(e, diff);
      if (fresh) base = fresh; else apply.hidden = true;
    }
  };
  return wrap;
}

function jumpToOp(graph, node) {
  switchTab("flow");
  if (state.graph !== graph
      && (state.ir.graphs || []).includes(graph)) {
    state.graph = graph;
    $("#graph-pick").value = graph.name;
    state.sel = null;
    state.expanded.clear();
    render();
    fit();
  }
  const find = () => [...state.rendered.values()]
    .find(x => !x.inner && x.node.name === node.name);
  let it = find();
  if (!it) {
    // nested inside a collapsed GraphOp — open everything and retry
    expandAll(true);
    it = find();
  }
  if (it) { select(it.key); centerOn(it); }
}

/* A pane's "nothing here yet" — what is missing and the exact lines
 * that fix it, instead of a grey sentence. */
/* A screen that could not load: what went wrong in one line, and a way
 * to try again — a dropped tunnel is the usual reason, and it passes. */
function loadError(err, retry) {
  const box = el("div", "errbox loaderr");
  box.append(el("div", "errhead", "This could not load"),
    el("div", "note", err && err.message ? err.message : String(err)));
  if (retry) {
    const b = Icons.button("refresh", "Try again", "small");
    b.onclick = retry;
    box.append(b);
  }
  return box;
}

/* An empty or stuck screen: what is (not) here, and the ONE action that
 * fixes it — usually the assistant doing it — before any manual recipe.
 * opts.ask = {label, prompt}: a button that hands the assistant the task.
 * opts.actions = [{label, icon, run}]: plain buttons beside it. A code
 * recipe, when given, folds under "Or do it by hand". */
function paneNote(title, text, code, opts) {
  opts = opts || {};
  const box = el("div", "panenote");
  box.append(el("h3", null, title));
  box.append(el("div", null, text));
  const acts = el("div", "noteacts");
  if (opts.ask && window.oxAsk) {
    const b = Icons.button("spark", opts.ask.label, "primary noteask");
    b.title = "The assistant does it, and shows you what it changed";
    b.onclick = () => window.oxAsk(opts.ask.prompt);
    acts.append(b);
  }
  for (const a of opts.actions || []) {
    const b = Icons.button(a.icon || "right", a.label, opts.ask ? "" : "primary");
    b.onclick = a.run;
    acts.append(b);
  }
  if (acts.childNodes.length) box.append(acts);
  if (code) {
    if (acts.childNodes.length) {
      const fold = el("details", "notehand");
      fold.append(el("summary", null, "Or do it by hand"), el("pre", null, code));
      box.append(fold);
    } else box.append(el("pre", null, code));
  }
  return box;
}

/* The runs list is the Runs screen (runs.js): origin tree, filters,
 * the runs in the chosen folder. Everything that used to "go back to the
 * list" still calls this. */
function showTraces() {
  return RunsView.show();
}

/* Time, the way a person reads it: "3h ago" first, the exact local
 * time beside it. Anything that does not parse is shown as given. */
function fmtWhen(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return String(t || "");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString([], {month: "short", day: "numeric"})}, ${time}`;
}
function fmtAgo(t) {
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return "";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function fmtSpan(a, b) {
  const s = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  if (!isFinite(s) || s < 0) return "";
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

