/* operonx studio — Prompts: an LLM op's prompt, tried on what really came in.
 *
 * Pick an LLM op; its recorded executions are the samples. An input with
 * the same value in every sample is the prompt — editable; one that varies
 * is each case's data. Try the edit on the samples you pick: each is the
 * op re-run in the current code with the edit (the playground bridge),
 * shown beside what it answered when recorded, with tokens and cost.
 * Save writes the text back where it lives when it lives there verbatim;
 * otherwise the assistant is asked to.
 */

"use strict";

const PromptsView = (() => {
  const box = $("#prompts");
  const K = `prompts:${PID}`;
  const v = Object.assign({op: "", prompt: ""}, recall(K, {}));
  let token = 0;
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
  const money = (x) => (x == null ? "unpriced" : `$${x < 0.01 ? x.toFixed(5) : x.toFixed(3)}`);
  const toks = (u) => (u ? `${u.prompt_tokens ?? u.input_tokens ?? "?"} → ${u.completion_tokens ?? u.output_tokens ?? "?"} tokens` : "");

  /* A chat op takes one input, `messages`, and it differs in every sample — yet the prompt is in it:
   * the messages every sample starts with (the system message, as a rule). Those are the prompt;
   * what follows them is the case. Returns how many leading messages are shared, 0 when none. */
  function sharedLead(samples) {
    const lists = samples.map(s => s.inputs && s.inputs.messages);
    if (!lists.length || !lists.every(Array.isArray)) return 0;
    let n = 0;
    while (lists.every(l => l.length > n) && lists.every(l => JSON.stringify(l[n]) === JSON.stringify(lists[0][n]))) n++;
    // a lone sample shares all of itself: only its system messages are the prompt
    if (samples.length === 1) { n = 0; while (n < lists[0].length && lists[0][n] && lists[0][n].role === "system") n++; }
    return n;
  }
  const ROLE = {system: "System prompt", user: "User", assistant: "Assistant", tool: "Tool"};
  const said = (m) => (m && typeof m.content === "string" ? m.content : text(m && m.content !== undefined ? m.content : m));

  async function show() {
    const mine = ++token;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Prompts"));
    box.append(head);
    const ops = llmOps();
    const declared = await api(`/api/p/${PID}/prompts`).catch(() => ({prompts: []}));
    if (mine !== token) return;
    const named = declared.prompts || [];
    if (!ops.length && !named.length) {
      box.append(paneNote("No LLM ops here", "The workbench opens an LLMOp's prompt and tries edits on the inputs it really had. This project's graphs have none yet.",
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
    if (v.prompt) { showNamed(main, named.find(p => p.name === v.prompt), ops); return; }
    const wait = el("div", "note", "Reading this op's recorded executions…");
    main.append(wait);
    // the search opens up to 2,000 recorded runs to find this op's inputs: on a project with many
    // runs and none of this op that is most of a minute, so say it is still working
    const slow = setTimeout(() => { wait.textContent = "Still reading: looking through the recorded runs for this op. With many runs this can take a minute."; }, 4000);
    let got;
    try { got = await api(`/api/p/${PID}/prompts/${encodeURIComponent(v.op)}/samples?limit=20`); }
    catch (err) { clearTimeout(slow); main.textContent = ""; main.append(el("div", "errbox", err.message)); return; }
    clearTimeout(slow);
    if (mine !== token) return;
    main.textContent = "";
    if (!got.samples.length) {
      main.append(paneNote("Nothing recorded yet", `Run ${v.op} — a service call, a job, the Playground — and its inputs become the samples here.`));
      return;
    }

    // the prompt: every input that is the same in every sample
    const edits = {};
    const sec = el("section", "pwprompt");
    sec.append(el("div", "stitle", "The prompt — the same in every sample"));
    /* a piece of prompt text, to be read: its name, its size, the text in a reading face */
    const prose = (title, val, key, label, editable = true) => {
      const f = el("div", "pwfield pwlead");
      const cap = el("div", "pwcap");
      cap.append(el("b", null, title), el("span", null, `${val.length.toLocaleString()} characters · the same in every sample`));
      const inp = el("textarea", "pwtext pwprose");
      inp.value = val; inp.spellcheck = false; inp.readOnly = !editable;
      inp.setAttribute("aria-label", title);
      inp.style.height = `${Math.min(460, 34 + 22 * Math.max(2, val.split("\n").reduce((n, ln) => n + 1 + Math.floor(ln.length / 110), 0)))}px`;
      const saveRow = el("div", "pwsave");
      saveRow.hidden = true;
      inp.oninput = () => {
        edits[key] = inp.value;
        if (inp.value === val) delete edits[key];
        f.classList.toggle("edited", key in edits);
        saveRow.hidden = !(key in edits);
      };
      const sb = el("button", "linkbtn needs-edit", "Save this text where it lives…");
      sb.type = "button";
      sb.onclick = () => saveText(saveRow, v.op, label, val, inp.value);
      saveRow.append(sb);
      f.append(cap, inp, saveRow);
      return f;
    };
    const PART = {system: "System prompt", user: "User message — the template"};
    /* a part the op asks for by name is not a copy to edit here: it is that prompt, opened */
    const mine_ = ops.find(o => o.name === v.op) || {prompts: []};
    const byName = (part) => {
      const r = mine_.prompts.find(x => x.part === part);
      if (!r) return null;
      const row = el("div", "pwfield pwlead pwnamed");
      const cap = el("div", "pwcap");
      cap.append(el("b", null, part ? (PART[part] || part) : "Prompt"));
      const b = el("button", "linkbtn mono", r.name);
      b.type = "button"; b.title = "Open this prompt: its text, its versions";
      b.onclick = () => { v.prompt = r.name; save(); show(); };
      cap.append(b, el("span", null, r.version != null ? `${r.label || "pinned"} → v${r.version}` : "working text"));
      row.append(cap);
      return row;
    };
    const parts = (val) => val && typeof val === "object" && !Array.isArray(val) && Object.keys(val).length && Object.values(val).every(x => typeof x === "string");
    /* a prompt chosen in the run (an op upstream rendered it): the samples say which ones */
    const atRun = [...new Map((got.samples || []).flatMap(x => (x.prompts || []).filter(r => r.input)).map(r => [r.name, r])).values()];
    if (atRun.length) {
      const row = el("div", "pwfield pwlead pwnamed");
      const cap = el("div", "pwcap");
      cap.append(el("b", null, "Rendered in the run from"));
      for (const r of atRun) {
        const b = el("button", "linkbtn mono", r.name);
        b.type = "button"; b.title = "Open this prompt: its text, its versions";
        b.onclick = () => { v.prompt = r.name; save(); show(); };
        cap.append(b);
      }
      row.append(cap);
      sec.append(row);
    }
    for (const [k, val] of Object.entries(got.constant)) {
      // a {system, user} template is read part by part, not as JSON; the messages built from it are
      // the same text again and are not shown twice
      if (k === "prompt" && parts(val)) { for (const [p, x] of Object.entries(val)) sec.append(byName(p) || prose(PART[p] || p, x, `prompt.${p}`, `prompt.${p}`)); continue; }
      if (k === "prompt" && byName(undefined)) { sec.append(byName(undefined)); continue; }
      if (k === "messages" && parts(got.constant.prompt)) continue;
      const f = el("label", "pwfield");
      f.append(el("span", "mono", k));
      // an object (a {system, user} template) always gets the room to read as JSON
      const long = (val !== null && typeof val === "object") || (typeof val !== "number" && text(val).length > 60);
      const inp = long ? el("textarea", "playjson pwtext") : el("input", "mono");
      inp.value = text(val);
      if (long) inp.style.height = `${Math.min(420, 40 + 18 * text(val).split("\n").length)}px`;
      const saveRow = el("div", "pwsave");
      inp.oninput = () => {
        edits[k] = inp.value;
        if (inp.value === text(val)) delete edits[k];
        f.classList.toggle("edited", k in edits);
        saveRow.hidden = !(k in edits) || typeof val !== "string";
      };
      saveRow.hidden = true;
      const sb = el("button", "linkbtn needs-edit", "Save this text where it lives…");
      sb.type = "button";
      sb.onclick = () => saveText(saveRow, v.op, k, val, inp.value);
      saveRow.append(sb);
      f.append(inp, saveRow);
      sec.append(f);
    }
    const lead = got.varying.includes("messages") && !parts(got.constant.prompt) ? sharedLead(got.samples) : 0;
    const first = lead ? got.samples[0].inputs.messages : [];
    for (let i = 0; i < lead; i++) {
      const m = first[i];
      sec.append(prose(ROLE[m.role] || m.role || "Message", said(m), `messages#${i}`, `messages[${i}].content`, typeof m.content === "string"));
    }
    if (!Object.keys(got.constant).length && !lead) sec.append(el("div", "note", "Every input differs between samples — there is no fixed prompt to edit here."));
    main.append(sec);

    // the samples, and what the edit makes of them
    const ss = el("section");
    ss.append(el("div", "stitle", `Samples — ${got.samples.length} recorded, newest first`));
    const table = el("div", "pwsamples");
    const picks = new Set(got.samples.slice(0, 3).map((_, i) => i));
    const resEls = [];
    got.samples.forEach((smp, i) => {
      const row = el("div", "pwrow");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = picks.has(i);
      cb.setAttribute("aria-label", "Try the edit on this sample");
      cb.onchange = () => { cb.checked ? picks.add(i) : picks.delete(i); go.textContent = `Try it on ${picks.size}`; };
      const data = el("div", "pwdata");
      const used = (smp.prompts || []).map(r => `${r.name} ${r.version != null ? "v" + r.version : "working"}`).join(", ");
      data.append(el("span", "note", `${smp.origin} · ${smp.name} · ${fmtAgo(smp.started * 1000)}${used ? " · " + used : ""}`));
      let shown = 0;
      if (lead) {                                    // the case is the conversation after the prompt: its last turns, as said
        const rest = smp.inputs.messages.slice(lead);
        if (rest.length > 2) data.append(el("div", "note pwmore", `${rest.length - 2} earlier message${rest.length - 2 === 1 ? "" : "s"}`));
        for (const m of rest.slice(-2)) {
          const ln = el("div", "pwsaid");
          ln.append(el("b", null, ROLE[m.role] || m.role || "message"), el("span", null, said(m).slice(0, 600)));
          data.append(ln);
        }
        shown = 1;
      }
      for (const k of got.varying.filter(k => !(k === "messages" && (lead || parts(got.constant.prompt)))).slice(0, 2 - shown)) data.append(el("div", "mono pwvar", `${k}: ${text(smp.inputs[k]).slice(0, 220)}`));
      const pair = el("div", "rerunpair pwpair");
      const then = el("div");
      then.append(el("div", "stitle", `Then · ${fmtMs(smp.duration_ms || 0)} · ${toks(smp.usage)} · ${money(smp.cost_usd)}`),
                  el("pre", "mono" + (smp.status === "error" ? " bad" : smp.content ? "" : " muted"), smp.status === "error" ? String(smp.error || "").trim().split("\n").pop() : (text(smp.content ?? "") || "(empty answer)")));
      const now = el("div", "pwnow");
      now.append(el("div", "stitle", "Now"), el("pre", "mono muted", "—"));
      pair.append(then, now);
      resEls.push(now);
      row.append(cb, data, pair);
      table.append(row);
    });
    const acts = el("div", "priceacts");
    const go = el("button", "primary needs-edit", `Try it on ${picks.size}`);
    go.type = "button";
    acts.append(go);
    ss.append(acts, table);
    main.append(ss);

    go.onclick = async () => {
      go.disabled = true;
      const jobs = [...picks].map(async (i) => {
        const smp = got.samples[i];
        const slot = resEls[i];
        slot.textContent = "";
        slot.append(el("div", "stitle", "Now · running…"));
        const inputs = {...smp.inputs};
        for (const [k, x] of Object.entries(edits)) {
          if (k.startsWith("prompt.")) { inputs.prompt = {...inputs.prompt, [k.slice(7)]: x}; continue; }   // one part of a template
          if (k.startsWith("messages#")) {             // an edited prompt message, put back in its place
            const i = +k.slice(9);
            inputs.messages = inputs.messages.map((m, j) => (j === i ? {...m, content: x} : m));
            continue;
          }
          const orig = got.constant[k];
          inputs[k] = typeof orig === "string" ? x : (() => { try { return JSON.parse(x); } catch { return x; } })();
        }
        try {
          const r = await PlayView.rerun(smp.run, v.op, inputs);
          const out = r.outputs || {};
          slot.textContent = "";
          slot.append(el("div", "stitle", `Now · ${fmtMs(r.ms || 0)} · ${toks(out.usage)} · ${money(out.cost_usd)}`),
                      el("pre", "mono" + (r.status === "error" ? " bad" : ""), r.status === "error" ? r.error : text(out.content ?? "")));
        } catch (err) {
          slot.textContent = "";
          slot.append(el("div", "stitle", "Now"), el("pre", "mono bad", err.message));
        }
      });
      await Promise.all(jobs);
      go.disabled = false;
    };
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
    const liveB = el("button", "needs-edit", "Publish and serve as production");
    const msg = el("span", "note");
    for (const b of [saveB, pubB, liveB]) b.type = "button";
    const sync = () => {
      const edited = inp.value !== p.text;
      saveB.hidden = !edited;
      pubB.hidden = liveB.hidden = edited || !p.unpublished;
      if (!edited && !p.unpublished) msg.textContent = p.versions.length ? `Same as v${p.versions[0].version}: nothing to publish.` : "";
    };
    inp.oninput = () => { msg.textContent = ""; sync(); };
    saveB.onclick = async () => {
      try { const got = await api(`/api/p/${PID}/prompts/write`, {name: p.name, text: inp.value, base: p.base}); wrote(got, `Saved ${p.file}`); again(got.prompt); }
      catch (err) { msg.textContent = err.message; }
    };
    const publish = (label) => async () => {
      try { const got = await api(`/api/p/${PID}/prompts/publish`, {name: p.name, label}); again(got.prompt); }
      catch (err) { msg.textContent = err.message; }
    };
    pubB.onclick = publish(null);
    liveB.onclick = publish("production");
    acts.append(saveB, pubB, liveB, msg);
    sec.append(cap, inp, acts);
    main.append(sec);
    sync();

    const vs = el("section", "pwversions");
    vs.append(el("div", "stitle", p.versions.length ? `Versions — ${p.versions.length}, newest first` : "Versions"));
    if (!p.versions.length) vs.append(el("div", "note", "Not published yet: every run is given the working text. Publishing freezes it as v1, so a later edit can be compared and rolled back."));
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
      const w = el("button", "linkbtn", "Compare with working text"); w.type = "button"; w.onclick = () => showDiff(ver.version, null, `v${ver.version} → working text`); tools.append(w);
      if (!ver.labels.includes("production")) {
        const s = el("button", "linkbtn needs-edit", "Serve as production"); s.type = "button";
        s.onclick = async () => { try { const got = await api(`/api/p/${PID}/prompts/label`, {name: p.name, label: "production", version: ver.version}); again(got.prompt); } catch (err) { diffAt.textContent = ""; diffAt.append(el("div", "errbox", err.message)); } };
        tools.append(s);
      }
      row.append(tools);
      vs.append(row);
    });
    if (p.versions.length) vs.append(el("div", "note", "A label is read when a service starts: a moved label is served after the next restart."));
    vs.append(diffAt);
    main.append(vs);
  }

  async function saveText(slot, op, key, original, updated) {
    slot.querySelector(".diffbox")?.remove();
    slot.querySelector(".pwask")?.remove();
    let got;
    try { got = await api(`/api/p/${PID}/prompts/save`, {original, updated}); }
    catch (err) {
      const ask = el("div", "pwask");
      ask.append(el("span", "note", `${err.message}. `));
      const b = el("button", "linkbtn", "Ask the assistant to make this change");
      b.type = "button";
      b.onclick = () => window.oxAsk && window.oxAsk(
        `In op \`${op}\`, the prompt input \`${key}\` should change. It is built in code or YAML — find where and edit it.\n\n`
        + `Currently:\n\`\`\`\n${original}\n\`\`\`\n\nShould become:\n\`\`\`\n${updated}\n\`\`\``);
      ask.append(b);
      slot.append(ask);
      return;
    }
    const diff = el("div", "diffbox");
    for (const ln of got.diff.split("\n")) diff.append(el("span", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : "", ln + "\n"));
    const apply = el("button", "primary needs-edit", `Write ${got.file}`);
    apply.type = "button";
    let base = got.base;
    apply.onclick = async () => {
      try {
        const done = await api(`/api/p/${PID}/prompts/save`, {original, updated, apply: true, base});
        wrote(done, `Saved to ${got.file}`);
        show();
      } catch (err) {
        const fresh = refusal(err, diff);
        if (fresh) { base = fresh; apply.textContent = `Write ${got.file} as it is now`; } else apply.remove();
      }
    };
    slot.append(diff, apply);
  }

  registerPane("prompts", {el: box, show});
  return {show};
})();
