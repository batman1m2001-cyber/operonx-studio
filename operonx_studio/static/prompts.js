/* operonx studio — Prompts: the project's named prompts and the LLM ops that send them.
 *
 * A prompt's page: its text, Save, Publish, its versions. An op's page: the
 * prompts it sends and its recent runs (what it was given, what it answered).
 */

"use strict";

const PromptsView = (() => {
  const box = $("#prompts");
  const K = `prompts:${PID}`;
  const v = Object.assign({op: "", prompt: ""}, recall(K, {}));
  let token = 0;
  let creating = false;   // the New prompt form is open
  const save = () => store(K, v);

  function llmOps() {
    const out = [];
    for (const g of (state.ir || {}).graphs || []) {
      (function walk(nodes) {
        for (const n of nodes || []) {
          if (/llm/i.test(n.kind || "") || (n.prompts || []).length) out.push({name: n.name, graph: g.name, resource: Array.isArray(n.resource) ? n.resource.join(", ") : n.resource, prompts: n.prompts || []});
          if (n.graph) walk(n.graph.nodes);
        }
      })(g.nodes);
    }
    const seen = new Set();
    return out.filter(o => !seen.has(o.name) && seen.add(o.name));
  }

  const text = (x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2));
  const toks = (u) => (u ? `${u.prompt_tokens ?? u.input_tokens ?? "?"} → ${u.completion_tokens ?? u.output_tokens ?? "?"} tokens` : "");

  const said = (m) => (m && typeof m.content === "string" ? m.content : text(m && m.content !== undefined ? m.content : m));

  async function show() {
    const mine = ++token;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Prompts"));
    const nb = el("button", "needs-edit" + (creating ? " on" : ""), creating ? "Cancel" : "+ New prompt");
    nb.type = "button";
    nb.onclick = () => { creating = !creating; show(); };
    head.append(nb);
    box.append(head);
    const ops = llmOps();
    const declared = await api(`/api/p/${PID}/prompts`).catch(() => ({prompts: []}));
    if (mine !== token) return;
    const named = declared.prompts || [];
    if (creating && !ops.length && !named.length) { box.append(newForm()); return; }
    if (!ops.length && !named.length) {
      box.append(paneNote("No LLM ops here", "This project's graphs have no LLMOp yet.",
        null, {ask: {label: "Add an LLM step", prompt: "Look at this project's flow and suggest one place an LLM step would "
          + "clearly help. Describe it first; if I agree, add it with an LLMOp and a prompt I can tune here."}}));
      return;
    }
    if (v.prompt && !named.find(p => p.name === v.prompt)) v.prompt = "";
    if (!v.prompt && !ops.find(o => o.name === v.op)) { v.op = ops.length ? ops[0].name : ""; if (!v.op && named.length) v.prompt = named[0].name; }
    save();
    const grid = el("div", "pwgrid");
    const list = el("div", "pwlist");
    const main = el("div", "pwmain");
    grid.append(list, main);
    box.append(grid);
    // the project's named prompts (prompts/<name>.md): what is declared, before what is guessed from runs
    if (named.length) {
      list.append(el("div", "stitle", "Prompts"));
      for (const p of named) {
        const b = el("button", "pwop" + (p.name === v.prompt ? " sel" : ""));
        b.type = "button";
        const sv = p.serving || {};
        b.append(el("b", "mono", p.name), el("span", null, p.error ? "cannot be read" : sv.version != null ? `${sv.label} → v${sv.version}${p.unpublished ? " · edited since" : ""}` : (p.versions.length ? "working text served" : "not published yet")));
        b.onclick = () => { v.prompt = p.name; save(); show(); };
        list.append(b);
      }
    }
    if (named.length && ops.length) list.append(el("div", "stitle", "LLM ops"));
    for (const o of ops) {
      const b = el("button", "pwop" + (!v.prompt && o.name === v.op ? " sel" : ""));
      b.type = "button";
      const uses = o.prompts.map(r => r.name).join(", ");
      b.append(el("b", "mono", o.name), el("span", null, `${o.graph}${uses ? " · " + uses : o.resource ? " · " + o.resource : ""}`));
      b.onclick = () => { v.op = o.name; v.prompt = ""; save(); show(); };
      list.append(b);
    }
    if (!named.length) list.append(el("div", "note pwhint", "A prompt kept as prompts/<name>.md and asked for with prompt(\"name\") is listed here with its versions."));
    if (creating) { main.append(newForm()); return; }
    if (v.prompt) { showNamed(main, named.find(p => p.name === v.prompt), ops); return; }
    // An op's page: which prompts it sends, and what it was given and answered in its recent runs.
    // Prompt text is read and changed on the prompt's own page, not here.
    const o = ops.find(x => x.name === v.op) || {prompts: []};
    const ohead = el("div", "pwnhead");
    const title = el("div", "pwntitle");
    title.append(el("h3", "mono", o.name || v.op), el("span", "pwchip", o.graph || ""));
    const uses = el("div", "pwnmeta");
    ohead.append(title, uses);
    main.append(ohead);
    const chips = new Map();
    uses.append(el("span", null, "sends"));
    const none = el("span", "note", "no named prompt");
    uses.append(none);
    const chip = (r) => {
      const name = typeof r === "string" ? r : r.name;
      if (!name || chips.has(name)) return;
      const b = el("button", "linkbtn mono", name);
      b.type = "button"; b.title = "Open this prompt";
      b.onclick = () => { v.prompt = name; save(); show(); };
      chips.set(name, b);
      uses.insertBefore(b, none);
      none.hidden = true;
    };
    (o.prompts || []).forEach(chip);
    const wait = el("div", "note pwwait", "Loading recent runs…");
    main.append(wait);
    let got;
    try { got = await api(`/api/p/${PID}/prompts/${encodeURIComponent(v.op)}/samples?limit=20`); }
    catch (err) { if (mine === token) wait.replaceWith(el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    wait.remove();
    for (const smp of got.samples) (smp.prompts || []).forEach(chip);   // a prompt chosen at run time
    if (!got.samples.length) { main.append(el("div", "note", `No runs yet: a service call, a job or Play on the Flow that runs ${v.op} shows here.`)); return; }

    const ss = el("section");
    ss.append(el("div", "stitle", `Recent runs — ${got.samples.length}, newest first`));
    const table = el("div", "pwsamples");
    const shownKeys = (got.varying || []).filter(k => k !== "prompt");
    for (const smp of got.samples) {
      const row = el("div", "pwrow");
      const data = el("div", "pwdata");
      data.append(el("span", "note", `${smp.name || smp.origin} · ${fmtAgo(smp.started * 1000)}`));
      for (const k of shownKeys.slice(0, 3)) {
        const val = (smp.inputs || {})[k];
        const shown = k === "messages" && Array.isArray(val) && val.length ? said(val[val.length - 1]) : text(val);
        data.append(el("div", "mono pwvar", `${k}: ${String(shown).slice(0, 220)}`));
      }
      const ans = el("div", "pwans");
      const bad = smp.status === "error";
      const body = bad ? String(smp.error || "").trim().split("\n").pop() : (text(smp.content ?? "") || "(empty answer)");
      ans.append(el("div", "stitle", `${fmtMs(smp.duration_ms || 0)} · ${toks(smp.usage)}`),
                 el("pre", "mono" + (bad ? " bad" : smp.content ? "" : " muted"), body));
      row.append(data, ans);
      table.append(row);
    }
    ss.append(table);
    main.append(ss);
  }

  /* A named prompt: its text, who uses it, its versions and the labels on them. */
  function showNamed(main, p, ops) {
    if (!p) return;
    const again = () => show();                    // the list says what is served too: draw the page again
    const head = el("div", "pwnhead");
    const title = el("div", "pwntitle");
    title.append(el("h3", "mono", p.name));
    const sv = p.serving || {};
    title.append(el("span", "pwchip" + (sv.version != null ? " live" : ""), sv.version != null ? `${sv.label} → v${sv.version}` : "working text is served"));
    if (p.unpublished && p.versions.length) title.append(el("span", "pwchip warn", "edited since v" + p.versions[0].version));
    head.append(title);
    if (p.description) head.append(el("p", "pwndesc", p.description));
    const users = ops.filter(o => o.prompts.some(r => r.name === p.name));
    const meta = el("div", "pwnmeta");
    meta.append(el("span", "mono", p.file));
    if (p.variables && p.variables.length) meta.append(el("span", null, "fills " + p.variables.map(x => `{{${x}}}`).join(" ")));
    meta.append(el("span", null, users.length ? "used by" : "no op names it in its graph"));
    for (const o of users) {
      const b = el("button", "linkbtn mono", o.name);
      b.type = "button"; b.title = `${o.name} in ${o.graph}: its recorded runs`;
      b.onclick = () => { v.op = o.name; v.prompt = ""; save(); show(); };
      meta.append(b);
    }
    head.append(meta);
    main.append(head);
    if (p.error) { main.append(el("div", "errbox", p.error)); return; }

    const sec = el("section", "pwprompt");
    const cap = el("div", "pwcap");
    cap.append(el("b", null, "Working text"), el("span", null, `${p.text.length.toLocaleString()} characters`));
    const inp = el("textarea", "pwtext pwprose");
    inp.value = p.text; inp.spellcheck = false;
    inp.setAttribute("aria-label", `${p.name}: working text`);
    inp.style.height = `${Math.min(520, 34 + 22 * Math.max(4, p.text.split("\n").reduce((n, ln) => n + 1 + Math.floor(ln.length / 110), 0)))}px`;
    const acts = el("div", "pwacts");
    const saveB = el("button", "primary needs-edit", "Save");
    const pubB = el("button", "needs-edit", `Publish as v${(p.versions[0] ? p.versions[0].version : 0) + 1}`);
    const msg = el("span", "note");
    for (const b of [saveB, pubB]) b.type = "button";
    const sync = () => {
      const edited = inp.value !== p.text;
      saveB.hidden = !edited;
      pubB.hidden = edited || !p.unpublished;
      if (!edited && !p.unpublished) msg.textContent = p.versions.length ? `Same as v${p.versions[0].version}: nothing to publish.` : "";
    };
    inp.oninput = () => { msg.textContent = ""; sync(); };
    saveB.onclick = async () => {
      try { const got = await api(`/api/p/${PID}/prompts/write`, {name: p.name, text: inp.value, base: p.base}); wrote(got, `Saved ${p.file}`); again(got.prompt); }
      catch (err) { msg.textContent = err.message; }
    };
    const publish = (label) => async () => {
      try { const got = await api(`/api/p/${PID}/prompts/publish`, {name: p.name, label}); stored(got); again(got.prompt); }
      catch (err) { msg.textContent = err.message; }
    };
    pubB.onclick = publish(null);
    acts.append(saveB, pubB, msg);
    sec.append(cap, inp, acts);
    main.append(sec);
    sync();

    const vs = el("section", "pwversions");
    vs.append(el("div", "stitle", p.versions.length ? `Versions — ${p.versions.length}, newest first` : "Versions"));
    if (!p.versions.length) vs.append(el("div", "note", "Not published yet: runs get the working text."));
    const diffAt = el("div", "pwdiff");
    const showDiff = async (a, b, label) => {
      diffAt.textContent = "";
      let got;
      try { got = await api(`/api/p/${PID}/prompts/diff?name=${encodeURIComponent(p.name)}${a != null ? "&a=" + a : ""}${b != null ? "&b=" + b : ""}`); }
      catch (err) { diffAt.append(el("div", "errbox", err.message)); return; }
      diffAt.append(el("div", "stitle", label));
      if (got.same) { diffAt.append(el("div", "note", "The two are the same.")); return; }
      const d = el("div", "diffbox");
      for (const ln of got.diff.split("\n")) d.append(el("span", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : "", ln + "\n"));
      diffAt.append(d);
    };
    p.versions.forEach((ver, i) => {
      const row = el("div", "pwver");
      row.append(el("b", "mono", "v" + ver.version), el("span", "note", `${ver.chars.toLocaleString()} chars`));
      const chips = el("span", "pwchips");
      for (const l of ver.labels) chips.append(el("span", "pwchip live", l));
      row.append(chips);
      const tools = el("span", "pwvtools");
      const prev = p.versions[i + 1];
      if (prev) { const b = el("button", "linkbtn", `Changes from v${prev.version}`); b.type = "button"; b.onclick = () => showDiff(prev.version, ver.version, `v${prev.version} → v${ver.version}`); tools.append(b); }
      if (!ver.labels.includes("production")) {
        const s = el("button", "linkbtn needs-edit", "Serve as production"); s.type = "button";
        s.onclick = async () => { try { const got = await api(`/api/p/${PID}/prompts/label`, {name: p.name, label: "production", version: ver.version}); stored(got); again(got.prompt); } catch (err) { diffAt.textContent = ""; diffAt.append(el("div", "errbox", err.message)); } };
        tools.append(s);
      }
      row.append(tools);
      vs.append(row);
    });
    vs.append(diffAt);
    main.append(vs);
  }

  /* A prompt no op asks for yet: prompts/<name>.md, written, then opened with its versions. */
  function newForm() {
    const sec = el("section", "pwprompt pwnew");
    sec.append(el("div", "stitle", "New prompt"));
    const name = el("input", "pwname mono");
    name.placeholder = "name — intake.system, or cio/analyst for a folder"; name.spellcheck = false; name.setAttribute("aria-label", "The prompt's name");
    const inp = el("textarea", "pwtext pwprose");
    inp.placeholder = "The prompt's text. {{name}} is filled in by the op.";
    inp.spellcheck = false; inp.style.height = "260px"; inp.setAttribute("aria-label", "The prompt's text");
    const file = el("span", "note");
    const go = el("button", "primary needs-edit", "Create");
    go.type = "button";
    const err = el("div", "errbox"); err.hidden = true;
    const tell = () => { file.textContent = name.value.trim() ? `prompts/${name.value.trim()}.md — an op asks for it with prompt("${name.value.trim()}")` : ""; };
    name.oninput = tell;
    go.onclick = async () => {
      err.hidden = true;
      try {
        const got = await api(`/api/p/${PID}/prompts/new`, {name: name.value.trim(), text: inp.value});
        wrote(got, `Created ${got.prompt.file}`);
        creating = false; v.prompt = got.prompt.name; save(); show();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    const row = el("div", "pwline");
    row.append(go, file);
    sec.append(name, inp, row, err);
    setTimeout(() => name.focus(), 0);
    return sec;
  }

  /* A publish or a moved label is also copied to the prompt store when the project has one
   * (Settings → Prompts): say it reached the running services, or why it did not. */
  function stored(got) {
    if (got.store_error) toast(`Saved in the files, but not sent to the prompt store: ${got.store_error}`, true);
    else if (got.store) toast(`Sent to the prompt store — running services pick it up within seconds`);
  }

  /* From an op's card: straight to the prompt it names ({prompt}), or to the op's own page here ({op}). */
  function open(to) {
    v.prompt = (to && to.prompt) || "";
    if (to && to.op) v.op = to.op;
    save();
    if (state.tab === "prompts") show(); else switchTab("prompts");
  }

  registerPane("prompts", {el: box, show});
  return {show, open};
})();
