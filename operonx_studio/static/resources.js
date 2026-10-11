/* operonx studio — the Resources screen. Split from studio.js, same
 * bundle, same order. */

/* ── the resource hub: every declared backing service, who uses it,
   and whether the env contract is satisfied. Read-only by design —
   the server checks variables by NAME and never returns a value. */
async function showResources() {
  const box = $("#resources");
  box.textContent = "";
  const res = state.ir.resources || {};
  const details = res.details || {};
  const head = el("div", "panehead");
  head.append(el("h2", null, "Resources"));
  box.append(head);
  box.append(el("p", "panesub",
    "The backing services this project declares, which ops use them, and whether the "
    + "environment they need is set. Secret fields never leave the server."));

  // reverse index: resource name → the ops that lean on it — including
  // ops nested inside GraphOps, which carry their graph inline
  const uses = {};
  const walk = (nodes, graph) => {
    for (const n of nodes || []) {
      const names = Array.isArray(n.resource) ? n.resource
        : n.resource ? [n.resource] : [];
      for (const r of names) (uses[r] = uses[r] || []).push({graph, node: n});
      if (n.graph) walk(n.graph.nodes, graph);
    }
  };
  for (const g of state.ir.graphs || []) walk(g.nodes, g);

  const cats = {};
  for (const [name, det] of Object.entries(details)) {
    const c = det.category || "other";
    (cats[c] = cats[c] || []).push([name, det]);
  }
  if (!Object.keys(cats).length && !(res.keys || []).length) {
    box.append(paneNote("No resources declared",
      "Resources are the LLMs, stores and services ops call by name. Declare them in a resources file next to operonx.toml."));
  }
  for (const cat of Object.keys(cats).sort()) {
    box.append(el("h3", "rescat", cat));
    const grid = el("div", "resgrid");
    box.append(grid);
    for (const [name, det] of cats[cat].sort((a, b) => a[0].localeCompare(b[0]))) {
      const card = el("div", "rescard");
      card.append(el("div", "resname", name));
      const provider = det.category === "llm"
        ? llmProvider({kind: "LLMOp", resource: name}) : null;
      if (provider) {
        const row = el("div", "resrow");
        row.append(el("span", "reskey", "backend"));
        row.append(el("span", "resval resbackend",
          `${LLM_PROVIDERS[provider].icon} ${LLM_PROVIDERS[provider].label}`));
        card.append(row);
      }
      if (det.category === "llm") card.append(priceRow(name, det));
      for (const [k, v] of Object.entries(det)) {
        if (k === "category" || k === "cost_per_input_token" || k === "cost_per_output_token") continue;
        const row = el("div", "resrow");
        row.append(el("span", "reskey", k));
        row.append(envValue(v));
        card.append(row);
      }
      const urow = el("div", "resrow");
      urow.append(el("span", "reskey", "used by"));
      const val = el("span", "usedby");
      const u = uses[name] || [];
      if (!u.length) val.append(el("span", "note", "No op uses it"));
      for (const use of u) {
        const c = el("button", "pchip pref", use.node.name);
        c.title = `${use.graph.name} · ${use.node.kind} — jump to it`;
        c.onclick = () => jumpToOp(use.graph, use.node);
        val.append(c);
      }
      urow.append(val);
      card.append(urow);
      grid.append(card);
    }
  }
  const covered = new Set([...Object.keys(details),
    ...Object.values(details).map(d => d.category)]);
  const loose = (res.keys || []).filter(k => !covered.has(k));
  if (loose.length) {
    box.append(el("h3", "rescat", "declared, details not parsed"));
    const card = el("div", "rescard usedby");
    for (const k of loose) card.append(el("span", "chip", k));
    box.append(card);
  }

  // the env contract, with a health light per variable
  box.append(el("h3", "rescat", "Environment"));
  const envBox = el("div", "envlist");
  box.append(envBox);
  try {
    const h = await api(`/api/p/${PID}/env-health`);
    const env = res.env || {};
    const rows = [];
    for (const name of env.required || [])
      rows.push([name, h.env[name] || "missing", null]);
    for (const [name, dflt] of Object.entries(env.optional || {}))
      rows.push([name, h.env[name] || "default", dflt]);
    if (!rows.length) envBox.append(el("div", "envrow note", "The project asks for no environment variables."));
    for (const [name, stat, dflt] of rows) {
      const row = el("div", "envrow");
      row.append(el("span", `envdot ${stat}`));
      row.append(el("span", "envname mono", name));
      row.append(el("span", `envstat ${stat}`,
        stat === "set" ? "Set" : stat === "missing"
          ? "Missing — required, and nothing sets it" : "Not set — the default applies"));
      if (dflt != null && stat === "default")
        row.append(el("span", "envdflt mono", String(dflt)));
      envBox.append(row);
    }
    if (!h.dotenv) envBox.append(el("div", "envrow note",
      "No .env file in the project root — variables can only come from the process environment."));
  } catch {
    envBox.append(el("div", "envrow note", "Environment status is unavailable."));
  }
}

/* An LLM resource's prices, and an editor that writes them to the
 * resources file — shown as a diff first, applied on confirm. A price of
 * 0 is a declared zero (an in-house model); no price is "unpriced". */
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

